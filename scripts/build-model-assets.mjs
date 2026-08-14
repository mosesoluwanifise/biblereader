#!/usr/bin/env node
/**
 * Builds the Supertonic model bundle under public/models/supertonic-3/.
 *
 * Downloads the four ONNX graphs, the tokenizer, and the ten voice styles from
 * the official Supertone release, then carries the licensing obligations that
 * shipping those weights to a browser creates.
 *
 * BigScience Open RAIL-M, section 4, applies because serving weights to a
 * client is Distribution:
 *   4(b) recipients must be given a copy of the license -> LICENSE is copied
 *        verbatim into the bundle and served as a static asset.
 *   4(c) modified files must carry prominent change notices -> NOTICE records
 *        any quantization applied here.
 *   4(d) attribution notices must be retained -> recorded in NOTICE.
 * Section 7 obliges reasonable effort to run the latest model version, which
 * the manifest's version field lets the client detect.
 *
 * Quantization is optional. When the Python toolchain is unavailable the
 * bundle is still correct, just larger, and the manifest says which it is.
 */

import { mkdir, writeFile, readFile, stat, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'models', 'supertonic-3');
const REPO = 'Supertone/supertonic-3';
const BASE = `https://huggingface.co/${REPO}/resolve/main`;

export const GRAPHS = ['duration_predictor', 'text_encoder', 'vector_estimator', 'vocoder'];
export const VOICE_STYLES = ['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'];
const SUPPORT_FILES = ['onnx/tts.json', 'onnx/unicode_indexer.json'];

/** Graphs small enough that quantizing them saves little and risks quality. */
export const QUANTIZE_SKIP = new Set(['duration_predictor']);

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function download(remote, local) {
  if (await exists(local)) return { cached: true, bytes: (await stat(local)).size };

  const res = await fetch(`${BASE}/${remote}`);
  if (!res.ok) throw new Error(`${remote}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(local), { recursive: true });
  await writeFile(local, buf);
  return { cached: false, bytes: buf.length };
}

/** Dynamic int8 quantization via onnxruntime's Python tooling, if present. */
async function quantize(src, dest) {
  const script = `
import sys
from onnxruntime.quantization import quantize_dynamic, QuantType
quantize_dynamic(sys.argv[1], sys.argv[2], weight_type=QuantType.QInt8)
`;
  await run('python', ['-c', script, src, dest], { maxBuffer: 1 << 26 });
}

async function quantizationAvailable() {
  try {
    await run('python', ['-c', 'import onnxruntime.quantization']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Quantization is opt-in (`--quantize`) and currently a bad trade.
 *
 * int8 shrinks the bundle from 380 MB to 102.7 MB, but on WASM it has no
 * optimized kernels and dequantizes per operation: 0.08x realtime against
 * fp32's 0.62x at eight flow steps, and it never clears realtime at any step
 * count. Worse, listening tests found int8 output unintelligible where fp32 is
 * clear — a difference that RMS comparison completely missed, because the
 * energy is identical while the speech is destroyed.
 *
 * Keep the flag for measuring fp16 or a future static quantization, but fp32
 * is what ships.
 */
const WANT_QUANTIZE = process.argv.includes('--quantize');

async function main() {
  await mkdir(join(OUT, 'onnx'), { recursive: true });
  await mkdir(join(OUT, 'voice_styles'), { recursive: true });

  const canQuantize = WANT_QUANTIZE && (await quantizationAvailable());
  console.log(
    WANT_QUANTIZE
      ? `quantization: ${canQuantize ? 'int8 (onnxruntime)' : 'requested but tooling unavailable — shipping fp32'}\n`
      : 'quantization: off — shipping fp32 (int8 is slower and unintelligible; pass --quantize to override)\n'
  );

  const files = [];
  const record = async (relative) => {
    const buf = await readFile(join(OUT, relative));
    files.push({ path: relative, bytes: buf.length, sha256: sha256(buf) });
  };

  for (const name of SUPPORT_FILES) {
    const { bytes } = await download(name, join(OUT, name));
    await record(name);
    console.log(`  ${name.padEnd(34)} ${(bytes / 1024).toFixed(0)} KB`);
  }

  for (const style of VOICE_STYLES) {
    const rel = `voice_styles/${style}.json`;
    await download(rel, join(OUT, rel));
    await record(rel);
  }
  console.log(`  ${'voice_styles/*.json'.padEnd(34)} ${VOICE_STYLES.length} styles`);

  let quantizedAny = false;
  for (const graph of GRAPHS) {
    const rel = `onnx/${graph}.onnx`;
    const raw = join(OUT, `onnx/${graph}.fp32.onnx`);
    const { bytes } = await download(rel, raw);

    const target = join(OUT, rel);
    let finalBytes = bytes;

    if (canQuantize && !QUANTIZE_SKIP.has(graph)) {
      if (!(await exists(target))) {
        process.stdout.write(`  ${rel.padEnd(34)} quantizing ${(bytes / 1048576).toFixed(0)} MB...`);
        try {
          await quantize(raw, target);
          quantizedAny = true;
        } catch (err) {
          console.log(` failed (${err.message.split('\n')[0].slice(0, 60)}) — using fp32`);
          await writeFile(target, await readFile(raw));
        }
      } else {
        quantizedAny = true;
      }
      finalBytes = (await stat(target)).size;
      process.stdout.write(`\r  ${rel.padEnd(34)} ${(finalBytes / 1048576).toFixed(1)} MB (int8, from ${(bytes / 1048576).toFixed(0)} MB)\n`);
    } else {
      if (!(await exists(target))) await writeFile(target, await readFile(raw));
      console.log(`  ${rel.padEnd(34)} ${(finalBytes / 1048576).toFixed(1)} MB (fp32)`);
    }

    await record(rel);
  }

  // 4(b): the license travels with the weights.
  const { bytes: licenseBytes } = await download('LICENSE', join(OUT, 'LICENSE'));
  await record('LICENSE');
  console.log(`  ${'LICENSE'.padEnd(34)} ${(licenseBytes / 1024).toFixed(1)} KB`);

  // 4(c) and 4(d): change notice and attribution.
  const notice = `Supertonic model weights
========================

Source:  https://huggingface.co/${REPO}
License: BigScience Open RAIL-M (see LICENSE, distributed with these weights)

Attribution
-----------
The model weights in this directory are the work of Supertone, Inc. and are
redistributed here under the terms of the accompanying license. No endorsement
by Supertone is claimed or implied.

Modifications
-------------
${
  quantizedAny
    ? `The following graphs were modified from the upstream release: weights were
dynamically quantized from float32 to int8 to reduce download size for
in-browser inference. No other change was made to the model architecture,
weights, or outputs.

  ${GRAPHS.filter((g) => !QUANTIZE_SKIP.has(g))
    .map((g) => `onnx/${g}.onnx`)
    .join('\n  ')}

Graphs left unmodified from upstream:

  ${[...QUANTIZE_SKIP].map((g) => `onnx/${g}.onnx`).join('\n  ')}`
    : `No modifications were made to the upstream weights. All graphs in this
directory are byte-identical to the upstream release.`
}

Use restrictions
----------------
Use of these weights is subject to the use-based restrictions in Attachment A
of the accompanying license. Those restrictions are carried into this
application's terms of use, which bind end users. See docs/TERMS.md.

Audio produced by these weights is machine-generated and is disclosed as such
in the application interface, per Attachment A(e).
`;
  await writeFile(join(OUT, 'NOTICE'), notice, 'utf8');
  await record('NOTICE');

  // Section 7: lets the client notice an upstream update instead of serving
  // stale weights from cache forever.
  const manifest = {
    name: 'supertonic-3',
    source: `https://huggingface.co/${REPO}`,
    license: 'BigScience Open RAIL-M',
    quantization: quantizedAny ? 'int8-dynamic' : 'none',
    builtAt: new Date().toISOString(),
    sampleRate: 44100,
    graphs: GRAPHS,
    voiceStyles: VOICE_STYLES,
    files: files.sort((a, b) => a.path.localeCompare(b.path))
  };
  manifest.version = sha256(Buffer.from(files.map((f) => f.sha256).sort().join(''))).slice(0, 16);
  await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const total = files.reduce((sum, f) => sum + f.bytes, 0);
  console.log(`\n  bundle version ${manifest.version}`);
  console.log(`  total ${(total / 1048576).toFixed(1)} MB across ${files.length} files`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
