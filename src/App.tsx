import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { BibleView } from './components/BibleView';
import { AudioControls } from './components/AudioControls';
import { VoiceSelector } from './components/VoiceSelector';
import { TranslationCode } from './services/bible/types';
import { VoiceOption } from './services/tts/types';
import { PRESET_VOICES, supertonicEngine } from './services/tts/supertonicEngine';
import { getNextChapter, loadChapter, countWords } from './services/bible/bibleService';

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

    const result = await loadChapter(book, chapter, translation);
    if (!result.ok) {
      setIsPlaying(false);
      return;
    }
    const text = result.verses.map((v) => v.text).join(' ');

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

    const result = await loadChapter(book, chapter, translation);
    if (!result.ok) return;

    const selectedVerses = result.verses.filter((v) => v.verse >= startVerseNumber);
    const textToRead = selectedVerses.map((v) => v.text).join(' ');

    let startWordOffset = 0;
    for (const v of result.verses) {
      if (v.verse >= startVerseNumber) break;
      startWordOffset += countWords(v.text);
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

  // R4: continuous playback across chapters and book boundaries.
  // U8 replaces this with effect-driven advance; the setTimeout below still
  // reads a stale `handleTogglePlay` closure and is a known defect until then.
  const handleAutoAdvance = () => {
    const next = getNextChapter(book, chapter);
    if (!next) return;
    setBook(next.book);
    setChapter(next.chapter);
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
