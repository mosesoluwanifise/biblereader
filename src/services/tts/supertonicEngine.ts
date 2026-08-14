import { SynthesisResult, WordTimestamp } from './types';
import { DEFAULT_VOICE_ID } from './voices';
import { interpolateWordTimings } from './wordTiming';
import type { WorkerRequest, WorkerResponse } from './synthesis.worker';

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
 * Flow-matching steps. Cost is linear, and on one WASM thread with fp32 this
 * is the throughput dial: 2 steps run at 1.79x realtime but clip, 4 at 1.11x
 * clean, 8 at 0.62x. Anything below 1.0x means synthesis loses to playback and
 * the reader stalls before every sentence, so 4 is the slowest setting that
 * still keeps up without a GPU.
 */
const DEFAULT_STEPS = 4;

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
}

/** Plain Omit collapses a discriminated union into its shared keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export class SupertonicEngine {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private status: EngineStatus = 'idle';
  private loadPromise: Promise<void> | null = null;
  private backend: string | null = null;
  private version: string | null = null;
  private voiceIds: string[] = [];

  getStatus(): EngineStatus {
    return this.status;
  }

  getBackend(): string | null {
    return this.backend;
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
        this.status = 'ready';
        this.pending.delete(message.id);
        (entry.resolve as unknown as () => void)();
        break;
      case 'audio':
        this.pending.delete(message.id);
        (entry.resolve as unknown as (v: WorkerResponse) => void)(message);
        break;
      case 'error':
        this.pending.delete(message.id);
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
      this.pending.set(id, { resolve: resolve as never, reject, onProgress });
      worker.postMessage({ ...request, id } as WorkerRequest);
    });
  }

  /** Loads the bundle. Concurrent callers share one load. */
  async load(onProgress?: (p: LoadProgress) => void): Promise<void> {
    if (this.status === 'ready') return;
    if (this.loadPromise) return this.loadPromise;

    this.status = 'loading';
    this.loadPromise = this.send<void>({ type: 'load', modelBase: MODEL_BASE }, onProgress).catch((err) => {
      this.status = 'failed';
      this.loadPromise = null;
      throw err;
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
    steps: number = DEFAULT_STEPS
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
      steps
    });

    const audio = new Float32Array(result.audio);
    const duration = audio.length / result.sampleRate;

    return {
      audio,
      sampleRate: result.sampleRate,
      duration,
      words: interpolateWordTimings(trimmed, duration)
    };
  }

  async dispose(): Promise<void> {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
    this.status = 'idle';
    this.loadPromise = null;
    this.backend = null;
  }
}

export const supertonicEngine = new SupertonicEngine();
export type { WordTimestamp };
