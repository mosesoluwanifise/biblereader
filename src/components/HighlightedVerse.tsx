import React, { useEffect, useRef } from 'react';
import { Verse } from '../services/bible/types';

interface HighlightedVerseProps {
  verse: Verse;
  activeGlobalWordIndex: number;
  /** Cumulative word offset of this verse within the chapter. */
  wordOffset: number;
  onSelectVerse?: (verseNumber: number) => void;
}

/** True when the user has asked the system to minimise motion. */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

export const HighlightedVerse: React.FC<HighlightedVerseProps> = ({
  verse,
  activeGlobalWordIndex,
  wordOffset,
  onSelectVerse
}) => {
  const activeRef = useRef<HTMLSpanElement | null>(null);
  const words = verse.text.split(/(\s+)/);

  // Count words once so the render below stays a pure map.
  const wordCount = words.filter((t) => t.trim().length > 0).length;
  const isActiveVerse =
    activeGlobalWordIndex >= wordOffset && activeGlobalWordIndex < wordOffset + wordCount;

  /**
   * Keep the spoken word on screen.
   *
   * Without this the highlight scrolls out of view within a few seconds and
   * the reader has to chase it — the karaoke effect is useless if you cannot
   * see it. Only the active verse scrolls, and only when the highlight moves,
   * so idle re-renders do not fight the user's own scrolling.
   */
  useEffect(() => {
    if (!isActiveVerse || !activeRef.current) return;
    activeRef.current.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'center',
      inline: 'nearest'
    });
  }, [isActiveVerse, activeGlobalWordIndex]);

  const select = () => onSelectVerse?.(verse.verse);

  let seen = 0;

  return (
    <div
      className={`verse-item ${isActiveVerse ? 'verse-item--active' : ''}`}
      // A div with onClick was unreachable by keyboard; the whole reader had no
      // aria attributes at all.
      role={onSelectVerse ? 'button' : undefined}
      tabIndex={onSelectVerse ? 0 : undefined}
      aria-label={onSelectVerse ? `Read from verse ${verse.verse}` : undefined}
      onClick={select}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select();
        }
      }}
    >
      <span className="verse-number" aria-hidden="true">
        {verse.verse}
      </span>
      {words.map((token, idx) => {
        if (token.trim().length === 0) return <span key={idx}>{token}</span>;

        const globalIndex = wordOffset + seen;
        const isHighlighted = globalIndex === activeGlobalWordIndex;
        seen += 1;

        return (
          <span
            key={idx}
            ref={isHighlighted ? activeRef : undefined}
            className={`word-span ${isHighlighted ? 'highlighted' : ''}`}
          >
            {token}
          </span>
        );
      })}
    </div>
  );
};
