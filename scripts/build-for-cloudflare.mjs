#!/usr/bin/env node
/**
 * Production build for Cloudflare Pages.
 *
 * Three things differ from a normal build, none of them expressible as a
 * plain npm-script chain:
 *
 *  - Bible text is checked, but the model bundle is not: it deploys via R2
 *    (see functions/models/[[path]].js and scripts/upload-models-to-r2.mjs),
 *    not as a local public/models/ folder.
 *  - onnxruntime-web's own WASM runtime — 26.8 MB, over Pages' 25 MiB
 *    per-asset cap — is pointed at jsDelivr instead of the bundled copy. The
 *    jsDelivr URL is pinned to whatever version is actually installed, read
 *    from node_modules at build time, so it can never drift out of sync with
 *    the bundled JS glue that talks to it.
 *  - The build then still contains that now-unused local copy — Vite's
 *    static-asset detection bundles it regardless of the runtime override,
 *    since it has no way to know the override will make that code path
 *    unreachable — so it is deleted from dist/assets afterwards. Left in
 *    place, Cloudflare would refuse to deploy it.
 *  - Vite also copies the entire public/ directory into dist/ verbatim,
 *    .gitignore notwithstanding — so if the model bundle happens to exist
 *    locally (e.g. from testing), dist/models/ reintroduces the exact
 *    problem this build is working around, for four files this time
 *    (vector_estimator.onnx alone is 244.7 MB). Deleted for the same reason.
 *
 * Every other build target (`npm run build`, `build:app`) is untouched by
 * this file and keeps serving the WASM runtime locally.
 */

import { spawn } from 'node:child_process';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const DIST_ASSETS = join(DIST, 'assets');
const DIST_MODELS = join(DIST, 'models');
const STALE_WASM_PATTERN = /^ort-wasm-simd-threaded\.jsep-.*\.wasm$/;

const PAGES_MAX_ASSET_BYTES = 25 * 1024 * 1024; // 25 MiB

async function dirSize(path) {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const full = join(path, entry.name);
    total += entry.isDirectory() ? await dirSize(full) : (await stat(full)).size;
  }
  return total;
}

/**
 * Final safety net, not just cleanup for the two known offenders above. If a
 * future dependency bump introduces some other file over the limit, this
 * fails the build loudly instead of letting a broken deploy reach Cloudflare,
 * where the failure mode is a confusing upload-time rejection with no local
 * repro.
 */
async function findOversized(root) {
  const oversized = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const { size } = await stat(full);
        if (size > PAGES_MAX_ASSET_BYTES) oversized.push({ path: full.slice(root.length + 1), size });
      }
    }
  }
  await walk(root);
  return oversized;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit', shell: true, ...options });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

async function main() {
  const pkg = JSON.parse(
    await readFile(join(ROOT, 'node_modules', 'onnxruntime-web', 'package.json'), 'utf8')
  );
  const wasmBase = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${pkg.version}/dist/`;
  console.log(`onnxruntime-web ${pkg.version} — WASM runtime will load from ${wasmBase}\n`);

  console.log('checking release assets (bible text only; models are served from R2)...');
  await run('node', ['scripts/check-release-assets.mjs', '--skip-models']);

  console.log('\ntype-checking...');
  await run('npx', ['tsc']);

  console.log('\nbuilding...');
  await run('npx', ['vite', 'build'], { env: { ...process.env, VITE_ORT_WASM_BASE: wasmBase } });

  console.log('\nremoving the local WASM runtime copy — served from jsDelivr instead...');
  const files = await readdir(DIST_ASSETS).catch(() => []);
  const stale = files.filter((f) => STALE_WASM_PATTERN.test(f));

  if (stale.length === 0) {
    console.warn(
      '  WARNING: no matching file found in dist/assets. If onnxruntime-web changed its output ' +
        'naming, STALE_WASM_PATTERN in this script needs updating, or the 26.8 MB runtime file ' +
        'will ship as a Pages asset and the deploy will fail at upload.'
    );
  }
  for (const f of stale) {
    const size = (await stat(join(DIST_ASSETS, f))).size;
    await rm(join(DIST_ASSETS, f));
    console.log(`  removed dist/assets/${f} (${(size / 1048576).toFixed(1)} MB)`);
  }

  console.log('\nremoving dist/models/ — served from R2 instead...');
  const modelsSize = await dirSize(DIST_MODELS);
  if (modelsSize === 0) {
    console.log('  (nothing there — the model bundle was not present locally, as expected in CI)');
  } else {
    await rm(DIST_MODELS, { recursive: true, force: true });
    console.log(`  removed dist/models/ (${(modelsSize / 1048576).toFixed(1)} MB)`);
  }

  console.log('\nverifying every remaining file is under the 25 MiB Pages limit...');
  const oversized = await findOversized(DIST);
  if (oversized.length > 0) {
    for (const f of oversized) console.error(`  OVER LIMIT: ${f.path} (${(f.size / 1048576).toFixed(1)} MB)`);
    throw new Error(
      `${oversized.length} file(s) in dist/ exceed Cloudflare Pages' 25 MiB per-asset limit. ` +
        'The deploy would fail at upload; fix before deploying.'
    );
  }
  console.log('  ok');

  console.log('\nbuild ready for Cloudflare Pages.');
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exitCode = 1;
});
