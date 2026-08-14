/**
 * Does int8 quantization hold up?
 *
 * Runs the same sentence through the shipped bundle (public/models) and
 * reports duration agreement and signal statistics against the fp32 spike
 * baseline. Quantization that halves quality is not a saving.
 */
import ort from 'onnxruntime-web';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

const BUNDLE = join(import.meta.dirname, '..', '..', 'public', 'models', 'supertonic-3');
const SR = 44100;
const HOP = 512;
const LATENT_DIM = 24;
const COMPRESS = 6;
const STEPS = 8;

const manifest = JSON.parse(await readFile(join(BUNDLE, 'manifest.json'), 'utf8'));
console.log(`bundle ${manifest.version}  quantization=${manifest.quantization}`);
console.log(`files ${manifest.files.length}  total ${(manifest.files.reduce((s, f) => s + f.bytes, 0) / 1048576).toFixed(1)} MB\n`);

const indexer = JSON.parse(await readFile(join(BUNDLE, 'onnx', 'unicode_indexer.json'), 'utf8'));

function styleTensors(style) {
  const build = (node) => {
    const flat = [];
    (function walk(x) {
      if (Array.isArray(x)) x.forEach(walk);
      else flat.push(x);
    })(node.data);
    const dims = [];
    let c = node.data;
    while (Array.isArray(c)) {
      dims.push(c.length);
      c = c[0];
    }
    return new ort.Tensor('float32', Float32Array.from(flat), dims);
  };
  return { ttl: build(style.style_ttl), dp: build(style.style_dp) };
}

const load = (f) => ort.InferenceSession.create(join(BUNDLE, 'onnx', f), { executionProviders: ['wasm'] });
const t0 = Date.now();
const [dp, te, ve, voc] = await Promise.all([
  load('duration_predictor.onnx'),
  load('text_encoder.onnx'),
  load('vector_estimator.onnx'),
  load('vocoder.onnx')
]);
console.log(`graphs loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s (int8)\n`);

const TEXT = 'In the beginning God created the heaven and the earth.';
const style = styleTensors(JSON.parse(await readFile(join(BUNDLE, 'voice_styles', 'F1.json'), 'utf8')));

const ids = [...TEXT].map((ch) => {
  const cp = ch.codePointAt(0);
  return cp < indexer.length ? indexer[cp] : 0;
});
const N = ids.length;
const textIds = new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, N]);
const textMask = new ort.Tensor('float32', new Float32Array(N).fill(1), [1, 1, N]);

const tSynth = Date.now();
const { duration } = await dp.run({ text_ids: textIds, style_dp: style.dp, text_mask: textMask });
const seconds = Number(duration.data[0]);
const L = Math.max(1, Math.round((seconds * SR) / HOP));
const Lc = Math.max(1, Math.ceil(L / COMPRESS));

const { text_emb: textEmb } = await te.run({ text_ids: textIds, style_ttl: style.ttl, text_mask: textMask });

let latent = new ort.Tensor(
  'float32',
  Float32Array.from({ length: LATENT_DIM * COMPRESS * Lc }, () => {
    const u = Math.random() || 1e-9;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
  }),
  [1, LATENT_DIM * COMPRESS, Lc]
);
const latentMask = new ort.Tensor('float32', new Float32Array(Lc).fill(1), [1, 1, Lc]);

for (let s = 0; s < STEPS; s += 1) {
  const out = await ve.run({
    noisy_latent: latent,
    text_emb: textEmb,
    style_ttl: style.ttl,
    latent_mask: latentMask,
    text_mask: textMask,
    current_step: new ort.Tensor('float32', Float32Array.from([s]), [1]),
    total_step: new ort.Tensor('float32', Float32Array.from([STEPS]), [1])
  });
  latent = out.denoised_latent;
}

const { wav_tts: wav } = await voc.run({ latent });
const elapsed = (Date.now() - tSynth) / 1000;
const samples = wav.data;

let peak = 0;
let energy = 0;
for (let i = 0; i < samples.length; i += 1) {
  const v = Math.abs(samples[i]);
  if (v > peak) peak = v;
  energy += samples[i] * samples[i];
}
const rms = Math.sqrt(energy / samples.length);

// Envelope: speech has silence and onsets; noise is flat.
const win = Math.floor(SR * 0.05);
const env = [];
for (let i = 0; i + win < samples.length; i += win) {
  let e = 0;
  for (let j = i; j < i + win; j += 1) e += samples[j] * samples[j];
  env.push(Math.sqrt(e / win));
}
const envPeak = Math.max(...env);
const quiet = env.filter((e) => e < envPeak * 0.08).length;

console.log(`duration predicted : ${seconds.toFixed(3)}s   (fp32 baseline 4.437s)`);
console.log(`audio produced     : ${(samples.length / SR).toFixed(2)}s`);
console.log(`peak ${peak.toFixed(4)}  rms ${rms.toFixed(4)}   (fp32 baseline peak 0.7594 rms 0.0765)`);
console.log(`near-silent windows: ${quiet}/${env.length} (${((100 * quiet) / env.length).toFixed(0)}%)`);
console.log(`synthesis          : ${elapsed.toFixed(1)}s = ${(seconds / elapsed).toFixed(2)}x realtime (int8, WASM 1 thread)`);
console.log('');
console.log('envelope:');
console.log(env.map((e) => ' .:-=+*#%@'[Math.min(9, Math.floor((e / envPeak) * 9.99))]).join(''));

const pcm = Buffer.alloc(samples.length * 2);
for (let i = 0; i < samples.length; i += 1) {
  pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
}
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(SR, 24);
h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36);
h.writeUInt32LE(pcm.length, 40);
await writeFile(join(import.meta.dirname, 'genesis-1-1-int8.wav'), Buffer.concat([h, pcm]));

console.log('');
console.log(rms > 0.02 && quiet > 2 ? 'VERDICT: int8 output is healthy speech.' : 'VERDICT: int8 output looks degraded — investigate.');
