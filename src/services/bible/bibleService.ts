import { TranslationCode, Verse } from './types';

// Complete list of 66 books in the Bible with chapter counts
export const BIBLE_BOOKS: { name: string; chapters: number; category: 'OT' | 'NT' }[] = [
  // Old Testament
  { name: 'Genesis', chapters: 50, category: 'OT' },
  { name: 'Exodus', chapters: 40, category: 'OT' },
  { name: 'Leviticus', chapters: 27, category: 'OT' },
  { name: 'Numbers', chapters: 36, category: 'OT' },
  { name: 'Deuteronomy', chapters: 34, category: 'OT' },
  { name: 'Joshua', chapters: 24, category: 'OT' },
  { name: 'Judges', chapters: 21, category: 'OT' },
  { name: 'Ruth', chapters: 4, category: 'OT' },
  { name: '1 Samuel', chapters: 31, category: 'OT' },
  { name: '2 Samuel', chapters: 24, category: 'OT' },
  { name: '1 Kings', chapters: 22, category: 'OT' },
  { name: '2 Kings', chapters: 25, category: 'OT' },
  { name: '1 Chronicles', chapters: 29, category: 'OT' },
  { name: '2 Chronicles', chapters: 36, category: 'OT' },
  { name: 'Ezra', chapters: 10, category: 'OT' },
  { name: 'Nehemiah', chapters: 13, category: 'OT' },
  { name: 'Esther', chapters: 10, category: 'OT' },
  { name: 'Job', chapters: 42, category: 'OT' },
  { name: 'Psalms', chapters: 150, category: 'OT' },
  { name: 'Proverbs', chapters: 31, category: 'OT' },
  { name: 'Ecclesiastes', chapters: 12, category: 'OT' },
  { name: 'Song of Solomon', chapters: 8, category: 'OT' },
  { name: 'Isaiah', chapters: 66, category: 'OT' },
  { name: 'Jeremiah', chapters: 52, category: 'OT' },
  { name: 'Lamentations', chapters: 5, category: 'OT' },
  { name: 'Ezekiel', chapters: 48, category: 'OT' },
  { name: 'Daniel', chapters: 12, category: 'OT' },
  { name: 'Hosea', chapters: 14, category: 'OT' },
  { name: 'Joel', chapters: 3, category: 'OT' },
  { name: 'Amos', chapters: 9, category: 'OT' },
  { name: 'Obadiah', chapters: 1, category: 'OT' },
  { name: 'Jonah', chapters: 4, category: 'OT' },
  { name: 'Micah', chapters: 7, category: 'OT' },
  { name: 'Nahum', chapters: 3, category: 'OT' },
  { name: 'Habakkuk', chapters: 3, category: 'OT' },
  { name: 'Zephaniah', chapters: 3, category: 'OT' },
  { name: 'Haggai', chapters: 2, category: 'OT' },
  { name: 'Zechariah', chapters: 14, category: 'OT' },
  { name: 'Malachi', chapters: 4, category: 'OT' },
  // New Testament
  { name: 'Matthew', chapters: 28, category: 'NT' },
  { name: 'Mark', chapters: 16, category: 'NT' },
  { name: 'Luke', chapters: 24, category: 'NT' },
  { name: 'John', chapters: 21, category: 'NT' },
  { name: 'Acts', chapters: 28, category: 'NT' },
  { name: 'Romans', chapters: 16, category: 'NT' },
  { name: '1 Corinthians', chapters: 16, category: 'NT' },
  { name: '2 Corinthians', chapters: 13, category: 'NT' },
  { name: 'Galatians', chapters: 6, category: 'NT' },
  { name: 'Ephesians', chapters: 6, category: 'NT' },
  { name: 'Philippians', chapters: 4, category: 'NT' },
  { name: 'Colossians', chapters: 4, category: 'NT' },
  { name: '1 Thessalonians', chapters: 5, category: 'NT' },
  { name: '2 Thessalonians', chapters: 3, category: 'NT' },
  { name: '1 Timothy', chapters: 6, category: 'NT' },
  { name: '2 Timothy', chapters: 4, category: 'NT' },
  { name: 'Titus', chapters: 3, category: 'NT' },
  { name: 'Philemon', chapters: 1, category: 'NT' },
  { name: 'Hebrews', chapters: 13, category: 'NT' },
  { name: 'James', chapters: 5, category: 'NT' },
  { name: '1 Peter', chapters: 5, category: 'NT' },
  { name: '2 Peter', chapters: 3, category: 'NT' },
  { name: '1 John', chapters: 5, category: 'NT' },
  { name: '2 John', chapters: 1, category: 'NT' },
  { name: '3 John', chapters: 1, category: 'NT' },
  { name: 'Jude', chapters: 1, category: 'NT' },
  { name: 'Revelation', chapters: 22, category: 'NT' }
];

export const AVAILABLE_TRANSLATIONS: { code: TranslationCode; name: string }[] = [
  { code: 'KJV', name: 'King James Version' },
  { code: 'WEB', name: 'World English Bible' },
  { code: 'ASV', name: 'American Standard Version' }
];

// In-memory cache for loaded chapters
const chapterCache: Record<string, Verse[]> = {};

export function getAvailableBooks(): string[] {
  return BIBLE_BOOKS.map(b => b.name);
}

export function getAvailableChapters(bookName: string): number[] {
  const book = BIBLE_BOOKS.find(b => b.name.toLowerCase() === bookName.toLowerCase());
  if (!book) return [1];
  return Array.from({ length: book.chapters }, (_, i) => i + 1);
}

/**
 * Asynchronously fetches any chapter across the entire Bible (all 66 books) from open public domain API.
 * Caches in memory and returns all verses (e.g. Genesis 1 returns all 31 verses).
 */
export async function fetchChapterVersesAsync(book: string, chapter: number, translation: TranslationCode = 'KJV'): Promise<Verse[]> {
  const cacheKey = `${translation}_${book}_${chapter}`;
  if (chapterCache[cacheKey]) {
    return chapterCache[cacheKey];
  }

  try {
    const formattedRef = `${encodeURIComponent(book)}+${chapter}`;
    const url = `https://bible-api.com/${formattedRef}?translation=${translation.toLowerCase()}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();

    if (json.verses && Array.isArray(json.verses) && json.verses.length > 0) {
      const verses: Verse[] = json.verses.map((v: any) => ({
        verse: v.verse,
        text: v.text.trim().replace(/\s+/g, ' ')
      }));
      chapterCache[cacheKey] = verses;
      return verses;
    }
  } catch (err) {
    console.warn(`[BibleService] Live fetch failed for ${book} ${chapter} (${translation}), trying backup API...`, err);
  }

  // Backup open CDN fetch if bible-api.com is unreachable
  try {
    const bookSlug = book.toLowerCase().replace(/\s+/g, '');
    const backupUrl = `https://cdn.jsdelivr.net/gh/wldeh/bible-api/bibles/en-kjv/books/${bookSlug}/chapters/${chapter}.json`;
    const res = await fetch(backupUrl);
    if (res.ok) {
      const data = await res.json();
      if (data && data.verses && Array.isArray(data.verses)) {
        const verses: Verse[] = data.verses.map((v: any) => ({
          verse: parseInt(v.verse || v.id, 10),
          text: (v.text || '').trim()
        }));
        chapterCache[cacheKey] = verses;
        return verses;
      }
    }
  } catch (e) {
    console.error(`[BibleService] Backup CDN fetch failed:`, e);
  }

  return [];
}

export function splitIntoWords(text: string): { word: string; cleanWord: string }[] {
  const rawTokens = text.split(/(\s+)/);
  const words: { word: string; cleanWord: string }[] = [];
  
  for (const token of rawTokens) {
    if (token.trim().length > 0) {
      const cleanWord = token.replace(/[^\w]/g, '').toLowerCase();
      words.push({ word: token, cleanWord });
    }
  }
  return words;
}
