import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearTtsDiagnostics,
  getTtsDiagnostics,
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
});
