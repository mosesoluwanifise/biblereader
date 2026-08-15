import { EngineRuntimeInfo, SynthesisResult, WordTimestamp } from './types';
import { DEFAULT_VOICE_ID } from './voices';
import { interpolateWordTimings } from './wordTiming';
import type { WorkerRequest, WorkerResponse } from './synthesis.worker';
import { recordTtsDiagnostic } from './diagnostics';
import {
  clearRuntimeProfile,
  getRuntimeCapabilities,
  makeRuntimeProfile,
  ORT_RUNTIME_VERSION,
  readRuntimeProfile,
  writeRuntimeProfile,
  type RuntimeProfile,
  type RuntimeProvider
} from './runtimeProfile';

export { PRESET_VOICES, findVoice, DEFAULT_VOICE_ID } from './voices';

/**
 * Client for the synthesis worker.
 *
 * All model work happens off the main thread — inference pins the renderer for
 * tens of seconds otherwise, which stops input and freezes the word-highlight
 * animation frames. This class only marshals messages and turns the returned
 * duration into word timings.
 */

const MODEL_BASE = `${import.meta.env.BASE_URL}models/supertonic-3`.replace(/\/{2,}/g, '/');

/**
 * Flow-matching steps.
 *
 * Not a free throughput dial: below 8 the flow has not converged. On one seed,
 * 4 steps peaks at 0.853 where 8 peaks at 0.292 and 16 at 0.308 — 8 and 16
 * agree, 4 overshoots roughly threefold, and that overshoot is audible as
 * artifacts on individual words. Dropping to 4 for speed traded away
 * correctness and was reported as glitchy audio.
 *
 * 8 measures 1.04x realtime on four WASM threads, so it clears playback with
 * cross-origin isolation enabled. 16 buys nothing audible for half the speed.
 */
const DEFAULT_STEPS = 8;

export type EngineStatus = 'idle' | 'loading' | 'ready' | 'failed';

export interface LoadProgress {
  loaded: number;
  total: number;
  label: string;
}

interface Pending {
  resolve: (value: never) => void;
  reject: (reason: Error) => void;
  onProgress?: (p: LoadProgress) => void;
  startedAt: number;
  steps?: number;
  requestType: WorkerRequest['type'];
}

/** Plain Omit collapses a discriminated union into its shared keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Thrown when a synthesis is abandoned; callers should exit quietly. */
export class EngineCancelled extends Error {
  constructor() {
    super('Synthesis cancelled');
    this.name = 'EngineCancelled';
  }
}

export class SupertonicEngine {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private status: EngineStatus = 'idle';
  private loadPromise: Promise<void> | null = null;
  private backend: string | null = null;
  private runtimeSteps = DEFAULT_STEPS;
  private preferredProfile: RuntimeProfile | null = null;
  private version: string | null = null;
  private voiceIds: string[] = [];
  private currentGeneration = 1;
  private progressListeners = new Set<(p: LoadProgress) => void>();
  private lastProgress: LoadProgress | null = null;

  getStatus(): EngineStatus {
    return this.status;
  }

  getBackend(): string | null {
    return this.backend;
  }

  getRuntimeInfo(): EngineRuntimeInfo | null {
    if (!this.backend) return null;
    return {
      provider: this.backend as RuntimeProvider,
      steps: this.runtimeSteps,
      modelVersion: this.version,
      ortVersion: ORT_RUNTIME_VERSION
    };
  }

  getVersion(): string | null {
    return this.version;
  }

  getVoiceIds(): string[] {
    return this.voiceIds;
  }

  isReady(): boolean {
    return this.status === 'ready';
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    const worker = new Worker(new URL('./synthesis.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.handle(event.data);
    worker.onerror = (event) => {
      const error = new Error(event.message || 'Synthesis worker failed');
      this.status = 'failed';
      this.loadPromise = null;
      for (const [, entry] of this.pending) entry.reject(error);
      this.pending.clear();
    };

    this.worker = worker;
    return worker;
  }

  private handle(message: WorkerResponse): void {
    const entry = this.pending.get(message.id);
    if (!entry) return;

    switch (message.type) {
      case 'progress':
        entry.onProgress?.({ loaded: message.loaded, total: message.total, label: message.label });
        break;
      case 'loaded':
        this.backend = message.backend;
        this.version = message.version;
        this.voiceIds = message.voiceIds;
        this.runtimeSteps = message.steps;
        {
          const capabilities = getRuntimeCapabilities();
          const attemptedFirst = this.preferredProfile?.provider ?? (capabilities.webgpu ? 'webgpu' : 'wasm');
          if (attemptedFirst !== message.backend) {
            recordTtsDiagnostic({
              phase: 'provider-fallback',
              provider: message.backend,
              steps: message.steps,
              outcome: 'success'
            });
          }
        }
        recordTtsDiagnostic({
          phase: 'compile',
          durationMs: message.compileMs,
          provider: message.backend,
          steps: message.steps,
          outcome: 'success'
        });
        recordTtsDiagnostic({
          phase: 'warmup',
          durationMs: message.warmupMs,
          provider: message.backend,
          steps: message.steps,
          outcome: 'success'
        });
        recordTtsDiagnostic({
          phase: 'download',
          durationMs: Math.max(0, performance.now() - entry.startedAt - message.compileMs - message.warmupMs),
          provider: message.backend,
          steps: message.steps,
          outcome: 'success'
        });
        if (message.version) {
          const qualityApproved =
            import.meta.env.VITE_SUPERTONIC_FIVE_STEP_QUALITY_APPROVED === message.version;
          const storedSteps = qualityApproved ? 5 : message.steps;
          const stored = makeRuntimeProfile(message.version, message.backend, getRuntimeCapabilities(), storedSteps);
          if (qualityApproved) {
            stored.qualityGate = { steps: 5, approved: true, modelVersion: message.version };
          } else if (message.steps === 5 && this.preferredProfile?.qualityGate) {
            stored.qualityGate = this.preferredProfile.qualityGate;
          }
          writeRuntimeProfile(stored);
        }
        this.status = 'ready';
        this.pending.delete(message.id);
        (entry.resolve as unknown as () => void)();
        break;
      case 'audio':
        this.pending.delete(message.id);
        {
          const durationMs = performance.now() - entry.startedAt;
          const audioSeconds = message.audio.byteLength / Float32Array.BYTES_PER_ELEMENT / message.sampleRate;
          recordTtsDiagnostic({
            phase: 'synthesis',
            durationMs,
            provider: (this.backend as RuntimeProvider | null) ?? undefined,
            steps: entry.steps,
            audioSeconds,
            realtimeFactor: durationMs > 0 ? audioSeconds / (durationMs / 1000) : undefined,
            outcome: 'success'
          });
        }
        (entry.resolve as unknown as (v: WorkerResponse) => void)(message);
        break;
      case 'cancelled':
        this.pending.delete(message.id);
        entry.reject(new EngineCancelled());
        break;
      case 'error':
        this.pending.delete(message.id);
        recordTtsDiagnostic({
          phase: entry.requestType === 'load' ? 'compile' : 'synthesis',
          durationMs: performance.now() - entry.startedAt,
          provider: (this.backend as RuntimeProvider | null) ?? undefined,
          steps: entry.steps,
          outcome: 'failure'
        });
        if (message.providerLost) {
          clearRuntimeProfile();
          this.status = 'failed';
          this.loadPromise = null;
        }
        entry.reject(new Error(message.message));
        break;
    }
  }

  private send<T>(
    request: DistributiveOmit<WorkerRequest, 'id'>,
    onProgress?: (p: LoadProgress) => void
  ): Promise<T> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as never,
        reject,
        onProgress,
        startedAt: performance.now(),
        steps: request.type === 'synthesize' ? request.steps : undefined,
        requestType: request.type
      });
      worker.postMessage({ ...request, id } as WorkerRequest);
    });
  }

  /**
   * Loads the bundle. Concurrent callers share one load.
   *
   * Progress fans out to every caller rather than only the first. The app
   * warms the bundle on idle without asking for progress; when the reader then
   * presses play mid-warm, that second caller joins the same load and must
   * still get a progress bar — otherwise it sits on "Preparing…" in silence
   * for the remainder of a 398 MB fetch. Joiners are replayed the latest
   * reading immediately, so the bar starts where the load actually is instead
   * of at zero.
   */
  async load(onProgress?: (p: LoadProgress) => void): Promise<void> {
    if (this.status === 'ready') return;

    if (onProgress) {
      this.progressListeners.add(onProgress);
      if (this.lastProgress) onProgress(this.lastProgress);
    }
    if (this.loadPromise) return this.loadPromise;

    this.status = 'loading';
    this.preferredProfile = readRuntimeProfile(getRuntimeCapabilities());
    recordTtsDiagnostic({ phase: 'download', outcome: 'start' });
    const publish = (p: LoadProgress) => {
      this.lastProgress = p;
      for (const listener of this.progressListeners) listener(p);
    };

    this.loadPromise = this.send<void>(
      { type: 'load', modelBase: MODEL_BASE, preferredProfile: this.preferredProfile },
      publish
    )
      .catch((err) => {
        recordTtsDiagnostic({
          phase: 'download',
          outcome: 'failure'
        });
        this.status = 'failed';
        this.loadPromise = null;
        throw err;
      })
      .finally(() => {
        this.progressListeners.clear();
        this.lastProgress = null;
      });
    return this.loadPromise;
  }

  /**
   * Synthesizes one sentence. Word timings are interpolated inside the
   * duration the model predicted for this sentence, so the sentence boundary
   * is exact even though interior positions are estimates.
   */
  async synthesizeSentence(
    text: string,
    voiceId: string = DEFAULT_VOICE_ID,
    steps?: number,
    generation: number = this.generation,
    speed?: number
  ): Promise<SynthesisResult> {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return { audio: new Float32Array(0), sampleRate: 44100, duration: 0, words: [] };
    }
    if (!this.isReady()) throw new Error('Engine not loaded');

    const result = await this.send<Extract<WorkerResponse, { type: 'audio' }>>({
      type: 'synthesize',
      text: trimmed,
      voiceId,
      steps: steps ?? this.runtimeSteps,
      generation,
      speed
    });

    const audio = new Float32Array(result.audio);
    const duration = audio.length / result.sampleRate;

    // Spread the words across the speech, not the whole buffer. The model pads
    // each utterance with roughly half a second of silence at either end;
    // interpolating over that put the highlight ahead of the voice at the
    // start of every sentence and behind it by the end. The audio itself is
    // untouched — that padding is the model's phrasing and is worth keeping.
    const speechStart = result.speechStart ?? 0;
    const speechDuration = result.speechDuration || duration;

    return {
      audio,
      sampleRate: result.sampleRate,
      duration,
      words: interpolateWordTimings(trimmed, speechDuration, speechStart)
    };
  }

  /** Current generation; synthesis requests are tagged with it. */
  get generation(): number {
    return this.currentGeneration;
  }

  /**
   * Abandons in-flight and queued synthesis. Without this, stopping playback
   * left the worker executing graph chains nobody was waiting for.
   */
  cancelInFlight(): number {
    this.currentGeneration += 1;
    this.worker?.postMessage({ id: 0, type: 'cancel', generation: this.currentGeneration } as WorkerRequest);
    return this.currentGeneration;
  }

  async dispose(): Promise<void> {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
    this.status = 'idle';
    this.loadPromise = null;
    this.backend = null;
    this.runtimeSteps = DEFAULT_STEPS;
    this.preferredProfile = null;
    this.version = null;
    this.voiceIds = [];
    this.progressListeners.clear();
    this.lastProgress = null;
  }
}

export const supertonicEngine = new SupertonicEngine();
export type { WordTimestamp };
