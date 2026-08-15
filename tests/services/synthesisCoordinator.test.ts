import { beforeEach, describe, expect, it, vi } from 'vitest';
import { planSynthesisChunks } from '../../src/services/tts/chunkPlanner';
import {
  PreparationCancelled,
  SynthesisCoordinator,
  type SynthesisPreparationRequest
} from '../../src/services/tts/synthesisCoordinator';
import type { EngineRuntimeInfo, PassageSynthesisIdentity, SynthesisResult } from '../../src/services/tts/types';
import { clearTtsDiagnostics, getTtsQualificationSnapshot } from '../../src/services/tts/diagnostics';

const runtime: EngineRuntimeInfo = {
  provider: 'wasm',
  steps: 8,
  modelVersion: 'model-1',
  ortVersion: '1.18.0'
};

function identity(overrides: Partial<PassageSynthesisIdentity> = {}): PassageSynthesisIdentity {
  return {
    translation: 'KJV',
    book: 'Genesis',
    chapter: 1,
    sourceTextVersion: 'kjv-1',
    sourceText: 'First sentence. Second sentence. Third sentence.',
    startingVerse: 1,
    startWordOffset: 0,
    voiceId: 'voice-1',
    speed: 1.05,
    steps: 8,
    provider: 'wasm',
    modelVersion: 'model-1',
    runtimeVersion: '1.18.0',
    ...overrides
  };
}

function result(text: string, duration = 4, samples = 400): SynthesisResult {
  const words = text.split(/\s+/).map((word, index, all) => ({
    word,
    start: 0.5 + (index / all.length) * 3,
    end: 0.5 + ((index + 1) / all.length) * 3
  }));
  return {
    audio: new Float32Array(samples),
    sampleRate: 100,
    duration,
    speechStart: 0.5,
    speechDuration: 3,
    words
  };
}

class FakeEngine {
  calls: string[] = [];
  runtime: EngineRuntimeInfo | null = runtime;
  synthesize = vi.fn(async (text: string) => result(text));
  predict = vi.fn(async () => 1);

  getRuntimeInfo() {
    return this.runtime;
  }

  async synthesizeSentence(text: string) {
    this.calls.push(`synthesize:${text}`);
    return this.synthesize(text);
  }

  async predictDuration(text: string) {
    this.calls.push(`predict:${text}`);
    return this.predict(text);
  }
}

function request(
  overrides: Partial<SynthesisPreparationRequest> = {},
  identityOverrides: Partial<PassageSynthesisIdentity> = {}
): SynthesisPreparationRequest {
  const sourceText = identityOverrides.sourceText ?? 'First sentence. Second sentence. Third sentence.';
  return {
    identity: identity({ sourceText, ...identityOverrides }),
    chunk: planSynthesisChunks(sourceText, { startupMaxChars: 100, steadyMaxChars: 240 })[0],
    priority: 'foreground',
    slot: 'current',
    ...overrides
  };
}

describe('SynthesisCoordinator', () => {
  let engine: FakeEngine;
  let coordinator: SynthesisCoordinator;

  beforeEach(() => {
    clearTtsDiagnostics();
    engine = new FakeEngine();
    coordinator = new SynthesisCoordinator(engine);
  });

  it('adopts identical speculative first-chunk work before cancelling speculation', async () => {
    let release!: (value: SynthesisResult) => void;
    engine.synthesize.mockImplementationOnce((text) => new Promise((resolve) => (release = resolve)));
    const speculative = coordinator.prepare(request({ priority: 'speculative', slot: 'next' }));
    const foreground = coordinator.prepare(request({ priority: 'foreground', slot: 'current' }));
    expect(foreground).toBe(speculative);
    release(result('First sentence.'));
    await expect(foreground).resolves.toMatchObject({ chunk: { kind: 'startup' } });
    expect(engine.synthesize).toHaveBeenCalledTimes(1);
    expect(coordinator.getPreparedUsage().entries).toBe(1);
  });

  it('promotes an already prepared next chunk when foreground Play adopts it', async () => {
    const speculativeRequest = request({ priority: 'speculative', slot: 'next' });
    const prepared = await coordinator.prepare(speculativeRequest);
    expect(coordinator.getPreparedUsage().entries).toBe(1);
    const adopted = await coordinator.prepare(request({ priority: 'foreground', slot: 'current' }));
    expect(adopted).toBe(prepared);
    expect(engine.synthesize).toHaveBeenCalledTimes(1);
    coordinator.clearPrepared('next');
    expect(coordinator.getPreparedUsage().entries).toBe(1);
  });

  it('supersedes older speculative first-chunk work', async () => {
    let release!: (value: SynthesisResult) => void;
    engine.synthesize.mockImplementationOnce((text) => new Promise((resolve) => (release = resolve)));
    const old = coordinator.prepare(request({ priority: 'speculative' }, { chapter: 1 })).catch((error) => error);
    const latest = coordinator.prepare(request({ priority: 'speculative' }, { chapter: 2 }));
    release(result('First sentence.'));
    expect(await old).toBeInstanceOf(PreparationCancelled);
    await expect(latest).resolves.toBeDefined();
  });

  it('runs queued foreground work before queued speculation after an active graph returns', async () => {
    let release!: (value: SynthesisResult) => void;
    engine.synthesize.mockImplementationOnce((text) => new Promise((resolve) => (release = resolve)));
    const active = coordinator.prepare(request({ priority: 'speculative' }, { chapter: 1 }));
    const queued = coordinator.prepare(request({ priority: 'speculative' }, { chapter: 2 }));
    const foreground = coordinator.prepare(request({ priority: 'foreground' }, { chapter: 3 }));
    const activeOutcome = active.catch((error) => error);
    const queuedOutcome = queued.catch((error) => error);
    release(result('First sentence.'));
    expect(await activeOutcome).toBeInstanceOf(PreparationCancelled);
    expect(await queuedOutcome).toBeInstanceOf(PreparationCancelled);
    await foreground;
    expect(engine.calls.filter((call) => call.startsWith('synthesize:'))).toHaveLength(2);
  });

  it('measures cancellation latency because an active ONNX run cannot be hard-preempted', async () => {
    let clock = 0;
    coordinator = new SynthesisCoordinator(engine, () => clock);
    let release!: (value: SynthesisResult) => void;
    engine.synthesize.mockImplementationOnce((text) => new Promise((resolve) => (release = resolve)));
    const speculative = coordinator.prepare(request({ priority: 'speculative' }, { chapter: 1 }));
    const outcome = speculative.catch((error) => error);
    clock = 10;
    const foreground = coordinator.prepare(request({ priority: 'foreground' }, { chapter: 2 }));
    clock = 35;
    release(result('First sentence.'));
    expect(await outcome).toMatchObject({ name: 'PreparationCancelled', latencyMs: 25 });
    await foreground;
  });

  it('transport cancellation does not invalidate unrelated retained preparation', async () => {
    const nextRequest = request({ priority: 'speculative', slot: 'next' }, { chapter: 2 });
    const preparedNext = await coordinator.prepare(nextRequest);
    let release!: (value: SynthesisResult) => void;
    engine.synthesize.mockImplementationOnce((text) => new Promise((resolve) => (release = resolve)));
    const foreground = coordinator.prepare(request({ priority: 'foreground', slot: 'current' }, { chapter: 1 }));
    const outcome = foreground.catch((error) => error);
    coordinator.cancelScope('foreground');
    release(result('First sentence.'));
    expect(await outcome).toBeInstanceOf(PreparationCancelled);
    const callsBeforeReuse = engine.synthesize.mock.calls.length;
    await expect(coordinator.prepare(nextRequest)).resolves.toBe(preparedNext);
    expect(engine.synthesize).toHaveBeenCalledTimes(callsBeforeReuse);
  });

  it('stops stale packed work before isolated duration predictions', async () => {
    const text = 'First sentence. Second sentence. Third sentence.';
    const steady = planSynthesisChunks(text, { startupMaxChars: 20, steadyMaxChars: 100 })[1];
    let release!: (value: SynthesisResult) => void;
    engine.synthesize.mockImplementationOnce((value) => new Promise((resolve) => (release = resolve)));
    const stale = coordinator
      .prepare(request({ chunk: steady, slot: undefined }, { sourceText: text, chapter: 1 }))
      .catch((error) => error);
    const latest = coordinator.prepare(request({}, { chapter: 2 }));
    release(result(steady.text));
    expect(await stale).toBeInstanceOf(PreparationCancelled);
    await latest;
    expect(engine.predict).not.toHaveBeenCalled();
  });

  it('rejects speculative steady chunks so speculative graph work stays bounded', async () => {
    const text = Array.from({ length: 10 }, (_, index) => `Sentence ${index}.`).join(' ');
    const chunks = planSynthesisChunks(text, { startupMaxChars: 20, steadyMaxChars: 100 });
    await expect(
      coordinator.prepare(request({ priority: 'speculative', chunk: chunks[1] }, { sourceText: text }))
    ).rejects.toThrow('bounded');
    expect(engine.synthesize).not.toHaveBeenCalled();
  });

  it.each([
    ['translation', 'WEB'],
    ['book', 'Exodus'],
    ['chapter', 2],
    ['sourceTextVersion', 'kjv-2'],
    ['sourceText', 'Changed source.'],
    ['startingVerse', 2],
    ['startWordOffset', 12],
    ['voiceId', 'voice-2'],
    ['speed', 1.2]
  ] as const)('treats %s changes as preparation cache misses', async (field, value) => {
    await coordinator.prepare(request());
    const changed = { [field]: value } as Partial<PassageSynthesisIdentity>;
    await coordinator.prepare(request({}, changed));
    expect(engine.synthesize).toHaveBeenCalledTimes(2);
  });

  it('rejects identities from a different profile, provider, model, or runtime', () => {
    for (const changed of [
      { steps: 5 },
      { provider: 'webgpu' as const },
      { modelVersion: 'model-2' },
      { runtimeVersion: '1.19.0' }
    ]) {
      expect(() => coordinator.prepare(request({}, changed))).toThrow('active runtime');
    }
  });

  it('discards stale rapid-navigation completions and retains only the final passage', async () => {
    let release!: (value: SynthesisResult) => void;
    engine.synthesize.mockImplementationOnce((text) => new Promise((resolve) => (release = resolve)));
    const promises = Array.from({ length: 10 }, (_, index) =>
      coordinator.prepare(request({}, { chapter: index + 1 })).catch((error) => error)
    );
    release(result('First sentence.'));
    const outcomes = await Promise.all(promises);
    expect(outcomes.slice(0, 9).every((value) => value instanceof PreparationCancelled)).toBe(true);
    expect(outcomes[9]).not.toBeInstanceOf(Error);
    expect(coordinator.getPreparedUsage().entries).toBe(1);
  });

  it('normalizes isolated constituent predictions to the packed speech span and includes their cost', async () => {
    let clock = 0;
    coordinator = new SynthesisCoordinator(engine, () => clock);
    engine.synthesize.mockImplementation(async (text) => {
      clock += 1000;
      return result(text, 4);
    });
    engine.predict.mockImplementation(async (text) => {
      clock += 250;
      return text.startsWith('Second') ? 1 : 3;
    });
    const text = 'First sentence. Second sentence. Third sentence.';
    const steady = planSynthesisChunks(text, { startupMaxChars: 20, steadyMaxChars: 100 })[1];
    const prepared = await coordinator.prepare(request({ chunk: steady, slot: undefined }, { sourceText: text }));
    expect(engine.predict).toHaveBeenCalledTimes(2);
    expect(prepared.words[0].start).toBeCloseTo(0.5);
    expect(prepared.words[1].end).toBeCloseTo(1.25);
    expect(prepared.words.at(-1)!.end).toBeCloseTo(3.5);
    expect(prepared.timingPredictionMs).toBe(500);
    expect(prepared.synthesisMs).toBe(1500);
    expect(prepared.productionFactor).toBeCloseTo(4 / 1.5);
    const qualification = getTtsQualificationSnapshot();
    expect(qualification.synthesisMs.p50).toBe(1500);
    expect(qualification.productionFactor.p50).toBeCloseTo(4 / 1.5);
    expect(qualification.productionFactor.p50).toBeLessThan(4 / 1);
  });

  it('bounds retained current and next audio by duration and bytes', async () => {
    engine.synthesize.mockImplementation(async (text) => result(text, 20, 900_000));
    await coordinator.prepare(request({}, { chapter: 1 }));
    await coordinator.prepare(request({ priority: 'speculative', slot: 'next' }, { chapter: 2 }));
    expect(coordinator.getPreparedUsage()).toMatchObject({ entries: 1, seconds: 20, bytes: 3_600_000 });
  });

  it('clears a failed task and permits a clean retry', async () => {
    engine.synthesize.mockRejectedValueOnce(new Error('worker failed'));
    await expect(coordinator.prepare(request())).rejects.toThrow('worker failed');
    await expect(coordinator.prepare(request())).resolves.toBeDefined();
    expect(engine.synthesize).toHaveBeenCalledTimes(2);
  });
});
