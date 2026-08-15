#!/usr/bin/env node
/**
 * Pushes the Supertonic model bundle into R2 for the Cloudflare Pages deploy.
 *
 * Cloudflare Pages caps a static asset at 25 MiB; vector_estimator.onnx alone
 * is 244.7 MB fp32. The bundle cannot ship as an ordinary Pages asset, so it
 * lives in R2 instead and functions/models/[[path]].js proxies it same-origin
 * — see that file for why same-origin specifically matters here (COEP).
 *
 * The local manifest.json that build-model-assets.mjs already writes is the
 * source of truth for what to upload: every path it lists, uploaded to the
 * matching supertonic-3/ key, with the exact content type and byte size it
 * recorded. Requires `npx wrangler login` once beforehand.
 *
 *   npm run deploy:models
 *   npm run deploy:models -- --bucket=my-other-bucket
 */

import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_DIR = join(ROOT, 'public', 'models', 'supertonic-3');
const DEFAULT_BUCKET = 'scripture-voice-models';

function contentTypeFor(path) {
  if (path.endsWith('.onnx')) return 'application/octet-stream';
  if (path.endsWith('.json')) return 'application/json';
  if (path === 'LICENSE' || path === 'NOTICE') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function parseBucketArg(argv) {
  const flag = argv.find((a) => a.startsWith('--bucket='));
  return flag ? flag.slice('--bucket='.length) : DEFAULT_BUCKET;
}

async function uploadFile(bucket, entry) {
  const localPath = join(BUNDLE_DIR, entry.path);
  const key = `${bucket}/supertonic-3/${entry.path}`;

  const { size } = await stat(localPath);
  if (size !== entry.bytes) {
    throw new Error(
      `${entry.path}: local file is ${size} bytes, manifest says ${entry.bytes}. ` +
        `Re-run npm run build:models before uploading.`
    );
  }

  await run(
    'npx',
    [
      'wrangler',
      'r2',
      'object',
      'put',
      key,
      '--file',
      localPath,
      '--content-type',
      contentTypeFor(entry.path),
      '--remote'
    ],
    { shell: true, maxBuffer: 1 << 24 }
  );
}

async function main() {
  const bucket = parseBucketArg(process.argv.slice(2));

  const manifest = JSON.parse(await readFile(join(BUNDLE_DIR, 'manifest.json'), 'utf8'));
  const files = manifest.files ?? [];
  if (files.length === 0) {
    throw new Error('manifest.json lists no files. Run npm run build:models first.');
  }

  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
  console.log(
    `Uploading ${files.length} files (${(totalBytes / 1048576).toFixed(1)} MB) to R2 bucket "${bucket}"\n` +
      `model version ${manifest.version}\n`
  );

  // Serial, not parallel: these are large files sharing one uplink, and a
  // burst of concurrent multi-hundred-MB uploads is more likely to time out
  // or get throttled than to finish faster.
  let done = 0;
  for (const entry of files) {
    process.stdout.write(`  [${done + 1}/${files.length}] ${entry.path} (${(entry.bytes / 1048576).toFixed(1)} MB)...`);
    try {
      await uploadFile(bucket, entry);
      done += 1;
      console.log(' done');
    } catch (err) {
      console.log(' FAILED');
      throw err;
    }
  }

  console.log(
    `\nUploaded ${done}/${files.length} files.\n` +
      `Bucket "${bucket}" must be bound as MODELS in the Pages project ` +
      `(Settings -> Functions -> R2 bucket bindings) for functions/models/[[path]].js to serve it.`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
