import { supertonicEngine } from '../tts/supertonicEngine';
import { splitSentences, offsetTimings } from '../tts/wordTiming';
import { WordTimestamp } from '../tts/types';

/**
 * Owns audio playback for a passage.
 *
 * Three defects in the prototype motivate the shape here:
 *
 *  - Auto-advance ran off a setTimeout that captured a stale closure, so it
 *    replayed the previous chapter forever. Advance is now a callback the
 *    caller drives from an effect.
 *  - Pause called speechSynthesis.cancel(), discarding position. Pause now
 *    suspends the AudioContext and resume continues from the same offset.
 *  - Play awaited a network fetch before speaking, severing the iOS user
 *    gesture. The AudioContext is created and unlocked synchronously in
 *    `start`, before any await.
 *
 * Synthesis is slower than realtime on WASM, so sentences are produced one
 * ahead of playback rather than on demand.
 */

export type PlaybackState = 'idle' | 'preparing' | 'playing' | 'paused';

export interface PlaybackCallbacks {
  onWord?: (globalWordIndex: number) => void;
  onStateChange?: (state: PlaybackState) => void;
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
  private cursor = 0;
  private prefetch: Promise<Chunk | null> | null = null;

  /** Wall-clock context time at which the current chunk started. */
  private chunkStartedAt = 0;
  private offsetWithinChunk = 0;
  private current: Chunk | null = null;
  private rafId: number | null = null;
  private generation = 0;

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
  start(text: string, voiceId: string, callbacks: PlaybackCallbacks = {}, startWordOffset = 0): void {
    this.stop();
    this.generation += 1;
    const generation = this.generation;

    this.callbacks = callbacks;
    this.voiceId = voiceId;

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

  private async synthesize(index: number): Promise<Chunk | null> {
    if (index >= this.sentences.length) return null;
    const context = this.ensureContext();
    const result = await supertonicEngine.synthesizeSentence(this.sentences[index], this.voiceId);
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
      if (!supertonicEngine.isReady()) await supertonicEngine.load();
      if (generation !== this.generation) return;

      while (this.cursor < this.sentences.length) {
        const chunk = this.prefetch ? await this.prefetch : await this.synthesize(this.cursor);
        this.prefetch = null;
        if (generation !== this.generation) return;
        if (!chunk) {
          this.cursor += 1;
          continue;
        }

        // Produce the next sentence while this one plays.
        const next = this.cursor + 1;
        this.prefetch = next < this.sentences.length ? this.synthesize(next) : null;

        await this.playChunk(chunk, generation);
        if (generation !== this.generation) return;
        this.cursor += 1;
      }

      this.setState('idle');
      this.callbacks.onWord?.(-1);
      this.callbacks.onEnd?.();
    } catch (err) {
      if (generation !== this.generation) return;
      this.setState('idle');
      this.callbacks.onError?.((err as Error)?.message ?? 'Playback failed');
    }
  }

  private playChunk(chunk: Chunk, generation: number): Promise<void> {
    return new Promise((resolve) => {
      const context = this.ensureContext();
      this.current = chunk;
      this.offsetWithinChunk = 0;

      const source = context.createBufferSource();
      source.buffer = chunk.buffer;
      source.connect(context.destination);
      source.onended = () => {
        if (generation !== this.generation) return;
        if (this.source === source) this.source = null;
        this.stopWordClock();
        resolve();
      };

      this.source = source;
      this.chunkStartedAt = context.currentTime;
      source.start();

      this.setState('playing');
      this.callbacks.onSentence?.(this.cursor, this.sentences.length);
      this.startWordClock(generation);
    });
  }

  private startWordClock(generation: number): void {
    this.stopWordClock();
    let lastIndex = -2;

    const tick = () => {
      if (generation !== this.generation || !this.current || !this.context) return;
      const elapsed = this.context.currentTime - this.chunkStartedAt + this.offsetWithinChunk;

      let active = -1;
      for (let i = 0; i < this.current.words.length; i += 1) {
        if (elapsed >= this.current.words[i].start && elapsed < this.current.words[i].end) {
          active = i;
          break;
        }
      }

      if (active !== -1) {
        const globalIndex = this.current.wordOffset + active;
        if (globalIndex !== lastIndex) {
          lastIndex = globalIndex;
          this.callbacks.onWord?.(globalIndex);
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

  /** Suspends without losing position. */
  async pause(): Promise<void> {
    if (this.state !== 'playing' || !this.context) return;
    this.offsetWithinChunk += this.context.currentTime - this.chunkStartedAt;
    await this.context.suspend();
    this.stopWordClock();
    this.setState('paused');
  }

  async resume(): Promise<void> {
    if (this.state !== 'paused' || !this.context) return;
    await this.context.resume();
    this.chunkStartedAt = this.context.currentTime;
    this.setState('playing');
    this.startWordClock(this.generation);
  }

  stop(): void {
    this.generation += 1;
    this.stopWordClock();

    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        /* already stopped */
      }
      this.source = null;
    }

    if (this.context && this.context.state === 'suspended') void this.context.resume();

    this.current = null;
    this.prefetch = null;
    this.cursor = 0;
    this.offsetWithinChunk = 0;
    this.setState('idle');
  }
}

export const playbackController = new PlaybackController();
