import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaybackController } from '../../src/services/audio/playbackController';
import { clearTtsDiagnostics, getTtsDiagnostics } from '../../src/services/tts/diagnostics';
import { supertonicEngine } from '../../src/services/tts/supertonicEngine';
import {
  PreparationCancelled,
  SynthesisCoordinator,
  type SynthesisPreparationRequest
} from '../../src/services/tts/synthesisCoordinator';
import type { PreparedSynthesisChunk } from '../../src/services/tts/types';
import { interpolateWordTimings } from '../../src/services/tts/wordTiming';

class FakeAudioContext {
  static SPEEDUP = 1;
  static live: FakeAudioContext[] = [];
  state: 'running' | 'suspended' | 'closed' = 'running';
  destination = {};
  sources: FakeSource[] = [];
  private origin = Date.now();
  private frozenAt: number | null = null;

  constructor() {
    FakeAudioContext.live.push(this);
  }

  get currentTime(): number {
    return (((this.frozenAt ?? Date.now()) - this.origin) / 1000) * FakeAudioContext.SPEEDUP;
  }

  createBuffer(_channels: number, length: number, sampleRate: number) {
    return { length, sampleRate, duration: length / sampleRate, copyToChannel: vi.fn() };
  }

  createBufferSource() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }

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
}

class FakeSource {
  buffer: { duration: number } | null = null;
  started = false;
  ended = false;
  startAt = 0;
  connect() {}
  disconnect() {}
  start(when = 0) {
    this.started = true;
    this.startAt = when;
  }
  stop() {
    this.ended = true;
  }
}

class FakeCoordinator {
  calls: SynthesisPreparationRequest[] = [];
  cancelCalls = 0;
  clearCalls = 0;
  duration = 0.2;
  delayMs = 0;
  productionFactor = 2;
  rejectAt: number | null = null;
  deferred = new Map<number, () => void>();
  deferAt = new Set<number>();
  cancellationLatency = new Map<number, number>();

  async prepare(request: SynthesisPreparationRequest): Promise<PreparedSynthesisChunk> {
    this.calls.push(request);
    const call = this.calls.length;
    if (this.rejectAt === call) throw new Error('synthesis failed after playback started');
    if (this.deferAt.has(call)) await new Promise<void>((resolve) => this.deferred.set(call, resolve));
    if (this.cancellationLatency.has(call)) throw new PreparationCancelled(this.cancellationLatency.get(call)!);
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const sampleRate = 1000;
    return {
      audio: new Float32Array(Math.round(sampleRate * this.duration)),
      sampleRate,
      duration: this.duration,
      speechStart: 0,
      speechDuration: this.duration,
      words: interpolateWordTimings(request.chunk.text, this.duration),
      chunk: request.chunk,
      synthesisMs: this.delayMs,
      timingPredictionMs: 0,
      productionFactor: this.productionFactor
    };
  }

  cancelScope() {
    this.cancelCalls += 1;
  }

  clearPrepared() {
    this.clearCalls += 1;
  }
}

const runtime = { provider: 'wasm' as const, steps: 8, modelVersion: 'model-1', ortVersion: '1.18.0' };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const longPassage = (count: number) =>
  Array.from({ length: count }, (_, index) => `Sentence ${index} ${'descriptive words '.repeat(5)}ends.`).join(' ');

beforeEach(() => {
  FakeAudioContext.live = [];
  FakeAudioContext.SPEEDUP = 1;
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 8) as unknown as number
  );
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  vi.spyOn(supertonicEngine, 'isReady').mockReturnValue(true);
  vi.spyOn(supertonicEngine, 'load').mockResolvedValue(undefined);
  vi.spyOn(supertonicEngine, 'getRuntimeInfo').mockReturnValue(runtime);
  vi.spyOn(supertonicEngine, 'cancelInFlight');
  clearTtsDiagnostics();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('startup and adoption', () => {
  it('unlocks the audio context synchronously', () => {
    const controller = new PlaybackController(new FakeCoordinator());
    controller.start('In the beginning God created.', 'F1');
    expect(FakeAudioContext.live).toHaveLength(1);
    expect(FakeAudioContext.live[0].state).toBe('running');
  });

  it('starts after the first startup chunk while the packed chunk is still pending', async () => {
    const coordinator = new FakeCoordinator();
    coordinator.deferAt.add(2);
    const states: string[] = [];
    const controller = new PlaybackController(coordinator);
    controller.start('First sentence. Second sentence. Third sentence.', 'F1', {
      onStateChange: (state) => states.push(state)
    });
    await flush();
    await flush();

    expect(coordinator.calls).toHaveLength(2);
    expect(states).toContain('playing');
    expect(FakeAudioContext.live[0].sources).toHaveLength(1);
    controller.stop();
  });

  it('treats repeated Play for the identical preparing passage as a no-op', async () => {
    const coordinator = new FakeCoordinator();
    coordinator.deferAt.add(1);
    const controller = new PlaybackController(coordinator);
    controller.start('Jesus wept.', 'F1');
    await flush();
    const cancellations = coordinator.cancelCalls;
    controller.start('Jesus wept.', 'F1');
    await flush();
    expect(coordinator.calls).toHaveLength(1);
    expect(coordinator.cancelCalls).toBe(cancellations);
    controller.stop();
  });

  it('retains a prepared current startup chunk across ordinary Stop and adopts it on replay', async () => {
    const synthesizeSentence = vi.fn(async (text: string) => ({
      audio: new Float32Array(2000),
      sampleRate: 1000,
      duration: 2,
      speechStart: 0,
      speechDuration: 2,
      words: interpolateWordTimings(text, 2)
    }));
    const coordinator = new SynthesisCoordinator({
      getRuntimeInfo: () => runtime,
      synthesizeSentence,
      predictDuration: vi.fn(async () => 1)
    });
    const controller = new PlaybackController(coordinator);
    controller.start('A prepared sentence.', 'F1');
    await flush();
    await flush();
    expect(FakeAudioContext.live[0].sources).toHaveLength(1);
    controller.stop();

    controller.start('A prepared sentence.', 'F1');
    await flush();
    await flush();
    expect(FakeAudioContext.live[0].sources).toHaveLength(2);
    expect(synthesizeSentence).toHaveBeenCalledTimes(1);
    controller.stop();
  });
});

describe('packed playback progress', () => {
  it('reports packed constituent sentences once when their audio becomes audible', async () => {
    const coordinator = new FakeCoordinator();
    coordinator.duration = 0.16;
    const sentences: number[] = [];
    const words: number[] = [];
    const onEnd = vi.fn();
    const controller = new PlaybackController(coordinator);
    controller.start(
      'First words. Second words. Third words. Fourth words.',
      'F1',
      { onSentence: (index) => sentences.push(index), onWord: (index) => words.push(index), onEnd },
      100
    );
    await settle(450);

    expect(coordinator.calls.map((call) => call.chunk.kind)).toEqual(['startup', 'steady']);
    expect(sentences).toEqual([0, 1, 2, 3]);
    expect(words.filter((index) => index >= 0).every((index) => index >= 100)).toBe(true);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('pauses and resumes the same sources while production stays bounded by the horizon', async () => {
    const coordinator = new FakeCoordinator();
    coordinator.duration = 5;
    const controller = new PlaybackController(coordinator);
    controller.start(longPassage(30), 'F1');
    await settle(40);
    const context = FakeAudioContext.live[0];
    await controller.pause();
    const callsAtPause = coordinator.calls.length;
    const sourcesAtPause = context.sources.length;
    await settle(80);

    expect(controller.getState()).toBe('paused');
    expect(coordinator.calls.length).toBe(callsAtPause);
    expect(callsAtPause).toBeLessThanOrEqual(6);
    await controller.resume();
    expect(context.sources).toHaveLength(sourcesAtPause);
    controller.stop();
  });
});

describe('producer sustainability', () => {
  it('completes a sustainable full passage without synthesis underruns', async () => {
    FakeAudioContext.SPEEDUP = 10;
    const coordinator = new FakeCoordinator();
    coordinator.duration = 1;
    coordinator.delayMs = 30;
    coordinator.productionFactor = 3;
    const controller = new PlaybackController(coordinator);
    controller.start(longPassage(12), 'F1');
    await settle(1800);

    const underruns = getTtsDiagnostics().filter(
      (event) => event.phase === 'playback' && (event.underrunCount ?? 0) > 0
    );
    expect(controller.getState()).toBe('idle');
    expect(underruns).toHaveLength(0);
    expect(getTtsDiagnostics().some((event) => event.bufferLowWaterSeconds !== undefined)).toBe(true);
  });

  it('records repeated slow-production gaps and reaches device-too-slow without a reload loop', async () => {
    FakeAudioContext.SPEEDUP = 10;
    const coordinator = new FakeCoordinator();
    coordinator.duration = 1;
    coordinator.delayMs = 160;
    coordinator.productionFactor = 0.6;
    const onError = vi.fn();
    const controller = new PlaybackController(coordinator);
    controller.start(longPassage(12), 'F1', { onError });
    await settle(1000);

    const lastUnderrun = getTtsDiagnostics()
      .filter((event) => event.phase === 'playback' && event.underrunCount)
      .at(-1);
    expect(controller.getState()).toBe('device-too-slow');
    expect(lastUnderrun?.underrunCount).toBeGreaterThanOrEqual(2);
    expect(lastUnderrun?.underrunDurationMs).toBeGreaterThan(0);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('cannot synthesize'));
    expect(supertonicEngine.load).not.toHaveBeenCalled();
  });

  it('records an externally suspended audio graph separately from synthesis underruns', async () => {
    const coordinator = new FakeCoordinator();
    coordinator.duration = 1;
    coordinator.deferAt.add(2);
    const controller = new PlaybackController(coordinator);
    controller.start('First sentence. Second sentence. Third sentence.', 'F1');
    await flush();
    await flush();
    await FakeAudioContext.live[0].suspend();
    coordinator.deferred.get(2)?.();
    await flush();
    await flush();

    const playback = getTtsDiagnostics().filter((event) => event.phase === 'playback');
    expect(playback.some((event) => event.platformInterruptionCount === 1)).toBe(true);
    expect(playback.every((event) => (event.underrunCount ?? 0) === 0)).toBe(true);
    controller.stop();
  });
});

describe('cancellation and failure', () => {
  it('explicit stop prevents an in-flight stale completion from scheduling audio', async () => {
    const coordinator = new FakeCoordinator();
    coordinator.duration = 2;
    coordinator.deferAt.add(2);
    const controller = new PlaybackController(coordinator);
    controller.start('First sentence. Second sentence. Third sentence.', 'F1');
    await flush();
    await flush();
    expect(FakeAudioContext.live[0].sources).toHaveLength(1);
    controller.stop();
    coordinator.deferred.get(2)?.();
    await flush();
    await flush();

    expect(FakeAudioContext.live[0].sources).toHaveLength(1);
    expect(FakeAudioContext.live[0].sources[0].ended).toBe(true);
    expect(controller.getState()).toBe('idle');
    expect(supertonicEngine.cancelInFlight).not.toHaveBeenCalled();
  });

  it('records the non-preemptible preparation cancellation latency', async () => {
    const coordinator = new FakeCoordinator();
    coordinator.deferAt.add(1);
    coordinator.cancellationLatency.set(1, 37);
    const controller = new PlaybackController(coordinator);
    controller.start('One sentence.', 'F1');
    await flush();
    controller.stop();
    coordinator.deferred.get(1)?.();
    await flush();
    await flush();

    expect(getTtsDiagnostics()).toContainEqual(
      expect.objectContaining({ phase: 'playback', cancellationLatencyMs: 37 })
    );
  });

  it('a post-start synthesis failure stops queued audio, clears highlighting, and surfaces a retryable error', async () => {
    const coordinator = new FakeCoordinator();
    coordinator.duration = 2;
    coordinator.rejectAt = 2;
    const onError = vi.fn();
    const onWord = vi.fn();
    const controller = new PlaybackController(coordinator);
    controller.start('First sentence. Second sentence. Third sentence.', 'F1', { onError, onWord });
    await settle(80);

    const sources = FakeAudioContext.live[0].sources;
    expect(sources).toHaveLength(1);
    expect(sources[0].ended).toBe(true);
    expect(onWord).toHaveBeenCalledWith(-1);
    expect(onError).toHaveBeenCalledWith('synthesis failed after playback started');
    expect(controller.getState()).toBe('idle');
    expect(coordinator.clearCalls).toBeGreaterThan(0);
  });
});
