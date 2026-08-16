import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearTtsDiagnostics,
  getTtsDiagnostics,
  getTtsQualificationSnapshot,
  MAX_TTS_DIAGNOSTICS,
  recordTtsDiagnostic
} from '../../src/services/tts/diagnostics';

describe('TTS diagnostics', () => {
  beforeEach(clearTtsDiagnostics);

  it('keeps a bounded snapshot', () => {
    for (let index = 0; index < MAX_TTS_DIAGNOSTICS + 7; index += 1) {
      recordTtsDiagnostic({ at: index, phase: 'synthesis', durationMs: index });
    }
    const snapshot = getTtsDiagnostics();
    expect(snapshot).toHaveLength(MAX_TTS_DIAGNOSTICS);
    expect(snapshot[0].at).toBe(7);
  });

  it('copies records and stores no arbitrary text fields', () => {
    recordTtsDiagnostic({ phase: 'warmup', provider: 'wasm', durationMs: Number.NaN });
    const snapshot = getTtsDiagnostics();
    expect(snapshot[0]).toEqual(
      expect.objectContaining({ phase: 'warmup', provider: 'wasm', durationMs: undefined })
    );
    expect(JSON.stringify(snapshot)).not.toContain('text');
    (snapshot[0] as { provider?: string }).provider = 'changed';
    expect(getTtsDiagnostics()[0].provider).toBe('wasm');
  });

  it('summarizes qualification percentiles using the documented production-factor convention', () => {
    // Raw engine timing is useful in the event log but must not double-count
    // or replace the coordinator's end-to-end prepared-chunk measurement.
    recordTtsDiagnostic({ phase: 'synthesis', durationMs: 1, realtimeFactor: 100 });
    for (const [durationMs, realtimeFactor] of [[10, 4], [20, 3], [30, 2], [40, 1]] as const) {
      recordTtsDiagnostic({
        phase: 'chunk',
        provider: 'wasm',
        steps: 8,
        modelVersion: 'model-1',
        runtimeVersion: '1.18.0',
        durationMs,
        realtimeFactor
      });
    }
    recordTtsDiagnostic({
      phase: 'playback',
      scheduledAheadSeconds: 0.4,
      underrunCount: 2,
      underrunDurationMs: 125,
      cancellationLatencyMs: 37,
      platformInterruptionCount: 1
    });
    const scope = {
      navigator: { hardwareConcurrency: 8, gpu: {}, userAgent: 'Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36' },
      crossOriginIsolated: true
    } as unknown as typeof globalThis;
    const snapshot = getTtsQualificationSnapshot(scope);

    expect(snapshot.synthesisMs).toEqual({ count: 4, p50: 20, p95: 40, p99: 40 });
    expect(snapshot.productionFactor).toEqual({ count: 4, p50: 2, p95: 4, p99: 4 });
    expect(snapshot.minScheduledAheadSeconds).toBe(0.4);
    expect(snapshot.underrunCount).toBe(2);
    expect(snapshot.cancellationLatencyMs.p50).toBe(37);
    expect(snapshot.runtime).toEqual({
      provider: 'wasm',
      steps: 8,
      modelVersion: 'model-1',
      runtimeVersion: '1.18.0'
    });
    expect(snapshot.capabilities).toMatchObject({
      webgpu: true,
      crossOriginIsolated: true,
      hardwareConcurrency: 8,
      threadCapacity: 8,
      browserFamily: 'chromium',
      browserMajor: 126,
      fingerprint: 'wgpu:1|coi:1|hc:8|b:chromium:126'
    });
    expect(JSON.stringify(snapshot)).not.toContain('passage');
  });

  it('reports discarded events and resets retention accounting', () => {
    for (let index = 0; index < MAX_TTS_DIAGNOSTICS + 3; index += 1) {
      recordTtsDiagnostic({ phase: 'playback', scheduledAheadSeconds: index });
    }
    expect(getTtsQualificationSnapshot().retention).toEqual({
      count: MAX_TTS_DIAGNOSTICS,
      limit: MAX_TTS_DIAGNOSTICS,
      dropped: 3,
      metricSampleLimit: 256
    });
    clearTtsDiagnostics();
    expect(getTtsQualificationSnapshot().retention.dropped).toBe(0);
  });

  it('summarizes text-free chunk, reuse, first-speech, and PCM metrics', () => {
    recordTtsDiagnostic({
      phase: 'chunk',
      chunkKind: 'startup',
      chunkChars: 80,
      durationMs: 900,
      preparationOutcome: 'synthesized',
      preparedBytes: 200_000,
      inFlightBytes: 400_000,
      scheduledBytes: 600_000,
      totalPcmBytes: 1_200_000,
      outcome: 'success'
    });
    recordTtsDiagnostic({
      phase: 'chunk',
      chunkKind: 'steady',
      chunkChars: 250,
      durationMs: 1_800,
      preparationOutcome: 'cache-hit',
      outcome: 'success'
    });
    recordTtsDiagnostic({
      phase: 'chunk',
      chunkKind: 'startup',
      chunkChars: 80,
      preparationOutcome: 'in-flight-adoption',
      outcome: 'success'
    });
    recordTtsDiagnostic({ phase: 'playback', tapToFirstSpeechMs: 1_250, outcome: 'success' });

    const snapshot = getTtsQualificationSnapshot();
    expect(snapshot.startupSynthesisMs).toEqual({ count: 1, p50: 900, p95: 900, p99: 900 });
    expect(snapshot.steadySynthesisMs).toEqual({ count: 1, p50: 1800, p95: 1800, p99: 1800 });
    expect(snapshot.startupChunkChars.count).toBe(2);
    expect(snapshot.steadyChunkChars.p50).toBe(250);
    expect(snapshot.preparedCacheHits).toBe(1);
    expect(snapshot.inFlightAdoptions).toBe(1);
    expect(snapshot.tapToFirstSpeechMs.p95).toBe(1_250);
    expect(snapshot.peakTotalPcmBytes).toBe(1_200_000);
    expect(JSON.stringify(snapshot)).not.toContain('text');
  });
});
