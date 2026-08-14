import booksCatalog from '../../data/books.json';
import { BookData, BookEntry, ChapterResult, TranslationCode, Verse } from './types';
import { readCachedBook, writeCachedBook, reconcileDataVersion } from './bibleCache';

export const BIBLE_BOOKS = booksCatalog as BookEntry[];

export const AVAILABLE_TRANSLATIONS: { code: TranslationCode; name: string }[] = [
  { code: 'KJV', name: 'King James Version' },
  { code: 'WEB', name: 'World English Bible' },
  { code: 'ASV', name: 'American Standard Version' }
];

/** Session-scoped layer in front of IndexedDB. */
const memoryCache = new Map<string, BookData>();

/**
 * In-flight loads, keyed the same way as the cache. Without this, two mounts
 * racing for the same book (React StrictMode, or a fast double navigation)
 * both miss the cache and fetch the same file twice.
 */
const inFlight = new Map<string, Promise<BookData | null>>();

/** Matches the on-disk filenames produced by scripts/build-bible-data.mjs. */
export function slugify(bookName: string): string {
  return bookName.toLowerCase().replace(/\s+/g, '');
}

export function getBookEntry(bookName: string): BookEntry | undefined {
  return BIBLE_BOOKS.find((b) => b.name.toLowerCase() === bookName.toLowerCase());
}

export function getAvailableBooks(): string[] {
  return BIBLE_BOOKS.map((b) => b.name);
}

export function getAvailableChapters(bookName: string): number[] {
  const book = getBookEntry(bookName);
  if (!book) return [1];
  return Array.from({ length: book.chapters }, (_, i) => i + 1);
}

/** The chapter after the given reference, crossing into the next book. */
export function getNextChapter(bookName: string, chapter: number): { book: string; chapter: number } | null {
  const index = BIBLE_BOOKS.findIndex((b) => b.name.toLowerCase() === bookName.toLowerCase());
  if (index === -1) return null;

  if (chapter < BIBLE_BOOKS[index].chapters) {
    return { book: BIBLE_BOOKS[index].name, chapter: chapter + 1 };
  }
  const next = BIBLE_BOOKS[index + 1];
  return next ? { book: next.name, chapter: 1 } : null;
}

/**
 * Resolves once the cache has been reconciled against the shipped text version.
 * Memoized so the manifest is fetched at most once per session, and awaited
 * before any cached read so a stale book cannot be served first.
 */
let versionCheck: Promise<void> | null = null;

function ensureCurrentData(): Promise<void> {
  versionCheck ??= (async () => {
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}bibles/manifest.json`);
      if (!response.ok) return;
      const { version } = (await response.json()) as { version?: string };
      if (!version) return;
      if (await reconcileDataVersion(version)) memoryCache.clear();
    } catch {
      // A missing or unreachable manifest must not block reading.
    }
  })();
  return versionCheck;
}

async function loadBook(bookName: string, translation: TranslationCode): Promise<BookData | null> {
  await ensureCurrentData();

  const slug = slugify(bookName);
  const code = translation.toLowerCase();
  const key = `${code}:${slug}`;

  const inMemory = memoryCache.get(key);
  if (inMemory) return inMemory;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const load = (async () => {
    const cached = await readCachedBook(code, slug);
    if (cached) {
      memoryCache.set(key, cached);
      return cached;
    }

    // Bundled asset — same origin, no API, no key. The service worker caches
    // this on read (U10), which is what makes the offline promise real.
    const response = await fetch(`${import.meta.env.BASE_URL}bibles/${code}/${slug}.json`);
    if (!response.ok) return null;

    const book = (await response.json()) as BookData;
    memoryCache.set(key, book);
    void writeCachedBook(code, slug, book);
    return book;
  })();

  inFlight.set(key, load);
  try {
    return await load;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Loads one chapter. Failure is reported in the return value rather than as an
 * empty array, so the UI can tell "this reference does not exist" apart from
 * "we could not reach the data".
 */
export async function loadChapter(
  bookName: string,
  chapter: number,
  translation: TranslationCode = 'KJV'
): Promise<ChapterResult> {
  const entry = getBookEntry(bookName);
  if (!entry) {
    return { ok: false, reason: 'not-found', message: `Unknown book: ${bookName}` };
  }
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > entry.chapters) {
    return {
      ok: false,
      reason: 'not-found',
      message: `${entry.name} has ${entry.chapters} chapter${entry.chapters === 1 ? '' : 's'}.`
    };
  }

  let book: BookData | null;
  try {
    book = await loadBook(entry.name, translation);
  } catch {
    book = null;
  }

  if (!book) {
    return {
      ok: false,
      reason: 'unavailable',
      message: `Could not load ${entry.name} (${translation}). It may not be downloaded yet.`
    };
  }

  const verses = book.chapters?.[String(chapter)];
  if (!Array.isArray(verses) || verses.length === 0) {
    return {
      ok: false,
      reason: 'unavailable',
      message: `${entry.name} ${chapter} (${translation}) is missing from the downloaded text.`
    };
  }

  return { ok: true, verses };
}

/** Word tokens for highlighting. Whitespace is dropped; order is preserved. */
export function splitIntoWords(text: string): { word: string; cleanWord: string }[] {
  return text
    .split(/(\s+)/)
    .filter((token) => token.trim().length > 0)
    .map((token) => ({ word: token, cleanWord: token.replace(/[^\w]/g, '').toLowerCase() }));
}

/** Word count used to align highlight indices across verses. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

/** Cumulative word offset of each verse within a chapter. */
export function computeVerseOffsets(verses: Verse[]): number[] {
  let running = 0;
  return verses.map((v) => {
    const offset = running;
    running += countWords(v.text);
    return offset;
  });
}

/** Test seam. */
export function clearMemoryCache(): void {
  memoryCache.clear();
  inFlight.clear();
  versionCheck = null;
}
