import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  loadChapter,
  clearMemoryCache,
  slugify,
  getNextChapter,
  getAvailableChapters,
  computeVerseOffsets,
  countWords,
  splitIntoWords,
  BIBLE_BOOKS
} from '../../src/services/bible/bibleService';
import { closeCache } from '../../src/services/bible/bibleCache';

function bookFixture(book: string, chapters: Record<string, { verse: number; text: string }[]>) {
  return { translation: 'kjv', book, chapters };
}

const GENESIS = bookFixture('Genesis', {
  '1': [
    { verse: 1, text: 'In the beginning God created the heaven and the earth.' },
    { verse: 2, text: 'And the earth was without form, and void.' },
    { verse: 3, text: 'And God said, Let there be light: and there was light.' }
  ]
});

/** Distinct text per translation so we can prove which file was served. */
function translationFixture(translation: string) {
  return bookFixture('John', {
    '3': [{ verse: 16, text: `${translation.toUpperCase()} rendering of John 3:16.` }]
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  clearMemoryCache();
  await closeCache();
  // Must complete before the next open, or the open queues behind it.
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('scripture-voice');
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(payload: unknown, ok = true) {
  fetchMock = vi.fn().mockResolvedValue({ ok, json: async () => payload });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('loadChapter', () => {
  it('returns every verse in order with correct verse numbers', async () => {
    stubFetch(GENESIS);
    const result = await loadChapter('Genesis', 1, 'KJV');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verses).toHaveLength(3);
    expect(result.verses.map((v) => v.verse)).toEqual([1, 2, 3]);
    expect(result.verses[0].text).toMatch(/^In the beginning/);
  });

  it('requests the bundled asset, not a remote API', async () => {
    const mock = stubFetch(GENESIS);
    await loadChapter('Genesis', 1, 'KJV');

    const url = String(mock.mock.calls[0][0]);
    expect(url).toContain('bibles/kjv/genesis.json');
    expect(url).not.toMatch(/^https?:\/\//);
  });

  it('fetches once for repeated reads of the same book', async () => {
    const mock = stubFetch(GENESIS);
    await loadChapter('Genesis', 1, 'KJV');
    await loadChapter('Genesis', 1, 'KJV');
    await loadChapter('Genesis', 2, 'KJV').catch(() => undefined);

    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('serves a cached book after the in-memory layer is cleared', async () => {
    const mock = stubFetch(GENESIS);
    await loadChapter('Genesis', 1, 'KJV');
    expect(mock).toHaveBeenCalledTimes(1);

    // Simulates a reload: session memory is gone, IndexedDB is not.
    clearMemoryCache();
    const result = await loadChapter('Genesis', 1, 'KJV');

    expect(result.ok).toBe(true);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('keeps reading position when translation changes', async () => {
    for (const code of ['KJV', 'WEB', 'ASV'] as const) {
      clearMemoryCache();
      stubFetch(translationFixture(code));
      const result = await loadChapter('John', 3, code);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.verses[0].verse).toBe(16);
      expect(result.verses[0].text).toContain(code);
    }
  });

  it('reports failure rather than returning an empty verse list', async () => {
    stubFetch(null, false);
    const result = await loadChapter('Genesis', 1, 'KJV');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unavailable');
    expect(result.message).toMatch(/Genesis/);
  });

  it('reports failure when the fetch rejects outright', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const result = await loadChapter('Genesis', 1, 'KJV');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unavailable');
  });

  it('returns not-found for a chapter beyond the book', async () => {
    stubFetch(GENESIS);
    const result = await loadChapter('Genesis', 51, 'KJV');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not-found');
    expect(result.message).toMatch(/50 chapters/);
  });

  it('returns not-found for an unknown book', async () => {
    stubFetch(GENESIS);
    const result = await loadChapter('Hezekiah', 1, 'KJV');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not-found');
  });

  it('returns not-found for chapter zero and negative chapters', async () => {
    stubFetch(GENESIS);
    for (const n of [0, -1]) {
      const result = await loadChapter('Genesis', n, 'KJV');
      expect(result.ok).toBe(false);
    }
  });

  it('reports unavailable when the book loads but the chapter is missing', async () => {
    stubFetch(bookFixture('Genesis', { '1': [] }));
    const result = await loadChapter('Genesis', 1, 'KJV');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unavailable');
  });
});

describe('getNextChapter', () => {
  it('advances within a book', () => {
    expect(getNextChapter('Genesis', 1)).toEqual({ book: 'Genesis', chapter: 2 });
  });

  it('crosses the book boundary at the last chapter', () => {
    expect(getNextChapter('Genesis', 50)).toEqual({ book: 'Exodus', chapter: 1 });
  });

  it('crosses from the Old Testament into the New', () => {
    expect(getNextChapter('Malachi', 4)).toEqual({ book: 'Matthew', chapter: 1 });
  });

  it('advances out of a single-chapter book', () => {
    expect(getNextChapter('Jude', 1)).toEqual({ book: 'Revelation', chapter: 1 });
  });

  it('stops at the end of Revelation rather than wrapping', () => {
    expect(getNextChapter('Revelation', 22)).toBeNull();
  });

  it('returns null for an unknown book', () => {
    expect(getNextChapter('Hezekiah', 1)).toBeNull();
  });
});

describe('word offsets', () => {
  it('counts words the same way the highlighter tokenizes them', () => {
    const text = 'And God said, Let there be light.';
    expect(countWords(text)).toBe(splitIntoWords(text).length);
  });

  it('computes cumulative offsets across verses', () => {
    const verses = [
      { verse: 1, text: 'one two three' },
      { verse: 2, text: 'four five' },
      { verse: 3, text: 'six' }
    ];
    expect(computeVerseOffsets(verses)).toEqual([0, 3, 5]);
  });

  it('treats an empty verse as consuming no word indices', () => {
    expect(computeVerseOffsets([{ verse: 1, text: '' }, { verse: 2, text: 'a b' }])).toEqual([0, 0]);
  });
});

describe('catalog helpers', () => {
  it('slugifies to the generated filenames', () => {
    expect(slugify('1 Samuel')).toBe('1samuel');
    expect(slugify('Song of Solomon')).toBe('songofsolomon');
  });

  it('lists chapters from 1 to the book length', () => {
    const chapters = getAvailableChapters('Psalms');
    expect(chapters[0]).toBe(1);
    expect(chapters.at(-1)).toBe(150);
    expect(chapters).toHaveLength(150);
  });

  it('exposes all 66 books', () => {
    expect(BIBLE_BOOKS).toHaveLength(66);
  });
});
