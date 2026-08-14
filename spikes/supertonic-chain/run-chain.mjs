/**
 * U11 spike, step 4: does the full chain actually produce audio?
 *
 * duration_predictor -> latent length
 * text_encoder       -> text_emb
 * vector_estimator   -> iterative flow-matching denoise
 * vocoder            -> waveform
 *
 * Writes a WAV so the result can be listened to, not just measured.
 */
import ort from 'onnxruntime-web';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

const ROOT = join(import.meta.dirname, 'models');
const SAMPLE_RATE = 44100;
const HOP = 512; // ae.base_chunk_size
const LATENT_DIM = 24; // ae.ldim
const STEPS = 8; // flow-matching steps

const indexer = JSON.parse(await readFile(join(ROOT, 'onnx', 'unicode_indexer.json'), 'utf8'));
const style = JSON.parse(await readFile(join(ROOT, 'voice_styles', 'F1.json'), 'utf8'));

function flatten(node) {
  const out = [];
  (function walk(x) {
    if (Array.isArray(x)) x.forEach(walk);
    else out.push(x);
  })(node.data ?? node);
  return Float32Array.from(out);
}

function dimsOf(node) {
  const dims = [];
  let cursor = node.data ?? node;
  while (Array.isArray(cursor)) {
    dims.push(cursor.length);
    cursor = cursor[0];
  }
  return dims;
}

const styleTtl = new ort.Tensor('float32', flatten(style.style_ttl), dimsOf(style.style_ttl));
const styleDp = new ort.Tensor('float32', flatten(style.style_dp), dimsOf(style.style_dp));
console.log(`style_ttl dims [${styleTtl.dims.join(', ')}]   style_dp dims [${styleDp.dims.join(', ')}]`);

const load = (f) =>
  ort.InferenceSession.create(join(ROOT, 'onnx', f), { executionProviders: ['wasm'] });

console.log('loading graphs...');
const t0 = Date.now();
const [dp, te, ve, voc] = await Promise.all([
  load('duration_predictor.onnx'),
  load('text_encoder.onnx'),
  load('vector_estimator.onnx'),
  load('vocoder.onnx')
]);
console.log(`  loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

const TEXT = 'In the beginning God created the heaven and the earth.';
const ids = [...TEXT].map((ch) => {
  const cp = ch.codePointAt(0);
  return cp < indexer.length ? indexer[cp] : 0;
});
const N = ids.length;

const textIds = new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, N]);
const textMask = new ort.Tensor('float32', new Float32Array(N).fill(1), [1, 1, N]);

const tSynth = Date.now();

// 1. duration
const { duration } = await dp.run({ text_ids: textIds, style_dp: styleDp, text_mask: textMask });
const seconds = Number(duration.data[0]);
const L = Math.max(1, Math.round((seconds * SAMPLE_RATE) / HOP));
console.log(`duration    : ${seconds.toFixed(3)}s  ->  ${L} latent frames`);

// 2. text embedding
const { text_emb: textEmb } = await te.run({ text_ids: textIds, style_ttl: styleTtl, text_mask: textMask });
console.log(`text_emb    : [${textEmb.dims.join(', ')}]`);

// 3. iterative denoise from noise.
// The denoiser runs on latents compressed by ttl.chunk_compress_factor: it
// wants 24 * 6 = 144 channels at one sixth the frame rate.
const COMPRESS = 6;
const Lc = Math.max(1, Math.ceil(L / COMPRESS));
const CH = LATENT_DIM * COMPRESS;
console.log(`compressed  : [1, ${CH}, ${Lc}]`);

let latent = new ort.Tensor(
  'float32',
  Float32Array.from({ length: CH * Lc }, () => {
    // Box-Muller: flow matching starts from a standard normal prior.
    const u = Math.random() || 1e-9;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
  }),
  [1, CH, Lc]
);
const latentMask = new ort.Tensor('float32', new Float32Array(Lc).fill(1), [1, 1, Lc]);

for (let step = 0; step < STEPS; step += 1) {
  const out = await ve.run({
    noisy_latent: latent,
    text_emb: textEmb,
    style_ttl: styleTtl,
    latent_mask: latentMask,
    text_mask: textMask,
    current_step: new ort.Tensor('float32', Float32Array.from([step]), [1]),
    total_step: new ort.Tensor('float32', Float32Array.from([STEPS]), [1])
  });
  latent = out.denoised_latent;
  if (step === 0) console.log(`denoised    : [${latent.dims.join(', ')}]`);
}

// 4. vocode. The vocoder takes the compressed latent directly — it expects the
// same 144 channels the denoiser emits and expands internally.
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

console.log(`wav_tts     : [${wav.dims.join(', ')}]  = ${(samples.length / SAMPLE_RATE).toFixed(2)}s audio`);
console.log(`peak ${peak.toFixed(4)}   rms ${rms.toFixed(4)}`);
console.log(`synthesis   : ${elapsed.toFixed(1)}s for ${seconds.toFixed(1)}s audio (${(seconds / elapsed).toFixed(2)}x realtime, WASM 1 thread)`);

// Write a WAV so this is audible, not just numeric.
const pcm = Buffer.alloc(samples.length * 2);
for (let i = 0; i < samples.length; i += 1) {
  pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
}
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(SAMPLE_RATE, 24);
header.writeUInt32LE(SAMPLE_RATE * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(pcm.length, 40);

const outPath = join(import.meta.dirname, 'genesis-1-1.wav');
await writeFile(outPath, Buffer.concat([header, pcm]));

console.log('');
if (rms > 0.001 && peak > 0.01) {
  console.log(`VERDICT: chain produces audio. Written to ${outPath}`);
} else {
  console.log('VERDICT: chain ran but output is silent — shapes or step schedule are wrong.');
}
