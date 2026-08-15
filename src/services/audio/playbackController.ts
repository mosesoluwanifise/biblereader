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
 * no platform voice plays in the meantime. Synthesis is slower than realtime
 * on WASM, so sentences are produced one ahead of playback.
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
  private prefetch: Promise<Chunk | null> | null = null;

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

      const context = this.ensureContext();
      this.nextStartAt = context.currentTime;
      this.startWordClock(generation);

      while (this.cursor < this.sentences.length) {
        const chunk = this.prefetch ? await this.prefetch : await this.synthesize(this.cursor, generation);
        this.prefetch = null;
        if (generation !== this.generation) return;
        if (!chunk) {
          this.cursor += 1;
          continue;
        }

        const next = this.cursor + 1;
        this.prefetch = next < this.sentences.length ? this.synthesize(next, generation) : null;

        this.scheduleChunk(chunk, generation);
        this.cursor += 1;

        // Hand back control until this sentence is nearly over, leaving the
        // next one time to be scheduled before the audio clock reaches it.
        await this.waitUntil(this.nextStartAt - 0.3, generation);
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
  private scheduleChunk(chunk: Chunk, generation: number): void {
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
      this.callbacks.onSentence?.(this.cursor, this.sentences.length);
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

    this.prefetch = null;
    this.cursor = 0;
    this.nextStartAt = 0;
    this.setState('idle');
  }
}

export const playbackController = new PlaybackController();
