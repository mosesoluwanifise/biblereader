/**
 * Reproduces the app's synthesis path over a multi-sentence passage and
 * measures what happens at the seams.
 *
 * Two suspects for glitchy playback:
 *   1. We cut each utterance at an arbitrary sample (targetSamples). If the
 *      waveform is not near zero there, every sentence ends in a click.
 *   2. The controller starts each buffer from the previous buffer's `onended`
 *      callback, so the next sentence is scheduled a JS event-loop turn late —
 *      an audible gap at every join.
 * This measures (1) directly; (2) is a scheduling fact, reported for context.
 */
import ort from 'onnxruntime-web';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

ort.env.wasm.numThreads = 4;
ort.env.logLevel = 'error';

const HERE = import.meta.dirname;
const BUNDLE = join(HERE, '..', '..', 'public', 'models', 'supertonic-3');
const SR = 44100, HOP = 512, DIM = 24, COMPRESS = 6, SPEED = 1.05, STEPS = 4;

// Genesis 1:1-3, i.e. what the reader actually hears first.
const PASSAGE =
  'In the beginning God created the heaven and the earth. ' +
  'And the earth was without form, and void; and darkness was upon the face of the deep. ' +
  'And God said, Let there be light: and there was light.';

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

// Mirrors splitSentences()
const sentences = PASSAGE.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).filter(Boolean);
console.log(`passage split into ${sentences.length} sentences\n`);

const chunks = [];
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

  // How loud is the signal exactly where we cut?
  const edge = Math.abs(trimmed[trimmed.length - 1]);
  const tailRms = Math.sqrt(
    Array.from(trimmed.slice(-441)).reduce((s, v) => s + v * v, 0) / 441
  );
  const headRms = Math.sqrt(
    Array.from(trimmed.slice(0, 441)).reduce((s, v) => s + v * v, 0) / 441
  );
  const droppedRms = full.length > target
    ? Math.sqrt(Array.from(full.slice(target)).reduce((s, v) => s + v * v, 0) / (full.length - target))
    : 0;

  chunks.push(trimmed);
  console.log(
    `  "${sentence.slice(0, 34)}..."\n` +
      `    kept ${(trimmed.length / SR).toFixed(2)}s of ${(full.length / SR).toFixed(2)}s  ` +
      `cut-sample |${edge.toFixed(4)}|  last-10ms rms ${tailRms.toFixed(4)}  ` +
      `first-10ms rms ${headRms.toFixed(4)}  discarded rms ${droppedRms.toFixed(4)}`
  );
}

// Join exactly as the controller does: buffers played back to back.
const total = chunks.reduce((n, c) => n + c.length, 0);
const joined = new Float32Array(total);
let at = 0;
const seams = [];
for (const c of chunks) {
  if (at > 0) seams.push(at);
  joined.set(c, at);
  at += c.length;
}

console.log('\nseam discontinuities (|sample step| across the join):');
for (const s of seams) {
  const jump = Math.abs(joined[s] - joined[s - 1]);
  console.log(`  at ${(s / SR).toFixed(2)}s  step ${jump.toFixed(4)}${jump > 0.05 ? '   <-- audible click' : ''}`);
}

const pcm = Buffer.alloc(joined.length * 2);
for (let i = 0; i < joined.length; i += 1) {
  pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(joined[i] * 32767))), i * 2);
}
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(SR, 24);
h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36);
h.writeUInt32LE(pcm.length, 40);
await writeFile(join(HERE, 'fixed-joined.wav'), Buffer.concat([h, pcm]));
console.log(`\nwrote glitch-joined.wav (${(joined.length / SR).toFixed(2)}s)`);
