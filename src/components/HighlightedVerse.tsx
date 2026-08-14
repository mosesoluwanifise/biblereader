import React from 'react';
import { Verse } from '../services/bible/types';

interface HighlightedVerseProps {
  verse: Verse;
  activeGlobalWordIndex: number;
  wordOffset: number; // Cumulative word offset in chapter
  onSelectVerse?: (verseNumber: number) => void;
}

export const HighlightedVerse: React.FC<HighlightedVerseProps> = ({
  verse,
  activeGlobalWordIndex,
  wordOffset,
  onSelectVerse
}) => {
  // Split words by space preserving tokens
  const words = verse.text.split(/(\s+)/);
  let currentWordCount = 0;

  return (
    <div
      className="verse-item"
      onClick={() => onSelectVerse && onSelectVerse(verse.verse)}
      title="Click to start reading from this verse"
      style={{ cursor: 'pointer' }}
    >
      <span className="verse-number">{verse.verse}</span>
      {words.map((token, idx) => {
        if (token.trim().length === 0) {
          return <span key={idx}>{token}</span>; // Render spacing
        }

        const globalIndex = wordOffset + currentWordCount;
        const isHighlighted = globalIndex === activeGlobalWordIndex;
        currentWordCount++;

        return (
          <span
            key={idx}
            className={`word-span ${isHighlighted ? 'highlighted' : ''}`}
          >
            {token}
          </span>
        );
      })}
    </div>
  );
};
