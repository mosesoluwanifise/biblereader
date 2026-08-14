/**
 * Runs our chain on the reference's exact noise and inputs, then reports the
 * first tensor that diverges. Listening tests could not localise the quality
 * gap; this can.
 */
import ort from 'onnxruntime-web';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

const HERE = import.meta.dirname;
const BUNDLE = join(HERE, '..', '..', 'public', 'models', 'supertonic-3');
const SR = 44100;

const ref = JSON.parse(await readFile(join(HERE, 'reference-dump.json'), 'utf8'));
const indexer = JSON.parse(await readFile(join(BUNDLE, 'onnx', 'unicode_indexer.json'), 'utf8'));
const styleJson = JSON.parse(await readFile(join(BUNDLE, 'voice_styles', 'F1.json'), 'utf8'));

const mk = (node) => {
  const flat = [];
  (function w(x) {
    Array.isArray(x) ? x.forEach(w) : flat.push(x);
  })(node.data);
  const dims = [];
  let c = node.data;
  while (Array.isArray(c)) {
    dims.push(c.length);
    c = c[0];
  }
  return new ort.Tensor('float32', Float32Array.from(flat), dims);
};
const styleTtl = mk(styleJson.style_ttl);
const styleDp = mk(styleJson.style_dp);

const load = (g) =>
  ort.InferenceSession.create(join(BUNDLE, 'onnx', `${g}.onnx`), { executionProviders: ['wasm'] });
const [dp, te, ve, voc] = await Promise.all([
  load('duration_predictor'),
  load('text_encoder'),
  load('vector_estimator'),
  load('vocoder')
]);

function stats(name, data, dims) {
  const a = Array.from(data, Number);
  const mean = a.reduce((s, v) => s + v, 0) / a.length;
  const std = Math.sqrt(a.reduce((s, v) => s + (v - mean) ** 2, 0) / a.length);
  let min = Infinity, max = -Infinity;
  for (const v of a) { if (v < min) min = v; if (v > max) max = v; }
  return { name, shape: dims, mean, std, min, max, first8: a.slice(0, 8) };
}

function compare(mine, theirs) {
  const shapeMatch = JSON.stringify(mine.shape) === JSON.stringify(theirs.shape);
  const rel = (a, b) => (Math.abs(b) < 1e-9 ? Math.abs(a - b) : Math.abs(a - b) / Math.abs(b));
  const meanOff = rel(mine.mean, theirs.mean);
  const stdOff = rel(mine.std, theirs.std);
  const ok = shapeMatch && stdOff < 0.02 && Math.abs(mine.mean - theirs.mean) < 0.02;
  console.log(
    `  ${mine.name.padEnd(14)} ${ok ? 'MATCH ' : 'DIFFER'} ` +
      `shape ${JSON.stringify(mine.shape)}${shapeMatch ? '' : ` vs ${JSON.stringify(theirs.shape)}`}  ` +
      `mean ${mine.mean.toFixed(5)} vs ${theirs.mean.toFixed(5)}  ` +
      `std ${mine.std.toFixed(5)} vs ${theirs.std.toFixed(5)}` +
      (ok ? '' : `   (std off ${(stdOff * 100).toFixed(1)}%)`)
  );
  return ok;
}

// --- inputs -----------------------------------------------------------------
const TEXT = ref.text;
const ids = [...TEXT].map((ch) => {
  const cp = ch.codePointAt(0);
  return cp < indexer.length ? indexer[cp] : 0;
});
const idsMatch = JSON.stringify(ids) === JSON.stringify(ref.text_ids);
console.log(`text_ids       ${idsMatch ? 'MATCH' : 'DIFFER'} (${ids.length} tokens)`);
if (!idsMatch) {
  console.log('  ours  :', ids.slice(0, 16).join(','));
  console.log('  theirs:', ref.text_ids.slice(0, 16).join(','));
}

const N = ids.length;
const textIds = new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, N]);
const textMask = new ort.Tensor('float32', new Float32Array(N).fill(1), [1, 1, N]);

// --- duration ---------------------------------------------------------------
const { duration } = await dp.run({ text_ids: textIds, style_dp: styleDp, text_mask: textMask });
const durRaw = Number(duration.data[0]);
const durScaled = durRaw / ref.speed;
console.log(
  `duration       ${Math.abs(durRaw - ref.duration_raw) < 1e-3 ? 'MATCH' : 'DIFFER'} ` +
    `raw ${durRaw.toFixed(4)} vs ${ref.duration_raw.toFixed(4)}  ` +
    `scaled ${durScaled.toFixed(4)} vs ${ref.duration_scaled.toFixed(4)}`
);

// --- latent grid ------------------------------------------------------------
const chunk = 512 * 6;
const latentLen = Math.max(1, Math.ceil(Math.round(durScaled * SR) / chunk));
console.log(
  `latent_len     ${latentLen === ref.latent_len ? 'MATCH' : 'DIFFER'} ${latentLen} vs ${ref.latent_len}`
);

console.log('\ntensors:');
const refByName = Object.fromEntries(ref.tensors.map((t) => [t.name, t]));

// --- text encoder -----------------------------------------------------------
const enc = await te.run({ text_ids: textIds, style_ttl: styleTtl, text_mask: textMask });
compare(stats('text_emb', enc.text_emb.data, enc.text_emb.dims), refByName.text_emb);

// --- flow matching on the reference's own noise ------------------------------
const CH = ref.latent_dim;
const L = ref.latent_len;
let latent = new ort.Tensor('float32', Float32Array.from(ref.noise), [1, CH, L]);
const latentMask = new ort.Tensor('float32', new Float32Array(L).fill(1), [1, 1, L]);

for (let s = 0; s < ref.total_step; s += 1) {
  const out = await ve.run({
    noisy_latent: latent,
    text_emb: enc.text_emb,
    style_ttl: styleTtl,
    latent_mask: latentMask,
    text_mask: textMask,
    current_step: new ort.Tensor('float32', Float32Array.from([s]), [1]),
    total_step: new ort.Tensor('float32', Float32Array.from([ref.total_step]), [1])
  });
  latent = out.denoised_latent;
}
compare(stats('latent_final', latent.data, latent.dims), refByName.latent_final);

// --- vocoder ----------------------------------------------------------------
const { wav_tts } = await voc.run({ latent });
const wav = wav_tts.data;
compare(stats('wav', wav, [wav.length]), refByName.wav);

console.log(
  `\nwav length     ${wav.length === ref.wav_len ? 'MATCH' : 'DIFFER'} ${wav.length} vs ${ref.wav_len}`
);

// Sample-level agreement is the real test: matching statistics can still hide
// a different waveform.
const n = Math.min(wav.length, ref.wav_len);
let maxAbs = 0;
let sumSq = 0;
for (let i = 0; i < Math.min(n, ref.wav_first32.length); i += 1) {
  maxAbs = Math.max(maxAbs, Math.abs(wav[i] - ref.wav_first32[i]));
}
for (let i = 0; i < n; i += 1) sumSq += wav[i] * wav[i];
console.log(`first32 max |diff| ${maxAbs.toExponential(2)}`);
console.log(`our wav rms ${Math.sqrt(sumSq / n).toFixed(5)} vs reference ${refByName.wav.std.toFixed(5)}`);

// Write ours for listening alongside the reference's own render.
const pcm = Buffer.alloc(wav.length * 2);
for (let i = 0; i < wav.length; i += 1) {
  pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(wav[i] * 32767))), i * 2);
}
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(SR, 24);
h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36);
h.writeUInt32LE(pcm.length, 40);
await writeFile(join(HERE, 'diff-ours-sameseed.wav'), Buffer.concat([h, pcm]));
console.log('wrote diff-ours-sameseed.wav');
