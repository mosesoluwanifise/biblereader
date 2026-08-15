import React from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { TranslationCode, Verse } from '../services/bible/types';
import { computeVerseOffsets } from '../services/bible/bibleService';
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
  activeWordIndex,
  onSelectVerseToRead
}) => {
  const verses = state.status === 'loaded' ? state.verses : [];
  const verseOffsets = computeVerseOffsets(verses);

  return (
    <div className="reader-container">
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
