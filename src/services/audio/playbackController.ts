import { planSynthesisChunks } from '../tts/chunkPlanner';
import { recordTtsDiagnostic } from '../tts/diagnostics';
import { supertonicEngine } from '../tts/supertonicEngine';
import {
  PreparationCancelled,
  synthesisCoordinator,
  type SynthesisPreparationRequest
} from '../tts/synthesisCoordinator';
import type {
  PassageSynthesisIdentity,
  PlannedSynthesisChunk,
  PreparedSynthesisChunk,
  WordTimestamp
} from '../tts/types';
import { MediaElementSink } from './mediaElementSink';

export type PlaybackState = 'idle' | 'preparing' | 'playing' | 'paused' | 'rebuffering' | 'device-too-slow';
export type PlaybackModelPhase = 'download' | 'compile' | 'warmup' | 'provider-fallback';
export const PREFETCH_LOW_WATER_SECONDS = 8;
export const PREFETCH_HIGH_WATER_SECONDS = 12;
export const SPECULATIVE_PREPARATION_ENABLED = import.meta.env.VITE_SUPERTONIC_SPECULATIVE_PREPARATION !== '0';

export type PassageIdentityInput = Omit<
  PassageSynthesisIdentity,
  'provider' | 'steps' | 'modelVersion' | 'runtimeVersion'
>;

export interface PlaybackCallbacks {
  onWord?: (globalWordIndex: number) => void;
  onStateChange?: (state: PlaybackState) => void;
  onModelProgress?: (fraction: number | null) => void;
  onModelPhase?: (phase: PlaybackModelPhase | null) => void;
  onBufferChange?: (scheduledAheadSeconds: number) => void;
  onSentence?: (index: number, total: number) => void;
  onEnd?: () => void;
  onError?: (message: string) => void;
}

interface ScheduledChunk {
  chunk: PlannedSynthesisChunk;
  buffer: AudioBuffer;
  pcmBytes: number;
  words: ScheduledWord[];
  startAt: number;
  endAt: number;
  source: AudioBufferSourceNode;
}

interface ScheduledWord extends WordTimestamp {
  globalIndex: number;
}

interface CoordinatorPort {
  prepare(request: SynthesisPreparationRequest): Promise<PreparedSynthesisChunk>;
  cancelScope(scope: 'foreground' | 'speculative'): void;
  clearPrepared(slot?: 'current' | 'next'): void;
  setScheduledUsage?(usage: { seconds: number; bytes: number }): void;
}

class DeviceTooSlow extends Error {
  constructor() {
    super('This device cannot synthesize narration fast enough for continuous playback. Please retry.');
    this.name = 'DeviceTooSlow';
  }
}

class RuntimeFallbackRequired extends Error {
  constructor() {
    super('The active narration runtime is not sustainable');
    this.name = 'RuntimeFallbackRequired';
  }
}

/** Owns bounded synthesis scheduling and audio-clock playback for one passage. */
export class PlaybackController {
  private context: AudioContext | null = null;
  private sink: MediaElementSink | null = null;
  private state: PlaybackState = 'idle';
  private callbacks: PlaybackCallbacks = {};
  private rafId: number | null = null;
  private generation = 0;
  private activeRequestKey: string | null = null;
  private nextStartAt = 0;
  private scheduled: ScheduledChunk[] = [];
  private reportedSentences = new Set<number>();
  private totalSentences = 0;
  private playbackStarted = false;
  private lowWaterSeconds = Number.POSITIVE_INFINITY;
  private underrunCount = 0;
  private underrunDurationMs = 0;
  private slowUnderrunEvidence = 0;
  private platformInterruptionCount = 0;
  private platformInterruptionActive = false;
  private bufferBand: 'low' | 'middle' | 'high' | null = null;
  private passageIncomplete = false;
  private requiredSynthesisGeneration: number | null = null;
  private pausedFrom: 'playing' | 'rebuffering' = 'playing';
  private fallbackAttempted = false;
  private tapStartedAt: number | null = null;
  private firstSpeechAt: number | null = null;
  private firstSpeechRecorded = false;

  private static readonly BUFFER_HORIZON_SECONDS = 20;
  private static readonly UNDERRUN_TOLERANCE_SECONDS = 0.02;
  private static readonly DEVICE_TOO_SLOW_UNDERRUNS = 2;
  private static readonly SUSTAINABLE_PRODUCTION_FACTOR = 1.25;

  constructor(private readonly coordinator: CoordinatorPort = synthesisCoordinator) {}

  getState(): PlaybackState {
    return this.state;
  }

  getScheduledAheadSeconds(): number {
    return this.context && this.playbackStarted ? Math.max(0, this.nextStartAt - this.context.currentTime) : 0;
  }

  cancelPreparation(scope: 'foreground' | 'speculative' = 'speculative'): void {
    this.coordinator.cancelScope(scope);
  }

  /** Prepares only the startup chunk and never touches the audio graph. */
  async preparePassage(
    text: string,
    identityInput: PassageIdentityInput,
    slot: 'current' | 'next' = 'current'
  ): Promise<PreparedSynthesisChunk | null> {
    if (!SPECULATIVE_PREPARATION_ENABLED) return null;
    const runtime = supertonicEngine.getRuntimeInfo();
    if (!supertonicEngine.isReady() || !runtime) return null;
    const identity = completeIdentity(identityInput, runtime);
    validateIdentityArguments(identity, text, identity.voiceId, identity.startWordOffset, identity.speed);
    const startup = planSynthesisChunks(text, { startWordOffset: identity.startWordOffset })[0];
    if (!startup) return null;
    return this.coordinator.prepare({ identity, chunk: startup, priority: 'speculative', slot });
  }

  private setState(next: PlaybackState): void {
    if (this.state === next) return;
    this.state = next;
    this.callbacks.onStateChange?.(next);
  }

  /** Creates and unlocks audio synchronously inside the user gesture. */
  start(
    text: string,
    voiceId: string,
    callbacks: PlaybackCallbacks = {},
    startWordOffset = 0,
    speed?: number,
    identity?: PassageIdentityInput
  ): void {
    const requestKey = JSON.stringify([text, voiceId, startWordOffset, speed ?? null, identity ?? null]);
    if (this.state === 'preparing' && requestKey === this.activeRequestKey) {
      const context = this.ensureContext();
      void context.resume();
      this.ensureSink().activate();
      return;
    }

    this.stop();
    const generation = this.generation;
    this.callbacks = callbacks;
    this.activeRequestKey = requestKey;
    this.tapStartedAt = performance.now();

    const context = this.ensureContext();
    void context.resume();
    this.ensureSink().activate();
    this.setState('preparing');
    void this.run(text, voiceId, startWordOffset, speed, identity, generation);
  }

  private ensureContext(): AudioContext {
    if (!this.context || this.context.state === 'closed') {
      this.sink?.release();
      this.sink = null;
      this.context = new AudioContext();
    }
    return this.context;
  }

  private ensureSink(): MediaElementSink {
    const context = this.ensureContext();
    if (!this.sink) this.sink = new MediaElementSink(context);
    return this.sink;
  }

  private async run(
    text: string,
    voiceId: string,
    startWordOffset: number,
    speed: number | undefined,
    suppliedIdentity: PassageIdentityInput | undefined,
    generation: number
  ): Promise<void> {
    try {
      if (!supertonicEngine.isReady()) {
        try {
          await supertonicEngine.load((progress) => {
            if (generation === this.generation) {
              this.callbacks.onModelProgress?.(progress.total > 0 ? progress.loaded / progress.total : null);
              this.callbacks.onModelPhase?.(playbackPhase(progress.label));
            }
          });
        } finally {
          if (generation === this.generation) {
            this.callbacks.onModelProgress?.(null);
            this.callbacks.onModelPhase?.(null);
          }
        }
      }
      if (generation !== this.generation) return;

      const runtime = supertonicEngine.getRuntimeInfo();
      if (!runtime) throw new Error('Engine runtime is unavailable after loading');
      const identity = suppliedIdentity
        ? completeIdentity(suppliedIdentity, runtime)
        : anonymousIdentity(text, voiceId, startWordOffset, speed ?? 1.05, runtime);
      validateIdentityArguments(identity, text, voiceId, startWordOffset, speed ?? 1.05);
      const chunks = planSynthesisChunks(text, { startWordOffset });
      this.totalSentences = chunks.reduce((count, chunk) => count + chunk.segments.length, 0);
      if (chunks.length === 0) {
        this.finish(generation);
        return;
      }
      this.passageIncomplete = true;

      for (const chunk of chunks) {
        if (this.playbackStarted) {
          this.observeLowWater();
          await this.waitUntil(this.nextStartAt - PlaybackController.BUFFER_HORIZON_SECONDS, generation);
        }
        if (generation !== this.generation) return;

        this.requiredSynthesisGeneration = generation;
        let prepared: PreparedSynthesisChunk;
        try {
          prepared = await this.coordinator.prepare({
            identity,
            chunk,
            priority: 'foreground',
            slot: chunk.kind === 'startup' ? 'current' : undefined
          });
        } finally {
          if (this.requiredSynthesisGeneration === generation) this.requiredSynthesisGeneration = null;
        }
        if (generation !== this.generation) return;
        this.scheduleChunk(prepared, generation);
        if (!this.playbackStarted) {
          this.playbackStarted = true;
          this.setState('playing');
          this.startWordClock(generation);
        } else if (this.state === 'rebuffering') {
          this.setState('playing');
        } else if (this.state === 'paused' && this.pausedFrom === 'rebuffering') {
          this.pausedFrom = 'playing';
        }
      }
      this.passageIncomplete = false;

      await this.waitUntil(this.nextStartAt, generation);
      if (generation === this.generation) this.finish(generation);
    } catch (error) {
      if (error instanceof PreparationCancelled) {
        recordTtsDiagnostic({
          phase: 'playback',
          cancellationLatencyMs: error.latencyMs,
          outcome: 'success'
        });
      }
      if (generation !== this.generation || error instanceof PreparationCancelled) return;
      if (error instanceof RuntimeFallbackRequired) {
        if (await this.tryRuntimeFallback(generation)) {
          await this.run(text, voiceId, startWordOffset, speed, suppliedIdentity, generation);
          return;
        }
        this.fail(new DeviceTooSlow(), 'device-too-slow');
        return;
      }
      this.fail(error as Error, error instanceof DeviceTooSlow ? 'device-too-slow' : 'idle');
    }
  }

  private async tryRuntimeFallback(generation: number): Promise<boolean> {
    if (this.fallbackAttempted || generation !== this.generation) return false;
    this.fallbackAttempted = true;
    this.coordinator.cancelScope('foreground');
    this.coordinator.clearPrepared();
    this.stopSources();
    this.stopWordClock();
    this.sink?.pause();
    this.resetMetrics(true);
    this.setState('preparing');
    this.callbacks.onModelPhase?.('provider-fallback');

    try {
      await supertonicEngine.fallbackFromActiveProvider((progress) => {
        if (generation !== this.generation) return;
        this.callbacks.onModelProgress?.(progress.total > 0 ? progress.loaded / progress.total : null);
        this.callbacks.onModelPhase?.(playbackPhase(progress.label));
      });
      if (generation !== this.generation) return false;
      this.sink?.resume();
      return true;
    } catch {
      return false;
    } finally {
      if (generation === this.generation) {
        this.callbacks.onModelProgress?.(null);
        this.callbacks.onModelPhase?.(null);
      }
    }
  }

  private scheduleChunk(prepared: PreparedSynthesisChunk, generation: number): void {
    const context = this.ensureContext();
    const hadTimeline = this.playbackStarted && this.nextStartAt > 0;
    const expectedAt = this.nextStartAt;
    const lateBy = context.currentTime - expectedAt;
    if (hadTimeline) {
      const aheadBeforeScheduling = Math.max(0, expectedAt - context.currentTime);
      this.lowWaterSeconds = Math.min(this.lowWaterSeconds, aheadBeforeScheduling);
      recordTtsDiagnostic({
        phase: 'playback',
        scheduledAheadSeconds: aheadBeforeScheduling,
        bufferLowWaterSeconds: this.lowWaterSeconds,
        underrunCount: this.underrunCount,
        underrunDurationMs: this.underrunDurationMs,
        platformInterruptionCount: this.platformInterruptionCount,
        outcome: 'success'
      });
    }
    if (hadTimeline && context.state !== 'running' && this.state !== 'paused') {
      if (!this.platformInterruptionActive) {
        this.platformInterruptionActive = true;
        this.platformInterruptionCount += 1;
        recordTtsDiagnostic({
          phase: 'playback',
          platformInterruptionCount: this.platformInterruptionCount,
          scheduledAheadSeconds: Math.max(0, expectedAt - context.currentTime),
          outcome: 'failure'
        });
      }
    } else if (context.state === 'running') {
      this.platformInterruptionActive = false;
    }
    if (
      hadTimeline &&
      context.state === 'running' &&
      lateBy > PlaybackController.UNDERRUN_TOLERANCE_SECONDS
    ) {
      this.underrunCount += 1;
      this.underrunDurationMs += lateBy * 1000;
      if (prepared.productionFactor < PlaybackController.SUSTAINABLE_PRODUCTION_FACTOR) {
        this.slowUnderrunEvidence += 1;
      }
      recordTtsDiagnostic({
        phase: 'playback',
        underrunCount: this.underrunCount,
        underrunDurationMs: this.underrunDurationMs,
        scheduledAheadSeconds: 0,
        realtimeFactor: prepared.productionFactor,
        outcome: 'failure'
      });
      if (
        this.underrunCount >= PlaybackController.DEVICE_TOO_SLOW_UNDERRUNS &&
        this.slowUnderrunEvidence >= PlaybackController.DEVICE_TOO_SLOW_UNDERRUNS
      ) {
        if (!this.fallbackAttempted) throw new RuntimeFallbackRequired();
        throw new DeviceTooSlow();
      }
    }

    let samples: Float32Array<ArrayBuffer>;
    if (prepared.audio.buffer instanceof ArrayBuffer) {
      samples = prepared.audio as Float32Array<ArrayBuffer>;
    } else {
      samples = new Float32Array(prepared.audio.length);
      samples.set(prepared.audio);
    }
    const buffer = context.createBuffer(1, samples.length, prepared.sampleRate);
    buffer.copyToChannel(samples, 0);

    const startAt = Math.max(context.currentTime, expectedAt);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ensureSink().node);
    source.start(startAt);
    const endAt = startAt + buffer.duration;
    const words = scheduledWords(prepared);
    this.scheduled.push({
      chunk: prepared.chunk,
      buffer,
      pcmBytes: samples.byteLength,
      words,
      startAt,
      endAt,
      source
    });
    if (this.firstSpeechAt === null) {
      this.firstSpeechAt = startAt + (words[0]?.start ?? prepared.speechStart ?? 0);
    }
    this.nextStartAt = endAt;
    this.reportScheduledUsage();
    if (generation === this.generation) this.observeLowWater();
  }

  private observeLowWater(): void {
    if (!this.context || !this.playbackStarted) return;
    const ahead = Math.max(0, this.nextStartAt - this.context.currentTime);
    this.notifyBuffer(ahead);
    this.lowWaterSeconds = Math.min(this.lowWaterSeconds, ahead);
    recordTtsDiagnostic({
      phase: 'playback',
      scheduledAheadSeconds: ahead,
      bufferLowWaterSeconds: this.lowWaterSeconds,
      underrunCount: this.underrunCount,
      underrunDurationMs: this.underrunDurationMs,
      platformInterruptionCount: this.platformInterruptionCount,
      outcome: 'success'
    });
  }

  private waitUntil(when: number, generation: number): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (generation !== this.generation || !this.context) return resolve();
        const remaining = when - this.context.currentTime;
        if (remaining <= 0) return resolve();
        setTimeout(check, Math.min(200, Math.max(20, remaining * 1000)));
      };
      check();
    });
  }

  private startWordClock(generation: number): void {
    this.stopWordClock();
    let lastWord = -2;
    const tick = () => {
      if (generation !== this.generation || !this.context) return;
      const now = this.context.currentTime;
      if (this.context.state === 'running') this.platformInterruptionActive = false;
      if (
        !this.firstSpeechRecorded &&
        this.firstSpeechAt !== null &&
        this.tapStartedAt !== null &&
        this.context.state === 'running' &&
        now >= this.firstSpeechAt
      ) {
        this.firstSpeechRecorded = true;
        recordTapToFirstSpeech(Math.max(0, performance.now() - this.tapStartedAt));
      }
      const scheduledAhead = Math.max(0, this.nextStartAt - now);
      this.notifyBuffer(scheduledAhead);
      if (
        scheduledAhead <= PlaybackController.UNDERRUN_TOLERANCE_SECONDS &&
        this.passageIncomplete &&
        this.requiredSynthesisGeneration === generation &&
        this.context.state === 'running' &&
        this.state === 'playing'
      ) {
        this.setState('rebuffering');
      }
      for (const entry of this.scheduled) {
        if (now < entry.startAt) continue;
        this.reportAudibleSegments(entry, Math.min(entry.buffer.duration, now - entry.startAt));
      }

      const active = this.scheduled.find((entry) => now >= entry.startAt && now < entry.endAt);
      if (active) {
        const globalWord = activeGlobalWord(active.words, now - active.startAt);
        if (globalWord !== null && globalWord !== lastWord) {
          lastWord = globalWord;
          this.callbacks.onWord?.(globalWord);
        }
      }
      const retained = this.scheduled.filter((entry) => {
        if (entry.endAt > now) return true;
        entry.source.disconnect();
        return false;
      });
      if (retained.length !== this.scheduled.length) {
        this.scheduled = retained;
        this.reportScheduledUsage();
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private reportAudibleSegments(entry: ScheduledChunk, elapsed: number): void {
    let wordCursor = 0;
    for (const segment of entry.chunk.segments) {
      const firstWord = entry.words[wordCursor];
      const audibleAt = firstWord?.start ?? 0;
      if (elapsed >= audibleAt && !this.reportedSentences.has(segment.sentenceIndex)) {
        this.reportedSentences.add(segment.sentenceIndex);
        this.callbacks.onSentence?.(segment.sentenceIndex, this.totalSentences);
      }
      wordCursor += segment.wordCount;
    }
  }

  private stopWordClock(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  private notifyBuffer(ahead: number): void {
    const band = ahead <= PREFETCH_LOW_WATER_SECONDS ? 'low' : ahead > PREFETCH_HIGH_WATER_SECONDS ? 'high' : 'middle';
    if (band === this.bufferBand) return;
    this.bufferBand = band;
    this.callbacks.onBufferChange?.(ahead);
  }

  async pause(): Promise<void> {
    if ((this.state !== 'playing' && this.state !== 'rebuffering') || !this.context) return;
    this.pausedFrom = this.state;
    await this.context.suspend();
    this.sink?.pause();
    this.stopWordClock();
    this.platformInterruptionActive = false;
    this.setState('paused');
  }

  async resume(): Promise<void> {
    if (this.state !== 'paused' || !this.context) return;
    await this.context.resume();
    this.sink?.resume();
    this.setState(this.pausedFrom);
    this.startWordClock(this.generation);
  }

  stop(): void {
    this.generation += 1;
    this.coordinator.cancelScope('foreground');
    this.stopSources();
    this.stopWordClock();
    if (this.context?.state === 'suspended') void this.context.resume();
    this.sink?.pause();
    this.activeRequestKey = null;
    this.callbacks.onWord?.(-1);
    this.resetMetrics();
    this.setState('idle');
  }

  private finish(generation: number): void {
    if (generation !== this.generation) return;
    for (const entry of this.scheduled) this.reportAudibleSegments(entry, entry.buffer.duration);
    this.stopWordClock();
    this.releaseScheduledSources(false);
    this.activeRequestKey = null;
    this.setState('idle');
    this.callbacks.onWord?.(-1);
    this.callbacks.onEnd?.();
  }

  private fail(error: Error, state: PlaybackState): void {
    this.coordinator.cancelScope('foreground');
    this.coordinator.clearPrepared('current');
    this.stopSources();
    this.stopWordClock();
    this.sink?.pause();
    this.activeRequestKey = null;
    this.callbacks.onWord?.(-1);
    this.setState(state);
    this.callbacks.onError?.(error.message || 'Playback failed');
  }

  private stopSources(): void {
    this.releaseScheduledSources(true);
  }

  private releaseScheduledSources(stop: boolean): void {
    for (const entry of this.scheduled) {
      if (stop) {
        try {
          entry.source.stop();
        } catch {
          // Source may already have ended.
        }
      }
      entry.source.disconnect();
    }
    this.scheduled = [];
    this.nextStartAt = 0;
    this.reportScheduledUsage();
  }

  private reportScheduledUsage(): void {
    this.coordinator.setScheduledUsage?.({
      seconds: this.scheduled.reduce((total, entry) => total + entry.buffer.duration, 0),
      bytes: this.scheduled.reduce((total, entry) => total + entry.pcmBytes, 0)
    });
  }

  private resetMetrics(preserveFallbackAttempt = false): void {
    const fallbackAttempted = this.fallbackAttempted;
    const tapStartedAt = this.tapStartedAt;
    this.nextStartAt = 0;
    this.scheduled = [];
    this.reportedSentences.clear();
    this.totalSentences = 0;
    this.playbackStarted = false;
    this.lowWaterSeconds = Number.POSITIVE_INFINITY;
    this.underrunCount = 0;
    this.underrunDurationMs = 0;
    this.slowUnderrunEvidence = 0;
    this.platformInterruptionCount = 0;
    this.platformInterruptionActive = false;
    this.bufferBand = null;
    this.passageIncomplete = false;
    this.requiredSynthesisGeneration = null;
    this.pausedFrom = 'playing';
    this.fallbackAttempted = preserveFallbackAttempt ? fallbackAttempted : false;
    this.tapStartedAt = preserveFallbackAttempt ? tapStartedAt : null;
    this.firstSpeechAt = null;
    this.firstSpeechRecorded = false;
  }
}

function playbackPhase(label: string): PlaybackModelPhase {
  if (label === 'provider-fallback') return 'provider-fallback';
  if (label === 'warmup') return 'warmup';
  if (label === 'duration_predictor' || label === 'text_encoder' || label === 'vector_estimator' || label === 'vocoder') {
    return 'compile';
  }
  return 'download';
}

function recordTapToFirstSpeech(durationMs: number): void {
  recordTtsDiagnostic({ phase: 'playback', tapToFirstSpeechMs: durationMs, outcome: 'success' });
}

function scheduledWords(prepared: PreparedSynthesisChunk): ScheduledWord[] {
  const scheduled: ScheduledWord[] = [];
  let wordCursor = 0;
  for (const segment of prepared.chunk.segments) {
    for (let localIndex = 0; localIndex < segment.wordCount; localIndex += 1) {
      const word = prepared.words[wordCursor + localIndex];
      if (word) scheduled.push({ ...word, globalIndex: segment.wordOffset + localIndex });
    }
    wordCursor += segment.wordCount;
  }
  return scheduled;
}

function activeGlobalWord(words: ScheduledWord[], elapsed: number): number | null {
  for (const word of words) {
    if (elapsed >= word.start && elapsed < word.end) return word.globalIndex;
  }
  return null;
}

function anonymousIdentity(
  text: string,
  voiceId: string,
  startWordOffset: number,
  speed: number,
  runtime: NonNullable<ReturnType<typeof supertonicEngine.getRuntimeInfo>>
): PassageSynthesisIdentity {
  return {
    translation: '__anonymous__',
    book: '__selection__',
    chapter: 0,
    sourceTextVersion: 'inline-v1',
    sourceText: text,
    startingVerse: 0,
    startWordOffset,
    voiceId,
    speed,
    steps: runtime.steps,
    provider: runtime.provider,
    modelVersion: runtime.modelVersion,
    runtimeVersion: runtime.ortVersion
  };
}

function completeIdentity(
  input: PassageIdentityInput,
  runtime: NonNullable<ReturnType<typeof supertonicEngine.getRuntimeInfo>>
): PassageSynthesisIdentity {
  return {
    ...input,
    provider: runtime.provider,
    steps: runtime.steps,
    modelVersion: runtime.modelVersion,
    runtimeVersion: runtime.ortVersion
  };
}

function validateIdentityArguments(
  identity: PassageSynthesisIdentity,
  text: string,
  voiceId: string,
  startWordOffset: number,
  speed: number
): void {
  if (
    identity.sourceText !== text ||
    identity.startWordOffset !== startWordOffset ||
    identity.voiceId !== voiceId ||
    identity.speed !== speed
  ) {
    throw new Error('Playback arguments do not match the supplied passage identity');
  }
}

export const playbackController = new PlaybackController();
