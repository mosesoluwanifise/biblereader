export type TranslationCode = 'KJV' | 'WEB' | 'ASV';

export interface Verse {
  verse: number;
  text: string;
}

export interface BookEntry {
  name: string;
  chapters: number;
  category: 'OT' | 'NT';
}

/** Shape of a generated file under public/bibles/{translation}/{slug}.json */
export interface BookData {
  translation: string;
  book: string;
  chapters: Record<string, Verse[]>;
}

export type ChapterFailure = 'not-found' | 'unavailable';

/**
 * Loading a chapter is fallible, so the result says so. The pre-V1 service
 * returned a bare array and signalled failure with `[]`, which BibleView
 * rendered as a blank screen indistinguishable from a real empty chapter.
 */
export type ChapterResult =
  | { ok: true; verses: Verse[] }
  | { ok: false; reason: ChapterFailure; message: string };

export interface BibleLocation {
  translation: TranslationCode;
  book: string;
  chapter: number;
}
