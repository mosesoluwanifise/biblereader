import { BIBLE_BOOKS, slugify } from '../bible/bibleService';
import { TranslationCode } from '../bible/types';

/**
 * Explicit offline download for a whole translation.
 *
 * Chapters are cached as they are read, which covers the common case but
 * leaves a reader who wants a translation available on a flight to open all
 * 1,189 chapters by hand. This warms the service worker's cache deliberately.
 *
 * Deliberately not done on install: a translation is roughly 4-5 MB and
 * fetching three of them uninvited on a mobile connection is hostile.
 */

export interface DownloadProgress {
  done: number;
  total: number;
  book: string;
}

const CACHE_NAME = 'scripture-text';

/** How much of a translation is already cached, as a fraction. */
export async function offlineCoverage(translation: TranslationCode): Promise<number> {
  if (typeof caches === 'undefined') return 0;
  try {
    const cache = await caches.open(CACHE_NAME);
    const code = translation.toLowerCase();
    const keys = await cache.keys();
    const have = keys.filter((r) => r.url.includes(`/bibles/${code}/`)).length;
    return Math.min(1, have / BIBLE_BOOKS.length);
  } catch {
    return 0;
  }
}

/**
 * Fetches every book of a translation so the service worker caches it.
 *
 * Serial rather than parallel: this competes with synthesis for bandwidth and
 * CPU, and a burst of 66 requests would stall playback that is already only
 * marginally ahead of realtime.
 */
export async function downloadTranslation(
  translation: TranslationCode,
  onProgress?: (p: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<{ ok: boolean; failed: string[] }> {
  const code = translation.toLowerCase();
  const failed: string[] = [];

  for (let i = 0; i < BIBLE_BOOKS.length; i += 1) {
    if (signal?.aborted) return { ok: false, failed };
    const book = BIBLE_BOOKS[i];
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}bibles/${code}/${slugify(book.name)}.json`, {
        signal
      });
      if (!response.ok) failed.push(book.name);
      // Read the body so the service worker's cache-first handler stores it.
      else await response.arrayBuffer();
    } catch {
      if (signal?.aborted) return { ok: false, failed };
      failed.push(book.name);
    }
    onProgress?.({ done: i + 1, total: BIBLE_BOOKS.length, book: book.name });
  }

  return { ok: failed.length === 0, failed };
}

/** Whether the model bundle is cached, i.e. narration works offline. */
export async function isVoiceAvailableOffline(): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  try {
    const cache = await caches.open('voice-model');
    const keys = await cache.keys();
    return keys.some((r) => r.url.includes('vector_estimator'));
  } catch {
    return false;
  }
}
