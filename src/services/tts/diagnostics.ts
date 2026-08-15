export type DiagnosticPhase = 'download' | 'compile' | 'warmup' | 'synthesis' | 'provider-fallback';

export interface TtsDiagnostic {
  at: number;
  phase: DiagnosticPhase;
  durationMs?: number;
  provider?: 'webgpu' | 'wasm';
  steps?: number;
  audioSeconds?: number;
  realtimeFactor?: number;
  outcome?: 'start' | 'success' | 'failure';
}

const MAX_EVENTS = 100;
const events: TtsDiagnostic[] = [];

/** Records only bounded numeric and enum metadata. Passage text is not accepted by the type or stored. */
export function recordTtsDiagnostic(event: Omit<TtsDiagnostic, 'at'> & { at?: number }): void {
  const safe: TtsDiagnostic = {
    at: event.at ?? Date.now(),
    phase: event.phase,
    durationMs: finite(event.durationMs),
    provider: event.provider,
    steps: finite(event.steps),
    audioSeconds: finite(event.audioSeconds),
    realtimeFactor: finite(event.realtimeFactor),
    outcome: event.outcome
  };
  events.push(safe);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

function finite(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function getTtsDiagnostics(): readonly TtsDiagnostic[] {
  return events.map((event) => ({ ...event }));
}

export function clearTtsDiagnostics(): void {
  events.length = 0;
}

export { MAX_EVENTS as MAX_TTS_DIAGNOSTICS };
