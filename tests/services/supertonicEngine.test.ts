import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SupertonicEngine } from '../../src/services/tts/supertonicEngine';
import { ORT_RUNTIME_VERSION } from '../../src/services/tts/runtimeProfile';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: Array<Record<string, unknown>> = [];
  terminate = vi.fn();

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: Record<string, unknown>) {
    this.messages.push(message);
  }

  emit(data: Record<string, unknown>) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

describe('SupertonicEngine lifecycle', () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal('Worker', FakeWorker);
    localStorage.clear();
  });

  it('shares one load, fans out progress, and is not ready before warmed loaded response', async () => {
    const engine = new SupertonicEngine();
    const firstProgress = vi.fn();
    const secondProgress = vi.fn();
    const first = engine.load(firstProgress);
    const worker = FakeWorker.instances[0];
    const id = worker.messages[0].id as number;
    worker.emit({ id, type: 'progress', loaded: 40, total: 100, label: 'compile' });
    const second = engine.load(secondProgress);

    expect(worker.messages).toHaveLength(1);
    expect(secondProgress).toHaveBeenCalledWith({ loaded: 40, total: 100, label: 'compile' });
    expect(engine.getStatus()).toBe('loading');
    expect(engine.isReady()).toBe(false);

    worker.emit({
      id,
      type: 'loaded',
      backend: 'wasm',
      version: 'model-1',
      voiceIds: ['voice-1'],
      steps: 8,
      compileMs: 12,
      warmupMs: 8
    });
    await Promise.all([first, second]);
    expect(engine.isReady()).toBe(true);
    expect(engine.getRuntimeInfo()).toEqual({
      provider: 'wasm',
      steps: 8,
      modelVersion: 'model-1',
      ortVersion: ORT_RUNTIME_VERSION
    });
    expect(firstProgress).toHaveBeenCalled();
  });

  it('returns to a retryable failed state and invalidates profile after WebGPU device loss', async () => {
    const engine = new SupertonicEngine();
    const loading = engine.load();
    const worker = FakeWorker.instances[0];
    const loadId = worker.messages[0].id as number;
    worker.emit({
      id: loadId,
      type: 'loaded',
      backend: 'webgpu',
      version: 'model-1',
      voiceIds: ['voice-1'],
      steps: 8,
      compileMs: 1,
      warmupMs: 1
    });
    await loading;

    const synthesis = engine.synthesizeSentence('Amen.');
    const request = worker.messages.at(-1)!;
    worker.emit({ id: request.id, type: 'error', message: 'GPUDevice was lost', providerLost: true });
    await expect(synthesis).rejects.toThrow('GPUDevice was lost');
    expect(engine.getStatus()).toBe('failed');
    expect(worker.terminate).toHaveBeenCalledOnce();

    const retry = engine.load();
    const retryWorker = FakeWorker.instances[1];
    expect(retryWorker.messages.at(-1)).toMatchObject({
      type: 'load',
      excludedProviders: ['webgpu']
    });
    retryWorker.emit({
      id: retryWorker.messages.at(-1)?.id,
      type: 'loaded',
      backend: 'wasm',
      version: 'model-1',
      voiceIds: ['voice-1'],
      steps: 8,
      compileMs: 1,
      warmupMs: 1
    });
    await retry;
    expect(engine.getStatus()).toBe('ready');
  });

  it('recreates the worker after an uncaught worker error before Retry', async () => {
    const engine = new SupertonicEngine();
    const loading = engine.load();
    const failedWorker = FakeWorker.instances[0];
    failedWorker.onerror?.({ message: 'worker crashed' } as ErrorEvent);
    await expect(loading).rejects.toThrow('worker crashed');
    expect(failedWorker.terminate).toHaveBeenCalledOnce();

    const retry = engine.load();
    const retryWorker = FakeWorker.instances[1];
    expect(retryWorker).not.toBe(failedWorker);
    retryWorker.emit({
      id: retryWorker.messages[0].id,
      type: 'loaded',
      backend: 'wasm',
      version: 'model-1',
      voiceIds: ['voice-1'],
      steps: 8,
      compileMs: 1,
      warmupMs: 1
    });
    await retry;
    expect(engine.isReady()).toBe(true);
  });

  it('honors the provider-fallback rollout kill switch', async () => {
    vi.stubEnv('VITE_SUPERTONIC_PROVIDER_FALLBACK_ENABLED', '0');
    const engine = new SupertonicEngine();
    const loading = engine.load();
    const worker = FakeWorker.instances[0];
    expect(worker.messages[0]).toMatchObject({ type: 'load', allowProviderFallback: false });
    worker.emit({
      id: worker.messages[0].id,
      type: 'loaded',
      backend: 'wasm',
      version: 'model-1',
      voiceIds: ['voice-1'],
      steps: 8,
      compileMs: 1,
      warmupMs: 1
    });
    await loading;
    await expect(engine.fallbackFromActiveProvider()).rejects.toThrow('fallback is disabled');
    vi.unstubAllEnvs();
  });

  it('tears down the active runtime and loads only the bounded alternate provider', async () => {
    const engine = new SupertonicEngine();
    const loading = engine.load();
    const firstWorker = FakeWorker.instances[0];
    firstWorker.emit({
      id: firstWorker.messages[0].id,
      type: 'loaded',
      backend: 'webgpu',
      version: 'model-1',
      voiceIds: ['voice-1'],
      steps: 8,
      compileMs: 1,
      warmupMs: 1
    });
    await loading;

    const fallback = engine.fallbackFromActiveProvider();
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    const fallbackWorker = FakeWorker.instances[1];
    expect(fallbackWorker.messages[0]).toMatchObject({
      type: 'load',
      excludedProviders: ['webgpu'],
      allowProviderFallback: true
    });
    fallbackWorker.emit({
      id: fallbackWorker.messages[0].id,
      type: 'loaded',
      backend: 'wasm',
      version: 'model-1',
      voiceIds: ['voice-1'],
      steps: 8,
      compileMs: 1,
      warmupMs: 1
    });
    await fallback;
    expect(engine.getBackend()).toBe('wasm');
  });

  it('reports a provider fallback phase to loading callers', async () => {
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: {} });
    const progress = vi.fn();
    const engine = new SupertonicEngine();
    const loading = engine.load(progress);
    const worker = FakeWorker.instances[0];
    worker.emit({
      id: worker.messages[0].id,
      type: 'progress',
      loaded: 20,
      total: 100,
      label: 'provider-fallback'
    });
    expect(progress).toHaveBeenLastCalledWith({ loaded: 20, total: 100, label: 'provider-fallback' });
    expect(engine.getStatus()).toBe('loading');
    worker.emit({
      id: worker.messages[0].id,
      type: 'loaded',
      backend: 'wasm',
      version: 'model-1',
      voiceIds: ['voice-1'],
      steps: 8,
      compileMs: 1,
      warmupMs: 1
    });
    await loading;
    expect(progress).toHaveBeenCalledWith({ loaded: 20, total: 100, label: 'provider-fallback' });
    delete (navigator as Navigator & { gpu?: unknown }).gpu;
  });

  it('preserves cancellation messages and generation ordering', () => {
    const engine = new SupertonicEngine();
    // A worker is created lazily by load.
    void engine.load();
    expect(engine.cancelInFlight()).toBe(2);
    expect(FakeWorker.instances[0].messages.at(-1)).toMatchObject({ type: 'cancel', generation: 2 });
  });

  it('exposes isolated duration prediction without running a synthesis request', async () => {
    const engine = new SupertonicEngine();
    const loading = engine.load();
    const worker = FakeWorker.instances[0];
    worker.emit({
      id: worker.messages[0].id,
      type: 'loaded',
      backend: 'wasm',
      version: 'model-1',
      voiceIds: ['voice-1'],
      steps: 8,
      compileMs: 1,
      warmupMs: 1
    });
    await loading;

    const prediction = engine.predictDuration('Second sentence.', 'voice-1', undefined, 1.2);
    const message = worker.messages.at(-1)!;
    expect(message).toMatchObject({
      type: 'predict-duration',
      text: 'Second sentence.',
      voiceId: 'voice-1',
      generation: 1,
      speed: 1.2
    });
    worker.emit({ id: message.id, type: 'duration', predicted: 2.75 });
    await expect(prediction).resolves.toBe(2.75);
  });
});
