import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  slugify,
  normalizeVerseText,
  normalizeChapter,
  validateBook,
  fetchChapter,
  TRANSLATIONS
} from '../../scripts/build-bible-data.mjs';
import books from '../../src/data/books.json';

type BookEntry = { name: string; chapters: number; category: 'OT' | 'NT' };
const catalog = books as BookEntry[];

/** Builds a valid book fixture with `chapters` chapters of two verses each. */
function makeBook(name: string, chapters: number) {
  const map: Record<string, { verse: number; text: string }[]> = {};
  for (let n = 1; n <= chapters; n += 1) {
    map[String(n)] = [
      { verse: 1, text: 'In the beginning.' },
      { verse: 2, text: 'And the earth was without form.' }
    ];
  }
  return { translation: 'kjv', book: name, chapters: map };
}

describe('slugify', () => {
  it('lowercases and strips spaces to match the CDN path format', () => {
    expect(slugify('1 Samuel')).toBe('1samuel');
    expect(slugify('Song of Solomon')).toBe('songofsolomon');
    expect(slugify('Genesis')).toBe('genesis');
  });

  it('produces a slug for every book in the catalog with no collisions', () => {
    const slugs = catalog.map((b) => slugify(b.name));
    expect(slugs).toHaveLength(66);
    expect(new Set(slugs).size).toBe(66);
    expect(slugs.every((s) => /^[a-z0-9]+$/.test(s))).toBe(true);
  });
});

describe('normalizeVerseText', () => {
  it('collapses internal whitespace and trims', () => {
    expect(normalizeVerseText('  And   God \n said,\tLet there be light.  ')).toBe(
      'And God said, Let there be light.'
    );
  });

  it('preserves typographic quotes used by the WEB text', () => {
    expect(normalizeVerseText('He said, “Rabbi”')).toBe('He said, “Rabbi”');
  });

  it('returns an empty string for null or undefined', () => {
    expect(normalizeVerseText(null)).toBe('');
    expect(normalizeVerseText(undefined)).toBe('');
  });
});

describe('normalizeChapter', () => {
  it('converts the upstream data envelope into verse objects', () => {
    const payload = {
      data: [
        { book: 'John', chapter: '3', verse: '1', text: 'Now there was a man  ' },
        { book: 'John', chapter: '3', verse: '2', text: 'He came to Jesus by night.' }
      ]
    };
    expect(normalizeChapter(payload, { book: 'John', chapter: 3 })).toEqual([
      { verse: 1, text: 'Now there was a man' },
      { verse: 2, text: 'He came to Jesus by night.' }
    ]);
  });

  it('coerces string verse numbers to integers', () => {
    const [first] = normalizeChapter({ data: [{ verse: '17', text: 'text' }] });
    expect(first.verse).toBe(17);
    expect(typeof first.verse).toBe('number');
  });

  it('sorts verses even when the source returns them out of order', () => {
    const out = normalizeChapter({
      data: [
        { verse: '3', text: 'third' },
        { verse: '1', text: 'first' },
        { verse: '2', text: 'second' }
      ]
    });
    expect(out.map((v) => v.verse)).toEqual([1, 2, 3]);
  });

  it('drops rows with unusable verse numbers or empty text', () => {
    const out = normalizeChapter({
      data: [
        { verse: '1', text: 'kept' },
        { verse: 'x', text: 'bad verse number' },
        { verse: '2', text: '   ' },
        { verse: '0', text: 'zero is not a verse' }
      ]
    });
    expect(out).toEqual([{ verse: 1, text: 'kept' }]);
  });

  it('deduplicates the doubled rows the upstream source emits', () => {
    // Not hypothetical: the upstream repo returns Genesis 1 as 62 rows
    // carrying 31 distinct verses, each text repeated verbatim.
    const payload = {
      data: [
        { verse: '1', text: 'In the beginning God created the heaven and the earth.' },
        { verse: '2', text: 'And the earth was without form, and void.' },
        { verse: '1', text: 'In the beginning God created the heaven and the earth.' },
        { verse: '2', text: 'And the earth was without form, and void.' }
      ]
    };
    const out = normalizeChapter(payload, { book: 'Genesis', chapter: 1 });
    expect(out).toHaveLength(2);
    expect(out.map((v: { verse: number }) => v.verse)).toEqual([1, 2]);
  });

  it('throws when duplicate rows for one verse disagree on text', () => {
    // Benign duplication is absorbed above; a real conflict must not be
    // silently resolved by picking whichever row happened to arrive first.
    const payload = {
      data: [
        { verse: '1', text: 'In the beginning God created the heaven and the earth.' },
        { verse: '1', text: 'A materially different reading of verse one.' }
      ]
    };
    expect(() => normalizeChapter(payload, { book: 'Genesis', chapter: 1 })).toThrow(
      /conflicting duplicate rows/
    );
  });

  it('throws when the payload uses "verses" instead of "data"', () => {
    // This is the exact shape the pre-V1 fallback assumed. Failing loudly here
    // is what keeps that class of silent-miss bug from returning.
    expect(() => normalizeChapter({ verses: [{ verse: 1, text: 'x' }] }, { book: 'Genesis', chapter: 1 })).toThrow(
      /expected a "data" array/
    );
  });
});

describe('validateBook', () => {
  it('accepts a well-formed book', () => {
    expect(validateBook(makeBook('Genesis', 50), 50)).toEqual({ ok: true, errors: [] });
  });

  it('fails when the chapter count disagrees with the catalog', () => {
    const result = validateBook(makeBook('Genesis', 49), 50);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/expected 50 chapters, got 49/);
  });

  it('fails when any chapter is empty', () => {
    const book = makeBook('Jonah', 4);
    book.chapters['3'] = [];
    const result = validateBook(book, 4);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/chapter 3 is empty or missing/);
  });

  it('fails on duplicate verse numbers', () => {
    const book = makeBook('Ruth', 4);
    book.chapters['1'] = [
      { verse: 1, text: 'a' },
      { verse: 1, text: 'b' }
    ];
    const result = validateBook(book, 4);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/duplicate verse numbers/);
  });

  it('reports every problem rather than stopping at the first', () => {
    const book = makeBook('Amos', 9);
    book.chapters['2'] = [];
    book.chapters['5'] = [];
    expect(validateBook(book, 9).errors.length).toBeGreaterThanOrEqual(2);
  });

  it('accepts single-chapter books with exactly one chapter key', () => {
    for (const name of ['Obadiah', 'Philemon', 'Jude', '2 John', '3 John']) {
      const book = makeBook(name, 1);
      expect(Object.keys(book.chapters)).toEqual(['1']);
      expect(validateBook(book, 1).ok).toBe(true);
    }
  });
});

describe('fetchChapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns parsed JSON on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ verse: '1', text: 'x' }] }) })
    );
    await expect(fetchChapter('en-kjv', 'genesis', 1, { backoffMs: 0 })).resolves.toEqual({
      data: [{ verse: '1', text: 'x' }]
    });
  });

  it('retries on failure and succeeds if a later attempt works', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchChapter('en-kjv', 'genesis', 1, { backoffMs: 0 })).resolves.toEqual({ data: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws a terminal error after exhausting attempts rather than returning partial data', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchChapter('en-kjv', 'genesis', 1, { attempts: 3, backoffMs: 0 })).rejects.toThrow(
      /genesis 1: HTTP 503 \(3 attempts\)/
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('catalog integrity', () => {
  it('covers 66 books totalling 1,189 chapters', () => {
    expect(catalog).toHaveLength(66);
    expect(catalog.reduce((sum, b) => sum + b.chapters, 0)).toBe(1189);
  });

  it('splits into 39 Old Testament and 27 New Testament books', () => {
    expect(catalog.filter((b) => b.category === 'OT')).toHaveLength(39);
    expect(catalog.filter((b) => b.category === 'NT')).toHaveLength(27);
  });

  it('declares the three launch translations', () => {
    expect(TRANSLATIONS.map((t: { code: string }) => t.code)).toEqual(['kjv', 'web', 'asv']);
  });
});
