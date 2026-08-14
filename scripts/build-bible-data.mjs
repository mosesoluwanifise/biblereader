#!/usr/bin/env node
/**
 * Generates public/bibles/{translation}/{slug}.json from wldeh/bible-api.
 *
 * Run once; the output is committed (KTD2). Re-runs are resumable — books
 * already present and valid on disk are skipped, so an interrupted run costs
 * only the books it had not reached.
 *
 * The book catalog in src/data/books.json is the validation oracle: a book
 * whose fetched chapter count disagrees with the catalog fails the build
 * rather than being written short. A silently truncated book is worse than a
 * failed build, because nothing downstream would notice.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'public', 'bibles');
const CDN = 'https://cdn.jsdelivr.net/gh/wldeh/bible-api/bibles';

export const TRANSLATIONS = [
  { code: 'kjv', upstream: 'en-kjv', name: 'King James Version' },
  { code: 'web', upstream: 'en-web', name: 'World English Bible' },
  { code: 'asv', upstream: 'en-asv', name: 'American Standard Version' }
];

const CONCURRENCY = 8;
const MAX_ATTEMPTS = 4;

/** "1 Samuel" -> "1samuel". Confirmed against the CDN: lowercase, spaces stripped. */
export function slugify(bookName) {
  return bookName.toLowerCase().replace(/\s+/g, '');
}

/** Collapse internal whitespace and trim. Preserves typographic quotes. */
export function normalizeVerseText(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Converts the upstream `{ data: [{ book, chapter, verse, text }] }` envelope
 * into the app's `[{ verse, text }]` shape.
 *
 * The upstream envelope key is `data`, not `verses`. The pre-V1 fallback in
 * bibleService.ts read `data.verses` and therefore never once succeeded.
 */
export function normalizeChapter(payload, ref = {}) {
  const rows = payload?.data;
  if (!Array.isArray(rows)) {
    throw new Error(`${ref.book ?? '?'} ${ref.chapter ?? '?'}: expected a "data" array, got ${typeof rows}`);
  }

  // The upstream repository emits every verse twice — Genesis 1 arrives as 62
  // rows carrying 31 distinct verse numbers. Deduplicate on verse number and
  // keep the first occurrence. A repeat whose text *differs* is a genuine
  // source conflict, not this benign duplication, so it fails loudly rather
  // than letting the pipeline silently pick one reading of Scripture.
  const byVerse = new Map();
  for (const row of rows) {
    const verse = Number.parseInt(row?.verse, 10);
    const text = normalizeVerseText(row?.text);
    if (!Number.isFinite(verse) || verse < 1) continue;
    if (text.length === 0) continue;

    const seen = byVerse.get(verse);
    if (seen === undefined) {
      byVerse.set(verse, text);
    } else if (seen !== text) {
      throw new Error(
        `${ref.book ?? '?'} ${ref.chapter ?? '?'}:${verse}: conflicting duplicate rows in source`
      );
    }
  }

  return [...byVerse.entries()]
    .map(([verse, text]) => ({ verse, text }))
    .sort((a, b) => a.verse - b.verse);
}

/**
 * Checks a fully-assembled book against the catalog. Returns every problem
 * found rather than the first, so one run surfaces the whole picture.
 */
export function validateBook(book, expectedChapters) {
  const errors = [];
  const keys = Object.keys(book?.chapters ?? {});

  if (keys.length !== expectedChapters) {
    errors.push(`expected ${expectedChapters} chapters, got ${keys.length}`);
  }

  for (let n = 1; n <= expectedChapters; n += 1) {
    const verses = book?.chapters?.[String(n)];
    if (!Array.isArray(verses) || verses.length === 0) {
      errors.push(`chapter ${n} is empty or missing`);
      continue;
    }
    const numbers = verses.map((v) => v.verse);
    if (new Set(numbers).size !== numbers.length) {
      errors.push(`chapter ${n} has duplicate verse numbers`);
    }
    for (let i = 1; i < numbers.length; i += 1) {
      if (numbers[i] <= numbers[i - 1]) {
        errors.push(`chapter ${n} verse numbers are not increasing`);
        break;
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export async function fetchChapter(upstream, slug, chapter, options = {}) {
  const { attempts = MAX_ATTEMPTS, backoffMs = 250 } = options;
  const url = `${CDN}/${upstream}/books/${slug}/chapters/${chapter}.json`;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * backoffMs));
      }
    }
  }

  // Surface a terminal error rather than returning a partial book.
  throw new Error(`${slug} ${chapter}: ${lastError?.message ?? 'unknown error'} (${attempts} attempts)`);
}

/** Runs `worker` over `items` with a bounded pool, preserving input order. */
async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

async function buildBook(translation, entry) {
  const slug = slugify(entry.name);
  const chapterNumbers = Array.from({ length: entry.chapters }, (_, i) => i + 1);

  const chapterVerses = await mapPool(chapterNumbers, CONCURRENCY, async (n) => {
    const payload = await fetchChapter(translation.upstream, slug, n);
    return normalizeChapter(payload, { book: entry.name, chapter: n });
  });

  const chapters = {};
  chapterNumbers.forEach((n, i) => {
    chapters[String(n)] = chapterVerses[i];
  });

  return { translation: translation.code, book: entry.name, chapters };
}

async function main() {
  const books = JSON.parse(await readFile(join(ROOT, 'src', 'data', 'books.json'), 'utf8'));
  const totalChapters = books.reduce((sum, b) => sum + b.chapters, 0);
  const failures = [];

  console.log(
    `Building ${books.length} books x ${TRANSLATIONS.length} translations ` +
      `(${totalChapters * TRANSLATIONS.length} chapters)\n`
  );

  for (const translation of TRANSLATIONS) {
    const dir = join(OUT_DIR, translation.code);
    await mkdir(dir, { recursive: true });

    let built = 0;
    let skipped = 0;
    let verseCount = 0;

    for (const entry of books) {
      const target = join(dir, `${slugify(entry.name)}.json`);

      if (existsSync(target)) {
        const existing = JSON.parse(await readFile(target, 'utf8'));
        if (validateBook(existing, entry.chapters).ok) {
          skipped += 1;
          verseCount += Object.values(existing.chapters).reduce((s, v) => s + v.length, 0);
          continue;
        }
      }

      try {
        const book = await buildBook(translation, entry);
        const { ok, errors } = validateBook(book, entry.chapters);
        if (!ok) {
          const message = `${translation.code}/${entry.name}: ${errors.slice(0, 3).join('; ')}`;
          failures.push(message);
          // Surface immediately. A systematic source problem hits every book,
          // and 3,567 pointless fetches before reporting it helps nobody.
          console.error(`\n  FAIL ${message}`);
          if (failures.length >= 3) return { failures, aborted: true };
          continue;
        }
        await writeFile(target, JSON.stringify(book), 'utf8');
        built += 1;
        verseCount += Object.values(book.chapters).reduce((s, v) => s + v.length, 0);
      } catch (err) {
        failures.push(`${translation.code}/${entry.name}: ${err.message}`);
        console.error(`\n  FAIL ${translation.code}/${entry.name}: ${err.message}`);
        if (failures.length >= 3) return { failures, aborted: true };
      }

      const done = built + skipped;
      if (done % 10 === 0 || done === books.length) {
        console.log(`  ${translation.code}: ${done}/${books.length} books`);
      }
    }

    const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    console.log(
      `  ${translation.code}: ${files.length}/${books.length} books, ` +
        `${verseCount.toLocaleString()} verses (${built} built, ${skipped} cached)\n`
    );
  }

  return { failures, aborted: false };
}

// Only run when invoked directly, so the helpers above stay unit-testable.
// pathToFileURL handles Windows drive letters and spaces in the path; hand
// rolled `file://` + string replacement does not.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(({ failures, aborted }) => {
      if (failures.length > 0) {
        console.error(
          `\nFAILED — ${failures.length} book(s) did not validate` +
            (aborted ? ' (aborted early; the problem looks systematic)' : '') + ':'
        );
        for (const f of failures) console.error(`  - ${f}`);
        process.exitCode = 1;
        return;
      }
      console.log('All books built and validated.');
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
