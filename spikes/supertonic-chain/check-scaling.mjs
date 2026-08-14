/**
 * U11 spike, step 3: confirm the scalar really is total duration.
 *
 * If `duration` scales with text length at a plausible speaking rate, it is a
 * per-utterance length prediction — which makes sentence-bounded proportional
 * distribution a *well-anchored* fallback rather than a guess: every sentence
 * starts and ends on a model-predicted boundary.
 */
import ort from 'onnxruntime-web';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

const ROOT = join(import.meta.dirname, 'models');
const indexer = JSON.parse(await readFile(join(ROOT, 'onnx', 'unicode_indexer.json'), 'utf8'));

function styleTensor(style) {
  const flat = [];
  (function f(x) {
    if (Array.isArray(x)) x.forEach(f);
    else flat.push(x);
  })(style.style_dp.data);
  return new ort.Tensor('float32', Float32Array.from(flat), [1, 8, 16]);
}

const session = await ort.InferenceSession.create(join(ROOT, 'onnx', 'duration_predictor.onnx'), {
  executionProviders: ['wasm']
});

const SAMPLES = [
  'Jesus wept.',
  'In the beginning God created the heaven and the earth.',
  'And God said, Let there be light: and there was light. And God saw the light, that it was good.',
  'The LORD is my shepherd; I shall not want. He maketh me to lie down in green pastures: he leadeth me beside the still waters. He restoreth my soul.'
];

for (const voice of ['F1', 'M1']) {
  const style = JSON.parse(await readFile(join(ROOT, 'voice_styles', `${voice}.json`), 'utf8'));
  const styleDp = styleTensor(style);
  console.log(`\nvoice ${voice}`);
  console.log('  chars  words  seconds   wpm    text');

  for (const text of SAMPLES) {
    const ids = [...text].map((ch) => {
      const cp = ch.codePointAt(0);
      return cp < indexer.length ? indexer[cp] : 0;
    });
    const out = await session.run({
      text_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      text_mask: new ort.Tensor('float32', Float32Array.from(ids.map(() => 1)), [1, 1, ids.length]),
      style_dp: styleDp
    });
    const seconds = Number(out.duration.data[0]);
    const words = text.trim().split(/\s+/).length;
    console.log(
      `  ${String(text.length).padStart(5)}  ${String(words).padStart(5)}  ` +
        `${seconds.toFixed(3).padStart(7)}  ${((words / seconds) * 60).toFixed(0).padStart(4)}    ` +
        `"${text.slice(0, 42)}${text.length > 42 ? '…' : ''}"`
    );
  }
}
