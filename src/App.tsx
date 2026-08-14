import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Header } from './components/Header';
import { BibleView } from './components/BibleView';
import { AudioControls } from './components/AudioControls';
import { VoiceSelector } from './components/VoiceSelector';
import { ChapterResult, TranslationCode, Verse } from './services/bible/types';
import { EngineTier, VoiceOption } from './services/tts/types';
import { PRESET_VOICES } from './services/tts/supertonicEngine';
import { getNextChapter, loadChapter, computeVerseOffsets } from './services/bible/bibleService';
import { playbackController, PlaybackState } from './services/audio/playbackController';

/**
 * Chapter state carries the passage it belongs to.
 *
 * Without that key, auto-advance replayed the previous chapter: moving the
 * passage re-renders before the loading effect's state update lands, so the
 * continuation effect saw the *old* loaded verses, treated them as the new
 * chapter, and consumed the continuation flag — after which the real chapter
 * never resumed.
 */
type ChapterState =
  | { status: 'loading'; key: string }
  | { status: 'loaded'; key: string; verses: Verse[] }
  | { status: 'error'; key: string; message: string; retryable: boolean };

const passageKeyOf = (t: TranslationCode, b: string, c: number) => `${t}|${b}|${c}`;

export const App: React.FC = () => {
  const [translation, setTranslation] = useState<TranslationCode>('KJV');
  const [book, setBook] = useState<string>('Genesis');
  const [chapter, setChapter] = useState<number>(1);
  const [currentVoice, setCurrentVoice] = useState<VoiceOption>(PRESET_VOICES[0]);

  const passageKey = passageKeyOf(translation, book, chapter);

  const [chapterState, setChapterState] = useState<ChapterState>({ status: 'loading', key: passageKey });
  const [reloadToken, setReloadToken] = useState(0);
  const [playbackState, setPlaybackState] = useState<PlaybackState>('idle');
  const [engineTier, setEngineTier] = useState<EngineTier | null>(null);
  const [modelProgress, setModelProgress] = useState<number | null>(null);
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
    const key = passageKeyOf(translation, book, chapter);
    setChapterState({ status: 'loading', key });

    loadChapter(book, chapter, translation).then((result: ChapterResult) => {
      if (!active) return;
      if (result.ok) {
        setChapterState({ status: 'loaded', key, verses: result.verses });
      } else {
        continuePlaying.current = false;
        setChapterState({
          status: 'error',
          key,
          message: result.message,
          retryable: result.reason === 'unavailable'
        });
      }
    });

    return () => {
      active = false;
    };
  }, [book, chapter, translation, reloadToken]);

  /** Verses only count as current when they belong to the displayed passage. */
  const currentVerses = useMemo(
    () => (chapterState.status === 'loaded' && chapterState.key === passageKey ? chapterState.verses : null),
    [chapterState, passageKey]
  );

  const beginPlayback = useCallback(
    (fromVerse?: number) => {
      if (!currentVerses) return;

      const selected = fromVerse ? currentVerses.filter((v) => v.verse >= fromVerse) : currentVerses;
      if (selected.length === 0) return;

      const offsets = computeVerseOffsets(currentVerses);
      const startIndex = fromVerse ? currentVerses.findIndex((v) => v.verse >= fromVerse) : 0;
      const startWordOffset = startIndex >= 0 ? offsets[startIndex] : 0;

      setEngineError(null);
      setActiveWordIndex(startWordOffset);

      playbackController.start(
        selected.map((v) => v.text).join(' '),
        currentVoice.id,
        {
          onWord: setActiveWordIndex,
          onStateChange: setPlaybackState,
          onTier: setEngineTier,
          onModelProgress: setModelProgress,
          onError: (message) => {
            setEngineError(message);
            setActiveWordIndex(-1);
          },
          onEnd: () => {
            setActiveWordIndex(-1);
            // R4: hand off by moving the passage and flagging intent. The
            // effect below resumes once the *matching* chapter has loaded.
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
    [currentVerses, currentVoice.id, book, chapter]
  );

  // Resumes playback after auto-advance, once the next chapter's text is in.
  // Gated on currentVerses, which is null while the loaded state still belongs
  // to the previous passage — so a stale render cannot consume the flag.
  useEffect(() => {
    if (!continuePlaying.current) return;
    if (!currentVerses) return;
    continuePlaying.current = false;
    beginPlayback();
  }, [currentVerses, beginPlayback]);

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
    stopForNavigation();
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

  const viewState: ChapterState =
    chapterState.key === passageKey ? chapterState : { status: 'loading', key: passageKey };

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
        state={viewState}
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
        engineTier={engineTier}
        modelProgress={modelProgress}
        errorMessage={engineError}
        disabled={!currentVerses}
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
