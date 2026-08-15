import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  loadReadingState,
  saveReadingState,
  clearReadingState,
  DEFAULT_READING_STATE
} from '../../src/services/readingPosition';

const CATALOG = ['Genesis', 'Exodus', 'Psalms', 'John', 'Revelation'];

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('loadReadingState', () => {
  it('returns defaults on a first visit', () => {
    expect(loadReadingState(CATALOG)).toEqual(DEFAULT_READING_STATE);
  });

  it('round-trips a saved position', () => {
    saveReadingState({ translation: 'WEB', book: 'Psalms', chapter: 119, fontScale: 1.3, speed: 0.9 });
    expect(loadReadingState(CATALOG)).toEqual({
      translation: 'WEB',
      book: 'Psalms',
      chapter: 119,
      fontScale: 1.3,
      speed: 0.9
    });
  });

  it('falls back field by field rather than discarding the record', () => {
    // A corrupt font scale should not also lose the reader's place.
    localStorage.setItem(
      'scripture-voice:reading-state',
      JSON.stringify({ translation: 'ASV', book: 'John', chapter: 3, fontScale: 'huge', speed: null })
    );
    const state = loadReadingState(CATALOG);
    expect(state.book).toBe('John');
    expect(state.chapter).toBe(3);
    expect(state.fontScale).toBe(DEFAULT_READING_STATE.fontScale);
    expect(state.speed).toBe(DEFAULT_READING_STATE.speed);
  });

  it('drops a book that is not in the catalog, and its chapter with it', () => {
    // Navigating to a book that does not exist would fail on load, and a
    // chapter number belonging to it is meaningless.
    saveReadingState({ translation: 'KJV', book: 'Hezekiah', chapter: 9, fontScale: 1, speed: 1.05 });
    const state = loadReadingState(CATALOG);
    expect(state.book).toBe('Genesis');
    expect(state.chapter).toBe(1);
  });

  it('rejects an unknown translation', () => {
    saveReadingState({
      translation: 'NIV' as never,
      book: 'Genesis',
      chapter: 1,
      fontScale: 1,
      speed: 1.05
    });
    expect(loadReadingState(CATALOG).translation).toBe('KJV');
  });

  it('clamps out-of-range preferences instead of applying them', () => {
    saveReadingState({ translation: 'KJV', book: 'Genesis', chapter: 1, fontScale: 99, speed: 0.01 });
    const state = loadReadingState(CATALOG);
    expect(state.fontScale).toBeLessThanOrEqual(1.6);
    expect(state.speed).toBeGreaterThanOrEqual(0.7);
  });

  it('survives malformed JSON', () => {
    localStorage.setItem('scripture-voice:reading-state', '{not json');
    expect(loadReadingState(CATALOG)).toEqual(DEFAULT_READING_STATE);
  });

  it('rejects a non-positive chapter', () => {
    saveReadingState({ translation: 'KJV', book: 'Genesis', chapter: 0, fontScale: 1, speed: 1.05 });
    expect(loadReadingState(CATALOG).chapter).toBe(1);
  });

  it('accepts any book when no catalog is supplied', () => {
    saveReadingState({ translation: 'KJV', book: 'Obadiah', chapter: 1, fontScale: 1, speed: 1.05 });
    expect(loadReadingState().book).toBe('Obadiah');
  });
});

describe('storage failure', () => {
  it('reads defaults when localStorage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {},
      removeItem: () => {}
    });
    expect(loadReadingState(CATALOG)).toEqual(DEFAULT_READING_STATE);
  });

  it('does not throw when saving fails', () => {
    // Private browsing and full quotas both reject writes; losing the position
    // is not worth breaking the reader over.
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {}
    });
    expect(() =>
      saveReadingState({ translation: 'KJV', book: 'Genesis', chapter: 1, fontScale: 1, speed: 1.05 })
    ).not.toThrow();
  });
});

describe('clearReadingState', () => {
  it('returns the reader to defaults', () => {
    saveReadingState({ translation: 'ASV', book: 'John', chapter: 3, fontScale: 1.3, speed: 1.2 });
    clearReadingState();
    expect(loadReadingState(CATALOG)).toEqual(DEFAULT_READING_STATE);
  });
});
