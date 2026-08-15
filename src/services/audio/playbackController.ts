import { supertonicEngine, EngineCancelled } from '../tts/supertonicEngine';
import { splitSentences } from '../tts/wordTiming';
import { WordTimestamp } from '../tts/types';

/**
 * Owns audio playback for a passage.
 *
 * Shaped by defects that actually shipped:
 *  - Auto-advance ran off a setTimeout holding a stale closure, so it replayed
 *    the previous chapter. Advance is now a callback the caller drives.
 *  - Pause called speechSynthesis.cancel(), discarding position. Pause now
 *    suspends the AudioContext; resume continues from the same offset.
 *  - Play awaited a network fetch before speaking, severing the iOS user
 *    gesture. The AudioContext is created and unlocked synchronously in
 *    `start`, before any await.
 *  - Stopping abandoned in-flight inference without cancelling it, so the
 *    worker kept running chains nobody awaited. Stop now cancels by generation.
 *
 * Play waits for the Supertonic engine to finish loading before speaking —
 * no platform voice plays in the meantime. Synthesis only just clears realtime
 * on WASM, so audio is banked ahead of the playhead rather than produced
 * one sentence at a time.
 */

export type PlaybackState = 'idle' | 'preparing' | 'playing' | 'paused';

export interface PlaybackCallbacks {
  onWord?: (globalWordIndex: number) => void;
  onStateChange?: (state: PlaybackState) => void;
  onModelProgress?: (fraction: number | null) => void;
  onSentence?: (index: number, total: number) => void;
  onEnd?: () => void;
  onError?: (message: string) => void;
}

interface Chunk {
  text: string;
  wordOffset: number;
  buffer: AudioBuffer;
  words: WordTimestamp[];
}

export class PlaybackController {
  private context: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private state: PlaybackState = 'idle';
  private callbacks: PlaybackCallbacks = {};

  private sentences: string[] = [];
  private wordOffsets: number[] = [];
  private voiceId = '';
  private speed: number | undefined;
  private cursor = 0;

  private rafId: number | null = null;
  private generation = 0;

  /**
   * Next free position on the AudioContext timeline.
   *
   * Sentences are scheduled contiguously against the audio clock rather than
   * started from the previous buffer's `onended`. That callback fires a JS
   * event-loop turn *after* the audio has ended, so starting there left a
   * short silence at every join — audible as choppy, glitchy playback.
   */
  private nextStartAt = 0;
  private scheduled: { chunk: Chunk; startAt: number; endAt: number; source: AudioBufferSourceNode }[] = [];

  /**
   * Extra pause inserted between sentences.
   *
   * Zero on purpose. Utterances arrive with the model's own leading and
   * trailing silence intact, which already spaces sentences and phrases them
   * better than a fixed gap does. Adding one on top double-counts the pause.
   */
  private static readonly SENTENCE_GAP = 0;

  /**
   * Audio banked before the first sentence is allowed to play.
   *
   * Playback used to start the moment sentence one existed, which left zero
   * headroom. Measured per sentence on a 12-core desktop at 8 steps:
   *
   * | 85 chars | 5.83s audio | 4.97s | 1.17x |
   * | 63 chars | 4.38s audio | 3.39s | 1.29x |
   * | 11 chars | 1.38s audio | 1.65s | 0.83x |
   *
   * Ordinary verses run a surplus; short ones run a deficit, because the fixed
   * cost of a chain (duration predictor, text encoder, 8 flow steps, vocoder)
   * does not shrink with the text. Starting empty meant every deficit sentence
   * was met with nothing in reserve, and each shortfall surfaced as
   * `scheduleChunk` clamping to `currentTime` — a silence between verses that
   * grew as the chapter ran on.
   *
   * Six seconds costs ~5s before the first word and absorbs roughly twenty
   * consecutive short verses. Raise it for smoother playback on slower
   * hardware, lower it for a quicker start.
   */
  private static readonly LEAD_IN_SECONDS = 6;

  /**
   * How far ahead of the playhead the producer is allowed to run.
   *
   * Without a ceiling it would synthesize the whole chapter, pinning the
   * worker and holding every buffer in memory. With one, surplus earned on
   * long sentences is banked to cover the short ones that run at a deficit —
   * which is the whole point of the change. The old loop threw that surplus
   * away, idling 0.3s before each sentence ended rather than working ahead.
   * 20s is ~3.5 MB of float32 audio.
   */
  private static readonly BUFFER_HORIZON_SECONDS = 20;

  getState(): PlaybackState {
    return this.state;
  }

  private setState(next: PlaybackState): void {
    if (this.state === next) return;
    this.state = next;
    this.callbacks.onStateChange?.(next);
  }

  /**
   * Must be called directly inside a user gesture — it creates and resumes the
   * AudioContext before awaiting anything, which is what iOS requires.
   */
  start(
    text: string,
    voiceId: string,
    callbacks: PlaybackCallbacks = {},
    startWordOffset = 0,
    speed?: number
  ): void {
    this.stop();
    this.generation += 1;
    const generation = this.generation;

    this.callbacks = callbacks;
    this.voiceId = voiceId;
    this.speed = speed;

    // Synchronous, pre-await: keeps the gesture chain intact.
    const context = this.ensureContext();
    void context.resume();

    this.sentences = splitSentences(text);
    this.wordOffsets = [];
    let running = startWordOffset;
    for (const sentence of this.sentences) {
      this.wordOffsets.push(running);
      running += sentence.trim().split(/\s+/).filter(Boolean).length;
    }

    this.cursor = 0;
    this.setState('preparing');

    void this.run(generation);
  }

  private ensureContext(): AudioContext {
    if (!this.context || this.context.state === 'closed') {
      this.context = new AudioContext();
    }
    return this.context;
  }

  private async synthesize(index: number, generation: number): Promise<Chunk | null> {
    if (index >= this.sentences.length) return null;
    const context = this.ensureContext();
    const result = await supertonicEngine.synthesizeSentence(
      this.sentences[index],
      this.voiceId,
      undefined,
      undefined,
      this.speed
    );
    if (generation !== this.generation) return null;
    if (result.audio.length === 0) return null;

    // ONNX output may be backed by a SharedArrayBuffer when threaded WASM is
    // active, which copyToChannel will not accept. Copy into a plain buffer.
    const samples = new Float32Array(result.audio.length);
    samples.set(result.audio);

    const buffer = context.createBuffer(1, samples.length, result.sampleRate);
    buffer.copyToChannel(samples, 0);
    return {
      text: this.sentences[index],
      wordOffset: this.wordOffsets[index],
      buffer,
      words: result.words
    };
  }

  private async run(generation: number): Promise<void> {
    try {
      // Stay in 'preparing' — no platform voice — until the real engine is
      // ready. A ~383 MB first download means this can take a while, but
      // speaking on a system voice first was more confusing than silence: it
      // read as the finished product on a slower connection.
      if (!supertonicEngine.isReady()) {
        await supertonicEngine.load((p) => {
          if (generation === this.generation) this.callbacks.onModelProgress?.(p.loaded / p.total);
        });
        if (generation === this.generation) this.callbacks.onModelProgress?.(null);
      }

      if (generation !== this.generation) return;

      // Sentences held back while the lead-in fills. `nextStartAt` stays 0
      // until the first one is scheduled; `scheduleChunk` floors against
      // `currentTime`, so the bank costs nothing on the audio timeline.
      const banked: Chunk[] = [];
      let bankedSeconds = 0;
      let playing = false;

      while (this.cursor < this.sentences.length) {
        const index = this.cursor;
        const chunk = await this.synthesize(index, generation);
        if (generation !== this.generation) return;
        this.cursor += 1;
        if (!chunk) continue;

        if (!playing) {
          banked.push(chunk);
          bankedSeconds += chunk.buffer.duration;
          // Keep banking unless the target is met or the passage ran out —
          // a passage shorter than the lead-in must not wait forever.
          if (bankedSeconds < PlaybackController.LEAD_IN_SECONDS && this.cursor < this.sentences.length) continue;

          playing = true;
          this.startWordClock(generation);
          for (let i = 0; i < banked.length; i += 1) {
            this.scheduleChunk(banked[i], index - banked.length + 1 + i, generation);
          }
          banked.length = 0;
        } else {
          this.scheduleChunk(chunk, index, generation);
        }

        // Produce freely until the horizon is reached, then idle. Waiting on
        // the audio clock means a paused context suspends production too.
        await this.waitUntil(this.nextStartAt - PlaybackController.BUFFER_HORIZON_SECONDS, generation);
        if (generation !== this.generation) return;
      }

      await this.waitUntil(this.nextStartAt, generation);
      if (generation !== this.generation) return;
      this.finish(generation);
    } catch (err) {
      if (generation !== this.generation || err instanceof EngineCancelled) return;
      this.setState('idle');
      this.callbacks.onError?.((err as Error)?.message ?? 'Playback failed');
    }
  }

  private finish(generation: number): void {
    if (generation !== this.generation) return;
    this.setState('idle');
    this.callbacks.onWord?.(-1);
    this.callbacks.onEnd?.();
  }

  /** Queues a sentence at the next free slot on the audio clock. */
  private scheduleChunk(chunk: Chunk, index: number, generation: number): void {
    const context = this.ensureContext();
    const startAt = Math.max(context.currentTime, this.nextStartAt);

    const source = context.createBufferSource();
    source.buffer = chunk.buffer;
    source.connect(context.destination);
    source.start(startAt);

    const endAt = startAt + chunk.buffer.duration;
    this.scheduled.push({ chunk, startAt, endAt, source });
    this.nextStartAt = endAt + PlaybackController.SENTENCE_GAP;

    if (generation === this.generation) {
      this.setState('playing');
      this.callbacks.onSentence?.(index, this.sentences.length);
    }
  }

  /**
   * Resolves when the audio clock reaches `when`. Polls rather than using a
   * single timer because the clock stops while the context is suspended, so a
   * wall-clock timer would fire early after a pause.
   */
  private waitUntil(when: number, generation: number): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (generation !== this.generation) return resolve();
        const context = this.context;
        if (!context) return resolve();
        const remaining = when - context.currentTime;
        if (remaining <= 0) return resolve();
        setTimeout(check, Math.min(200, Math.max(20, remaining * 1000)));
      };
      check();
    });
  }

  private startWordClock(generation: number): void {
    this.stopWordClock();
    let lastIndex = -2;

    const tick = () => {
      if (generation !== this.generation || !this.context) return;
      const now = this.context.currentTime;

      // Which scheduled sentence is audible right now.
      const entry = this.scheduled.find((s) => now >= s.startAt && now < s.endAt);
      if (entry) {
        const elapsed = now - entry.startAt;
        const words = entry.chunk.words;
        let active = -1;
        for (let i = 0; i < words.length; i += 1) {
          if (elapsed >= words[i].start && elapsed < words[i].end) {
            active = i;
            break;
          }
        }
        if (active !== -1) {
          const globalIndex = entry.chunk.wordOffset + active;
          if (globalIndex !== lastIndex) {
            lastIndex = globalIndex;
            this.callbacks.onWord?.(globalIndex);
          }
        }
        // Sentences already finished cannot become audible again.
        if (this.scheduled.length > 4) {
          this.scheduled = this.scheduled.filter((s) => s.endAt > now - 1);
        }
      }
      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  private stopWordClock(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * Suspends without losing position. Suspending stops the AudioContext clock,
   * so scheduled start times stay valid relative to it and resume continues
   * exactly where it left off — no bookkeeping required.
   */
  async pause(): Promise<void> {
    if (this.state !== 'playing' || !this.context) return;
    await this.context.suspend();
    this.stopWordClock();
    this.setState('paused');
  }

  async resume(): Promise<void> {
    if (this.state !== 'paused' || !this.context) return;
    await this.context.resume();
    this.setState('playing');
    this.startWordClock(this.generation);
  }

  stop(): void {
    this.generation += 1;
    this.stopWordClock();

    // Tell the worker to abandon queued and in-flight chains. Dropping the
    // promise reference alone left them running on shared sessions.
    supertonicEngine.cancelInFlight();

    // Everything queued ahead on the audio clock must be cancelled too, or
    // sentences scheduled into the future keep playing after stop.
    for (const entry of this.scheduled) {
      try {
        entry.source.stop();
      } catch {
        /* already stopped or never started */
      }
      entry.source.disconnect();
    }
    this.scheduled = [];

    if (this.context && this.context.state === 'suspended') void this.context.resume();

    this.cursor = 0;
    this.nextStartAt = 0;
    this.setState('idle');
  }
}

export const playbackController = new PlaybackController();
