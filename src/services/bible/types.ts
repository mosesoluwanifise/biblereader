export type TranslationCode = 'KJV' | 'WEB' | 'ASV';

export interface Verse {
  verse: number;
  text: string;
}

export interface Chapter {
  [chapterNumber: string]: Verse[];
}

export interface Book {
  chapters: Chapter;
}

export interface TranslationData {
  translation: TranslationCode;
  name: string;
  books: {
    [bookName: string]: Book;
  };
}

export interface BibleLocation {
  translation: TranslationCode;
  book: string;
  chapter: number;
  verse: number;
}
