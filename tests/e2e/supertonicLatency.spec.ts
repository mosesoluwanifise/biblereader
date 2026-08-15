import { expect, test, type Page, type TestInfo } from '@playwright/test';

const qualificationEnabled = process.env.SUPERTONIC_QUALIFY === '1';
const coldEvidenceRequested = process.env.SUPERTONIC_COLD === '1';
const longChapterRequested = process.env.SUPERTONIC_LONG === '1';
const supportedClassExpected = process.env.SUPERTONIC_EXPECT_SUPPORTED === '1';

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

  const initializationTtfaMs = await scheduledFirstAudioMs(page);
  const initialization = await readSnapshot(page);
  await stopPlayback(page);

  const warmTtfaMs: number[] = [];
  let peakPreparedBytes = await preparedBytes(page);
  for (let run = 0; run < 3; run += 1) {
    warmTtfaMs.push(await scheduledFirstAudioMs(page));
    peakPreparedBytes = Math.max(peakPreparedBytes, await preparedBytes(page));
    await stopPlayback(page);
  }

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
  const primedNavigationTtfaMs = await scheduledFirstAudioMs(page);
  peakPreparedBytes = Math.max(peakPreparedBytes, await preparedBytes(page));
  await stopPlayback(page);

  const finalSnapshot = await readSnapshot(page);
  const evidence: Record<string, unknown> = {
    result: 'measured',
    project: testInfo.project.name,
    initialization: {
      classification: coldEvidenceRequested ? 'cold-empty-browser-context' : 'engine-initialization-not-claimed-cold',
      scheduledFirstAudioMs: initializationTtfaMs,
      phaseEvidence: initialization.events.filter((event: { phase: string }) =>
        ['download', 'compile', 'warmup'].includes(event.phase)
      )
    },
    warmTtfaMs,
    primedNavigationTtfaMs,
    peakPreparedBytes,
    snapshot: finalSnapshot
  };

  let long: { outcome: string; snapshot: QualificationSnapshot } | null = null;
  if (longChapterRequested) {
    evidence.longChapter = await qualifyLongChapter(page);
    long = evidence.longChapter as { outcome: string; snapshot: QualificationSnapshot };
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
  for (const latencyMs of [...warmTtfaMs, primedNavigationTtfaMs]) expect(latencyMs).toBeLessThanOrEqual(3_000);
  if (supportedClassExpected) {
    expect(longChapterRequested, 'SUPERTONIC_EXPECT_SUPPORTED requires SUPERTONIC_LONG=1').toBe(true);
    expect(long).not.toBeNull();
  }
  if (supportedClassExpected && long) {
    expect(long.outcome).toBe('completed');
    expect(long.snapshot.underrunCount).toBe(0);
    expect(long.snapshot.underrunDurationMs).toBe(0);
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
  capabilities: Record<string, unknown>;
  events: Array<{ phase: string }>;
}

async function scheduledFirstAudioMs(page: Page): Promise<number> {
  const play = page.getByRole('button', { name: /^(Play|Retry narration)$/ });
  await expect(play).toBeEnabled();
  const startedAt = await page.evaluate(() => performance.now());
  await play.click();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible({ timeout: 10 * 60_000 });
  return page.evaluate((start) => performance.now() - start, startedAt);
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

async function preparedBytes(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const coordinator = await (0, eval)('import("/src/services/tts/synthesisCoordinator.ts")');
    return coordinator.synthesisCoordinator.getPreparedUsage().bytes;
  });
}

async function qualifyLongChapter(page: Page): Promise<Record<string, unknown>> {
  await page.getByRole('combobox', { name: 'Book' }).selectOption('Psalms');
  await page.getByRole('combobox', { name: 'Chapter' }).selectOption('119');
  await expect(page.getByRole('heading', { name: /Psalms 119/ })).toBeVisible();
  await scheduledFirstAudioMs(page);

  let peakPreparedBytes = 0;
  let rebufferingObservedMs = 0;
  let previousSampleAt = Date.now();
  const deadline = Date.now() + 25 * 60_000;
  let outcome = 'timeout';
  while (Date.now() < deadline) {
    peakPreparedBytes = Math.max(peakPreparedBytes, await preparedBytes(page));
    const status = await page.locator('[role="status"]').allTextContents();
    const sampledAt = Date.now();
    if (status.some((value) => /rebuffering/i.test(value))) {
      rebufferingObservedMs += sampledAt - previousSampleAt;
    }
    previousSampleAt = sampledAt;
    if (status.some((value) => /too slow/i.test(value))) {
      outcome = 'device-too-slow';
      break;
    }
    if ((await page.getByRole('combobox', { name: 'Chapter' }).inputValue()) !== '119') {
      outcome = 'completed';
      break;
    }
    await page.waitForTimeout(500);
  }
  return {
    outcome,
    peakPreparedBytes,
    rebufferingObservedMs,
    recoverySamplingIntervalMs: 500,
    snapshot: await readSnapshot(page)
  };
}

async function attachEvidence(testInfo: TestInfo, evidence: unknown): Promise<void> {
  await testInfo.attach('supertonic-qualification.json', {
    body: Buffer.from(JSON.stringify(evidence, null, 2)),
    contentType: 'application/json'
  });
}
