/**
 * Renders the same multi-sentence passage at different step counts.
 *
 * A previous comparison used one short sentence while the reported artifact was
 * in a three-verse passage — not the same experiment. This renders the whole
 * passage, seeding each sentence deterministically so two runs differ only in
 * step count.
 *
 *   node passage-steps.mjs 4
 *   node passage-steps.mjs 8
 */
import ort from 'onnxruntime-web';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

ort.env.wasm.numThreads = 4;
ort.env.logLevel = 'error';

const HERE = import.meta.dirname;
const BUNDLE = join(HERE, '..', '..', 'public', 'models', 'supertonic-3');
const SR = 44100, HOP = 512, DIM = 24, COMPRESS = 6, SPEED = 1.05;
const STEPS = Number(process.argv[2] ?? 8);

const PASSAGE =
  'In the beginning God created the heaven and the earth. ' +
  'And the earth was without form, and void; and darkness was upon the face of the deep. ' +
  'And God said, Let there be light: and there was light.';

/** Deterministic PRNG so the same sentence draws the same noise every run. */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}
function gaussianFrom(rng) {
  const u = rng() || 1e-9;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

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

const load = (g) => ort.InferenceSession.create(join(BUNDLE, 'onnx', `${g}.onnx`), { executionProviders: ['wasm'] });
const [dp, te, ve, voc] = await Promise.all([
  load('duration_predictor'), load('text_encoder'), load('vector_estimator'), load('vocoder')
]);

const sentences = PASSAGE.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).filter(Boolean);
console.log(`${STEPS} steps, ${sentences.length} sentences\n`);

const chunks = [];
const wall0 = Date.now();
let seedIndex = 0;

for (const sentence of sentences) {
  const ids = [...`<en>${sentence}</en>`].map((ch) => {
    const cp = ch.codePointAt(0);
    return cp < indexer.length ? indexer[cp] : 0;
  });
  const n = ids.length;
  const textIds = new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, n]);
  const textMask = new ort.Tensor('float32', new Float32Array(n).fill(1), [1, 1, n]);

  const { duration } = await dp.run({ text_ids: textIds, style_dp: styleDp, text_mask: textMask });
  const target = Math.max(1, Math.round((Number(duration.data[0]) / SPEED) * SR));
  const Lc = Math.max(1, Math.ceil(target / (HOP * COMPRESS)));
  const CH = DIM * COMPRESS;

  const { text_emb } = await te.run({ text_ids: textIds, style_ttl: styleTtl, text_mask: textMask });

  // Fixed seed per sentence position: 4-step and 8-step runs start identically.
  const rng = makeRng(0xC0FFEE + seedIndex++ * 7919);
  let latent = new ort.Tensor('float32', Float32Array.from({ length: CH * Lc }, () => gaussianFrom(rng)), [1, CH, Lc]);
  const latentMask = new ort.Tensor('float32', new Float32Array(Lc).fill(1), [1, 1, Lc]);

  const t0 = Date.now();
  for (let s = 0; s < STEPS; s += 1) {
    const out = await ve.run({
      noisy_latent: latent, text_emb, style_ttl: styleTtl, latent_mask: latentMask, text_mask: textMask,
      current_step: new ort.Tensor('float32', Float32Array.from([s]), [1]),
      total_step: new ort.Tensor('float32', Float32Array.from([STEPS]), [1])
    });
    latent = out.denoised_latent;
  }
  const { wav_tts } = await voc.run({ latent });
  const audio = wav_tts.data.subarray(0, Math.min(wav_tts.data.length, target));
  chunks.push(audio);

  let peak = 0, sq = 0;
  for (let i = 0; i < audio.length; i += 1) { const v = Math.abs(audio[i]); if (v > peak) peak = v; sq += audio[i] * audio[i]; }
  console.log(
    `  "${sentence.slice(0, 40)}..."  ${(audio.length / SR).toFixed(2)}s  ` +
      `peak ${peak.toFixed(3)}  rms ${Math.sqrt(sq / audio.length).toFixed(4)}  ` +
      `${((Date.now() - t0) / 1000).toFixed(1)}s wall`
  );
}

const total = chunks.reduce((n, c) => n + c.length, 0);
const joined = new Float32Array(total);
let at = 0;
for (const c of chunks) { joined.set(c, at); at += c.length; }

const elapsed = (Date.now() - wall0) / 1000;
console.log(`\n  passage ${(total / SR).toFixed(2)}s in ${elapsed.toFixed(1)}s = ${(total / SR / elapsed).toFixed(2)}x realtime`);

const pcm = Buffer.alloc(joined.length * 2);
for (let i = 0; i < joined.length; i += 1) {
  pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(joined[i] * 32767))), i * 2);
}
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(SR, 24);
h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36);
h.writeUInt32LE(pcm.length, 40);
const out = join(HERE, `passage-${String(STEPS).padStart(2, '0')}step.wav`);
await writeFile(out, Buffer.concat([h, pcm]));
console.log(`  wrote ${out.split(/[\\/]/).pop()}`);
