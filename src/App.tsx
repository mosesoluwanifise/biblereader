import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { BibleView } from './components/BibleView';
import { AudioControls } from './components/AudioControls';
import { VoiceSelector } from './components/VoiceSelector';
import { TranslationCode } from './services/bible/types';
import { VoiceOption } from './services/tts/types';
import { PRESET_VOICES, supertonicEngine } from './services/tts/supertonicEngine';
import { getAvailableChapters, fetchChapterVersesAsync } from './services/bible/bibleService';

export const App: React.FC = () => {
  const [translation, setTranslation] = useState<TranslationCode>('KJV');
  const [book, setBook] = useState<string>('Genesis');
  const [chapter, setChapter] = useState<number>(1);
  const [currentVoice, setCurrentVoice] = useState<VoiceOption>(PRESET_VOICES[0]);

  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [activeWordIndex, setActiveWordIndex] = useState<number>(-1);
  const [isVoiceSelectorOpen, setIsVoiceSelectorOpen] = useState<boolean>(false);

  // Instantly stop audio whenever passage, translation, or voice selection changes
  useEffect(() => {
    supertonicEngine.stop();
    setIsPlaying(false);
    setActiveWordIndex(-1);
  }, [translation, book, chapter, currentVoice]);

  // R11 Position Preservation: Maintain current book & chapter when switching translation
  const handleSelectTranslation = (newTranslation: TranslationCode) => {
    supertonicEngine.stop();
    setIsPlaying(false);
    setActiveWordIndex(-1);
    setTranslation(newTranslation);
  };

  const handleTogglePlay = async () => {
    if (isPlaying) {
      supertonicEngine.stop();
      setIsPlaying(false);
      setActiveWordIndex(-1);
      return;
    }

    const verses = await fetchChapterVersesAsync(book, chapter, translation);
    const text = verses.map(v => v.text).join(' ');

    if (!text) {
      setIsPlaying(false);
      return;
    }

    setIsPlaying(true);

    supertonicEngine.speakText(
      text,
      currentVoice.id,
      0, // Start from beginning of chapter
      (wordIdx) => {
        setActiveWordIndex(wordIdx);
      },
      () => {
        setIsPlaying(false);
        setActiveWordIndex(-1);
        handleAutoAdvance();
      }
    );
  };

  // Click-to-Start Reading from selected verse
  const handleSelectVerseToRead = async (startVerseNumber: number) => {
    supertonicEngine.stop();
    setIsPlaying(false);
    setActiveWordIndex(-1);

    const verses = await fetchChapterVersesAsync(book, chapter, translation);
    if (!verses || verses.length === 0) return;

    // Filter verses starting from selected verse number
    const selectedVerses = verses.filter(v => v.verse >= startVerseNumber);
    const textToRead = selectedVerses.map(v => v.text).join(' ');

    // Calculate word offset of startVerseNumber in chapter
    let startWordOffset = 0;
    for (const v of verses) {
      if (v.verse < startVerseNumber) {
        startWordOffset += v.text.trim().split(/\s+/).length;
      } else {
        break;
      }
    }

    setIsPlaying(true);
    setActiveWordIndex(startWordOffset);

    supertonicEngine.speakText(
      textToRead,
      currentVoice.id,
      startWordOffset,
      (wordIdx) => {
        setActiveWordIndex(wordIdx);
      },
      () => {
        setIsPlaying(false);
        setActiveWordIndex(-1);
        handleAutoAdvance();
      }
    );
  };

  const handleRestart = () => {
    supertonicEngine.stop();
    setIsPlaying(false);
    setActiveWordIndex(-1);
  };

  // R4: Continuous playback auto-advance across chapters
  const handleAutoAdvance = () => {
    const chapters = getAvailableChapters(book);
    const nextIndex = chapters.indexOf(chapter) + 1;
    if (nextIndex < chapters.length) {
      setChapter(chapters[nextIndex]);
      setTimeout(() => {
        handleTogglePlay();
      }, 500);
    }
  };

  const handleSelectVoice = (voice: VoiceOption) => {
    supertonicEngine.stop();
    setIsPlaying(false);
    setActiveWordIndex(-1);
    setCurrentVoice(voice);
  };

  return (
    <div className="app-container">
      <Header
        currentTranslation={translation}
        onSelectTranslation={handleSelectTranslation}
        currentVoice={currentVoice}
        onOpenVoiceSelector={() => setIsVoiceSelectorOpen(true)}
      />

      <BibleView
        translation={translation}
        book={book}
        chapter={chapter}
        onSelectBook={(newBook) => {
          supertonicEngine.stop();
          setIsPlaying(false);
          setActiveWordIndex(-1);
          setBook(newBook);
        }}
        onSelectChapter={(newChapter) => {
          supertonicEngine.stop();
          setIsPlaying(false);
          setActiveWordIndex(-1);
          setChapter(newChapter);
        }}
        activeWordIndex={activeWordIndex}
        onSelectVerseToRead={handleSelectVerseToRead}
      />

      <AudioControls
        passageTitle={`${book} ${chapter} (${translation})`}
        voice={currentVoice}
        isPlaying={isPlaying}
        onTogglePlay={handleTogglePlay}
        onRestart={handleRestart}
        onOpenVoiceSelector={() => setIsVoiceSelectorOpen(true)}
      />

      <VoiceSelector
        isOpen={isVoiceSelectorOpen}
        onClose={() => setIsVoiceSelectorOpen(false)}
        selectedVoice={currentVoice}
        onSelectVoice={handleSelectVoice}
      />
    </div>
  );
};
