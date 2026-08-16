import { defineConfig, devices, type Project } from '@playwright/test';

const qualificationEnabled = process.env.SUPERTONIC_QUALIFY === '1';
const longQualificationEnabled = qualificationEnabled && process.env.SUPERTONIC_LONG === '1';

const projects: Project[] = [
  {
    name: 'chromium-smoke',
    use: { ...devices['Desktop Chrome'] }
  }
];

if (qualificationEnabled) {
  projects.push(
    {
      name: 'qualify-webgpu',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan']
        }
      }
    },
    {
      // The spec removes Navigator.prototype.gpu before application code runs.
      name: 'qualify-wasm',
      use: { ...devices['Desktop Chrome'] }
    },
    {
      // Keeps navigator.gpu visible while making adapter/session creation fail,
      // exercising the atomic WebGPU -> WASM initialization fallback.
      name: 'qualify-webgpu-fallback',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: ['--disable-gpu', '--disable-software-rasterizer'] }
      }
    }
  );
}

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: !qualificationEnabled,
  workers: qualificationEnabled ? 1 : undefined,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: longQualificationEnabled ? 100 * 60_000 : qualificationEnabled ? 30 * 60_000 : 30_000,
  expect: { timeout: qualificationEnabled ? 10 * 60_000 : 5_000 },
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry'
  },
  projects,
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
