import React from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { TranslationCode, Verse } from '../services/bible/types';
import { BIBLE_BOOKS, getAvailableChapters, computeVerseOffsets } from '../services/bible/bibleService';
import { HighlightedVerse } from './HighlightedVerse';

export type ChapterViewState =
  | { status: 'loading' }
  | { status: 'loaded'; verses: Verse[] }
  | { status: 'error'; message: string; retryable: boolean };

interface BibleViewProps {
  translation: TranslationCode;
  book: string;
  chapter: number;
  state: ChapterViewState;
  onRetry: () => void;
  onSelectBook: (b: string) => void;
  onSelectChapter: (c: number) => void;
  activeWordIndex: number;
  onSelectVerseToRead?: (verseNumber: number) => void;
}

/**
 * Presentational. Chapter text is owned by App so that starting playback never
 * has to await a load — see the gesture note there.
 */
export const BibleView: React.FC<BibleViewProps> = ({
  translation,
  book,
  chapter,
  state,
  onRetry,
  onSelectBook,
  onSelectChapter,
  activeWordIndex,
  onSelectVerseToRead
}) => {
  const chapters = getAvailableChapters(book);
  const verses = state.status === 'loaded' ? state.verses : [];
  const verseOffsets = computeVerseOffsets(verses);

  return (
    <div className="reader-container">
      <div className="nav-bar">
        <div className="navigation-selectors">
          <select
            className="select-input"
            value={book}
            aria-label="Book"
            onChange={(e) => {
              onSelectBook(e.target.value);
              onSelectChapter(1);
            }}
          >
            <optgroup label="Old Testament">
              {BIBLE_BOOKS.filter((b) => b.category === 'OT').map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="New Testament">
              {BIBLE_BOOKS.filter((b) => b.category === 'NT').map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
            </optgroup>
          </select>

          <select
            className="select-input"
            value={chapter}
            aria-label="Chapter"
            onChange={(e) => onSelectChapter(Number(e.target.value))}
          >
            {chapters.map((c) => (
              <option key={c} value={c}>
                Chapter {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      <h2 className="chapter-title">
        {book} {chapter} ({translation})
      </h2>

      {state.status === 'loading' && (
        <div className="reader-status" role="status" aria-live="polite">
          Loading passage…
        </div>
      )}

      {state.status === 'error' && (
        <div className="reader-status reader-status--error" role="alert">
          <AlertCircle size={20} aria-hidden="true" />
          <p>{state.message}</p>
          {state.retryable && (
            <button className="btn btn-secondary" onClick={onRetry}>
              <RefreshCw size={14} aria-hidden="true" />
              <span>Try again</span>
            </button>
          )}
        </div>
      )}

      {state.status === 'loaded' && (
        <div className="verses-list">
          {verses.map((verse, idx) => (
            <HighlightedVerse
              key={verse.verse}
              verse={verse}
              activeGlobalWordIndex={activeWordIndex}
              wordOffset={verseOffsets[idx]}
              onSelectVerse={onSelectVerseToRead}
            />
          ))}
        </div>
      )}
    </div>
  );
};
