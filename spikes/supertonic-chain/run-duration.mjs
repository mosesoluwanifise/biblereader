/**
 * U11 spike, step 2: does the duration predictor give per-token timing?
 *
 * KTD5 assumes word-level timestamps can be read from this graph's output.
 * If `duration` comes back with one value per input character, word timing is
 * derivable by summing over each word's characters. If it comes back as a
 * single scalar, it predicts only total utterance length and KTD5 is wrong —
 * U7 must fall back to sentence-bounded proportional distribution.
 */
import ort from 'onnxruntime-web';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

const ROOT = join(import.meta.dirname, 'models');

const indexer = JSON.parse(await readFile(join(ROOT, 'onnx', 'unicode_indexer.json'), 'utf8'));
const style = JSON.parse(await readFile(join(ROOT, 'voice_styles', 'F1.json'), 'utf8'));

function tensorFrom(node, name) {
  // Style entries look like { data: nested arrays, dims?: [...] }.
  const flat = [];
  (function flatten(x) {
    if (Array.isArray(x)) x.forEach(flatten);
    else flat.push(x);
  })(node.data ?? node);

  let dims = node.dims ?? node.shape;
  if (!dims) {
    // Recover dims by walking the nesting depth of the source array.
    dims = [];
    let cursor = node.data ?? node;
    while (Array.isArray(cursor)) {
      dims.push(cursor.length);
      cursor = cursor[0];
    }
  }
  console.log(`  ${name}: dims=[${dims.join(', ')}] values=${flat.length}`);
  return new ort.Tensor('float32', Float32Array.from(flat), dims);
}

function encode(text) {
  const ids = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    ids.push(cp < indexer.length ? indexer[cp] : 0);
  }
  return ids;
}

const TEXT = 'In the beginning God created the heaven and the earth.';
const ids = encode(TEXT);

console.log(`text        : "${TEXT}"`);
console.log(`characters  : ${TEXT.length}`);
console.log(`words       : ${TEXT.trim().split(/\s+/).length}`);
console.log(`token ids   : ${ids.length}  first 12: [${ids.slice(0, 12).join(', ')}]`);
console.log('');

console.log('style tensors:');
const styleDp = tensorFrom(style.style_dp, 'style_dp');
console.log('');

const session = await ort.InferenceSession.create(join(ROOT, 'onnx', 'duration_predictor.onnx'), {
  executionProviders: ['wasm']
});

const feeds = {
  text_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
  text_mask: new ort.Tensor('float32', Float32Array.from(ids.map(() => 1)), [1, 1, ids.length]),
  style_dp: styleDp
};

console.log('running duration_predictor...');
let out;
try {
  out = await session.run(feeds);
} catch (err) {
  console.log(`\n  RUN FAILED: ${String(err.message).split('\n')[0].slice(0, 300)}`);
  process.exit(1);
}
const duration = out.duration;

console.log('');
console.log('=== RESULT ===');
console.log(`  output dims : [${duration.dims.join(', ')}]`);
console.log(`  value count : ${duration.data.length}`);
console.log(`  values      : ${Array.from(duration.data).slice(0, 12).map((v) => Number(v).toFixed(4)).join(', ')}${duration.data.length > 12 ? ' ...' : ''}`);
console.log('');

if (duration.data.length === 1) {
  console.log('  VERDICT: single scalar — total utterance length only.');
  console.log('  KTD5 is wrong. Per-word timing is NOT derivable from this graph.');
} else if (duration.data.length === ids.length) {
  console.log('  VERDICT: one value per character — per-token durations available.');
  console.log('  KTD5 holds. Word timing = sum of each word\'s character durations.');
} else {
  console.log(`  VERDICT: ${duration.data.length} values for ${ids.length} characters — needs interpretation.`);
}
