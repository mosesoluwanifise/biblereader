import { defineConfig, devices } from '@playwright/test';

// Browser tier. Covers what jsdom cannot: real audio output, WebGPU vs WASM
// execution-provider selection, service-worker caching, and the PWA install
// gate. U6, U7, and U10 verify here.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry'
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Supertonic prefers the WebGPU execution provider; headless Chrome
        // needs it enabled explicitly. The WASM fallback path (R13) is
        // covered by the 'chromium-wasm' project below.
        launchOptions: { args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] }
      }
    },
    {
      name: 'chromium-wasm',
      use: { ...devices['Desktop Chrome'] }
    },
    {
      name: 'mobile-safari',
      use: { ...devices['iPhone 14'] }
    }
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
