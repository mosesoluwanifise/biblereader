/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web';

/**
 * Development-only throughput benchmark.
 *
 * 8 flow steps is the quality bar, and it measures 0.88x realtime on WASM
 * threads — below playback, so the deficit compounds across sentences. This
 * answers whether WebGPU clears it.
 *
 * Runs in a worker because inference on the main thread pins the renderer:
 * two earlier attempts to measure this from a page never returned.
 */

const SR = 44100, HOP = 512, DIM = 24, COMPRESS = 6, SPEED = 1.05;
const BASE = '/models/supertonic-3';

const PASSAGE =
  'In the beginning God created the heaven and the earth. ' +
  'And the earth was without form, and void; and darkness was upon the face of the deep. ' +
  'And God said, Let there be light: and there was light.';

type Report = { ep: string; steps: number; ok: boolean; detail: string };

const post = (msg: unknown) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);

function tensorFrom(node: { data: unknown }): ort.Tensor {
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

async function run(ep: 'webgpu' | 'wasm', steps: number): Promise<Report> {
  const t0 = performance.now();
  let dp: ort.InferenceSession, te: ort.InferenceSession, ve: ort.InferenceSession, voc: ort.InferenceSession;
  try {
    const load = (g: string) =>
      ort.InferenceSession.create(`${BASE}/onnx/${g}.onnx`, { executionProviders: [ep] });
    [dp, te, ve, voc] = await Promise.all([
      load('duration_predictor'), load('text_encoder'), load('vector_estimator'), load('vocoder')
    ]);
  } catch (e) {
    return { ep, steps, ok: false, detail: `session create failed: ${String(e).slice(0, 90)}` };
  }
  const loadSecs = (performance.now() - t0) / 1000;

  const indexer: number[] = await (await fetch(`${BASE}/onnx/unicode_indexer.json`)).json();
  const style = await (await fetch(`${BASE}/voice_styles/F1.json`)).json();
  const styleTtl = tensorFrom(style.style_ttl);
  const styleDp = tensorFrom(style.style_dp);

  const sentences = PASSAGE.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).filter(Boolean);

  let audioSecs = 0;
  const t1 = performance.now();
  try {
    for (const sentence of sentences) {
      const ids = [...`<en>${sentence}</en>`].map((ch) => {
        const cp = ch.codePointAt(0) ?? 0;
        return cp < indexer.length ? indexer[cp] : 0;
      });
      const n = ids.length;
      const textIds = new ort.Tensor('int64', BigInt64Array.from(ids.map((v) => BigInt(v))), [1, n]);
      const textMask = new ort.Tensor('float32', new Float32Array(n).fill(1), [1, 1, n]);

      const durOut = await dp.run({ text_ids: textIds, style_dp: styleDp, text_mask: textMask });
      const target = Math.max(1, Math.round((Number((durOut.duration.data as Float32Array)[0]) / SPEED) * SR));
      const lc = Math.max(1, Math.ceil(target / (HOP * COMPRESS)));
      const ch = DIM * COMPRESS;

      const enc = await te.run({ text_ids: textIds, style_ttl: styleTtl, text_mask: textMask });
      let latent: ort.Tensor = new ort.Tensor('float32', Float32Array.from({ length: ch * lc }, gaussian), [1, ch, lc]);
      const latentMask = new ort.Tensor('float32', new Float32Array(lc).fill(1), [1, 1, lc]);

      for (let s = 0; s < steps; s += 1) {
        const out = await ve.run({
          noisy_latent: latent, text_emb: enc.text_emb, style_ttl: styleTtl,
          latent_mask: latentMask, text_mask: textMask,
          current_step: new ort.Tensor('float32', Float32Array.from([s]), [1]),
          total_step: new ort.Tensor('float32', Float32Array.from([steps]), [1])
        });
        latent = out.denoised_latent as ort.Tensor;
      }
      const vocOut = await voc.run({ latent });
      audioSecs += Math.min((vocOut.wav_tts.data as Float32Array).length, target) / SR;
    }
  } catch (e) {
    return { ep, steps, ok: false, detail: `run failed: ${String(e).slice(0, 90)}` };
  }

  const synth = (performance.now() - t1) / 1000;
  const xrt = audioSecs / synth;
  return {
    ep, steps, ok: true,
    detail: `load ${loadSecs.toFixed(1)}s | ${audioSecs.toFixed(2)}s audio in ${synth.toFixed(1)}s = ${xrt.toFixed(2)}x realtime`
  };
}

self.onmessage = async () => {
  post({ type: 'env', gpu: 'gpu' in navigator, isolated: (self as unknown as { crossOriginIsolated: boolean }).crossOriginIsolated, threads: ort.env.wasm.numThreads });
  for (const ep of ['webgpu', 'wasm'] as const) {
    for (const steps of [8]) {
      post({ type: 'result', ...(await run(ep, steps)) });
    }
  }
  post({ type: 'done' });
};
