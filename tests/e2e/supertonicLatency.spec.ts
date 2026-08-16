import { expect, test, type Page, type TestInfo } from '@playwright/test';

const qualificationEnabled = process.env.SUPERTONIC_QUALIFY === '1';
const coldEvidenceRequested = process.env.SUPERTONIC_COLD === '1';
const longChapterRequested = process.env.SUPERTONIC_LONG === '1';
const supportedClassExpected = process.env.SUPERTONIC_EXPECT_SUPPORTED === '1';
const WARM_REPETITIONS = 10;
const LONG_CHAPTER_PASSES = 3;

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.project.name === 'qualify-wasm') {
    await page.addInitScript(() => {
      Reflect.deleteProperty(Navigator.prototype, 'gpu');
      Reflect.deleteProperty(navigator, 'gpu');
    });
  }
});

test('diagnostic qualification harness is bounded, text-free, and cross-origin isolated', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Scripture Voice/);
  const snapshot = await page.evaluate(async () => {
    const diagnostics = await (0, eval)('import("/src/services/tts/diagnostics.ts")');
    diagnostics.clearTtsDiagnostics();
    diagnostics.recordTtsDiagnostic({
      phase: 'chunk',
      provider: 'wasm',
      steps: 8,
      durationMs: 20,
      audioSeconds: 0.04,
      realtimeFactor: 2,
      outcome: 'success'
    });
    return diagnostics.getTtsQualificationSnapshot();
  });

  expect(snapshot.schemaVersion).toBe(1);
  expect(snapshot.retention).toMatchObject({ count: 1, limit: 100, dropped: 0, metricSampleLimit: 256 });
  expect(snapshot.metricScope).toBe('prepared-chunk-end-to-end');
  expect(snapshot.capabilities.crossOriginIsolated).toBe(true);
  expect(snapshot.productionFactor).toMatchObject({ count: 1, p50: 2, p95: 2, p99: 2 });
  expect(JSON.stringify(snapshot)).not.toMatch(/Genesis|Scripture text|passage/i);
});

test('opt-in real-model latency and continuity qualification', async ({ page }, testInfo) => {
  test.skip(
    !qualificationEnabled || !testInfo.project.name.startsWith('qualify-'),
    'Set SUPERTONIC_QUALIFY=1 to run the 398 MB real-model qualification.'
  );

  await page.goto('/');
  const manifestAvailable = await page.evaluate(async () => {
    const response = await fetch('/models/supertonic-3/manifest.json', { cache: 'no-store' });
    return response.ok;
  });
  test.skip(!manifestAvailable, 'UNSUPPORTED: Supertonic model assets are not installed or reachable.');

  if (testInfo.project.name === 'qualify-webgpu') {
    const adapterAvailable = await page.evaluate(async () => {
      if (!('gpu' in navigator)) return false;
      return !!(await navigator.gpu.requestAdapter());
    });
    test.skip(!adapterAvailable, 'UNSUPPORTED: this browser/hardware exposes no WebGPU adapter.');
  }

  await clearDiagnostics(page);
  await expect(page.getByRole('button', { name: 'Play' })).toBeEnabled();

  const initializationSpeechOnsetMs = await controllerScheduledSpeechOnsetMs(page);
  const initialization = await readSnapshot(page);
  await stopPlayback(page);

  const warmScheduledSpeechOnsetMs: number[] = [];
  for (let run = 0; run < WARM_REPETITIONS; run += 1) {
    warmScheduledSpeechOnsetMs.push(await controllerScheduledSpeechOnsetMs(page));
    await stopPlayback(page);
  }
  const warmP95Ms = nearestRank(warmScheduledSpeechOnsetMs, 0.95);

  // Navigation preparation is complete when another real synthesis sample is
  // recorded. Only then is the <=3 s primed transition gate measured.
  const beforeNavigationSamples = (await readSnapshot(page)).synthesisMs.count;
  await page.getByRole('combobox', { name: 'Chapter' }).selectOption('2');
  await expect(page.getByRole('heading', { name: /Genesis 2/ })).toBeVisible();
  await page.waitForFunction(
    async (before) => {
      const diagnostics = await (0, eval)('import("/src/services/tts/diagnostics.ts")');
      return diagnostics.getTtsQualificationSnapshot().synthesisMs.count > before;
    },
    beforeNavigationSamples,
    { timeout: 10 * 60_000 }
  );
  const primedNavigationScheduledSpeechOnsetMs = await controllerScheduledSpeechOnsetMs(page);
  await stopPlayback(page);

  const finalSnapshot = await readSnapshot(page);
  const evidence: Record<string, unknown> = {
    result: 'measured',
    project: testInfo.project.name,
    initialization: {
      classification: coldEvidenceRequested ? 'cold-empty-browser-context' : 'engine-initialization-not-claimed-cold',
      controllerScheduledSpeechOnsetMs: initializationSpeechOnsetMs,
      phaseEvidence: initialization.events.filter((event: { phase: string }) =>
        ['download', 'compile', 'warmup'].includes(event.phase)
      )
    },
    automatedTimingScope:
      'Controller-observed AudioContext clock reaching the first scheduled speech boundary; physical speaker audibility is not automated.',
    warmScheduledSpeechOnsetMs,
    warmScheduledSpeechOnsetNearestRankP95Ms: warmP95Ms,
    primedNavigationScheduledSpeechOnsetMs,
    peakTotalPcmBytes: finalSnapshot.peakTotalPcmBytes,
    snapshot: finalSnapshot
  };

  let long: { passes: Array<{ outcome: string; snapshot: QualificationSnapshot }> } | null = null;
  if (longChapterRequested) {
    evidence.longChapter = await qualifyLongChapter(page);
    long = evidence.longChapter as { passes: Array<{ outcome: string; snapshot: QualificationSnapshot }> };
  } else {
    evidence.longChapter = { outcome: 'not-run', reason: 'Set SUPERTONIC_LONG=1; no continuity claim made.' };
  }

  await attachEvidence(testInfo, evidence);

  const provider = finalSnapshot.runtime.provider;
  if (testInfo.project.name === 'qualify-webgpu') expect(provider).toBe('webgpu');
  if (testInfo.project.name === 'qualify-wasm') expect(provider).toBe('wasm');
  if (testInfo.project.name === 'qualify-webgpu-fallback') {
    expect(provider).toBe('wasm');
    expect(finalSnapshot.events.some((event: { phase: string }) => event.phase === 'provider-fallback')).toBe(true);
  }
  expect(warmScheduledSpeechOnsetMs).toHaveLength(WARM_REPETITIONS);
  expect(warmP95Ms).toBeLessThanOrEqual(3_000);
  expect(primedNavigationScheduledSpeechOnsetMs).toBeLessThanOrEqual(3_000);
  if (supportedClassExpected) {
    expect(longChapterRequested, 'SUPERTONIC_EXPECT_SUPPORTED requires SUPERTONIC_LONG=1').toBe(true);
    expect(long).not.toBeNull();
  }
  if (supportedClassExpected && long) {
    expect(long.passes).toHaveLength(LONG_CHAPTER_PASSES);
    for (const pass of long.passes) {
      expect(pass.outcome).toBe('completed');
      expect(pass.snapshot.underrunCount).toBe(0);
      expect(pass.snapshot.underrunDurationMs).toBe(0);
    }
  }
});

interface QualificationSnapshot {
  runtime: {
    provider: 'webgpu' | 'wasm' | null;
    steps: number | null;
    modelVersion: string | null;
    runtimeVersion: string | null;
  };
  synthesisMs: { count: number; p50: number | null; p95: number | null; p99: number | null };
  productionFactor: { count: number; p50: number | null; p95: number | null; p99: number | null };
  underrunCount: number;
  underrunDurationMs: number;
  minScheduledAheadSeconds: number | null;
  cancellationLatencyMs: { count: number; p50: number | null; p95: number | null; p99: number | null };
  tapToFirstSpeechMs: { count: number; p50: number | null; p95: number | null; p99: number | null };
  peakTotalPcmBytes: number;
  capabilities: Record<string, unknown>;
  events: Array<{ phase: string; tapToFirstSpeechMs?: number; outcome?: string }>;
}

async function controllerScheduledSpeechOnsetMs(page: Page): Promise<number> {
  const play = page.getByRole('button', { name: /^(Play|Retry narration)$/ });
  await expect(play).toBeEnabled();
  const before = (await readSnapshot(page)).tapToFirstSpeechMs.count;
  await play.click();
  await page.waitForFunction(
    async (count) => {
      const diagnostics = await (0, eval)('import("/src/services/tts/diagnostics.ts")');
      return diagnostics.getTtsQualificationSnapshot().tapToFirstSpeechMs.count > count;
    },
    before,
    { timeout: 10 * 60_000 }
  );
  const snapshot = await readSnapshot(page);
  const event = [...snapshot.events].reverse().find((candidate) => candidate.tapToFirstSpeechMs !== undefined);
  if (event?.tapToFirstSpeechMs === undefined) throw new Error('Controller did not record scheduled first-speech onset');
  return event.tapToFirstSpeechMs;
}

async function stopPlayback(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Stop and return to the start of the chapter' }).click();
  await expect(page.getByRole('button', { name: /^(Play|Retry narration)$/ })).toBeEnabled();
}

async function clearDiagnostics(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const diagnostics = await (0, eval)('import("/src/services/tts/diagnostics.ts")');
    diagnostics.clearTtsDiagnostics();
  });
}

async function readSnapshot(page: Page): Promise<QualificationSnapshot> {
  return page.evaluate(async () => {
    const diagnostics = await (0, eval)('import("/src/services/tts/diagnostics.ts")');
    return diagnostics.getTtsQualificationSnapshot();
  });
}

async function qualifyLongChapter(page: Page): Promise<Record<string, unknown>> {
  const passes: Record<string, unknown>[] = [];
  for (let pass = 0; pass < LONG_CHAPTER_PASSES; pass += 1) {
    await page.getByRole('combobox', { name: 'Book' }).selectOption('Psalms');
    await page.getByRole('combobox', { name: 'Chapter' }).selectOption('119');
    await expect(page.getByRole('heading', { name: /Psalms 119/ })).toBeVisible();
    await clearDiagnostics(page);
    const expectedWords = await installHighlightProbe(page);
    const jitter = pass === LONG_CHAPTER_PASSES - 1;
    if (jitter) await startControlledJitter(page);
    const scheduledSpeechOnsetMs = await controllerScheduledSpeechOnsetMs(page);

    let rebufferingObservedMs = 0;
    let previousSampleAt = Date.now();
    const deadline = Date.now() + 25 * 60_000;
    let outcome = 'timeout';
    while (Date.now() < deadline) {
      const status = await page.locator('[role="status"]').allTextContents();
      const sampledAt = Date.now();
      if (status.some((value) => /rebuffering/i.test(value))) rebufferingObservedMs += sampledAt - previousSampleAt;
      previousSampleAt = sampledAt;
      if (status.some((value) => /too slow/i.test(value))) {
        outcome = 'device-too-slow';
        break;
      }
      const observed = await highlightEvidence(page);
      if (observed.indices.length === expectedWords) {
        outcome = 'completed';
        break;
      }
      if ((await page.getByRole('combobox', { name: 'Chapter' }).inputValue()) !== '119') {
        outcome = observed.indices.length === expectedWords ? 'completed' : 'highlight-incomplete';
        break;
      }
      await page.waitForTimeout(500);
    }
    if (jitter) await stopControlledJitter(page);
    const highlights = await highlightEvidence(page);
    if (outcome === 'completed') {
      expect(highlights.indices).toHaveLength(expectedWords);
      expect(highlights.indices).toEqual(Array.from({ length: expectedWords }, (_, index) => index));
    }
    const snapshot = await readSnapshot(page);
    passes.push({
      pass: pass + 1,
      outcome,
      controlledMainThreadJitter: jitter ? { intervalMs: 5_000, busyMs: 20 } : null,
      scheduledSpeechOnsetMs,
      expectedGlobalWordCount: expectedWords,
      highlightedGlobalWordIndices: highlights.indices,
      highlightObservedAtMs: highlights.atMs,
      automatedHighlightScope:
        'DOM highlight transitions are checked for exact global-index order. Scheduled per-word boundaries are not exposed, so audible timing error and drift remain a manual listening gate.',
      rebufferingObservedMs,
      recoverySamplingIntervalMs: 500,
      peakTotalPcmBytes: snapshot.peakTotalPcmBytes,
      snapshot
    });
  }
  return { requiredPasses: LONG_CHAPTER_PASSES, passes };
}

async function installHighlightProbe(page: Page): Promise<number> {
  return page.evaluate(() => {
    const words = [...document.querySelectorAll('.word-span')];
    type HighlightProbe = { indices: number[]; atMs: number[]; observer?: MutationObserver };
    const scope = globalThis as typeof globalThis & { __supertonicHighlightEvidence?: HighlightProbe };
    scope.__supertonicHighlightEvidence?.observer?.disconnect();
    const evidence: HighlightProbe = { indices: [], atMs: [] };
    scope.__supertonicHighlightEvidence = evidence;
    const capture = () => {
      const active = document.querySelector('.word-span.highlighted');
      if (!active) return;
      const index = words.indexOf(active);
      if (index < 0 || evidence.indices.at(-1) === index) return;
      evidence.indices.push(index);
      evidence.atMs.push(performance.now());
    };
    evidence.observer = new MutationObserver(capture);
    evidence.observer.observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });
    capture();
    return words.length;
  });
}

async function highlightEvidence(page: Page): Promise<{ indices: number[]; atMs: number[] }> {
  return page.evaluate(() => {
    const value = (globalThis as typeof globalThis & {
      __supertonicHighlightEvidence?: { indices: number[]; atMs: number[] };
    }).__supertonicHighlightEvidence;
    return value ? { indices: [...value.indices], atMs: [...value.atMs] } : { indices: [], atMs: [] };
  });
}

async function startControlledJitter(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = globalThis as typeof globalThis & { __supertonicJitter?: number };
    scope.__supertonicJitter = window.setInterval(() => {
      const end = performance.now() + 20;
      while (performance.now() < end) {
        // Intentional, bounded main-thread scheduling disturbance.
      }
    }, 5_000);
  });
}

async function stopControlledJitter(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = globalThis as typeof globalThis & { __supertonicJitter?: number };
    if (scope.__supertonicJitter !== undefined) window.clearInterval(scope.__supertonicJitter);
    delete scope.__supertonicJitter;
  });
}

function nearestRank(values: number[], fraction: number): number {
  if (values.length === 0) throw new Error('Cannot calculate a percentile without observations');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(fraction * sorted.length) - 1];
}

async function attachEvidence(testInfo: TestInfo, evidence: unknown): Promise<void> {
  await testInfo.attach('supertonic-qualification.json', {
    body: Buffer.from(JSON.stringify(evidence, null, 2)),
    contentType: 'application/json'
  });
}
