import { BookData } from './types';

/**
 * IndexedDB persistence for fetched books.
 *
 * The in-memory map in bibleService handles a session; this survives reloads,
 * which is what makes offline reading real rather than documented. Every
 * operation degrades to a no-op when IndexedDB is unavailable (private
 * browsing, storage pressure, disabled) — a cache miss must never be able to
 * break reading.
 */

const DB_NAME = 'scripture-voice';
const DB_VERSION = 2;
const STORE = 'books';
const META = 'meta';
const DATA_VERSION_KEY = 'bibleDataVersion';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }

    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });

  return dbPromise;
}

export function cacheKey(translation: string, bookSlug: string): string {
  return `${translation}:${bookSlug}`;
}

/**
 * Drops every cached book when the shipped text changes.
 *
 * Cached books previously had no version, so a reader who had already opened a
 * chapter kept the old text indefinitely. That is how footnote-contaminated
 * verses survived a corrected rebuild — the files on disk were clean while the
 * app still served the bad copy from IndexedDB. A text correction that cannot
 * reach the people already reading is not a correction.
 */
export async function reconcileDataVersion(version: string): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;

  const stored = await new Promise<string | null>((resolve) => {
    try {
      const request = db.transaction(META, 'readonly').objectStore(META).get(DATA_VERSION_KEY);
      request.onsuccess = () => resolve((request.result as string) ?? null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

  if (stored === version) return false;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction([STORE, META], 'readwrite');
      tx.objectStore(STORE).clear();
      tx.objectStore(META).put(version, DATA_VERSION_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });

  return stored !== null;
}

export async function readCachedBook(translation: string, bookSlug: string): Promise<BookData | null> {
  const db = await openDb();
  if (!db) return null;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(cacheKey(translation, bookSlug));
      request.onsuccess = () => resolve((request.result as BookData) ?? null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function writeCachedBook(translation: string, bookSlug: string, book: BookData): Promise<void> {
  const db = await openDb();
  if (!db) return;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(book, cacheKey(translation, bookSlug));
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function listCachedBooks(translation: string): Promise<string[]> {
  const db = await openDb();
  if (!db) return [];

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).getAllKeys();
      request.onsuccess = () => {
        const prefix = `${translation}:`;
        resolve(
          (request.result as IDBValidKey[])
            .map(String)
            .filter((k) => k.startsWith(prefix))
            .map((k) => k.slice(prefix.length))
        );
      };
      request.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

/**
 * Closes the memoized connection. Dropping the reference alone is not enough —
 * an open handle blocks `deleteDatabase` and any subsequent `open`, which
 * deadlocks rather than erroring.
 */
export async function closeCache(): Promise<void> {
  if (!dbPromise) return;
  const pending = dbPromise;
  dbPromise = null;
  try {
    (await pending)?.close();
  } catch {
    /* already gone */
  }
}
