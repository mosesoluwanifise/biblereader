/**
 * Language tag on vs off, everything else identical.
 *
 * Supertonic-3 conditions on a `<en>...</en>` wrapper. We were sending none.
 * The duration predictor alone scores the same sentence 4.4369s untagged
 * against 3.6964s tagged, so the untagged render is ~20% slow before prosody
 * is even considered.
 */
import ort from 'onnxruntime-web';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

const HERE = import.meta.dirname;
const BUNDLE = join(HERE, '..', '..', 'public', 'models', 'supertonic-3');
const SR = 44100, HOP = 512, DIM = 24, COMPRESS = 6, SPEED = 1.05, STEPS = 8;
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

const load = (g) => ort.InferenceSession.create(join(BUNDLE, 'onnx', `${g}.onnx`), { executionProviders: ['wasm'] });
const [dp, te, ve, voc] = await Promise.all([
  load('duration_predictor'), load('text_encoder'), load('vector_estimator'), load('vocoder')
]);

function writeWav(name, samples) {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return writeFile(join(HERE, `${name}.wav`), Buffer.concat([h, pcm]));
}

async function render(label, promptText) {
  const ids = [...promptText].map((ch) => {
    const cp = ch.codePointAt(0);
    return cp < indexer.length ? indexer[cp] : 0;
  });
  const n = ids.length;
  const textIds = new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, n]);
  const textMask = new ort.Tensor('float32', new Float32Array(n).fill(1), [1, 1, n]);

  const { duration } = await dp.run({ text_ids: textIds, style_dp: styleDp, text_mask: textMask });
  const raw = Number(duration.data[0]);
  const scaled = raw / SPEED;
  const target = Math.max(1, Math.round(scaled * SR));
  const Lc = Math.max(1, Math.ceil(target / (HOP * COMPRESS)));
  const CH = DIM * COMPRESS;

  const { text_emb } = await te.run({ text_ids: textIds, style_ttl: styleTtl, text_mask: textMask });
  let latent = new ort.Tensor('float32', Float32Array.from({ length: CH * Lc }, () => {
    const u = Math.random() || 1e-9;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
  }), [1, CH, Lc]);
  const latentMask = new ort.Tensor('float32', new Float32Array(Lc).fill(1), [1, 1, Lc]);

  for (let s = 0; s < STEPS; s += 1) {
    const out = await ve.run({
      noisy_latent: latent, text_emb, style_ttl: styleTtl, latent_mask: latentMask, text_mask: textMask,
      current_step: new ort.Tensor('float32', Float32Array.from([s]), [1]),
      total_step: new ort.Tensor('float32', Float32Array.from([STEPS]), [1])
    });
    latent = out.denoised_latent;
  }

  const { wav_tts } = await voc.run({ latent });
  const full = wav_tts.data;
  const trimmed = full.subarray(0, Math.min(full.length, target));
  await writeWav(label, trimmed);

  const words = TEXT.trim().split(/\s+/).length;
  console.log(
    `  ${label.padEnd(22)} tokens ${String(n).padStart(3)}  ` +
      `predicted ${raw.toFixed(4)}s -> ${scaled.toFixed(3)}s  ` +
      `audio ${(trimmed.length / SR).toFixed(2)}s  ${((words / (trimmed.length / SR)) * 60).toFixed(0)} wpm`
  );
}

console.log(`text: "${TEXT}" (${TEXT.trim().split(/\s+/).length} words)\n`);
await render('lang-tagged', `<en>${TEXT}</en>`);
await render('lang-untagged', TEXT);
