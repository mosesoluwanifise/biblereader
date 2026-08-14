import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { BibleView } from './components/BibleView';
import { AudioControls } from './components/AudioControls';
import { VoiceSelector } from './components/VoiceSelector';
import { VoiceCloningModal } from './components/VoiceCloningModal';
import { TranslationCode } from './services/bible/types';
import { VoiceOption } from './services/tts/types';
import { PRESET_VOICES, supertonicEngine } from './services/tts/supertonicEngine';
import { getAvailableChapters, fetchChapterVersesAsync } from './services/bible/bibleService';
import { deleteClonedVoice } from './services/api/voiceCloningApi';

export const App: React.FC = () => {
  const [translation, setTranslation] = useState<TranslationCode>('KJV');
  const [book, setBook] = useState<string>('Genesis');
  const [chapter, setChapter] = useState<number>(1);
  const [currentVoice, setCurrentVoice] = useState<VoiceOption>(PRESET_VOICES[0]);
  const [clonedVoices, setClonedVoices] = useState<VoiceOption[]>([]);
  
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [activeWordIndex, setActiveWordIndex] = useState<number>(-1);
  const [isVoiceSelectorOpen, setIsVoiceSelectorOpen] = useState<boolean>(false);
  const [isCloningModalOpen, setIsCloningModalOpen] = useState<boolean>(false);
  const [isSubscribed, setIsSubscribed] = useState<boolean>(true);

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

  const handleVoiceCloned = (newVoice: VoiceOption) => {
    setClonedVoices((prev) => [...prev, newVoice]);
    setCurrentVoice(newVoice);
  };

  const handleDeleteClonedVoice = async (voiceId: string) => {
    try {
      await deleteClonedVoice(voiceId);
    } catch (e) {
      // Local fallback for demo
    }
    setClonedVoices((prev) => prev.filter((v) => v.id !== voiceId));
    if (currentVoice.id === voiceId) {
      setCurrentVoice(PRESET_VOICES[0]);
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
        onOpenVoiceCloning={() => setIsCloningModalOpen(true)}
        isSubscribed={isSubscribed}
        onToggleSubscription={() => setIsSubscribed(!isSubscribed)}
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
        clonedVoices={clonedVoices}
        onDeleteClonedVoice={handleDeleteClonedVoice}
        onOpenCloningModal={() => setIsCloningModalOpen(true)}
      />

      <VoiceCloningModal
        isOpen={isCloningModalOpen}
        onClose={() => setIsCloningModalOpen(false)}
        onVoiceCloned={handleVoiceCloned}
      />
    </div>
  );
};
