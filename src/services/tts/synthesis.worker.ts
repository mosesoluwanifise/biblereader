/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web';

/**
 * Runs Supertonic inference off the main thread.
 *
 * Inference is heavy enough to pin the renderer for tens of seconds — long
 * enough that the page stops responding to input entirely, and the word
 * highlight's animation frames never fire. Everything model-related lives
 * here; the main thread only sends text and receives audio.
 *
 * Audio comes back as a transferable buffer, so the samples are moved rather
 * than copied.
 */

const SAMPLE_RATE = 44100;
const HOP = 512; // ae.base_chunk_size
const LATENT_DIM = 24; // ae.ldim
const COMPRESS = 6; // ttl.chunk_compress_factor

type Graph = 'duration_predictor' | 'text_encoder' | 'vector_estimator' | 'vocoder';
const GRAPHS: Graph[] = ['duration_predictor', 'text_encoder', 'vector_estimator', 'vocoder'];

interface StyleTensors {
  ttl: ort.Tensor;
  dp: ort.Tensor;
}

const sessions = new Map<Graph, ort.InferenceSession>();
const styles = new Map<string, StyleTensors>();
let indexer: number[] | null = null;
let backend: 'webgpu' | 'wasm' | null = null;
let modelBase = '/models/supertonic-3';

export type WorkerRequest =
  | { id: number; type: 'load'; modelBase: string }
  | { id: number; type: 'synthesize'; text: string; voiceId: string; steps: number };

export type WorkerResponse =
  | { id: number; type: 'progress'; loaded: number; total: number; label: string }
  | { id: number; type: 'loaded'; backend: string; version: string | null; voiceIds: string[] }
  | { id: number; type: 'audio'; audio: ArrayBuffer; sampleRate: number; predicted: number }
  | { id: number; type: 'error'; message: string };

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

function gaussian(): number {
  const u = Math.random() || 1e-9;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

const post = (message: WorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message, transfer);

async function load(id: number, base: string): Promise<void> {
  modelBase = base;
  const manifest = await fetch(`${modelBase}/manifest.json`).then((r) => {
    if (!r.ok) throw new Error(`Model manifest unavailable (HTTP ${r.status})`);
    return r.json();
  });

  const voiceIds: string[] = manifest.voiceStyles ?? [];
  const total = GRAPHS.length + voiceIds.length + 1;
  let loaded = 0;
  const step = (label: string) => post({ id, type: 'progress', loaded: (loaded += 1), total, label });

  indexer = await fetch(`${modelBase}/onnx/unicode_indexer.json`).then((r) => r.json());
  step('tokenizer');

  // R13: WebGPU where available, WASM otherwise.
  const providers: ('webgpu' | 'wasm')[] = 'gpu' in navigator ? ['webgpu', 'wasm'] : ['wasm'];

  for (const graph of GRAPHS) {
    const url = `${modelBase}/onnx/${graph}.onnx`;
    let session: ort.InferenceSession | null = null;
    let lastError: unknown;

    for (const provider of providers) {
      try {
        session = await ort.InferenceSession.create(url, { executionProviders: [provider] });
        if (backend === null) backend = provider;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!session) throw new Error(`Could not load ${graph}: ${(lastError as Error)?.message ?? 'unknown'}`);
    sessions.set(graph, session);
    step(graph);
  }

  for (const voiceId of voiceIds) {
    const style = await fetch(`${modelBase}/voice_styles/${voiceId}.json`).then((r) => r.json());
    styles.set(voiceId, { ttl: tensorFromStyle(style.style_ttl), dp: tensorFromStyle(style.style_dp) });
    step(`voice ${voiceId}`);
  }

  post({ id, type: 'loaded', backend: backend ?? 'wasm', version: manifest.version ?? null, voiceIds });
}

async function synthesize(id: number, text: string, voiceId: string, steps: number): Promise<void> {
  if (!indexer) throw new Error('Engine not loaded');
  const style = styles.get(voiceId) ?? styles.values().next().value;
  if (!style) throw new Error(`Unknown voice: ${voiceId}`);

  const ids = [...text].map((ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    return cp < indexer!.length ? indexer![cp] : 0;
  });
  const n = ids.length;

  const textIds = new ort.Tensor('int64', BigInt64Array.from(ids.map((v) => BigInt(v))), [1, n]);
  const textMask = new ort.Tensor('float32', new Float32Array(n).fill(1), [1, 1, n]);

  const durationOut = await sessions.get('duration_predictor')!.run({
    text_ids: textIds,
    style_dp: style.dp,
    text_mask: textMask
  });
  const predicted = Number((durationOut.duration.data as Float32Array)[0]);

  const frames = Math.max(1, Math.round((predicted * SAMPLE_RATE) / HOP));
  const compressedFrames = Math.max(1, Math.ceil(frames / COMPRESS));
  const channels = LATENT_DIM * COMPRESS;

  const encoded = await sessions.get('text_encoder')!.run({
    text_ids: textIds,
    style_ttl: style.ttl,
    text_mask: textMask
  });

  const ve = sessions.get('vector_estimator')!;
  let latent: ort.Tensor = new ort.Tensor(
    'float32',
    Float32Array.from({ length: channels * compressedFrames }, gaussian),
    [1, channels, compressedFrames]
  );
  const latentMask = new ort.Tensor('float32', new Float32Array(compressedFrames).fill(1), [1, 1, compressedFrames]);

  for (let step = 0; step < steps; step += 1) {
    const out = await ve.run({
      noisy_latent: latent,
      text_emb: encoded.text_emb,
      style_ttl: style.ttl,
      latent_mask: latentMask,
      text_mask: textMask,
      current_step: new ort.Tensor('float32', Float32Array.from([step]), [1]),
      total_step: new ort.Tensor('float32', Float32Array.from([steps]), [1])
    });
    latent = out.denoised_latent as ort.Tensor;
  }

  const vocoded = await sessions.get('vocoder')!.run({ latent });
  const source = vocoded.wav_tts.data as Float32Array;

  // Copy into a plain buffer so it can be transferred; ONNX output may sit in
  // shared WASM memory, which is not transferable.
  const samples = new Float32Array(source.length);
  samples.set(source);

  post({ id, type: 'audio', audio: samples.buffer, sampleRate: SAMPLE_RATE, predicted }, [samples.buffer]);
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'load') await load(request.id, request.modelBase);
    else if (request.type === 'synthesize') {
      await synthesize(request.id, request.text, request.voiceId, request.steps);
    }
  } catch (err) {
    post({ id: request.id, type: 'error', message: (err as Error)?.message ?? 'Synthesis failed' });
  }
};
