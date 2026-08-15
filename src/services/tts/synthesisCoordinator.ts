import { supertonicEngine, type SupertonicEngine } from './supertonicEngine';
import type {
  PassageSynthesisIdentity,
  PlannedSynthesisChunk,
  PreparedSynthesisChunk,
  SynthesisResult,
  WordTimestamp
} from './types';
import { interpolateWordTimings } from './wordTiming';
import { recordTtsDiagnostic } from './diagnostics';

export type SynthesisPriority = 'foreground' | 'speculative';
export type PreparationSlot = 'current' | 'next';

export interface SynthesisPreparationRequest {
  identity: PassageSynthesisIdentity;
  chunk: PlannedSynthesisChunk;
  priority: SynthesisPriority;
  slot?: PreparationSlot;
}

interface EnginePort {
  getRuntimeInfo(): ReturnType<SupertonicEngine['getRuntimeInfo']>;
  synthesizeSentence(
    text: string,
    voiceId?: string,
    steps?: number,
    generation?: number,
    speed?: number
  ): Promise<SynthesisResult>;
  predictDuration(text: string, voiceId?: string, generation?: number, speed?: number): Promise<number>;
}

interface Task {
  key: string;
  passageKey: string;
  sequence: number;
  request: SynthesisPreparationRequest;
  state: 'queued' | 'running';
  cancelledAt?: number;
  resolve: (value: PreparedSynthesisChunk) => void;
  reject: (reason: Error) => void;
  promise: Promise<PreparedSynthesisChunk>;
}

interface CacheEntry {
  key: string;
  slot: PreparationSlot;
  value: PreparedSynthesisChunk;
}

export class PreparationCancelled extends Error {
  constructor(public readonly latencyMs: number) {
    super('Synthesis preparation cancelled');
    this.name = 'PreparationCancelled';
  }
}

const MAX_PREPARED_SECONDS = 30;
const MAX_PREPARED_BYTES = Math.floor(5.3 * 1024 * 1024);

/** Serial priority queue and bounded first-chunk cache in front of the ONNX engine. */
export class SynthesisCoordinator {
  private readonly tasks = new Map<string, Task>();
  private readonly cache = new Map<PreparationSlot, CacheEntry>();
  private running = false;
  private sequence = 0;
  private selectedPassage: string | null = null;

  constructor(
    private readonly engine: EnginePort = supertonicEngine,
    private readonly now: () => number = () => performance.now()
  ) {}

  prepare(request: SynthesisPreparationRequest): Promise<PreparedSynthesisChunk> {
    if (request.priority === 'speculative' && request.chunk.kind !== 'startup') {
      return Promise.reject(new Error('Speculative synthesis is bounded to a passage first chunk'));
    }
    this.assertRuntimeIdentity(request.identity);
    const passageKey = identityKey(request.identity);
    const key = `${passageKey}\u0000${request.chunk.sourceStart}\u0000${request.chunk.sourceEnd}\u0000${request.chunk.text}`;
    const cached = [...this.cache.values()].find((entry) => entry.key === key);
    if (cached) {
      if (request.priority === 'foreground') {
        this.selectForeground(passageKey, key);
        if (cached.slot === 'next') {
          this.cache.delete('next');
          this.cache.set('current', { ...cached, slot: 'current' });
        }
      }
      return Promise.resolve(cached.value);
    }

    // Adoption happens before cancellation so foreground Play can reuse an
    // identical speculative first chunk already queued or running.
    const existing = this.tasks.get(key);
    if (existing) {
      if (request.priority === 'foreground') {
        existing.request.priority = 'foreground';
        existing.request.slot = request.slot ?? 'current';
        existing.cancelledAt = undefined;
        this.selectForeground(passageKey, key);
      }
      return existing.promise;
    }

    if (request.priority === 'foreground') this.selectForeground(passageKey, key);
    else this.selectSpeculative(key);
    let resolve!: Task['resolve'];
    let reject!: Task['reject'];
    const promise = new Promise<PreparedSynthesisChunk>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const task: Task = {
      key,
      passageKey,
      sequence: this.sequence++,
      request: { ...request },
      state: 'queued',
      resolve,
      reject,
      promise
    };
    this.tasks.set(key, task);
    void this.pump();
    return promise;
  }

  cancelScope(scope: SynthesisPriority): void {
    const at = this.now();
    for (const task of this.tasks.values()) {
      if (task.request.priority === scope && task.cancelledAt === undefined) task.cancelledAt = at;
    }
  }

  clearPrepared(slot?: PreparationSlot): void {
    if (slot) this.cache.delete(slot);
    else this.cache.clear();
  }

  getPreparedUsage(): { entries: number; seconds: number; bytes: number } {
    const values = [...this.cache.values()];
    return {
      entries: values.length,
      seconds: values.reduce((sum, entry) => sum + entry.value.duration, 0),
      bytes: values.reduce((sum, entry) => sum + entry.value.audio.byteLength, 0)
    };
  }

  private selectForeground(passageKey: string, adoptedKey: string): void {
    this.selectedPassage = passageKey;
    const at = this.now();
    for (const task of this.tasks.values()) {
      if (task.key !== adoptedKey && task.passageKey !== passageKey && task.cancelledAt === undefined) {
        task.cancelledAt = at;
      }
    }
  }

  private selectSpeculative(selectedKey: string): void {
    const at = this.now();
    for (const task of this.tasks.values()) {
      if (task.key !== selectedKey && task.request.priority === 'speculative' && task.cancelledAt === undefined) {
        task.cancelledAt = at;
      }
    }
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (true) {
        const task = this.nextTask();
        if (!task) break;
        if (task.cancelledAt !== undefined) {
          this.finishCancelled(task);
          continue;
        }
        task.state = 'running';
        const startedAt = this.now();
        try {
          const prepared = await this.execute(task, startedAt);
          if (task.cancelledAt !== undefined || (task.request.priority === 'foreground' && task.passageKey !== this.selectedPassage)) {
            this.finishCancelled(task);
            continue;
          }
          if (task.request.slot && task.request.chunk.kind === 'startup') {
            this.retain(task.key, task.request.slot, prepared);
          }
          this.tasks.delete(task.key);
          task.resolve(prepared);
        } catch (error) {
          this.tasks.delete(task.key);
          task.reject(error as Error);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private nextTask(): Task | undefined {
    return [...this.tasks.values()]
      .filter((task) => task.state === 'queued')
      .sort((a, b) => priorityRank(a.request.priority) - priorityRank(b.request.priority) || a.sequence - b.sequence)[0];
  }

  private async execute(task: Task, startedAt: number): Promise<PreparedSynthesisChunk> {
    const request = task.request;
    const result = await this.engine.synthesizeSentence(
      request.chunk.text,
      request.identity.voiceId,
      request.identity.steps,
      undefined,
      request.identity.speed
    );
    this.assertTaskLive(task);
    const synthesisFinishedAt = this.now();
    let words = result.words;
    let timingPredictionMs = 0;

    if (request.chunk.segments.length > 1) {
      const predictions: number[] = [];
      for (const segment of request.chunk.segments) {
        this.assertTaskLive(task);
        const segmentText = request.chunk.text.slice(segment.textStart, segment.textEnd);
        predictions.push(
          await this.engine.predictDuration(segmentText, request.identity.voiceId, undefined, request.identity.speed)
        );
        this.assertTaskLive(task);
      }
      timingPredictionMs = this.now() - synthesisFinishedAt;
      words = allocateSegmentWords(request.chunk, predictions, result);
    }

    const synthesisMs = this.now() - startedAt;
    const productionFactor = synthesisMs > 0 ? result.duration / (synthesisMs / 1000) : Number.POSITIVE_INFINITY;
    recordTtsDiagnostic({
      phase: 'chunk',
      durationMs: synthesisMs,
      provider: request.identity.provider,
      steps: request.identity.steps,
      modelVersion: request.identity.modelVersion ?? undefined,
      runtimeVersion: request.identity.runtimeVersion,
      audioSeconds: result.duration,
      realtimeFactor: productionFactor,
      outcome: 'success'
    });
    return {
      ...result,
      words,
      chunk: request.chunk,
      synthesisMs,
      timingPredictionMs,
      productionFactor
    };
  }

  private finishCancelled(task: Task): void {
    this.tasks.delete(task.key);
    task.reject(this.cancellationError(task));
  }

  private assertTaskLive(task: Task): void {
    if (task.cancelledAt !== undefined) throw this.cancellationError(task);
  }

  private cancellationError(task: Task): PreparationCancelled {
    return new PreparationCancelled(Math.max(0, this.now() - (task.cancelledAt ?? this.now())));
  }

  private retain(key: string, slot: PreparationSlot, value: PreparedSynthesisChunk): void {
    this.cache.set(slot, { key, slot, value });
    const usage = this.getPreparedUsage();
    if (usage.entries <= 2 && usage.seconds <= MAX_PREPARED_SECONDS && usage.bytes <= MAX_PREPARED_BYTES) return;
    // Speculative next audio is always the first eviction; an oversized current
    // result is returned to the caller but not retained.
    this.cache.delete('next');
    const current = this.getPreparedUsage();
    if (current.seconds > MAX_PREPARED_SECONDS || current.bytes > MAX_PREPARED_BYTES) this.cache.delete('current');
  }

  private assertRuntimeIdentity(identity: PassageSynthesisIdentity): void {
    const active = this.engine.getRuntimeInfo();
    if (!active) throw new Error('Engine not loaded');
    if (
      active.provider !== identity.provider ||
      active.steps !== identity.steps ||
      active.modelVersion !== identity.modelVersion ||
      active.ortVersion !== identity.runtimeVersion
    ) {
      throw new Error('Synthesis identity does not match the active runtime');
    }
  }
}

function allocateSegmentWords(
  chunk: PlannedSynthesisChunk,
  predictions: number[],
  result: SynthesisResult
): WordTimestamp[] {
  const speechStart = result.speechStart ?? result.words[0]?.start ?? 0;
  const lastWord = result.words[result.words.length - 1];
  const speechDuration = result.speechDuration ?? Math.max(0, (lastWord?.end ?? result.duration) - speechStart);
  const total = predictions.reduce((sum, value) => sum + Math.max(0, value), 0);
  const fallback = total > 0 ? predictions : chunk.segments.map((segment) => segment.wordCount);
  const denominator = fallback.reduce((sum, value) => sum + Math.max(0, value), 0) || fallback.length;
  const words: WordTimestamp[] = [];
  let cursor = speechStart;
  for (let index = 0; index < chunk.segments.length; index += 1) {
    const segment = chunk.segments[index];
    const segmentText = chunk.text.slice(segment.textStart, segment.textEnd);
    const end =
      index === chunk.segments.length - 1
        ? speechStart + speechDuration
        : cursor + (Math.max(0, fallback[index]) / denominator) * speechDuration;
    words.push(...interpolateWordTimings(segmentText, Math.max(0, end - cursor), cursor));
    cursor = end;
  }
  return words;
}

function identityKey(identity: PassageSynthesisIdentity): string {
  return JSON.stringify([
    identity.translation,
    identity.book,
    identity.chapter,
    identity.sourceTextVersion,
    identity.sourceText,
    identity.startingVerse,
    identity.startWordOffset,
    identity.voiceId,
    identity.speed,
    identity.steps,
    identity.provider,
    identity.modelVersion,
    identity.runtimeVersion
  ]);
}

function priorityRank(priority: SynthesisPriority): number {
  return priority === 'foreground' ? 0 : 1;
}

export const synthesisCoordinator = new SynthesisCoordinator();
