import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Header } from './components/Header';
import { BibleView } from './components/BibleView';
import { ChapterPicker } from './components/ChapterPicker';
import { AudioControls } from './components/AudioControls';
import { VoiceSelector } from './components/VoiceSelector';
import { ReaderSettings } from './components/ReaderSettings';
import { ChapterResult, TranslationCode, Verse } from './services/bible/types';
import { VoiceOption } from './services/tts/types';
import { PRESET_VOICES, supertonicEngine } from './services/tts/supertonicEngine';
import {
  getNextChapter,
  loadChapter,
  computeVerseOffsets,
  BIBLE_BOOKS
} from './services/bible/bibleService';
import { playbackController, PlaybackState } from './services/audio/playbackController';
import { loadReadingState, saveReadingState } from './services/readingPosition';
import {
  attachMediaSession,
  updateMediaMetadata,
  updatePlaybackState
} from './services/pwa/mediaSession';

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
  /**
   * Read once, synchronously, before the first render. Loading it in an effect
   * would paint Genesis 1 and then jump to the saved passage.
   */
  const [initial] = useState(() => loadReadingState(BIBLE_BOOKS.map((b) => b.name)));

  const [translation, setTranslation] = useState<TranslationCode>(initial.translation);
  const [book, setBook] = useState<string>(initial.book);
  const [chapter, setChapter] = useState<number>(initial.chapter);
  const [fontScale, setFontScale] = useState<number>(initial.fontScale);
  const [speed, setSpeed] = useState<number>(initial.speed);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [currentVoice, setCurrentVoice] = useState<VoiceOption>(PRESET_VOICES[0]);

  const passageKey = passageKeyOf(translation, book, chapter);

  const [chapterState, setChapterState] = useState<ChapterState>({ status: 'loading', key: passageKey });
  const [reloadToken, setReloadToken] = useState(0);
  const [playbackState, setPlaybackState] = useState<PlaybackState>('idle');
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

  /**
   * Warms the voice bundle while the reader is reading.
   *
   * Loading started only when play was pressed, so the entire 398 MB fetch and
   * four graph compiles sat between the tap and the first word — the whole
   * wait was in front of the user, doing nothing else. Starting it on idle
   * moves that cost behind the reading they were already going to do; by the
   * time play is pressed the engine is usually ready, and when it isn't the
   * progress bar simply resumes from wherever it got to.
   *
   * Gated on the connection hints because 398 MB uninvited on a metered link
   * is hostile. When the gate blocks, nothing is lost: pressing play loads it
   * exactly as before.
   */
  useEffect(() => {
    if (supertonicEngine.getStatus() !== 'idle') return;

    const connection = (navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }).connection;
    if (connection?.saveData) return;
    if (connection?.effectiveType && connection.effectiveType !== '4g') return;

    const idle = window.requestIdleCallback ?? ((cb: IdleRequestCallback) => window.setTimeout(cb, 2000));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;

    // Progress is deliberately not reported here: a bar the reader never asked
    // for reads as an error. Pressing play mid-warm picks up the same shared
    // load promise and starts reporting from there.
    const handle = idle(() => void supertonicEngine.load().catch(() => undefined));
    return () => cancel(handle as number);
  }, []);

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
        startWordOffset,
        speed
      );
    },
    [currentVerses, currentVoice.id, book, chapter, speed]
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

  /**
   * A chapter chosen by hand starts at its beginning.
   *
   * The picker is sticky, so it is now reachable from anywhere in a passage.
   * Before, it could only be used at the top of the page and the scroll offset
   * was always near zero, which hid the fact that nothing resets it — jumping
   * from deep in one chapter would otherwise drop the reader into the middle
   * of the next one.
   *
   * Instant rather than smooth: animating a jump of several thousand pixels is
   * slower and more disorienting than simply arriving. Deliberately not called
   * on translation or voice changes, where the reader is holding their place,
   * nor on auto-advance, where the highlight scrolls itself.
   */
  const scrollToPassageTop = () => window.scrollTo({ top: 0, behavior: 'auto' });

  const handleSelectTranslation = (next: TranslationCode) => {
    stopForNavigation();
    setTranslation(next); // R11: book and chapter are preserved.
  };

  const handleSelectVoice = (voice: VoiceOption) => {
    stopForNavigation();
    setCurrentVoice(voice);
  };

  /**
   * R24: lock-screen and headphone controls.
   *
   * Registered once with stable callbacks that read current state via refs
   * would be one option; re-registering when the transport changes is simpler
   * and cheap, since setActionHandler just replaces the previous handler.
   */
  useEffect(() => {
    const detach = attachMediaSession({
      onPlay: () => {
        if (playbackState === 'paused') void playbackController.resume();
        else beginPlayback();
      },
      onPause: () => void playbackController.pause(),
      onStop: () => stopForNavigation(),
      onNext: () => {
        const next = getNextChapter(book, chapter);
        if (!next) return;
        stopForNavigation();
        setBook(next.book);
        setChapter(next.chapter);
        scrollToPassageTop();
      }
    });
    return detach;
  }, [playbackState, beginPlayback, book, chapter]);

  useEffect(() => {
    updateMediaMetadata(book, chapter, translation, currentVoice.name);
  }, [book, chapter, translation, currentVoice.name]);

  useEffect(() => {
    updatePlaybackState(
      playbackState === 'playing' ? 'playing' : playbackState === 'paused' ? 'paused' : 'none'
    );
  }, [playbackState]);

  // R18: persist the passage and preferences so the next launch resumes here.
  useEffect(() => {
    saveReadingState({ translation, book, chapter, fontScale, speed });
  }, [translation, book, chapter, fontScale, speed]);

  useEffect(() => () => playbackController.stop(), []);

  const viewState: ChapterState =
    chapterState.key === passageKey ? chapterState : { status: 'loading', key: passageKey };

  return (
    <div className="app-container" style={{ ['--verse-scale' as string]: String(fontScale) }}>
      {/* Header and picker stick as one unit — see .app-topbar. */}
      <div className="app-topbar">
        <Header
          currentTranslation={translation}
          onSelectTranslation={handleSelectTranslation}
          currentVoice={currentVoice}
          onOpenVoiceSelector={() => setIsVoiceSelectorOpen(true)}
          onOpenSettings={() => setIsSettingsOpen(true)}
        />

        <ChapterPicker
          book={book}
          chapter={chapter}
          onSelectBook={(newBook) => {
            stopForNavigation();
            setBook(newBook);
            scrollToPassageTop();
          }}
          onSelectChapter={(newChapter) => {
            stopForNavigation();
            setChapter(newChapter);
            scrollToPassageTop();
          }}
        />
      </div>

      <BibleView
        translation={translation}
        book={book}
        chapter={chapter}
        state={viewState}
        onRetry={() => setReloadToken((n) => n + 1)}
        activeWordIndex={activeWordIndex}
        onSelectVerseToRead={(verse) => beginPlayback(verse)}
      />

      <AudioControls
        passageTitle={`${book} ${chapter} (${translation})`}
        voice={currentVoice}
        playbackState={playbackState}
        modelProgress={modelProgress}
        errorMessage={engineError}
        disabled={!currentVerses}
        onTogglePlay={handleTogglePlay}
        onRestart={handleRestart}
        onOpenVoiceSelector={() => setIsVoiceSelectorOpen(true)}
      />

      <ReaderSettings
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        fontScale={fontScale}
        onFontScale={setFontScale}
        speed={speed}
        translation={translation}
        onSpeed={(next) => {
          // Applies from the next sentence; the current one is already made.
          setSpeed(next);
        }}
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
