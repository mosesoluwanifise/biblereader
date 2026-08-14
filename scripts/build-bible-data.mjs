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

/**
 * Source: bible-api.com.
 *
 * The previous source (wldeh/bible-api via jsDelivr) inlines translator
 * footnotes into the verse text with no separate field — 18.8% of KJV verses
 * carried them, e.g. "…were the first day.1.5 And the evening…: Heb. And the
 * evening was…". In KJV they trail the verse; in WEB they are spliced
 * mid-sentence with no delimiter, so the verse resumes after the note and no
 * reliable strip is possible. Guessing where a footnote ends risks silently
 * truncating Scripture, which is the worst failure this app can have.
 *
 * bible-api.com returns the same public-domain translations without footnotes.
 * It is rate limited, but this runs once and the output is committed.
 */
const API = 'https://bible-api.com';

export const TRANSLATIONS = [
  { code: 'kjv', upstream: 'kjv', name: 'King James Version' },
  { code: 'web', upstream: 'web', name: 'World English Bible' },
  { code: 'asv', upstream: 'asv', name: 'American Standard Version' }
];

/** Polite against a small volunteer service; the build is one-time. */
const CONCURRENCY = 2;
const MAX_ATTEMPTS = 5;

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
/**
 * Text that must never reach a reader.
 *
 * `footnote` catches the previous source's inlined translator notes — kept as
 * defence in depth so a source regression fails the build instead of shipping
 * "…the first day.1.5 And the evening…: Heb." to someone reading Scripture.
 * `replacement` and `loneSurrogate` catch mojibake; bible-api.com returns at
 * least one verse (WEB 1 Chronicles 4:9) with a broken surrogate pair.
 */
export const CONTAMINATION = {
  // The marker is the row's own chapter, a dot or colon, the verse, then a
  // space. It glues to whatever precedes it — a letter in WEB ("God1:1 "), a
  // full stop in KJV ("day.1.5 ") — so a word boundary does not catch both.
  // The digit lookbehind keeps it from firing inside ordinary numbers.
  footnote: (text, ref) =>
    ref.chapter !== undefined && new RegExp(`(?<!\\d)${ref.chapter}[.:]\\d+\\s`).test(text),
  replacement: (text) => text.includes('�'),
  loneSurrogate: (text) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)
};

/** Returns the names of every contamination check the text trips. */
export function detectContamination(text, ref = {}) {
  return Object.entries(CONTAMINATION)
    .filter(([, test]) => test(text, ref))
    .map(([name]) => name);
}

export function normalizeChapter(payload, ref = {}) {
  // bible-api.com returns { verses: [...] }; the previous source used `data`.
  const rows = payload?.verses ?? payload?.data;
  if (!Array.isArray(rows)) {
    throw new Error(`${ref.book ?? '?'} ${ref.chapter ?? '?'}: expected a "verses" array, got ${typeof rows}`);
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

    const problems = detectContamination(text, { ...ref, chapter: ref.chapter });
    if (problems.length > 0) {
      throw new Error(
        `${ref.book ?? '?'} ${ref.chapter ?? '?'}:${verse}: ${problems.join(', ')} — ` +
          `"${text.slice(0, 80)}"`
      );
    }

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
    // Contamination is checked here too, not only at fetch time, so a cached
    // file written by an earlier build fails validation and gets rebuilt
    // instead of being silently skipped by the resume path.
    for (const v of verses) {
      const problems = detectContamination(v.text, { chapter: n });
      if (problems.length > 0) {
        errors.push(`chapter ${n}:${v.verse} ${problems.join(', ')}`);
        break;
      }
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

export async function fetchChapter(upstream, book, chapter, options = {}) {
  const { attempts = MAX_ATTEMPTS, backoffMs = 500 } = options;
  const url = `${API}/${encodeURIComponent(book)}+${chapter}?translation=${upstream}`;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url);
      // The service is rate limited; back off hard rather than hammering it.
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after')) || 0;
        await new Promise((r) => setTimeout(r, Math.max(retryAfter * 1000, 2 ** attempt * backoffMs * 4)));
        throw new Error('HTTP 429');
      }
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
  throw new Error(`${book} ${chapter}: ${lastError?.message ?? 'unknown error'} (${attempts} attempts)`);
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
  const chapterNumbers = Array.from({ length: entry.chapters }, (_, i) => i + 1);

  const chapterVerses = await mapPool(chapterNumbers, CONCURRENCY, async (n) => {
    const payload = await fetchChapter(translation.upstream, entry.name, n);
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
