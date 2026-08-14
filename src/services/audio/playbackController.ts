import { supertonicEngine, EngineCancelled } from '../tts/supertonicEngine';
import { splitSentences } from '../tts/wordTiming';
import { EngineTier, WordTimestamp } from '../tts/types';
import { findVoice } from '../tts/voices';
import { estimateDuration, isWebSpeechAvailable, speakWithWebSpeech, SpokenHandle } from '../tts/webSpeechFallback';

/**
 * Owns audio playback for a passage.
 *
 * Shaped by defects that actually shipped:
 *  - Auto-advance ran off a setTimeout holding a stale closure, so it replayed
 *    the previous chapter. Advance is now a callback the caller drives.
 *  - Pause called speechSynthesis.cancel(), discarding position. Pause now
 *    suspends the AudioContext; resume continues from the same offset.
 *  - Play awaited a network fetch before speaking, severing the iOS user
 *    gesture. The AudioContext is created and unlocked synchronously in
 *    `start`, before any await.
 *  - Stopping abandoned in-flight inference without cancelling it, so the
 *    worker kept running chains nobody awaited. Stop now cancels by generation.
 *
 * Narration starts on the Web Speech tier while the ~383 MB Supertonic bundle
 * downloads, then upgrades. Synthesis is slower than realtime on WASM, so
 * sentences are produced one ahead of playback.
 */

export type PlaybackState = 'idle' | 'preparing' | 'playing' | 'paused';

export interface PlaybackCallbacks {
  onWord?: (globalWordIndex: number) => void;
  onStateChange?: (state: PlaybackState) => void;
  onTier?: (tier: EngineTier) => void;
  onModelProgress?: (fraction: number | null) => void;
  onSentence?: (index: number, total: number) => void;
  onEnd?: () => void;
  onError?: (message: string) => void;
}

interface Chunk {
  text: string;
  wordOffset: number;
  buffer: AudioBuffer;
  words: WordTimestamp[];
}

export class PlaybackController {
  private context: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private state: PlaybackState = 'idle';
  private callbacks: PlaybackCallbacks = {};

  private sentences: string[] = [];
  private wordOffsets: number[] = [];
  private voiceId = '';
  private cursor = 0;
  private prefetch: Promise<Chunk | null> | null = null;
  private spoken: SpokenHandle | null = null;

  private chunkStartedAt = 0;
  private offsetWithinChunk = 0;
  private current: Chunk | null = null;
  private rafId: number | null = null;
  private generation = 0;

  getState(): PlaybackState {
    return this.state;
  }

  private setState(next: PlaybackState): void {
    if (this.state === next) return;
    this.state = next;
    this.callbacks.onStateChange?.(next);
  }

  /**
   * Must be called directly inside a user gesture — it creates and resumes the
   * AudioContext before awaiting anything, which is what iOS requires.
   */
  start(text: string, voiceId: string, callbacks: PlaybackCallbacks = {}, startWordOffset = 0): void {
    this.stop();
    this.generation += 1;
    const generation = this.generation;

    this.callbacks = callbacks;
    this.voiceId = voiceId;

    // Synchronous, pre-await: keeps the gesture chain intact.
    const context = this.ensureContext();
    void context.resume();

    this.sentences = splitSentences(text);
    this.wordOffsets = [];
    let running = startWordOffset;
    for (const sentence of this.sentences) {
      this.wordOffsets.push(running);
      running += sentence.trim().split(/\s+/).filter(Boolean).length;
    }

    this.cursor = 0;
    this.setState('preparing');

    void this.run(generation);
  }

  private ensureContext(): AudioContext {
    if (!this.context || this.context.state === 'closed') {
      this.context = new AudioContext();
    }
    return this.context;
  }

  private async synthesize(index: number, generation: number): Promise<Chunk | null> {
    if (index >= this.sentences.length) return null;
    const context = this.ensureContext();
    const result = await supertonicEngine.synthesizeSentence(this.sentences[index], this.voiceId);
    if (generation !== this.generation) return null;
    if (result.audio.length === 0) return null;

    // ONNX output may be backed by a SharedArrayBuffer when threaded WASM is
    // active, which copyToChannel will not accept. Copy into a plain buffer.
    const samples = new Float32Array(result.audio.length);
    samples.set(result.audio);

    const buffer = context.createBuffer(1, samples.length, result.sampleRate);
    buffer.copyToChannel(samples, 0);
    return {
      text: this.sentences[index],
      wordOffset: this.wordOffsets[index],
      buffer,
      words: result.words
    };
  }

  private async run(generation: number): Promise<void> {
    try {
      // R22 / KTD6: speak now on the platform voice rather than leaving the
      // reader in silence for the length of a 383 MB download.
      if (!supertonicEngine.isReady()) {
        void supertonicEngine
          .load((p) => {
            if (generation === this.generation) this.callbacks.onModelProgress?.(p.loaded / p.total);
          })
          .then(() => {
            if (generation === this.generation) this.callbacks.onModelProgress?.(null);
          })
          .catch(() => {
            if (generation === this.generation) this.callbacks.onModelProgress?.(null);
          });

        if (isWebSpeechAvailable()) {
          await this.runInterim(generation);
          return;
        }
        // No interim tier available: wait for the real engine.
        await supertonicEngine.load();
      }

      if (generation !== this.generation) return;
      this.callbacks.onTier?.('supertonic');

      while (this.cursor < this.sentences.length) {
        const chunk = this.prefetch ? await this.prefetch : await this.synthesize(this.cursor, generation);
        this.prefetch = null;
        if (generation !== this.generation) return;
        if (!chunk) {
          this.cursor += 1;
          continue;
        }

        const next = this.cursor + 1;
        this.prefetch = next < this.sentences.length ? this.synthesize(next, generation) : null;

        await this.playChunk(chunk, generation);
        if (generation !== this.generation) return;
        this.cursor += 1;
      }

      this.finish(generation);
    } catch (err) {
      if (generation !== this.generation || err instanceof EngineCancelled) return;
      this.setState('idle');
      this.callbacks.onError?.((err as Error)?.message ?? 'Playback failed');
    }
  }

  /**
   * Interim narration. Highlighting is verse-coarse and timing is estimated;
   * the UI labels the tier rather than implying parity with Supertonic.
   */
  private async runInterim(generation: number): Promise<void> {
    this.callbacks.onTier?.('web-speech');
    const voice = findVoice(this.voiceId);

    while (this.cursor < this.sentences.length) {
      if (generation !== this.generation) return;

      // Upgrade at the next sentence boundary once the real engine is ready.
      if (supertonicEngine.isReady()) {
        this.callbacks.onTier?.('supertonic');
        return this.run(generation);
      }

      const sentence = this.sentences[this.cursor];
      const offset = this.wordOffsets[this.cursor];
      this.setState('playing');
      this.callbacks.onSentence?.(this.cursor, this.sentences.length);

      const { done, handle } = speakWithWebSpeech(
        sentence,
        voice,
        (wordIndex) => {
          if (generation === this.generation) this.callbacks.onWord?.(offset + wordIndex);
        },
        estimateDuration(sentence)
      );
      this.spoken = handle;
      await done;
      this.spoken = null;

      if (generation !== this.generation) return;
      this.cursor += 1;
    }

    this.finish(generation);
  }

  private finish(generation: number): void {
    if (generation !== this.generation) return;
    this.setState('idle');
    this.callbacks.onWord?.(-1);
    this.callbacks.onEnd?.();
  }

  private playChunk(chunk: Chunk, generation: number): Promise<void> {
    return new Promise((resolve) => {
      const context = this.ensureContext();
      this.current = chunk;
      this.offsetWithinChunk = 0;

      const source = context.createBufferSource();
      source.buffer = chunk.buffer;
      source.connect(context.destination);
      source.onended = () => {
        if (generation !== this.generation) return;
        if (this.source === source) this.source = null;
        this.stopWordClock();
        resolve();
      };

      this.source = source;
      this.chunkStartedAt = context.currentTime;
      source.start();

      this.setState('playing');
      this.callbacks.onSentence?.(this.cursor, this.sentences.length);
      this.startWordClock(generation);
    });
  }

  private startWordClock(generation: number): void {
    this.stopWordClock();
    let lastIndex = -2;

    const tick = () => {
      if (generation !== this.generation || !this.current || !this.context) return;
      const elapsed = this.context.currentTime - this.chunkStartedAt + this.offsetWithinChunk;

      let active = -1;
      for (let i = 0; i < this.current.words.length; i += 1) {
        if (elapsed >= this.current.words[i].start && elapsed < this.current.words[i].end) {
          active = i;
          break;
        }
      }

      if (active !== -1) {
        const globalIndex = this.current.wordOffset + active;
        if (globalIndex !== lastIndex) {
          lastIndex = globalIndex;
          this.callbacks.onWord?.(globalIndex);
        }
      }
      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  private stopWordClock(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /** Suspends without losing position. */
  async pause(): Promise<void> {
    if (this.state !== 'playing' || !this.context) return;
    this.offsetWithinChunk += this.context.currentTime - this.chunkStartedAt;
    await this.context.suspend();
    this.stopWordClock();
    this.setState('paused');
  }

  async resume(): Promise<void> {
    if (this.state !== 'paused' || !this.context) return;
    await this.context.resume();
    this.chunkStartedAt = this.context.currentTime;
    this.setState('playing');
    this.startWordClock(this.generation);
  }

  stop(): void {
    this.generation += 1;
    this.stopWordClock();

    // Tell the worker to abandon queued and in-flight chains. Dropping the
    // promise reference alone left them running on shared sessions.
    supertonicEngine.cancelInFlight();

    this.spoken?.cancel();
    this.spoken = null;

    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        /* already stopped */
      }
      this.source = null;
    }

    if (this.context && this.context.state === 'suspended') void this.context.resume();

    this.current = null;
    this.prefetch = null;
    this.cursor = 0;
    this.offsetWithinChunk = 0;
    this.setState('idle');
  }
}

export const playbackController = new PlaybackController();
