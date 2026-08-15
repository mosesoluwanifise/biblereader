export type RuntimeProvider = 'webgpu' | 'wasm';

export const ORT_RUNTIME_VERSION = '1.18.0';
const PROFILE_SCHEMA_VERSION = 1;
const PROFILE_STORAGE_KEY = 'scripture-voice:supertonic-runtime-profile';

export interface RuntimeCapabilities {
  webgpu: boolean;
  crossOriginIsolated: boolean;
  hardwareConcurrency: number;
}

export interface RuntimeProfile {
  schemaVersion: typeof PROFILE_SCHEMA_VERSION;
  modelVersion: string;
  ortVersion: string;
  provider: RuntimeProvider;
  steps: number;
  capabilities: RuntimeCapabilities;
  /** Five-step synthesis is never enabled without an explicit quality record. */
  qualityGate?: { steps: 5; approved: true; modelVersion: string };
}

export interface SessionFactory<T> {
  create(graph: string, provider: RuntimeProvider): Promise<T>;
  release(session: T): Promise<void>;
}

export function getRuntimeCapabilities(scope: typeof globalThis = globalThis): RuntimeCapabilities {
  return {
    webgpu: 'gpu' in scope.navigator,
    crossOriginIsolated: scope.crossOriginIsolated === true,
    hardwareConcurrency: Math.max(1, scope.navigator.hardwareConcurrency || 1)
  };
}

export function compatibleProfile(
  value: unknown,
  capabilities: RuntimeCapabilities
): RuntimeProfile | null {
  if (!value || typeof value !== 'object') return null;
  const profile = value as Partial<RuntimeProfile>;
  if (
    profile.schemaVersion !== PROFILE_SCHEMA_VERSION ||
    profile.ortVersion !== ORT_RUNTIME_VERSION ||
    !profile.capabilities ||
    profile.capabilities.webgpu !== capabilities.webgpu ||
    profile.capabilities.crossOriginIsolated !== capabilities.crossOriginIsolated ||
    profile.capabilities.hardwareConcurrency !== capabilities.hardwareConcurrency ||
    (profile.provider !== 'wasm' && profile.provider !== 'webgpu') ||
    profile.provider === 'webgpu' && !capabilities.webgpu ||
    typeof profile.modelVersion !== 'string'
  ) {
    return null;
  }

  // Reduced-step inference is opt-in and tied to the exact model under test.
  if (
    profile.steps !== 8 &&
    !(
      profile.steps === 5 &&
      profile.qualityGate?.approved === true &&
      profile.qualityGate.modelVersion === profile.modelVersion
    )
  ) {
    return null;
  }
  return profile as RuntimeProfile;
}

export function readRuntimeProfile(
  capabilities: RuntimeCapabilities,
  storage: Pick<Storage, 'getItem' | 'removeItem'> | null = typeof localStorage === 'undefined' ? null : localStorage,
  approvedFiveStepModelVersion?: string
): RuntimeProfile | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(PROFILE_STORAGE_KEY);
    const profile = raw ? compatibleProfile(JSON.parse(raw), capabilities) : null;
    if (profile?.steps === 5 && approvedFiveStepModelVersion !== profile.modelVersion) {
      storage.removeItem(PROFILE_STORAGE_KEY);
      return null;
    }
    return profile;
  } catch {
    return null;
  }
}

export function writeRuntimeProfile(
  profile: RuntimeProfile,
  storage: Pick<Storage, 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage
): void {
  try {
    storage?.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Storage can be unavailable in private browsing; the in-memory profile still works.
  }
}

export function clearRuntimeProfile(
  storage: Pick<Storage, 'removeItem'> | null = typeof localStorage === 'undefined' ? null : localStorage
): void {
  try {
    storage?.removeItem(PROFILE_STORAGE_KEY);
  } catch {
    // Best-effort invalidation only.
  }
}

export function providerOrder(capabilities: RuntimeCapabilities, profile: RuntimeProfile | null): RuntimeProvider[] {
  if (profile) {
    const fallback: RuntimeProvider = profile.provider === 'webgpu' ? 'wasm' : 'webgpu';
    return capabilities.webgpu ? [profile.provider, fallback] : ['wasm'];
  }
  return capabilities.webgpu ? ['webgpu', 'wasm'] : ['wasm'];
}

export function profileForModel(profile: RuntimeProfile | null, modelVersion: string | null): RuntimeProfile | null {
  return profile && modelVersion && profile.modelVersion === modelVersion ? profile : null;
}

/**
 * Creates a complete graph set on exactly one provider. A failed attempt is
 * fully released before the next provider is allowed to allocate anything.
 */
export async function createAtomicSessionSet<T>(
  graphs: readonly string[],
  providers: readonly RuntimeProvider[],
  factory: SessionFactory<T>,
  onProviderFallback?: (failed: RuntimeProvider, next: RuntimeProvider) => void
): Promise<{ provider: RuntimeProvider; sessions: Map<string, T> }> {
  let lastError: unknown;
  for (let providerIndex = 0; providerIndex < providers.length; providerIndex += 1) {
    const provider = providers[providerIndex];
    const results = await Promise.allSettled(graphs.map((graph) => factory.create(graph, provider)));
    const created = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (!failure) {
      return { provider, sessions: new Map(graphs.map((graph, index) => [graph, created[index]])) };
    }

    lastError = failure.reason;
    await Promise.allSettled(created.map((session) => factory.release(session)));
    const next = providers[providerIndex + 1];
    if (next) onProviderFallback?.(provider, next);
  }
  throw new Error(`Could not create Supertonic sessions: ${(lastError as Error)?.message ?? 'unknown error'}`);
}

export function makeRuntimeProfile(
  modelVersion: string,
  provider: RuntimeProvider,
  capabilities: RuntimeCapabilities,
  steps = 8
): RuntimeProfile {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    modelVersion,
    ortVersion: ORT_RUNTIME_VERSION,
    provider,
    steps,
    capabilities
  };
}

export { PROFILE_STORAGE_KEY };
