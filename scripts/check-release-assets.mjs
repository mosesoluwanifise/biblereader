#!/usr/bin/env node
/**
 * Fails the production build when the shippable assets are missing.
 *
 * `npm run build` only ran tsc and Vite, while the model bundle is produced by
 * a separate command and public/models is gitignored. A clean CI checkout
 * therefore built green and deployed an app whose first action — fetching the
 * model manifest — 404s, leaving narration dead with no build-time signal.
 *
 * Checks the licence files too: distributing the weights without them breaches
 * Open RAIL-M section 4(b) and 4(c).
 */

import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = join(ROOT, 'public', 'models', 'supertonic-3');
const BIBLES = join(ROOT, 'public', 'bibles');

const TRANSLATIONS = ['kjv', 'web', 'asv'];
const EXPECTED_BOOKS = 66;

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

export async function checkReleaseAssets({ verifyChecksums = true } = {}) {
  const problems = [];

  // Bible text
  for (const code of TRANSLATIONS) {
    const books = await import('node:fs/promises')
      .then((fs) => fs.readdir(join(BIBLES, code)))
      .catch(() => null);
    if (!books) {
      problems.push(`public/bibles/${code}/ is missing — run: npm run build:bible`);
      continue;
    }
    const count = books.filter((f) => f.endsWith('.json')).length;
    if (count !== EXPECTED_BOOKS) {
      problems.push(`public/bibles/${code}/ has ${count} books, expected ${EXPECTED_BOOKS}`);
    }
  }

  // Model manifest
  const manifestPath = join(MODELS, 'manifest.json');
  const manifestRaw = await readFile(manifestPath, 'utf8').catch(() => null);
  if (!manifestRaw) {
    problems.push('public/models/supertonic-3/manifest.json is missing — run: npm run build:models');
    return { ok: problems.length === 0, problems };
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch {
    problems.push('model manifest.json is not valid JSON — rebuild with: npm run build:models');
    return { ok: false, problems };
  }

  // 4(b) and 4(c): the licence and change notice travel with the weights.
  for (const required of ['LICENSE', 'NOTICE']) {
    if ((await sizeOf(join(MODELS, required))) === null) {
      problems.push(`public/models/supertonic-3/${required} is missing — required by the model licence`);
    }
  }

  // Every file the manifest claims must exist, at the right size.
  for (const entry of manifest.files ?? []) {
    const actual = await sizeOf(join(MODELS, entry.path));
    if (actual === null) {
      problems.push(`model file missing: ${entry.path}`);
    } else if (actual !== entry.bytes) {
      problems.push(`model file size mismatch: ${entry.path} (${actual} bytes, manifest says ${entry.bytes})`);
    }
  }

  // Checksums catch a half-written or mode-switched bundle that size alone
  // would not — an int8 and fp32 graph can be wildly different sizes, but a
  // truncated download can coincidentally match.
  if (verifyChecksums) {
    for (const entry of manifest.files ?? []) {
      const buf = await readFile(join(MODELS, entry.path)).catch(() => null);
      if (!buf) continue;
      const digest = createHash('sha256').update(buf).digest('hex');
      if (digest !== entry.sha256) {
        problems.push(`model file checksum mismatch: ${entry.path} — rebuild with: npm run build:models`);
      }
    }
  }

  if (!manifest.version) problems.push('model manifest has no version field');
  if (!Array.isArray(manifest.voiceStyles) || manifest.voiceStyles.length === 0) {
    problems.push('model manifest lists no voice styles');
  }

  return { ok: problems.length === 0, problems, manifest };
}

async function main() {
  const { ok, problems, manifest } = await checkReleaseAssets();

  if (!ok) {
    console.error('\nRelease assets are incomplete:\n');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('\nA build without these deploys an app whose narration cannot start.\n');
    process.exitCode = 1;
    return;
  }

  const total = (manifest.files ?? []).reduce((sum, f) => sum + f.bytes, 0);
  console.log(
    `release assets ok — bibles 3x${EXPECTED_BOOKS}, model ${manifest.version} ` +
      `(${manifest.quantization}, ${(total / 1048576).toFixed(1)} MB)`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
