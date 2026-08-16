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
  cancelInFlight?(): number;
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
  value: PreparedSynthesisChunk;
}

export interface PcmUsage {
  seconds: number;
  bytes: number;
}

export interface PcmUsageSnapshot {
  prepared: PcmUsage;
  inFlight: PcmUsage;
  scheduled: PcmUsage;
  total: PcmUsage;
  peak: PcmUsage;
  limits: { maxSeconds: number; maxBytes: number };
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
  private inFlightUsage: PcmUsage = emptyUsage();
  private scheduledUsage: PcmUsage = emptyUsage();
  private peakUsage: PcmUsage = emptyUsage();
  private readonly capacityWaiters = new Set<() => void>();
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
    const passageKey = serializeIdentity(request.identity);
    const key = `${passageKey}\u0000${request.chunk.sourceStart}\u0000${request.chunk.sourceEnd}\u0000${request.chunk.text}`;
    const cached = [...this.cache.entries()].find(([, entry]) => entry.key === key);
    if (cached) {
      const [cachedSlot, cachedEntry] = cached;
      this.recordPreparation(request, 'cache-hit');
      if (request.priority === 'foreground') {
        this.selectForeground(passageKey, key);
        if (cachedSlot === 'next') {
          this.cache.delete('next');
          this.cache.set('current', cachedEntry);
        }
      }
      this.refreshUsage();
      return Promise.resolve(cachedEntry.value);
    }

    // Adoption happens before cancellation so foreground Play can reuse an
    // identical speculative first chunk already queued or running.
    const existing = this.tasks.get(key);
    if (existing) {
      this.recordPreparation(request, 'in-flight-adoption');
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
    this.cancelTasks((task) => task.request.priority === scope);
  }

  clearPrepared(slot?: PreparationSlot): void {
    if (slot) this.cache.delete(slot);
    else this.cache.clear();
    this.refreshUsage();
    this.notifyCapacityWaiters();
  }

  getPreparedUsage(): { entries: number; seconds: number; bytes: number } {
    const values = [...this.cache.values()];
    return {
      entries: values.length,
      seconds: values.reduce((sum, entry) => sum + entry.value.duration, 0),
      bytes: values.reduce((sum, entry) => sum + entry.value.audio.byteLength, 0)
    };
  }

  setScheduledUsage(usage: PcmUsage): void {
    this.scheduledUsage = sanitizeUsage(usage);
    this.enforcePcmBudget();
    this.refreshUsage();
    this.notifyCapacityWaiters();
  }

  getPcmUsage(): PcmUsageSnapshot {
    const prepared = this.preparedUsage();
    const total = addUsage(prepared, this.inFlightUsage, this.scheduledUsage);
    return {
      prepared,
      inFlight: { ...this.inFlightUsage },
      scheduled: { ...this.scheduledUsage },
      total,
      peak: { ...this.peakUsage },
      limits: { maxSeconds: MAX_PREPARED_SECONDS, maxBytes: MAX_PREPARED_BYTES }
    };
  }

  private selectForeground(passageKey: string, adoptedKey: string): void {
    this.selectedPassage = passageKey;
    this.cancelTasks((task) => task.key !== adoptedKey && task.passageKey !== passageKey);
  }

  private selectSpeculative(selectedKey: string): void {
    this.cancelTasks((task) => task.key !== selectedKey && task.request.priority === 'speculative');
  }

  private cancelTasks(predicate: (task: Task) => boolean): void {
    const at = this.now();
    let cancelEngine = false;
    for (const task of [...this.tasks.values()]) {
      if (!predicate(task) || task.cancelledAt !== undefined) continue;
      task.cancelledAt = at;
      if (task.state === 'running') {
        this.deleteTask(task);
        cancelEngine = true;
      } else {
        this.finishCancelled(task);
      }
    }
    if (cancelEngine) this.engine.cancelInFlight?.();
    this.notifyCapacityWaiters();
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
          this.deleteTask(task);
          task.resolve(prepared);
        } catch (error) {
          this.inFlightUsage = emptyUsage();
          this.refreshUsage();
          if (task.cancelledAt !== undefined) this.finishCancelled(task);
          else {
            this.deleteTask(task);
            task.reject(error as Error);
          }
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
    const admission = this.beginPcmAdmission(task);
    if (admission) await admission;
    const result = await this.engine.synthesizeSentence(
      request.chunk.text,
      request.identity.voiceId,
      request.identity.steps,
      undefined,
      request.identity.speed
    );
    // A worker response can race with its cancellation message. Discard stale
    // PCM before it participates in accounting or evicts still-valid cache.
    this.assertTaskLive(task);
    this.inFlightUsage = { seconds: result.duration, bytes: result.audio.byteLength };
    this.enforcePcmBudget();
    this.refreshUsage();
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
      chunkKind: request.chunk.kind,
      chunkChars: request.chunk.text.length,
      preparationOutcome: 'synthesized',
      preparedBytes: this.preparedUsage().bytes,
      inFlightBytes: this.inFlightUsage.bytes,
      scheduledBytes: this.scheduledUsage.bytes,
      totalPcmBytes: this.getPcmUsage().total.bytes,
      outcome: 'success'
    });
    const prepared = {
      ...result,
      words,
      chunk: request.chunk,
      synthesisMs,
      timingPredictionMs,
      productionFactor
    };
    this.inFlightUsage = emptyUsage();
    this.refreshUsage();
    return prepared;
  }

  private finishCancelled(task: Task): void {
    this.deleteTask(task);
    task.reject(this.cancellationError(task));
  }

  private deleteTask(task: Task): void {
    if (this.tasks.get(task.key) === task) this.tasks.delete(task.key);
  }

  private assertTaskLive(task: Task): void {
    if (task.cancelledAt !== undefined) throw this.cancellationError(task);
  }

  private cancellationError(task: Task): PreparationCancelled {
    return new PreparationCancelled(Math.max(0, this.now() - (task.cancelledAt ?? this.now())));
  }

  private retain(key: string, slot: PreparationSlot, value: PreparedSynthesisChunk): void {
    this.cache.set(slot, { key, value });
    this.enforcePcmBudget();
    this.refreshUsage();
    this.notifyCapacityWaiters();
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

  private preparedUsage(): PcmUsage {
    const usage = this.getPreparedUsage();
    return { seconds: usage.seconds, bytes: usage.bytes };
  }

  private enforcePcmBudget(): void {
    let usage = addUsage(this.preparedUsage(), this.inFlightUsage, this.scheduledUsage);
    if (withinBudget(usage)) return;
    this.cache.delete('next');
    usage = addUsage(this.preparedUsage(), this.inFlightUsage, this.scheduledUsage);
    if (!withinBudget(usage)) this.cache.delete('current');
  }

  private beginPcmAdmission(task: Task): Promise<void> | undefined {
    // Preserve the zero-extra-pass cold-start path. With no scheduled PCM,
    // the request owns the entire budget until its actual result is known.
    const prepared = this.preparedUsage();
    if (
      this.scheduledUsage.seconds === 0 &&
      this.scheduledUsage.bytes === 0 &&
      prepared.seconds === 0 &&
      prepared.bytes === 0
    ) {
      const reservation = { seconds: MAX_PREPARED_SECONDS, bytes: MAX_PREPARED_BYTES };
      this.evictForReservation(reservation);
      this.inFlightUsage = reservation;
      this.refreshUsage();
      return undefined;
    }
    return this.awaitPredictedPcmAdmission(task);
  }

  private async awaitPredictedPcmAdmission(task: Task): Promise<void> {
    const request = task.request;
    const predicted = await this.engine.predictDuration(
      request.chunk.text,
      request.identity.voiceId,
      undefined,
      request.identity.speed
    );
    const seconds = Math.min(MAX_PREPARED_SECONDS, Math.max(0, predicted) * 1.25 + 2);
    const reservation = {
      seconds,
      bytes: Math.min(MAX_PREPARED_BYTES, Math.ceil(seconds * 44_100 * Float32Array.BYTES_PER_ELEMENT))
    };
    this.assertTaskLive(task);
    while (true) {
      this.evictForReservation(reservation);
      if (withinBudget(addUsage(this.preparedUsage(), this.scheduledUsage, reservation))) {
        this.inFlightUsage = reservation;
        this.refreshUsage();
        return;
      }
      await new Promise<void>((resolve) => this.capacityWaiters.add(resolve));
      this.assertTaskLive(task);
    }
  }

  private evictForReservation(reservation: PcmUsage): void {
    let usage = addUsage(this.preparedUsage(), this.scheduledUsage, reservation);
    if (withinBudget(usage)) return;
    this.cache.delete('next');
    usage = addUsage(this.preparedUsage(), this.scheduledUsage, reservation);
    if (!withinBudget(usage)) this.cache.delete('current');
    this.refreshUsage();
  }

  private notifyCapacityWaiters(): void {
    const waiters = [...this.capacityWaiters];
    this.capacityWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  private refreshUsage(): void {
    const usage = this.getPcmUsage();
    this.peakUsage = {
      seconds: Math.max(this.peakUsage.seconds, usage.total.seconds),
      bytes: Math.max(this.peakUsage.bytes, usage.total.bytes)
    };
    recordTtsDiagnostic({
      phase: 'memory',
      preparedBytes: usage.prepared.bytes,
      inFlightBytes: usage.inFlight.bytes,
      scheduledBytes: usage.scheduled.bytes,
      totalPcmBytes: usage.total.bytes,
      outcome: 'success'
    });
  }

  private recordPreparation(
    request: SynthesisPreparationRequest,
    preparationOutcome: 'cache-hit' | 'in-flight-adoption'
  ): void {
    recordTtsDiagnostic({
      phase: 'chunk',
      chunkKind: request.chunk.kind,
      chunkChars: request.chunk.text.length,
      preparationOutcome,
      preparedBytes: this.preparedUsage().bytes,
      inFlightBytes: this.inFlightUsage.bytes,
      scheduledBytes: this.scheduledUsage.bytes,
      totalPcmBytes: this.getPcmUsage().total.bytes,
      outcome: 'success'
    });
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

function serializeIdentity(identity: PassageSynthesisIdentity): string {
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

function emptyUsage(): PcmUsage {
  return { seconds: 0, bytes: 0 };
}

function sanitizeUsage(usage: PcmUsage): PcmUsage {
  return {
    seconds: Number.isFinite(usage.seconds) ? Math.max(0, usage.seconds) : 0,
    bytes: Number.isFinite(usage.bytes) ? Math.max(0, usage.bytes) : 0
  };
}

function addUsage(...values: PcmUsage[]): PcmUsage {
  return values.reduce(
    (total, value) => ({ seconds: total.seconds + value.seconds, bytes: total.bytes + value.bytes }),
    emptyUsage()
  );
}

function withinBudget(usage: PcmUsage): boolean {
  return usage.seconds <= MAX_PREPARED_SECONDS && usage.bytes <= MAX_PREPARED_BYTES;
}

export const synthesisCoordinator = new SynthesisCoordinator();
