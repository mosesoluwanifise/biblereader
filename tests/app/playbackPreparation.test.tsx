import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const loadChapter = vi.hoisted(() => vi.fn());
const engine = vi.hoisted(() => ({
  ready: true,
  status: 'ready',
  isReady: vi.fn(() => engine.ready),
  getStatus: vi.fn(() => engine.status),
  load: vi.fn(async () => {
    engine.ready = true;
    engine.status = 'ready';
  })
}));
const controller = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  pause: vi.fn(async () => {}),
  resume: vi.fn(async () => {}),
  getState: vi.fn(() => 'idle' as const),
  preparePassage: vi.fn(async () => null),
  cancelPreparation: vi.fn(),
  getScheduledAheadSeconds: vi.fn(() => 13)
}));

vi.mock('../../src/services/bible/bibleService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/bible/bibleService')>();
  return { ...actual, loadChapter, getBibleDataVersion: vi.fn(async () => 'bible-v1') };
});

vi.mock('../../src/services/tts/supertonicEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/tts/supertonicEngine')>();
  return { ...actual, supertonicEngine: engine };
});

vi.mock('../../src/services/audio/playbackController', () => ({
  playbackController: controller,
  PlaybackController: class {},
  PREFETCH_LOW_WATER_SECONDS: 8,
  PREFETCH_HIGH_WATER_SECONDS: 12,
  SPECULATIVE_PREPARATION_ENABLED: true
}));

import { App } from '../../src/App';
import { AudioControls } from '../../src/components/AudioControls';
import { PRESET_VOICES } from '../../src/services/tts/supertonicEngine';

function verses(book: string, chapter: number) {
  return [
    { verse: 1, text: `${book} ${chapter} first sentence.` },
    { verse: 2, text: `${book} ${chapter} second sentence.` }
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  engine.ready = true;
  engine.status = 'ready';
  controller.getScheduledAheadSeconds.mockReturnValue(13);
  loadChapter.mockImplementation(async (book: string, chapter: number) => ({
    ok: true,
    verses: verses(book, chapter),
    dataVersion: 'bible-v1'
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'connection', { configurable: true, value: undefined });
});

describe('passage preparation integration', () => {
  it('primes matching current text after readiness without autoplay', async () => {
    render(<App />);
    await waitFor(() => expect(controller.preparePassage).toHaveBeenCalled());
    const [text, identity, slot] = controller.preparePassage.mock.calls.at(-1)!;
    expect(text).toContain('Genesis 1 first sentence');
    expect(identity).toMatchObject({
      translation: 'KJV',
      book: 'Genesis',
      chapter: 1,
      sourceTextVersion: 'bible-v1',
      startingVerse: 1,
      startWordOffset: 0,
      voiceId: PRESET_VOICES[0].id
    });
    expect(slot).toBe('current');
    expect(controller.start).not.toHaveBeenCalled();
  });

  it('rapid manual navigation primes only the final loaded target and never autoplays', async () => {
    const user = userEvent.setup();
    const resolvers = new Map<number, (value: unknown) => void>();
    loadChapter.mockImplementation((book: string, chapter: number) => {
      if (chapter === 1) return Promise.resolve({ ok: true, verses: verses(book, chapter), dataVersion: 'bible-v1' });
      return new Promise((resolve) => resolvers.set(chapter, resolve));
    });
    render(<App />);
    await waitFor(() => expect(controller.preparePassage).toHaveBeenCalledTimes(1));
    await user.selectOptions(screen.getByLabelText('Chapter'), '2');
    await user.selectOptions(screen.getByLabelText('Chapter'), '3');
    resolvers.get(3)?.({ ok: true, verses: verses('Genesis', 3), dataVersion: 'bible-v1' });
    resolvers.get(2)?.({ ok: true, verses: verses('Genesis', 2), dataVersion: 'bible-v1' });
    await waitFor(() => expect(controller.preparePassage).toHaveBeenCalledTimes(2));
    expect(controller.preparePassage.mock.calls.at(-1)?.[1]).toMatchObject({ book: 'Genesis', chapter: 3 });
    expect(controller.stop).toHaveBeenCalled();
    expect(controller.start).not.toHaveBeenCalled();
  });

  it('immediate Play uses the same rich identity as incomplete matching preparation', async () => {
    const user = userEvent.setup();
    controller.preparePassage.mockImplementation(() => new Promise(() => {}));
    render(<App />);
    await waitFor(() => expect(controller.preparePassage).toHaveBeenCalled());
    const preparedText = controller.preparePassage.mock.calls[0][0];
    const preparedIdentity = controller.preparePassage.mock.calls[0][1];
    await user.click(screen.getByRole('button', { name: 'Play' }));
    expect(controller.start).toHaveBeenCalledTimes(1);
    expect(controller.start.mock.calls[0][0]).toBe(preparedText);
    expect(controller.start.mock.calls[0][5]).toEqual(preparedIdentity);
  });

  it('admits next-chapter preparation above 12 seconds and cancels it below 8', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(controller.preparePassage).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'Play' }));
    const callbacks = controller.start.mock.calls[0][2] as { onBufferChange: (seconds: number) => void };
    callbacks.onBufferChange(13);
    await waitFor(() => {
      expect(controller.preparePassage.mock.calls.some((call) => call[2] === 'next')).toBe(true);
    });
    const nextCall = controller.preparePassage.mock.calls.find((call) => call[2] === 'next')!;
    expect(nextCall[1]).toMatchObject({ book: 'Genesis', chapter: 2, sourceTextVersion: 'bible-v1' });
    callbacks.onBufferChange(7);
    expect(controller.cancelPreparation).toHaveBeenCalledWith('speculative');
  });

  it('translation changes create a new identity and wait for explicit Play', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(controller.preparePassage).toHaveBeenCalled());
    await user.selectOptions(screen.getByLabelText('Bible translation'), 'WEB');
    await waitFor(() => expect(controller.preparePassage.mock.calls.at(-1)?.[1]).toMatchObject({ translation: 'WEB' }));
    expect(controller.start).not.toHaveBeenCalled();
  });

  it('speed and voice changes stop transport and prime distinct identities', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(controller.preparePassage).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: 'Reading settings' }));
    expect(screen.getByText('Restarts narration at the new speed.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '1.2x' }));
    await waitFor(() => expect(controller.preparePassage.mock.calls.at(-1)?.[1]).toMatchObject({ speed: 1.2 }));

    await user.click(screen.getAllByRole('button', { name: 'Clara' })[0]);
    await user.click(screen.getByText('Miriam'));
    await waitFor(() => expect(controller.preparePassage.mock.calls.at(-1)?.[1]).toMatchObject({
      speed: 1.2,
      voiceId: 'F2'
    }));
    expect(controller.stop).toHaveBeenCalledTimes(2);
    expect(controller.start).not.toHaveBeenCalled();
  });
});

describe('bounded idle warm-up', () => {
  it('passes a timeout to idle warm-up when the connection is eligible', () => {
    engine.ready = false;
    engine.status = 'idle';
    const requestIdleCallback = vi.fn(() => 7);
    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    Object.defineProperty(navigator, 'connection', { configurable: true, value: { effectiveType: '4g' } });
    render(<App />);
    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 5000 });
  });

  it.each([{ saveData: true }, { effectiveType: '3g' }])('does not warm on a gated connection: %o', (connection) => {
    engine.ready = false;
    engine.status = 'idle';
    const requestIdleCallback = vi.fn(() => 7);
    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    Object.defineProperty(navigator, 'connection', { configurable: true, value: connection });
    render(<App />);
    expect(requestIdleCallback).not.toHaveBeenCalled();
    expect(engine.load).not.toHaveBeenCalled();
  });
});

describe('accessible narration states', () => {
  const base = {
    passageTitle: 'Genesis 1 (KJV)',
    voice: PRESET_VOICES[0],
    modelProgress: null,
    modelPhase: null,
    errorMessage: null,
    disabled: false,
    onTogglePlay: vi.fn(),
    onRestart: vi.fn(),
    onOpenVoiceSelector: vi.fn()
  };

  it.each([
    ['preparing', {}, 'Preparing narration…'],
    ['rebuffering', {}, 'Rebuffering narration…'],
    ['device-too-slow', { errorMessage: 'Too slow.' }, 'Too slow.'],
    ['preparing', { modelProgress: 1, modelPhase: 'provider-fallback' }, 'Trying a compatible audio engine…'],
    ['preparing', { modelPhase: 'compile' }, 'Compiling voice model…'],
    ['preparing', { modelPhase: 'warmup' }, 'Warming up narration…']
  ] as const)('announces %s distinctly', (playbackState, overrides, expected) => {
    const { unmount } = render(<AudioControls {...base} {...overrides} playbackState={playbackState} />);
    expect(screen.getAllByRole('status').some((node) => node.textContent === expected)).toBe(true);
    unmount();
  });

  it('exposes stable busy state and numeric download progress', () => {
    render(<AudioControls {...base} playbackState="preparing" modelProgress={0.4} modelPhase="download" />);
    const player = screen.getByRole('region', { name: 'Audio narration controls' });
    expect(player).toHaveAttribute('data-narration-status', 'download');
    expect(player).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('progressbar', { name: 'Downloading voice model' })).toHaveAttribute('aria-valuenow', '40');
  });

  it('exposes a retry action after a retryable error', () => {
    render(<AudioControls {...base} playbackState="idle" errorMessage="Narration failed." />);
    expect(screen.getByRole('button', { name: 'Retry narration' })).toBeEnabled();
  });

  it('does not restart playback while preparing', () => {
    render(<AudioControls {...base} playbackState="preparing" />);
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
  });

  it('allows pausing while rebuffering', async () => {
    const user = userEvent.setup();
    const onTogglePlay = vi.fn();
    render(<AudioControls {...base} playbackState="rebuffering" onTogglePlay={onTogglePlay} />);
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(onTogglePlay).toHaveBeenCalledTimes(1);
  });
});
