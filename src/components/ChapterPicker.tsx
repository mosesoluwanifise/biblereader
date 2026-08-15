import React from 'react';
import { BIBLE_BOOKS, getAvailableChapters } from '../services/bible/bibleService';

interface ChapterPickerProps {
  book: string;
  chapter: number;
  onSelectBook: (b: string) => void;
  onSelectChapter: (c: number) => void;
}

/**
 * Book and chapter selection.
 *
 * Lives outside BibleView so it can share one sticky container with the header
 * — see `.app-topbar`. Keeping it inside the reader meant it scrolled away with
 * the text, and narration scrolls the page continuously to follow the spoken
 * word, so it was gone seconds after pressing play and could only be reached by
 * scrolling against the auto-scroll.
 */
export const ChapterPicker: React.FC<ChapterPickerProps> = ({
  book,
  chapter,
  onSelectBook,
  onSelectChapter
}) => {
  const chapters = getAvailableChapters(book);

  return (
    <div className="chapter-picker">
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
    </div>
  );
};
