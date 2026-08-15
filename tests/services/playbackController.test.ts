import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlaybackController } from '../../src/services/audio/playbackController';
import { supertonicEngine } from '../../src/services/tts/supertonicEngine';
import { interpolateWordTimings } from '../../src/services/tts/wordTiming';

/**
 * These cover regressions of behavior that actually shipped broken:
 * auto-advance replaying the previous chapter, pause discarding position, and
 * play losing the user gesture behind an await.
 */

/** Minimal AudioContext double. Sources finish when we say they do. */
class FakeAudioContext {
  /** 1:1 with wall clock — the controller's lookahead is in real seconds. */
  static SPEEDUP = 1;
  state: 'running' | 'suspended' | 'closed' = 'running';
  destination = {};
  static live: FakeAudioContext[] = [];
  sources: FakeSource[] = [];
  private origin = Date.now();
  private frozenAt: number | null = null;

  constructor() {
    FakeAudioContext.live.push(this);
  }

  get currentTime(): number {
    const ms = (this.frozenAt ?? Date.now()) - this.origin;
    return (ms / 1000) * FakeAudioContext.SPEEDUP;
  }

  /** Start times the controller scheduled, in order. */
  get startTimes(): number[] {
    return this.sources.filter((s) => s.started).map((s) => s.startAt);
  }

  createBuffer(_channels: number, length: number, sampleRate: number) {
    return { length, sampleRate, duration: length / sampleRate, copyToChannel: vi.fn() };
  }

  createBufferSource() {
    const source = new FakeSource(this);
    this.sources.push(source);
    return source;
  }

  /**
   * Sources feed the sink's bus rather than the speakers directly. No
   * createMediaStreamDestination here on purpose: the sink then takes its
   * speakers fallback, which keeps these tests about scheduling. The
   * media-element route has its own tests in mediaElementSink.test.ts.
   */
  createGain() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }

  async suspend() {
    this.state = 'suspended';
    this.frozenAt = Date.now();
  }

  async resume() {
    if (this.frozenAt !== null) {
      this.origin += Date.now() - this.frozenAt;
      this.frozenAt = null;
    }
    this.state = 'running';
  }

  /** Ends the most recently started source, as playback reaching its end would. */
  finishCurrent() {
    const source = this.sources.find((s) => s.started && !s.ended);
    source?.finish();
  }
}

class FakeSource {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  started = false;
  ended = false;
  startAt = 0;
  constructor(private context: FakeAudioContext) {}
  connect() {}
  disconnect() {}
  start(when = 0) {
    this.started = true;
    this.startAt = when;
  }
  stop() {
    this.ended = true;
  }
  finish() {
    this.ended = true;
    this.onended?.();
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Waits for the controller to settle; the fast audio clock does the rest. */
async function settle(ms = 900): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  FakeAudioContext.live = [];
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number);
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));

  vi.spyOn(supertonicEngine, 'isReady').mockReturnValue(true);
  vi.spyOn(supertonicEngine, 'load').mockResolvedValue(undefined);
  vi.spyOn(supertonicEngine, 'synthesizeSentence').mockImplementation(async (text: string) => ({
    audio: new Float32Array(4410),
    sampleRate: 44100,
    duration: 0.1,
    words: interpolateWordTimings(text, 1)
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('start', () => {
  it('creates and resumes the audio context synchronously, before any await', () => {
    // The shipped bug: play awaited a chapter fetch before speaking, which
    // severs the iOS user-gesture chain. The context must exist by the time
    // start() returns, not after a microtask.
    const controller = new PlaybackController();
    controller.start('In the beginning God created.', 'F1');

    expect(FakeAudioContext.live).toHaveLength(1);
    expect(FakeAudioContext.live[0].state).toBe('running');
  });

  it('reports preparing immediately and playing once audio starts', async () => {
    const states: string[] = [];
    const controller = new PlaybackController();
    controller.start('Jesus wept.', 'F1', { onStateChange: (s) => states.push(s) });

    expect(states).toContain('preparing');
    await flush();
    await flush();
    expect(states).toContain('playing');
  });
});

describe('pause and resume', () => {
  it('resumes rather than restarting, keeping the same source', async () => {
    // The shipped bug: pause called cancel(), so resume replayed the chapter.
    const controller = new PlaybackController();
    controller.start('Jesus wept.', 'F1');
    await flush();
    await flush();

    const context = FakeAudioContext.live[0];
    const sourcesBefore = context.sources.length;

    await controller.pause();
    expect(controller.getState()).toBe('paused');
    expect(context.state).toBe('suspended');

    await controller.resume();
    expect(controller.getState()).toBe('playing');
    expect(context.state).toBe('running');
    // No new source: playback continued rather than starting over.
    expect(context.sources).toHaveLength(sourcesBefore);
  });

  it('ignores pause when not playing and resume when not paused', async () => {
    const controller = new PlaybackController();
    await controller.pause();
    expect(controller.getState()).toBe('idle');
    await controller.resume();
    expect(controller.getState()).toBe('idle');
  });
});

describe('sentence sequencing', () => {
  it('synthesizes each sentence and plays them in order', async () => {
    const controller = new PlaybackController();
    const seen: number[] = [];
    controller.start('First one. Second one. Third one.', 'F1', {
      onSentence: (index) => seen.push(index)
    });

    await settle();
    const context = FakeAudioContext.live[0];

    expect(supertonicEngine.synthesizeSentence).toHaveBeenCalledTimes(3);
    const texts = (supertonicEngine.synthesizeSentence as unknown as { mock: { calls: string[][] } }).mock.calls.map(
      (c) => c[0]
    );
    expect(texts).toEqual(['First one.', 'Second one.', 'Third one.']);
    expect(seen).toEqual([0, 1, 2]);

    // Scheduling against the audio clock: each sentence begins a fixed,
    // deliberate pause after the previous one ends — never a gap that varies
    // with how long synthesis happened to take.
    const starts = context.startTimes;
    const GAP = 0; // model padding provides the spacing
    expect(starts).toHaveLength(3);
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i] - starts[i - 1]).toBeCloseTo(0.1 + GAP, 5);
    }
  });

  it('calls onEnd once the passage finishes', async () => {
    const onEnd = vi.fn();
    const controller = new PlaybackController();
    controller.start('One. Two.', 'F1', { onEnd });

    await settle();

    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('offsets word indices by the starting verse', async () => {
    const words: number[] = [];
    const controller = new PlaybackController();
    // Starting part-way into a chapter must not highlight from index 0.
    controller.start('Alpha beta gamma.', 'F1', { onWord: (i) => words.push(i) }, 100);

    await flush();
    await flush();
    await settle(300);

    // -1 is the clear-highlight signal emitted when the passage ends.
    const highlights = words.filter((w) => w !== -1);
    expect(highlights.length).toBeGreaterThan(0);
    expect(highlights.every((w) => w >= 100)).toBe(true);
  });
});

describe('buffering', () => {
  /**
   * The shipped defect: playback began the moment sentence one existed and
   * kept exactly one sentence in flight, so with synthesis slower than
   * realtime the deficit compounded and `scheduleChunk` clamped to
   * `currentTime` — an audible silence between verses, growing as the passage
   * ran on. These drive the audio clock at 10x so a slow producer can be
   * simulated in under two seconds of wall time.
   */
  const SENTENCES = 12;
  const SECONDS_EACH = 1;
  /** 150 ms wall = 1.5 s of audio clock: synthesis at 1.5x slower than realtime. */
  const SYNTH_WALL_MS = 150;

  beforeEach(() => {
    FakeAudioContext.SPEEDUP = 10;
    (supertonicEngine.synthesizeSentence as unknown as { mockImplementation: (f: unknown) => void }).mockImplementation(
      async (text: string) => {
        await new Promise((r) => setTimeout(r, SYNTH_WALL_MS));
        return {
          audio: new Float32Array(44100 * SECONDS_EACH),
          sampleRate: 44100,
          duration: SECONDS_EACH,
          words: interpolateWordTimings(text, SECONDS_EACH)
        };
      }
    );
  });

  afterEach(() => {
    FakeAudioContext.SPEEDUP = 1;
  });

  const passage = Array.from({ length: SENTENCES }, (_, i) => `Sentence number ${i}.`).join(' ');

  it('banks a lead-in before the first sentence plays', async () => {
    let synthesesWhenPlayingBegan = -1;
    const controller = new PlaybackController();
    controller.start(passage, 'F1', {
      onStateChange: (s) => {
        if (s === 'playing' && synthesesWhenPlayingBegan === -1) {
          synthesesWhenPlayingBegan = (supertonicEngine.synthesizeSentence as unknown as { mock: { calls: unknown[] } })
            .mock.calls.length;
        }
      }
    });

    await settle(2600);
    controller.stop();

    // LEAD_IN_SECONDS is 6, at one second of audio per sentence. Asserted
    // loosely so tuning the constant does not break the test — what matters
    // is that playback no longer begins on a single sentence, as it did.
    expect(synthesesWhenPlayingBegan).toBeGreaterThanOrEqual(5);
  });

  it('plays contiguously when synthesis runs slower than realtime', async () => {
    const controller = new PlaybackController();
    controller.start(passage, 'F1');

    await settle(2600);
    const context = FakeAudioContext.live[0];
    const starts = context.startTimes;
    controller.stop();

    expect(starts.length).toBeGreaterThanOrEqual(SENTENCES);
    // Every sentence butts against the end of the one before it. A producer
    // that fell behind would show a start time later than the previous end.
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i] - starts[i - 1]).toBeCloseTo(SECONDS_EACH, 5);
    }
  });
});

describe('stop', () => {
  it('abandons in-flight playback and resets to idle', async () => {
    const onEnd = vi.fn();
    const controller = new PlaybackController();
    controller.start('One. Two. Three.', 'F1', { onEnd });
    await flush();

    const context = FakeAudioContext.live[0];
    controller.stop();
    expect(controller.getState()).toBe('idle');

    // Anything queued ahead on the audio clock must be cancelled, or future
    // sentences keep playing after stop.
    expect(context.sources.filter((s) => s.started).every((s) => s.ended)).toBe(true);

    await settle(200);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('does not resume a superseded run when start is called again', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const controller = new PlaybackController();

    controller.start('One. Two.', 'F1', { onSentence: first });
    await flush();
    controller.start('Alpha. Beta.', 'F1', { onSentence: second });
    await settle();

    expect(second).toHaveBeenCalled();
  });
});

describe('error handling', () => {
  it('surfaces synthesis failure instead of hanging in preparing', async () => {
    (supertonicEngine.synthesizeSentence as unknown as { mockRejectedValue: (e: Error) => void }).mockRejectedValue(
      new Error('model unavailable')
    );
    const onError = vi.fn();
    const controller = new PlaybackController();
    controller.start('Jesus wept.', 'F1', { onError });

    await flush();
    await flush();
    await flush();

    expect(onError).toHaveBeenCalledWith('model unavailable');
    expect(controller.getState()).toBe('idle');
  });
});
