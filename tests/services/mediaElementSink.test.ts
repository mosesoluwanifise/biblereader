import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MediaElementSink } from '../../src/services/audio/mediaElementSink';

/**
 * The fallback is the point of these tests. Routing through a media element is
 * what buys background playback, but the support for it is uneven — and a
 * silent app is a far worse outcome than one that merely stops at the lock
 * screen. Every path that fails has to end with audio still reaching the
 * speakers.
 */

const destination = { id: 'speakers' };

function makeContext(options: { withStreamDestination: boolean }) {
  const gain = { connect: vi.fn(), disconnect: vi.fn() };
  const context: Record<string, unknown> = {
    destination,
    createGain: () => gain
  };
  if (options.withStreamDestination) {
    context.createMediaStreamDestination = () => ({ stream: { id: 'stream' } });
  }
  return { context: context as unknown as AudioContext, gain };
}

/** jsdom does not implement play(); every test states the behaviour it wants. */
function stubPlay(impl: () => Promise<void> | undefined) {
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    writable: true,
    value: impl
  });
}

beforeEach(() => {
  // jsdom implements neither; pause() is called on every teardown path, so it
  // needs a default or the console fills with not-implemented traces.
  stubPlay(() => Promise.resolve());
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    writable: true,
    value: vi.fn()
  });
});

afterEach(() => {
  document.querySelectorAll('audio').forEach((el) => el.remove());
  vi.restoreAllMocks();
});

describe('MediaElementSink', () => {
  it('routes through a media element when the browser supports it', () => {
    stubPlay(() => Promise.resolve());
    const { context, gain } = makeContext({ withStreamDestination: true });

    const sink = new MediaElementSink(context);
    sink.activate();

    // The bus goes to the stream, not the speakers — that indirection is what
    // makes the OS treat this as media playback.
    expect(gain.connect).toHaveBeenCalledTimes(1);
    expect(gain.connect).not.toHaveBeenCalledWith(destination);
    expect(document.querySelectorAll('audio')).toHaveLength(1);
  });

  it('falls back to the speakers when the browser cannot make a stream', () => {
    const { context, gain } = makeContext({ withStreamDestination: false });

    new MediaElementSink(context);

    expect(gain.connect).toHaveBeenCalledWith(destination);
    expect(document.querySelectorAll('audio')).toHaveLength(0);
  });

  it('falls back to the speakers when the element refuses to play', async () => {
    // iOS in particular may reject a WebAudio-backed stream. Playback has to
    // survive that, just without the lock-screen session.
    stubPlay(() => Promise.reject(new Error('NotAllowedError')));
    const { context, gain } = makeContext({ withStreamDestination: true });

    const sink = new MediaElementSink(context);
    sink.activate();
    await Promise.resolve();
    await Promise.resolve();

    expect(gain.connect).toHaveBeenCalledWith(destination);
    expect(document.querySelectorAll('audio')).toHaveLength(0);
  });

  it('tolerates a play() that returns no promise', () => {
    stubPlay(() => undefined);
    const { context } = makeContext({ withStreamDestination: true });

    const sink = new MediaElementSink(context);
    expect(() => sink.activate()).not.toThrow();
  });

  it('pauses the element so the lock screen stops advertising playback', () => {
    stubPlay(() => Promise.resolve());
    const pause = vi.fn();
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
      configurable: true,
      writable: true,
      value: pause
    });

    const { context } = makeContext({ withStreamDestination: true });
    const sink = new MediaElementSink(context);
    sink.activate();
    sink.pause();

    expect(pause).toHaveBeenCalled();
  });

  it('removes the element on release', () => {
    stubPlay(() => Promise.resolve());
    const { context } = makeContext({ withStreamDestination: true });

    const sink = new MediaElementSink(context);
    expect(document.querySelectorAll('audio')).toHaveLength(1);

    sink.release();
    expect(document.querySelectorAll('audio')).toHaveLength(0);
  });

  it('does not double-connect if the fallback is reached twice', async () => {
    stubPlay(() => Promise.reject(new Error('NotAllowedError')));
    const { context, gain } = makeContext({ withStreamDestination: true });

    const sink = new MediaElementSink(context);
    sink.activate();
    sink.activate();
    await Promise.resolve();
    await Promise.resolve();

    const speakerConnects = gain.connect.mock.calls.filter((c) => c[0] === destination);
    expect(speakerConnects).toHaveLength(1);
  });
});
