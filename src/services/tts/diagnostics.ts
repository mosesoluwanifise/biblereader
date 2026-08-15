export type DiagnosticPhase =
  | 'download'
  | 'compile'
  | 'warmup'
  | 'synthesis'
  | 'chunk'
  | 'provider-fallback'
  | 'playback';

export interface TtsDiagnostic {
  at: number;
  phase: DiagnosticPhase;
  durationMs?: number;
  provider?: RuntimeProvider;
  steps?: number;
  modelVersion?: string;
  runtimeVersion?: string;
  audioSeconds?: number;
  realtimeFactor?: number;
  scheduledAheadSeconds?: number;
  bufferLowWaterSeconds?: number;
  underrunCount?: number;
  underrunDurationMs?: number;
  cancellationLatencyMs?: number;
  platformInterruptionCount?: number;
  outcome?: 'start' | 'success' | 'failure';
}

const MAX_EVENTS = 100;
const events: TtsDiagnostic[] = [];
let droppedEvents = 0;
const MAX_METRIC_SAMPLES = 256;
const synthesisDurations: number[] = [];
const productionFactors: number[] = [];
const cancellationLatencies: number[] = [];
let minScheduledAheadSeconds: number | null = null;
let maxUnderrunCount = 0;
let maxUnderrunDurationMs = 0;
let maxPlatformInterruptionCount = 0;

export interface NumericDistribution {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface TtsQualificationSnapshot {
  schemaVersion: 1;
  capturedAt: number;
  retention: { count: number; limit: number; dropped: number; metricSampleLimit: number };
  metricScope: 'prepared-chunk-end-to-end';
  capabilities: {
    crossOriginIsolated: boolean;
    webgpu: boolean;
    hardwareConcurrency: number;
    threadCapacity: number;
    browserFamily: 'chromium' | 'firefox' | 'safari' | 'other';
    browserMajor: number | null;
    fingerprint: string;
  };
  runtime: {
    provider: TtsDiagnostic['provider'] | null;
    steps: number | null;
    modelVersion: string | null;
    runtimeVersion: string | null;
  };
  synthesisMs: NumericDistribution;
  /** Audio seconds produced per synthesis wall second. Higher is better. */
  productionFactor: NumericDistribution;
  minScheduledAheadSeconds: number | null;
  underrunCount: number;
  underrunDurationMs: number;
  platformInterruptionCount: number;
  cancellationLatencyMs: NumericDistribution;
  events: readonly TtsDiagnostic[];
}

/** Records only bounded numeric and enum metadata. Passage text is not accepted by the type or stored. */
export function recordTtsDiagnostic(event: Omit<TtsDiagnostic, 'at'> & { at?: number }): void {
  const safe: TtsDiagnostic = {
    at: event.at ?? Date.now(),
    phase: event.phase,
    durationMs: finite(event.durationMs),
    provider: event.provider,
    steps: finite(event.steps),
    modelVersion: boundedVersion(event.modelVersion),
    runtimeVersion: boundedVersion(event.runtimeVersion),
    audioSeconds: finite(event.audioSeconds),
    realtimeFactor: finite(event.realtimeFactor),
    scheduledAheadSeconds: finite(event.scheduledAheadSeconds),
    bufferLowWaterSeconds: finite(event.bufferLowWaterSeconds),
    underrunCount: finite(event.underrunCount),
    underrunDurationMs: finite(event.underrunDurationMs),
    cancellationLatencyMs: finite(event.cancellationLatencyMs),
    platformInterruptionCount: finite(event.platformInterruptionCount),
    outcome: event.outcome
  };
  events.push(safe);
  if (safe.phase === 'chunk') {
    appendMetric(synthesisDurations, safe.durationMs);
    appendMetric(productionFactors, safe.realtimeFactor);
  }
  appendMetric(cancellationLatencies, safe.cancellationLatencyMs);
  if (safe.scheduledAheadSeconds !== undefined) {
    minScheduledAheadSeconds =
      minScheduledAheadSeconds === null
        ? safe.scheduledAheadSeconds
        : Math.min(minScheduledAheadSeconds, safe.scheduledAheadSeconds);
  }
  maxUnderrunCount = Math.max(maxUnderrunCount, safe.underrunCount ?? 0);
  maxUnderrunDurationMs = Math.max(maxUnderrunDurationMs, safe.underrunDurationMs ?? 0);
  maxPlatformInterruptionCount = Math.max(
    maxPlatformInterruptionCount,
    safe.platformInterruptionCount ?? 0
  );
  if (events.length > MAX_EVENTS) {
    const overflow = events.length - MAX_EVENTS;
    events.splice(0, overflow);
    droppedEvents += overflow;
  }
}

function finite(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function getTtsDiagnostics(): readonly TtsDiagnostic[] {
  return events.map((event) => ({ ...event }));
}

/** Builds the shareable qualification artifact without accepting or exposing passage text. */
export function getTtsQualificationSnapshot(scope: typeof globalThis = globalThis): TtsQualificationSnapshot {
  const snapshot = getTtsDiagnostics();
  const capabilities = getRuntimeCapabilities(scope);
  const { hardwareConcurrency, crossOriginIsolated, webgpu } = capabilities;
  const browser = browserIdentity(scope.navigator?.userAgent ?? '');
  const runtime = [...snapshot].reverse().find((event) => event.provider || event.steps !== undefined);
  return {
    schemaVersion: 1,
    capturedAt: Date.now(),
    retention: {
      count: snapshot.length,
      limit: MAX_EVENTS,
      dropped: droppedEvents,
      metricSampleLimit: MAX_METRIC_SAMPLES
    },
    metricScope: 'prepared-chunk-end-to-end',
    capabilities: {
      crossOriginIsolated,
      webgpu,
      hardwareConcurrency,
      threadCapacity: crossOriginIsolated ? hardwareConcurrency : 1,
      browserFamily: browser.family,
      browserMajor: browser.major,
      fingerprint: `wgpu:${webgpu ? 1 : 0}|coi:${crossOriginIsolated ? 1 : 0}|hc:${hardwareConcurrency}|b:${browser.family}:${browser.major ?? 0}`
    },
    runtime: {
      provider: runtime?.provider ?? null,
      steps: runtime?.steps ?? null,
      modelVersion: runtime?.modelVersion ?? null,
      runtimeVersion: runtime?.runtimeVersion ?? null
    },
    synthesisMs: distribution(synthesisDurations),
    productionFactor: distribution(productionFactors),
    minScheduledAheadSeconds,
    underrunCount: maxUnderrunCount,
    underrunDurationMs: maxUnderrunDurationMs,
    platformInterruptionCount: maxPlatformInterruptionCount,
    cancellationLatencyMs: distribution(cancellationLatencies),
    events: snapshot
  };
}

export function clearTtsDiagnostics(): void {
  events.length = 0;
  droppedEvents = 0;
  synthesisDurations.length = 0;
  productionFactors.length = 0;
  cancellationLatencies.length = 0;
  minScheduledAheadSeconds = null;
  maxUnderrunCount = 0;
  maxUnderrunDurationMs = 0;
  maxPlatformInterruptionCount = 0;
}

function appendMetric(target: number[], value: number | undefined): void {
  if (value === undefined) return;
  target.push(value);
  if (target.length > MAX_METRIC_SAMPLES) target.splice(0, target.length - MAX_METRIC_SAMPLES);
}

function boundedVersion(value: string | undefined): string | undefined {
  return value && /^[A-Za-z0-9._+-]{1,64}$/.test(value) ? value : undefined;
}

function browserIdentity(userAgent: string): {
  family: 'chromium' | 'firefox' | 'safari' | 'other';
  major: number | null;
} {
  const edgeOrChrome = userAgent.match(/(?:Edg|HeadlessChrome|Chrome)\/(\d+)/);
  if (edgeOrChrome) return { family: 'chromium', major: Number(edgeOrChrome[1]) };
  const firefox = userAgent.match(/Firefox\/(\d+)/);
  if (firefox) return { family: 'firefox', major: Number(firefox[1]) };
  const safari = userAgent.match(/Version\/(\d+).+Safari\//);
  if (safari) return { family: 'safari', major: Number(safari[1]) };
  return { family: 'other', major: null };
}

function distribution(values: number[]): NumericDistribution {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99)
  };
}

/** Nearest-rank percentile: ceil(p*n), clamped to the observed sample range. */
function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1))];
}

export { MAX_EVENTS as MAX_TTS_DIAGNOSTICS };
import { getRuntimeCapabilities, type RuntimeProvider } from './runtimeProfile';
