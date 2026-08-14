import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Header } from './components/Header';
import { BibleView } from './components/BibleView';
import { AudioControls } from './components/AudioControls';
import { VoiceSelector } from './components/VoiceSelector';
import { ChapterResult, TranslationCode, Verse } from './services/bible/types';
import { VoiceOption } from './services/tts/types';
import { PRESET_VOICES, supertonicEngine } from './services/tts/supertonicEngine';
import { getNextChapter, loadChapter, computeVerseOffsets } from './services/bible/bibleService';
import { playbackController, PlaybackState } from './services/audio/playbackController';

type ChapterState =
  | { status: 'loading' }
  | { status: 'loaded'; verses: Verse[] }
  | { status: 'error'; message: string; retryable: boolean };

export const App: React.FC = () => {
  const [translation, setTranslation] = useState<TranslationCode>('KJV');
  const [book, setBook] = useState<string>('Genesis');
  const [chapter, setChapter] = useState<number>(1);
  const [currentVoice, setCurrentVoice] = useState<VoiceOption>(PRESET_VOICES[0]);

  const [chapterState, setChapterState] = useState<ChapterState>({ status: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);
  const [playbackState, setPlaybackState] = useState<PlaybackState>('idle');
  const [activeWordIndex, setActiveWordIndex] = useState<number>(-1);
  const [isVoiceSelectorOpen, setIsVoiceSelectorOpen] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);

  /** Set when auto-advance moves the passage, so the effect resumes playback. */
  const continuePlaying = useRef(false);

  // Chapter text is held here rather than inside the reader so that pressing
  // play never has to await a load — the iOS user-gesture chain cannot survive
  // an await before audio starts.
  useEffect(() => {
    let active = true;
    setChapterState({ status: 'loading' });

    loadChapter(book, chapter, translation).then((result: ChapterResult) => {
      if (!active) return;
      if (result.ok) {
        setChapterState({ status: 'loaded', verses: result.verses });
      } else {
        continuePlaying.current = false;
        setChapterState({ status: 'error', message: result.message, retryable: result.reason === 'unavailable' });
      }
    });

    return () => {
      active = false;
    };
  }, [book, chapter, translation, reloadToken]);

  const verses = chapterState.status === 'loaded' ? chapterState.verses : [];

  const beginPlayback = useCallback(
    (fromVerse?: number) => {
      if (chapterState.status !== 'loaded') return;

      const selected = fromVerse ? chapterState.verses.filter((v) => v.verse >= fromVerse) : chapterState.verses;
      if (selected.length === 0) return;

      const offsets = computeVerseOffsets(chapterState.verses);
      const startIndex = fromVerse ? chapterState.verses.findIndex((v) => v.verse >= fromVerse) : 0;
      const startWordOffset = startIndex >= 0 ? offsets[startIndex] : 0;

      setEngineError(null);
      setActiveWordIndex(startWordOffset);

      playbackController.start(
        selected.map((v) => v.text).join(' '),
        currentVoice.id,
        {
          onWord: setActiveWordIndex,
          onStateChange: setPlaybackState,
          onError: (message) => {
            setEngineError(message);
            setActiveWordIndex(-1);
          },
          onEnd: () => {
            setActiveWordIndex(-1);
            // R4: hand off to the next chapter by moving the passage and
            // flagging intent. The effect below restarts playback once the new
            // text has loaded — no timer, and no stale closure to capture.
            const next = getNextChapter(book, chapter);
            if (!next) return;
            continuePlaying.current = true;
            setBook(next.book);
            setChapter(next.chapter);
          }
        },
        startWordOffset
      );
    },
    [chapterState, currentVoice.id, book, chapter]
  );

  // Resumes playback after auto-advance, once the next chapter's text is in.
  useEffect(() => {
    if (!continuePlaying.current) return;
    if (chapterState.status !== 'loaded') return;
    continuePlaying.current = false;
    beginPlayback();
  }, [chapterState, beginPlayback]);

  const handleTogglePlay = () => {
    if (playbackState === 'playing') {
      void playbackController.pause();
      return;
    }
    if (playbackState === 'paused') {
      void playbackController.resume();
      return;
    }
    beginPlayback();
  };

  const handleRestart = () => {
    playbackController.stop();
    setActiveWordIndex(-1);
  };

  const stopForNavigation = () => {
    continuePlaying.current = false;
    playbackController.stop();
    setActiveWordIndex(-1);
  };

  const handleSelectTranslation = (next: TranslationCode) => {
    stopForNavigation();
    setTranslation(next); // R11: book and chapter are preserved.
  };

  const handleSelectVoice = (voice: VoiceOption) => {
    stopForNavigation();
    setCurrentVoice(voice);
  };

  useEffect(() => () => playbackController.stop(), []);

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
        state={chapterState}
        onRetry={() => setReloadToken((n) => n + 1)}
        onSelectBook={(newBook) => {
          stopForNavigation();
          setBook(newBook);
        }}
        onSelectChapter={(newChapter) => {
          stopForNavigation();
          setChapter(newChapter);
        }}
        activeWordIndex={activeWordIndex}
        onSelectVerseToRead={(verse) => beginPlayback(verse)}
      />

      <AudioControls
        passageTitle={`${book} ${chapter} (${translation})`}
        voice={currentVoice}
        playbackState={playbackState}
        engineStatus={supertonicEngine.getStatus()}
        errorMessage={engineError}
        disabled={verses.length === 0}
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
