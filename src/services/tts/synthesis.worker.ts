/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web';
import { softenAllCaps } from './wordTiming';
import {
  compatibleProfile,
  createAtomicSessionSet,
  getRuntimeCapabilities,
  profileForModel,
  providerOrder,
  type RuntimeProfile,
  type RuntimeProvider
} from './runtimeProfile';

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

/**
 * Points onnxruntime-web at a CDN copy of its own WASM runtime instead of the
 * copy Vite bundles locally. Unset by default: every host except Cloudflare
 * Pages serves the bundled copy exactly as before, and dev/build stay fully
 * offline-capable with no third-party dependency added.
 *
 * Cloudflare Pages caps a static asset at 25 MiB. The threaded SIMD JSEP
 * build — needed for both the wasm and webgpu execution providers, since the
 * jsep variant is the only one with WebGPU compiled in — is 26.8 MB and
 * fails to deploy as a Pages asset. jsDelivr serves the identical file:
 * verified byte-for-byte via sha256 against the locally installed version,
 * with `Cross-Origin-Resource-Policy: cross-origin` and
 * `Access-Control-Allow-Origin: *`, either of which satisfies this app's
 * `Cross-Origin-Embedder-Policy: require-corp`. scripts/build-for-cloudflare.mjs
 * sets this to the exact installed version and strips the now-unused local
 * copy from the build output; no other build target touches it.
 */
if (import.meta.env.VITE_ORT_WASM_BASE) {
  ort.env.wasm.wasmPaths = import.meta.env.VITE_ORT_WASM_BASE;
}

const SAMPLE_RATE = 44100;
const HOP = 512; // ae.base_chunk_size
const LATENT_DIM = 24; // ae.ldim
const COMPRESS = 6; // ttl.chunk_compress_factor

/** Reference pipeline's default, used when a request does not set one. */
const DEFAULT_SPEED = 1.05;

/**
 * Supertonic-3 is multilingual and conditions on a language tag wrapping the
 * text. Omitting it is not neutral: the same sentence untagged is predicted at
 * 4.4369s against 3.6964s tagged — 20% slower — and the prosody is conditioned
 * on no language at all, which reads as flat, drawn-out delivery.
 */
const LANGUAGE = 'en';

const tagText = (text: string) => `<${LANGUAGE}>${text}</${LANGUAGE}>`;

type Graph = 'duration_predictor' | 'text_encoder' | 'vector_estimator' | 'vocoder';
const GRAPHS: Graph[] = ['duration_predictor', 'text_encoder', 'vector_estimator', 'vocoder'];

interface StyleTensors {
  ttl: ort.Tensor;
  dp: ort.Tensor;
}

const sessions = new Map<Graph, ort.InferenceSession>();
const styles = new Map<string, StyleTensors>();
let indexer: number[] | null = null;
let backend: RuntimeProvider | null = null;
let runtimeSteps = 8;
let modelBase = '/models/supertonic-3';

export type WorkerRequest =
  | { id: number; type: 'load'; modelBase: string; preferredProfile?: RuntimeProfile | null }
  | {
      id: number;
      type: 'synthesize';
      text: string;
      voiceId: string;
      steps: number;
      generation: number;
      /** Divides the predicted duration: higher is faster speech. */
      speed?: number;
    }
  | {
      id: number;
      type: 'predict-duration';
      text: string;
      voiceId: string;
      generation: number;
      speed?: number;
    }
  | { id: number; type: 'cancel'; generation: number };

export type WorkerResponse =
  | { id: number; type: 'progress'; loaded: number; total: number; label: string }
  | {
      id: number;
      type: 'loaded';
      backend: RuntimeProvider;
      version: string | null;
      voiceIds: string[];
      steps: number;
      compileMs: number;
      warmupMs: number;
    }
  | { id: number; type: 'duration'; predicted: number }
  | {
      id: number;
      type: 'audio';
      audio: ArrayBuffer;
      sampleRate: number;
      predicted: number;
      /** Seconds of silence before speech begins in this buffer. */
      speechStart: number;
      /** Seconds of speech, excluding the model's leading and trailing pad. */
      speechDuration: number;
    }
  | { id: number; type: 'cancelled' }
  | { id: number; type: 'error'; message: string; providerLost?: boolean };

/**
 * Generations older than this are abandoned. Stopping playback used to leave
 * inference running: the controller dropped its reference, but the worker kept
 * executing the graph chain, so navigating or switching voice mid-sentence
 * stacked concurrent chains on shared sessions — severe CPU and memory
 * pressure on mobile.
 */
let liveGeneration = 0;

/** Serialises synthesis; concurrent runs on one session are not safe. */
let queue: Promise<unknown> = Promise.resolve();

class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

function assertLive(generation: number): void {
  if (generation < liveGeneration) throw new Cancelled();
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

function gaussian(): number {
  const u = Math.random() || 1e-9;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

const post = (message: WorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message, transfer);

async function releaseSessions(values: Iterable<ort.InferenceSession> = sessions.values()): Promise<void> {
  await Promise.allSettled([...values].map((session) => session.release()));
}

async function load(id: number, base: string, preferredProfile?: RuntimeProfile | null): Promise<void> {
  modelBase = base;
  const manifest = await fetch(`${modelBase}/manifest.json`).then((r) => {
    if (!r.ok) throw new Error(`Model manifest unavailable (HTTP ${r.status})`);
    return r.json();
  });

  const voiceIds: string[] = manifest.voiceStyles ?? [];

  /**
   * Progress is weighted by bytes, not by file count.
   *
   * Counting files put `vector_estimator` — 256 MB of the bundle's 398 — at
   * one fifteenth of the bar, so "Downloading voice… 20%" sat motionless for
   * most of the wait and then jumped. The manifest already records each file's
   * size; using it makes the number mean what it says.
   */
  const sizes = new Map<string, number>(
    ((manifest.files ?? []) as { path: string; bytes: number }[]).map((f) => [f.path, f.bytes])
  );
  const sizeOf = (path: string, fallback: number) => sizes.get(path) ?? fallback;

  const total =
    GRAPHS.reduce((sum, g) => sum + sizeOf(`onnx/${g}.onnx`, 1e7), 0) +
    voiceIds.reduce((sum, v) => sum + sizeOf(`voice_styles/${v}.json`, 3e5), 0) +
    sizeOf('onnx/unicode_indexer.json', 3e5);

  let loaded = 0;
  const step = (label: string, bytes: number) =>
    post({ id, type: 'progress', loaded: (loaded += bytes), total, label });

  indexer = await fetch(`${modelBase}/onnx/unicode_indexer.json`).then((r) => r.json());
  step('tokenizer', sizeOf('onnx/unicode_indexer.json', 3e5));

  const capabilities = getRuntimeCapabilities(globalThis);
  const compatible = compatibleProfile(preferredProfile, capabilities);
  // The worker is the first code to know the fetched model version. Never use
  // a provider or quality gate recorded against different weights.
  const profile = profileForModel(compatible, manifest.version ?? null);
  const providers = providerOrder(capabilities, profile);
  runtimeSteps = profile?.steps ?? 8;

  /**
   * All four graphs at once, not one after another.
   *
   * Sequentially, each `create` fetched its weights and only then compiled
   * them, so the network sat idle through every compile and the CPU sat idle
   * through every fetch — four times over, across 398 MB. Overlapping them is
   * the single largest saving available without touching the weights
   * themselves, and it is what the U5 spike already did when it measured load
   * time. Sessions are independent objects; nothing here is order-dependent.
   */
  await releaseSessions();
  sessions.clear();
  backend = null;
  const compileStarted = performance.now();
  const selected = await createAtomicSessionSet(GRAPHS, providers, {
    create: async (graph, provider) => {
      return ort.InferenceSession.create(`${modelBase}/onnx/${graph}.onnx`, {
        executionProviders: [provider]
      });
    },
    release: (session) => session.release()
  });
  const compileMs = performance.now() - compileStarted;
  backend = selected.provider;
  for (const graph of GRAPHS) {
    sessions.set(graph, selected.sessions.get(graph)!);
    step(graph, sizeOf(`onnx/${graph}.onnx`, 1e7));
  }

  // Ten styles at ~292 KB each: trivial bytes, but ten serial round trips is a
  // second of pure latency on a slow link for no reason.
  await Promise.all(
    voiceIds.map(async (voiceId) => {
      const style = await fetch(`${modelBase}/voice_styles/${voiceId}.json`).then((r) => r.json());
      styles.set(voiceId, { ttl: tensorFromStyle(style.style_ttl), dp: tensorFromStyle(style.style_dp) });
      step(`voice ${voiceId}`, sizeOf(`voice_styles/${voiceId}.json`, 3e5));
    })
  );

  /**
   * Run the chain once and throw the audio away.
   *
   * Measured: the first synthesis after a load runs at 0.69x realtime where
   * every later one runs at 1.07-1.29x — ONNX compiles its WASM kernels lazily
   * on first execution of each graph. That one-off penalty landed on the first
   * sentence of the passage, which is exactly where there is no buffered audio
   * to absorb it, so it opened a deficit the rest of the chapter inherited.
   *
   * Paid here instead, behind the background warm-up, where nobody is waiting.
   * The load task still owns the queue, so a play pressed mid-load waits for
   * this — about a second, against a download an order of magnitude longer.
   */
  if (voiceIds.length === 0) throw new Error('Model manifest contains no voice styles');
  step('warmup', 0);
  const warmupStarted = performance.now();
  await synthesize(id, 'Amen.', voiceIds[0], runtimeSteps, liveGeneration, DEFAULT_SPEED, false, false);
  const warmupMs = performance.now() - warmupStarted;

  // Ready means every graph has successfully run, not merely been allocated.
  post({
    id,
    type: 'loaded',
    backend,
    version: manifest.version ?? null,
    voiceIds,
    steps: runtimeSteps,
    compileMs,
    warmupMs
  });
}

async function synthesize(
  id: number,
  text: string,
  voiceId: string,
  steps: number,
  generation: number,
  speed: number = DEFAULT_SPEED,
  /** False for the post-load warm-up, which discards its audio. */
  emit = true,
  /** Model warm-up is part of loading and must not be cancelled by transport Stop. */
  cancellable = true
): Promise<void> {
  if (!indexer) throw new Error('Engine not loaded');
  if (cancellable) assertLive(generation);
  const style = styles.get(voiceId) ?? styles.values().next().value;
  if (!style) throw new Error(`Unknown voice: ${voiceId}`);

  // Tag affects synthesis only; word timings are derived from the untagged
  // text by the caller, so the tag must not leak into the word list.
  const ids = [...tagText(softenAllCaps(text))].map((ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    return cp < indexer!.length ? indexer![cp] : 0;
  });
  const n = ids.length;

  const textIds = new ort.Tensor('int64', BigInt64Array.from(ids.map((v) => BigInt(v))), [1, n]);
  const textMask = new ort.Tensor('float32', new Float32Array(n).fill(1), [1, 1, n]);

  const predicted = await runDurationPredictor(textIds, textMask, style, speed);

  const targetSamples = Math.max(1, Math.round(predicted * SAMPLE_RATE));
  // The latent grid is quantised to HOP * COMPRESS samples, so the vocoder
  // always emits a whole number of chunks — up to one chunk longer than the
  // duration actually predicted.
  const compressedFrames = Math.max(1, Math.ceil(targetSamples / (HOP * COMPRESS)));
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
    // Checked between steps so an abandoned run stops within one step rather
    // than completing the whole chain.
    if (cancellable) assertLive(generation);
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

  if (cancellable) assertLive(generation);
  const vocoded = await sessions.get('vocoder')!.run({ latent });
  if (!emit) return;
  const source = vocoded.wav_tts.data as Float32Array;

  /**
   * Locate the speech inside the utterance.
   *
   * The model pads generously — measured across three sentences, speech
   * occupied only ~72% of the buffer, with 0.40-0.57s of leading and
   * 0.53-0.65s of trailing silence. That padding is *kept*: it is the model's
   * own phrasing and sounds better than any gap inserted afterwards.
   *
   * What must not ignore it is word timing. Interpolating across the whole
   * buffer put the highlight up to 0.57s ahead of the voice at the start of a
   * sentence and 0.65s behind at the end. Reporting the bounds lets timings be
   * spread over the speech alone while the audio plays unaltered.
   */
  function findSpeechBounds(buf: Float32Array, limit: number): [number, number] {
    let peak = 0;
    for (let i = 0; i < limit; i += 1) {
      const v = Math.abs(buf[i]);
      if (v > peak) peak = v;
    }
    // Relative to peak so a quiet voice is not mistaken for silence, with an
    // absolute floor so near-silent output cannot select the whole buffer.
    const threshold = Math.max(0.004, peak * 0.02);

    let start = 0;
    while (start < limit && Math.abs(buf[start]) <= threshold) start += 1;
    let end = limit;
    while (end > start && Math.abs(buf[end - 1]) <= threshold) end -= 1;
    if (start >= end) return [0, limit];

    // Keep a little room so onsets and decays are not clipped.
    const padStart = Math.round(0.05 * SAMPLE_RATE);
    const padEnd = Math.round(0.08 * SAMPLE_RATE);
    return [Math.max(0, start - padStart), Math.min(limit, end + padEnd)];
  }

  // Drop the latent-grid padding only. The model's own silence stays in the
  // audio; the bounds below tell the caller where the speech sits inside it.
  const length = Math.min(source.length, targetSamples);
  const [speechFrom, speechTo] = findSpeechBounds(source, length);

  // Copy into a plain buffer so it can be transferred; ONNX output may sit in
  // shared WASM memory, which is not transferable.
  const samples = new Float32Array(length);
  samples.set(source.subarray(0, length));

  post(
    {
      id,
      type: 'audio',
      audio: samples.buffer,
      sampleRate: SAMPLE_RATE,
      predicted,
      speechStart: speechFrom / SAMPLE_RATE,
      speechDuration: (speechTo - speechFrom) / SAMPLE_RATE
    },
    [samples.buffer]
  );
}

async function runDurationPredictor(
  textIds: ort.Tensor,
  textMask: ort.Tensor,
  style: StyleTensors,
  speed: number
): Promise<number> {
  const durationOut = await sessions.get('duration_predictor')!.run({
    text_ids: textIds,
    style_dp: style.dp,
    text_mask: textMask
  });
  // Speed shortens the window the model fills rather than resampling the
  // result, so the voice does not change pitch.
  return Number((durationOut.duration.data as Float32Array)[0]) / speed;
}

async function predictDuration(
  id: number,
  text: string,
  voiceId: string,
  generation: number,
  speed: number = DEFAULT_SPEED
): Promise<void> {
  if (!indexer) throw new Error('Engine not loaded');
  assertLive(generation);
  const style = styles.get(voiceId) ?? styles.values().next().value;
  if (!style) throw new Error(`Unknown voice: ${voiceId}`);
  const ids = [...tagText(softenAllCaps(text))].map((ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    return cp < indexer!.length ? indexer![cp] : 0;
  });
  const textIds = new ort.Tensor('int64', BigInt64Array.from(ids.map((value) => BigInt(value))), [1, ids.length]);
  const textMask = new ort.Tensor('float32', new Float32Array(ids.length).fill(1), [1, 1, ids.length]);
  const predicted = await runDurationPredictor(textIds, textMask, style, speed);
  assertLive(generation);
  post({ id, type: 'duration', predicted });
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  // Cancellation must take effect immediately, not behind the queue it is
  // cancelling.
  if (request.type === 'cancel') {
    liveGeneration = Math.max(liveGeneration, request.generation);
    return;
  }

  queue = queue.then(async () => {
    try {
      if (request.type === 'load') {
        await load(request.id, request.modelBase, request.preferredProfile);
      } else if (request.type === 'synthesize') {
        await synthesize(
          request.id,
          request.text,
          request.voiceId,
          request.steps,
          request.generation,
          request.speed
        );
      } else {
        await predictDuration(request.id, request.text, request.voiceId, request.generation, request.speed);
      }
    } catch (err) {
      if (err instanceof Cancelled) {
        post({ id: request.id, type: 'cancelled' });
        return;
      }
      const message = (err as Error)?.message ?? 'Synthesis failed';
      post({
        id: request.id,
        type: 'error',
        message,
        providerLost: backend === 'webgpu' && /device\s*(?:was\s*)?lost|GPUDevice.*lost/i.test(message)
      });
    }
  });
};
