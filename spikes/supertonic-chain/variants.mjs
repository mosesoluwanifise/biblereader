/**
 * Intelligibility hunt.
 *
 * Baseline output is speech-shaped but garbled. Two suspects:
 *   1. ttl.normalizer.scale = 0.25 is never applied — the vocoder may expect
 *      the latent denormalized (x4) out of the flow model's space.
 *   2. vector_estimator may return a velocity to integrate rather than an
 *      updated latent, despite the output being named denoised_latent.
 * Plus a control for step count, since 8 flow-matching steps may simply be
 * too few to resolve.
 *
 * Writes one WAV per variant so they can be compared by ear.
 */
import ort from 'onnxruntime-web';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

const BUNDLE = join(import.meta.dirname, '..', '..', 'public', 'models', 'supertonic-3');
const SR = 44100, HOP = 512, DIM = 24, COMPRESS = 6;
const TEXT = 'In the beginning God created the heaven and the earth.';

const indexer = JSON.parse(await readFile(join(BUNDLE, 'onnx', 'unicode_indexer.json'), 'utf8'));
const styleJson = JSON.parse(await readFile(join(BUNDLE, 'voice_styles', 'F1.json'), 'utf8'));

const mk = (node) => {
  const flat = [];
  (function w(x) { Array.isArray(x) ? x.forEach(w) : flat.push(x); })(node.data);
  const dims = []; let c = node.data;
  while (Array.isArray(c)) { dims.push(c.length); c = c[0]; }
  return new ort.Tensor('float32', Float32Array.from(flat), dims);
};
const styleTtl = mk(styleJson.style_ttl), styleDp = mk(styleJson.style_dp);

// fp32 for quality; int8 is a separate axis.
const load = (g) => ort.InferenceSession.create(join(BUNDLE, 'onnx', `${g}.fp32.onnx`), { executionProviders: ['wasm'] });
const [dp, te, ve, voc] = await Promise.all([
  load('duration_predictor'), load('text_encoder'), load('vector_estimator'), load('vocoder')
]);

const ids = [...TEXT].map((ch) => { const cp = ch.codePointAt(0); return cp < indexer.length ? indexer[cp] : 0; });
const N = ids.length;
const textIds = new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, N]);
const textMask = new ort.Tensor('float32', new Float32Array(N).fill(1), [1, 1, N]);

const { duration } = await dp.run({ text_ids: textIds, style_dp: styleDp, text_mask: textMask });
const seconds = Number(duration.data[0]);
const L = Math.max(1, Math.round((seconds * SR) / HOP));
const Lc = Math.max(1, Math.ceil(L / COMPRESS));
const CH = DIM * COMPRESS;
const { text_emb } = await te.run({ text_ids: textIds, style_ttl: styleTtl, text_mask: textMask });
const latentMask = new ort.Tensor('float32', new Float32Array(Lc).fill(1), [1, 1, Lc]);

console.log(`text "${TEXT}"`);
console.log(`predicted ${seconds.toFixed(3)}s -> ${Lc} compressed frames x ${CH} channels\n`);

// Same starting noise for every variant so differences are the variable, not luck.
const seedNoise = Float32Array.from({ length: CH * Lc }, () => {
  const u = Math.random() || 1e-9;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
});

async function generate({ name, steps, scale, integrate }) {
  let latent = new ort.Tensor('float32', Float32Array.from(seedNoise), [1, CH, Lc]);

  for (let s = 0; s < steps; s += 1) {
    const out = await ve.run({
      noisy_latent: latent,
      text_emb,
      style_ttl: styleTtl,
      latent_mask: latentMask,
      text_mask: textMask,
      current_step: new ort.Tensor('float32', Float32Array.from([s]), [1]),
      total_step: new ort.Tensor('float32', Float32Array.from([steps]), [1])
    });

    if (integrate) {
      // Treat the output as a velocity field and take an Euler step.
      const v = out.denoised_latent.data;
      const x = latent.data;
      const next = new Float32Array(x.length);
      for (let i = 0; i < x.length; i += 1) next[i] = x[i] + v[i] / steps;
      latent = new ort.Tensor('float32', next, [1, CH, Lc]);
    } else {
      latent = out.denoised_latent;
    }
  }

  let feed = latent;
  if (scale !== 1) {
    const scaled = new Float32Array(latent.data.length);
    for (let i = 0; i < scaled.length; i += 1) scaled[i] = latent.data[i] * scale;
    feed = new ort.Tensor('float32', scaled, [1, CH, Lc]);
  }

  const { wav_tts } = await voc.run({ latent: feed });
  const a = wav_tts.data;
  let peak = 0, energy = 0;
  for (let i = 0; i < a.length; i += 1) { const v = Math.abs(a[i]); if (v > peak) peak = v; energy += a[i] * a[i]; }
  const rms = Math.sqrt(energy / a.length);
  const clipped = Array.prototype.reduce.call(a, (n, v) => n + (Math.abs(v) >= 0.999 ? 1 : 0), 0);

  const pcm = Buffer.alloc(a.length * 2);
  for (let i = 0; i < a.length; i += 1) {
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(a[i] * 32767))), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  const file = join(import.meta.dirname, `variant-${name}.wav`);
  await writeFile(file, Buffer.concat([h, pcm]));

  console.log(`${name.padEnd(22)} peak ${peak.toFixed(3)}  rms ${rms.toFixed(4)}  clipped ${clipped}  ${(a.length / SR).toFixed(2)}s`);
}

// fp32 confirmed intelligible; B (denorm) and D (integrate) confirmed wrong.
// Remaining question is purely the quality/latency tradeoff on step count.
for (const steps of [2, 4, 8]) {
  const t0 = Date.now();
  await generate({ name: `fp32-${steps}step`, steps, scale: 1, integrate: false });
  console.log(`  -> ${((Date.now() - t0) / 1000).toFixed(1)}s wall for ${seconds.toFixed(2)}s audio
`);
}
