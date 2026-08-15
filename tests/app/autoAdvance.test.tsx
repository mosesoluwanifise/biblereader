import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Regression cover for auto-advance replaying the previous chapter.
 *
 * Moving the passage re-renders before the chapter-loading effect's state
 * update lands, so the continuation effect used to see the *old* loaded verses,
 * treat them as the new chapter, and consume the continuation flag. The result
 * was the previous chapter read twice and the next one never starting.
 *
 * These drive the real App against a stubbed loader and playback controller,
 * because the defect lives in effect ordering — not in either collaborator.
 */

const loadChapter = vi.hoisted(() => vi.fn());
const controller = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  pause: vi.fn(async () => {}),
  resume: vi.fn(async () => {}),
  getState: vi.fn(() => 'idle' as const)
}));

vi.mock('../../src/services/bible/bibleService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/bible/bibleService')>();
  return { ...actual, loadChapter };
});

vi.mock('../../src/services/audio/playbackController', () => ({
  playbackController: controller,
  PlaybackController: class {}
}));

import { App } from '../../src/App';

/** Verses whose text names the passage, so replays are identifiable. */
function versesFor(book: string, chapter: number) {
  return [
    { verse: 1, text: `${book} ${chapter} verse one` },
    { verse: 2, text: `${book} ${chapter} verse two` }
  ];
}

/** Runs the onEnd callback the App handed to the controller. */
function fireEnd() {
  const lastCall = controller.start.mock.calls.at(-1);
  const callbacks = lastCall?.[2] as { onEnd?: () => void } | undefined;
  callbacks?.onEnd?.();
}

function textsPassedToStart(): string[] {
  return controller.start.mock.calls.map((c) => String(c[0]));
}

/**
 * HighlightedVerse renders every word in its own span, so the rendered text is
 * split across elements and getByText cannot match a phrase. Read it off the
 * verse containers instead.
 */
function renderedVerseText(): string {
  return [...document.querySelectorAll('.verse-item')].map((el) => el.textContent ?? '').join(' ');
}

async function waitForPassage(fragment: string): Promise<void> {
  await waitFor(() => expect(renderedVerseText()).toContain(fragment));
}

beforeEach(() => {
  vi.clearAllMocks();
  // App now restores the saved passage on mount, so a position left behind by
  // a previous test would decide where this one starts.
  localStorage.clear();
  loadChapter.mockImplementation(async (book: string, chapter: number) => ({
    ok: true,
    verses: versesFor(book, chapter)
  }));
});

afterEach(() => vi.restoreAllMocks());

describe('auto-advance', () => {
  it('plays the next chapter, not the one that just finished', async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitForPassage('Genesis 1 verse one');
    await user.click(screen.getByRole('button', { name: 'Play' }));

    await waitFor(() => expect(controller.start).toHaveBeenCalledTimes(1));
    expect(textsPassedToStart()[0]).toContain('Genesis 1');

    fireEnd();

    // The next start must carry Genesis 2's text. The bug produced a second
    // start still holding Genesis 1.
    await waitFor(() => expect(controller.start).toHaveBeenCalledTimes(2));
    const second = textsPassedToStart()[1];
    expect(second).toContain('Genesis 2');
    expect(second).not.toContain('Genesis 1 verse');
  });

  it('advances across a book boundary', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitForPassage('Genesis 1 verse one');

    // Jump to the last chapter of Genesis via the chapter selector.
    await user.selectOptions(screen.getByLabelText('Chapter'), '50');
    await waitForPassage('Genesis 50 verse one');

    await user.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() => expect(controller.start).toHaveBeenCalled());
    fireEnd();

    await waitFor(() => {
      expect(textsPassedToStart().at(-1)).toContain('Exodus 1');
    });
  });

  it('does not advance past the end of Revelation', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitForPassage('Genesis 1 verse one');

    await user.selectOptions(screen.getByLabelText('Book'), 'Revelation');
    await user.selectOptions(screen.getByLabelText('Chapter'), '22');
    await waitForPassage('Revelation 22 verse one');

    await user.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() => expect(controller.start).toHaveBeenCalled());
    const before = controller.start.mock.calls.length;

    fireEnd();
    await new Promise((r) => setTimeout(r, 50));

    expect(controller.start.mock.calls.length).toBe(before);
  });

  it('stops advancing when the next chapter fails to load', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitForPassage('Genesis 1 verse one');
    await user.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() => expect(controller.start).toHaveBeenCalledTimes(1));

    loadChapter.mockResolvedValue({ ok: false, reason: 'unavailable', message: 'Could not load Genesis 2' });
    fireEnd();

    await screen.findByRole('alert');
    // No second playback started from a chapter that never arrived.
    expect(controller.start).toHaveBeenCalledTimes(1);
  });

  it('shows the loading state for the new passage rather than stale verses', async () => {
    const user = userEvent.setup();
    let release: ((v: unknown) => void) | null = null;
    render(<App />);
    await waitForPassage('Genesis 1 verse one');

    loadChapter.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );

    await user.selectOptions(screen.getByLabelText('Chapter'), '2');

    // While chapter 2 is in flight, chapter 1's verses must not still show.
    await waitFor(() => expect(renderedVerseText()).not.toContain('Genesis 1 verse one'));

    release?.({ ok: true, verses: versesFor('Genesis', 2) });
    await waitForPassage('Genesis 2 verse one');
  });
});
