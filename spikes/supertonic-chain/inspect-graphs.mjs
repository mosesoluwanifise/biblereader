/**
 * U11 spike, step 1: what are the real tensor signatures?
 *
 * Loads each graph through onnxruntime-web (the runtime the app will actually
 * use, in its Node/WASM mode) and prints input and output names, types, and
 * shapes. The plan's chain diagram is inferred from filenames; this replaces
 * inference with fact.
 */
import ort from 'onnxruntime-web';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

const MODELS = join(import.meta.dirname, 'models', 'onnx');

function describe(meta, names) {
  return names.map((n) => {
    const m = meta[n];
    if (!m) return `    ${n}: <no metadata>`;
    const dims = Array.isArray(m.dims ?? m.shape) ? (m.dims ?? m.shape).join(' x ') : '?';
    return `    ${n.padEnd(22)} ${String(m.type ?? '?').padEnd(10)} [${dims}]`;
  });
}

const files = (await readdir(MODELS)).filter((f) => f.endsWith('.onnx')).sort();
console.log(`Found ${files.length} graph(s)\n`);

for (const file of files) {
  const path = join(MODELS, file);
  const size = (await stat(path)).size / 1048576;
  process.stdout.write(`${file}  (${size.toFixed(1)} MB)\n`);

  try {
    const session = await ort.InferenceSession.create(path, { executionProviders: ['wasm'] });
    console.log('  inputs:');
    for (const line of describe(session.inputMetadata ?? {}, session.inputNames)) console.log(line);
    console.log('  outputs:');
    for (const line of describe(session.outputMetadata ?? {}, session.outputNames)) console.log(line);
  } catch (err) {
    console.log(`  LOAD FAILED: ${err.message.split('\n')[0]}`);
  }
  console.log('');
}
