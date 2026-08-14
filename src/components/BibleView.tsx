import React, { useEffect, useState } from 'react';
import { TranslationCode, Verse } from '../services/bible/types';
import { BIBLE_BOOKS, getAvailableChapters, fetchChapterVersesAsync } from '../services/bible/bibleService';
import { HighlightedVerse } from './HighlightedVerse';

interface BibleViewProps {
  translation: TranslationCode;
  book: string;
  chapter: number;
  onSelectBook: (b: string) => void;
  onSelectChapter: (c: number) => void;
  activeWordIndex: number;
  onSelectVerseToRead?: (verseNumber: number) => void;
}

export const BibleView: React.FC<BibleViewProps> = ({
  translation,
  book,
  chapter,
  onSelectBook,
  onSelectChapter,
  activeWordIndex,
  onSelectVerseToRead
}) => {
  const [verses, setVerses] = useState<Verse[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const chapters = getAvailableChapters(book);

  useEffect(() => {
    let isMounted = true;
    setIsLoading(true);

    fetchChapterVersesAsync(book, chapter, translation).then((loadedVerses) => {
      if (isMounted) {
        setVerses(loadedVerses);
        setIsLoading(false);
      }
    });

    return () => {
      isMounted = false;
    };
  }, [book, chapter, translation]);

  // Compute word offsets per verse for global index matching
  let cumulativeWordOffset = 0;
  const verseOffsets = verses.map(v => {
    const offset = cumulativeWordOffset;
    const wordCount = v.text.trim().split(/\s+/).length;
    cumulativeWordOffset += wordCount;
    return offset;
  });

  return (
    <div className="reader-container">
      {/* Navigation Bar */}
      <div className="nav-bar">
        <div className="navigation-selectors">
          <select
            className="select-input"
            value={book}
            onChange={(e) => {
              onSelectBook(e.target.value);
              onSelectChapter(1);
            }}
          >
            <optgroup label="Old Testament">
              {BIBLE_BOOKS.filter(b => b.category === 'OT').map(b => (
                <option key={b.name} value={b.name}>{b.name}</option>
              ))}
            </optgroup>
            <optgroup label="New Testament">
              {BIBLE_BOOKS.filter(b => b.category === 'NT').map(b => (
                <option key={b.name} value={b.name}>{b.name}</option>
              ))}
            </optgroup>
          </select>

          <select
            className="select-input"
            value={chapter}
            onChange={(e) => onSelectChapter(Number(e.target.value))}
          >
            {chapters.map((c) => (
              <option key={c} value={c}>Chapter {c}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Chapter Title */}
      <h2 className="chapter-title">
        {book} {chapter} ({translation})
      </h2>

      {/* Loading state */}
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
          Loading passage...
        </div>
      ) : (
        /* Verses List with Word Highlighting */
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
