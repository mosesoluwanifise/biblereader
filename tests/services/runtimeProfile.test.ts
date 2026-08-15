import { describe, expect, it, vi } from 'vitest';
import {
  compatibleProfile,
  createAtomicSessionSet,
  makeRuntimeProfile,
  ORT_RUNTIME_VERSION,
  profileForModel,
  providerOrder,
  type RuntimeCapabilities
} from '../../src/services/tts/runtimeProfile';

const capabilities: RuntimeCapabilities = {
  webgpu: true,
  crossOriginIsolated: true,
  hardwareConcurrency: 8
};

describe('runtime profile', () => {
  it('uses a compatible persisted provider without probing a different one', () => {
    const profile = makeRuntimeProfile('model-1', 'wasm', capabilities);
    expect(compatibleProfile(profile, capabilities)).toEqual(profile);
    expect(providerOrder(capabilities, profile)).toEqual(['wasm', 'webgpu']);
  });

  it.each([
    ['runtime', { ortVersion: '2.0.0' }],
    ['WebGPU capability', { capabilities: { ...capabilities, webgpu: false } }],
    ['isolation', { capabilities: { ...capabilities, crossOriginIsolated: false } }],
    ['hardware concurrency', { capabilities: { ...capabilities, hardwareConcurrency: 4 } }]
  ])('rejects a profile after a %s change', (_name, change) => {
    const profile = { ...makeRuntimeProfile('model-1', 'wasm', capabilities), ...change };
    expect(compatibleProfile(profile, capabilities)).toBeNull();
  });

  it('does not enable five steps without a matching quality gate', () => {
    const profile = { ...makeRuntimeProfile('model-1', 'wasm', capabilities), steps: 5 };
    expect(compatibleProfile(profile, capabilities)).toBeNull();
    expect(
      compatibleProfile(
        { ...profile, qualityGate: { steps: 5, approved: true, modelVersion: 'model-1' } },
        capabilities
      )
    ).not.toBeNull();
  });

  it('ignores a profile recorded for different model weights', () => {
    const profile = makeRuntimeProfile('model-1', 'wasm', capabilities);
    expect(profileForModel(profile, 'model-2')).toBeNull();
    expect(profileForModel(profile, 'model-1')).toBe(profile);
  });

  it('releases every partial session before recreating all graphs on fallback', async () => {
    const events: string[] = [];
    const factory = {
      create: vi.fn(async (graph: string, provider: 'webgpu' | 'wasm') => {
        events.push(`create:${provider}:${graph}`);
        if (provider === 'webgpu' && graph === 'c') throw new Error('unsupported');
        return { graph, provider };
      }),
      release: vi.fn(async (session: { graph: string; provider: string }) => {
        events.push(`release:${session.provider}:${session.graph}`);
      })
    };

    const result = await createAtomicSessionSet(
      ['a', 'b', 'c', 'd'],
      ['webgpu', 'wasm'],
      factory,
      (failed, next) => events.push(`fallback:${failed}:${next}`)
    );
    expect(result.provider).toBe('wasm');
    expect([...result.sessions.values()].every((session) => session.provider === 'wasm')).toBe(true);
    const firstWasmCreate = events.findIndex((event) => event.startsWith('create:wasm'));
    const releases = events.filter((event) => event.startsWith('release:webgpu'));
    expect(releases).toHaveLength(3);
    expect(events.slice(0, firstWasmCreate).filter((event) => event.startsWith('release:webgpu'))).toHaveLength(3);
    const fallback = events.indexOf('fallback:webgpu:wasm');
    const lastRelease = Math.max(
      ...events.map((event, index) => (event.startsWith('release:webgpu') ? index : -1))
    );
    expect(fallback).toBeGreaterThan(lastRelease);
    expect(fallback).toBeLessThan(firstWasmCreate);
  });

  it('stops after each provider fails and releases fulfilled sessions', async () => {
    const released: string[] = [];
    await expect(
      createAtomicSessionSet(['a', 'b'], ['webgpu', 'wasm'], {
        create: async (graph, provider) => {
          if (graph === 'b') throw new Error(`${provider} failed`);
          return `${provider}:${graph}`;
        },
        release: async (session) => {
          released.push(session);
        }
      })
    ).rejects.toThrow('wasm failed');
    expect(released).toEqual(['webgpu:a', 'wasm:a']);
  });

  it('records the installed ORT runtime in new profiles', () => {
    expect(makeRuntimeProfile('model-1', 'wasm', capabilities).ortVersion).toBe(ORT_RUNTIME_VERSION);
  });
});
