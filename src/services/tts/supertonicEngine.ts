import * as ort from 'onnxruntime-web';
import { SynthesisResult, WordTimestamp } from './types';
import { DEFAULT_VOICE_ID } from './voices';
import { interpolateWordTimings } from './wordTiming';

export { PRESET_VOICES, findVoice, DEFAULT_VOICE_ID } from './voices';

/**
 * Supertonic TTS over onnxruntime-web.
 *
 * Chain, with shapes confirmed by running the graphs rather than inferred from
 * their filenames:
 *
 *   duration_predictor(text_ids, style_dp, text_mask)  -> duration  [1]
 *   text_encoder(text_ids, style_ttl, text_mask)       -> text_emb  [1,256,N]
 *   vector_estimator(...) x STEPS                      -> denoised  [1,144,Lc]
 *   vocoder(latent)                                    -> wav_tts   [1,samples]
 *
 * Two shapes worth stating because the names mislead: the estimator runs on
 * latents compressed by 6 (24 * 6 = 144 channels at a sixth the frame rate),
 * and the vocoder consumes that same compressed latent directly rather than an
 * expanded one.
 *
 * `duration` is a single scalar — total utterance seconds, not per-token
 * durations — so word timing is interpolated within it. See wordTiming.ts.
 */

const MODEL_BASE = `${import.meta.env.BASE_URL}models/supertonic-3`;
const SAMPLE_RATE = 44100;
const HOP = 512; // ae.base_chunk_size
const LATENT_DIM = 24; // ae.ldim
const COMPRESS = 6; // ttl.chunk_compress_factor
const DEFAULT_STEPS = 8;

type Graph = 'duration_predictor' | 'text_encoder' | 'vector_estimator' | 'vocoder';

interface StyleTensors {
  ttl: ort.Tensor;
  dp: ort.Tensor;
}

export type EngineStatus = 'idle' | 'loading' | 'ready' | 'failed';

export interface LoadProgress {
  loaded: number;
  total: number;
  label: string;
}

function tensorFromStyle(node: { data: unknown }): ort.Tensor {
  const flat: number[] = [];
  (function walk(x: unknown): void {
    if (Array.isArray(x)) x.forEach(walk);
    else flat.push(x as number);
  })(node.data);

  const dims: number[] = [];
  let cursor: unknown = node.data;
  while (Array.isArray(cursor)) {
    dims.push(cursor.length);
    cursor = cursor[0];
  }
  return new ort.Tensor('float32', Float32Array.from(flat), dims);
}

/** Standard normal sample; flow matching starts from a Gaussian prior. */
function gaussian(): number {
  const u = Math.random() || 1e-9;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

export class SupertonicEngine {
  private sessions = new Map<Graph, ort.InferenceSession>();
  private indexer: number[] | null = null;
  private styles = new Map<string, StyleTensors>();
  private status: EngineStatus = 'idle';
  private loadPromise: Promise<void> | null = null;
  private backend: 'webgpu' | 'wasm' | null = null;
  private version: string | null = null;

  getStatus(): EngineStatus {
    return this.status;
  }

  getBackend(): 'webgpu' | 'wasm' | null {
    return this.backend;
  }

  getVersion(): string | null {
    return this.version;
  }

  isReady(): boolean {
    return this.status === 'ready';
  }

  /**
   * Loads the bundle. Safe to call repeatedly — concurrent callers share one
   * load, and a completed load resolves immediately.
   */
  async load(onProgress?: (p: LoadProgress) => void): Promise<void> {
    if (this.status === 'ready') return;
    if (this.loadPromise) return this.loadPromise;

    this.status = 'loading';
    this.loadPromise = this.doLoad(onProgress).catch((err) => {
      this.status = 'failed';
      this.loadPromise = null;
      throw err;
    });
    return this.loadPromise;
  }

  private async doLoad(onProgress?: (p: LoadProgress) => void): Promise<void> {
    const manifest = await fetch(`${MODEL_BASE}/manifest.json`).then((r) => {
      if (!r.ok) throw new Error(`Model manifest unavailable (HTTP ${r.status})`);
      return r.json();
    });
    this.version = manifest.version ?? null;

    const graphs: Graph[] = ['duration_predictor', 'text_encoder', 'vector_estimator', 'vocoder'];
    const voiceStyles: string[] = manifest.voiceStyles ?? [];
    const total = graphs.length + voiceStyles.length + 1;
    let loaded = 0;
    const step = (label: string) => onProgress?.({ loaded: (loaded += 1), total, label });

    this.indexer = await fetch(`${MODEL_BASE}/onnx/unicode_indexer.json`).then((r) => r.json());
    step('tokenizer');

    // R13: prefer WebGPU, fall back to WASM rather than failing.
    const providers: ('webgpu' | 'wasm')[] =
      typeof navigator !== 'undefined' && 'gpu' in navigator ? ['webgpu', 'wasm'] : ['wasm'];

    for (const graph of graphs) {
      const url = `${MODEL_BASE}/onnx/${graph}.onnx`;
      let session: ort.InferenceSession | null = null;
      let lastError: unknown;

      for (const provider of providers) {
        try {
          session = await ort.InferenceSession.create(url, { executionProviders: [provider] });
          if (this.backend === null) this.backend = provider;
          break;
        } catch (err) {
          lastError = err;
        }
      }

      if (!session) {
        throw new Error(`Could not load ${graph}: ${(lastError as Error)?.message ?? 'unknown error'}`);
      }
      this.sessions.set(graph, session);
      step(graph);
    }

    for (const id of voiceStyles) {
      const style = await fetch(`${MODEL_BASE}/voice_styles/${id}.json`).then((r) => r.json());
      this.styles.set(id, { ttl: tensorFromStyle(style.style_ttl), dp: tensorFromStyle(style.style_dp) });
      step(`voice ${id}`);
    }

    this.status = 'ready';
  }

  private encode(text: string): number[] {
    const indexer = this.indexer;
    if (!indexer) throw new Error('Tokenizer not loaded');
    return [...text].map((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      return cp < indexer.length ? indexer[cp] : 0;
    });
  }

  /**
   * Synthesizes one sentence. Callers chunk at sentence boundaries: it keeps
   * time-to-first-audio low, and each sentence's model-predicted duration
   * re-anchors word timing so error cannot accumulate across a chapter.
   */
  async synthesizeSentence(
    text: string,
    voiceId: string = DEFAULT_VOICE_ID,
    steps: number = DEFAULT_STEPS
  ): Promise<SynthesisResult> {
    if (!this.isReady()) throw new Error('Engine not loaded');

    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return { audio: new Float32Array(0), sampleRate: SAMPLE_RATE, duration: 0, words: [] };
    }

    const style = this.styles.get(voiceId) ?? this.styles.get(DEFAULT_VOICE_ID);
    if (!style) throw new Error(`Unknown voice: ${voiceId}`);

    const ids = this.encode(trimmed);
    const n = ids.length;
    const textIds = new ort.Tensor('int64', BigInt64Array.from(ids.map((v) => BigInt(v))), [1, n]);
    const textMask = new ort.Tensor('float32', new Float32Array(n).fill(1), [1, 1, n]);

    const dp = this.sessions.get('duration_predictor')!;
    const durationOut = await dp.run({ text_ids: textIds, style_dp: style.dp, text_mask: textMask });
    const seconds = Number((durationOut.duration.data as Float32Array)[0]);

    const frames = Math.max(1, Math.round((seconds * SAMPLE_RATE) / HOP));
    const compressedFrames = Math.max(1, Math.ceil(frames / COMPRESS));
    const channels = LATENT_DIM * COMPRESS;

    const te = this.sessions.get('text_encoder')!;
    const encoded = await te.run({ text_ids: textIds, style_ttl: style.ttl, text_mask: textMask });
    const textEmb = encoded.text_emb;

    const ve = this.sessions.get('vector_estimator')!;
    let latent: ort.Tensor = new ort.Tensor(
      'float32',
      Float32Array.from({ length: channels * compressedFrames }, gaussian),
      [1, channels, compressedFrames]
    );
    const latentMask = new ort.Tensor(
      'float32',
      new Float32Array(compressedFrames).fill(1),
      [1, 1, compressedFrames]
    );

    for (let step = 0; step < steps; step += 1) {
      const out = await ve.run({
        noisy_latent: latent,
        text_emb: textEmb,
        style_ttl: style.ttl,
        latent_mask: latentMask,
        text_mask: textMask,
        current_step: new ort.Tensor('float32', Float32Array.from([step]), [1]),
        total_step: new ort.Tensor('float32', Float32Array.from([steps]), [1])
      });
      latent = out.denoised_latent as ort.Tensor;
    }

    const voc = this.sessions.get('vocoder')!;
    const vocoded = await voc.run({ latent });
    const audio = vocoded.wav_tts.data as Float32Array;
    const actualSeconds = audio.length / SAMPLE_RATE;

    return {
      audio,
      sampleRate: SAMPLE_RATE,
      duration: actualSeconds,
      words: interpolateWordTimings(trimmed, actualSeconds)
    };
  }

  /** Frees GPU/WASM sessions. */
  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.release?.();
    }
    this.sessions.clear();
    this.styles.clear();
    this.indexer = null;
    this.status = 'idle';
    this.loadPromise = null;
    this.backend = null;
  }
}

export const supertonicEngine = new SupertonicEngine();
export type { WordTimestamp };
