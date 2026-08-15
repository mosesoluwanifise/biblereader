import { TranslationCode } from './bible/types';

/**
 * Where the reader left off, and how they like to read.
 *
 * The app opened at Genesis 1 on every launch, which is fine for a demo and
 * useless for a daily habit — the whole point is resuming where you stopped.
 *
 * Stored in localStorage rather than IndexedDB: it is a few bytes, it must be
 * readable synchronously during the first render to avoid a visible jump from
 * Genesis to the saved passage, and losing it is harmless.
 */

const KEY = 'scripture-voice:reading-state';

export interface ReadingState {
  translation: TranslationCode;
  book: string;
  chapter: number;
  /** Root font scale for the verse text, 0.85–1.6. */
  fontScale: number;
  /** Narration speed multiplier applied to the model's predicted duration. */
  speed: number;
}

export const DEFAULT_READING_STATE: ReadingState = {
  translation: 'KJV',
  book: 'Genesis',
  chapter: 1,
  fontScale: 1,
  speed: 1.05
};

const TRANSLATIONS: TranslationCode[] = ['KJV', 'WEB', 'ASV'];

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  // Only a real number counts. Coercing first would turn null into 0, which is
  // finite and would then be clamped to the minimum — silently setting the
  // slowest speed instead of restoring the default.
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Reads the saved state, falling back field by field.
 *
 * Anything unusable is replaced rather than discarding the whole record — a
 * corrupt font scale should not also lose the passage. A stored book that is
 * not in the catalog is dropped, since navigating to it would fail.
 */
export function loadReadingState(available: string[] = []): ReadingState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_READING_STATE };

    const parsed = JSON.parse(raw) as Partial<ReadingState>;
    const translation = TRANSLATIONS.includes(parsed.translation as TranslationCode)
      ? (parsed.translation as TranslationCode)
      : DEFAULT_READING_STATE.translation;

    const bookIsKnown =
      typeof parsed.book === 'string' &&
      (available.length === 0 || available.some((b) => b.toLowerCase() === parsed.book!.toLowerCase()));
    const book = bookIsKnown ? (parsed.book as string) : DEFAULT_READING_STATE.book;

    const chapter = Number.isInteger(parsed.chapter) && (parsed.chapter as number) > 0
      ? (parsed.chapter as number)
      : DEFAULT_READING_STATE.chapter;

    return {
      translation,
      // A saved chapter belongs to a saved book; if the book was rejected the
      // chapter is meaningless too.
      book,
      chapter: bookIsKnown ? chapter : DEFAULT_READING_STATE.chapter,
      fontScale: clamp(parsed.fontScale, 0.85, 1.6, DEFAULT_READING_STATE.fontScale),
      speed: clamp(parsed.speed, 0.7, 1.6, DEFAULT_READING_STATE.speed)
    };
  } catch {
    // Private browsing, disabled storage, or malformed JSON.
    return { ...DEFAULT_READING_STATE };
  }
}

export function saveReadingState(state: ReadingState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage full or unavailable; losing the position is not worth an error.
  }
}

export function clearReadingState(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}
