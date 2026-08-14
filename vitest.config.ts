import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Logic tier. Anything needing real audio, WebGPU, service workers, or the
// PWA install gate belongs in the Playwright tier instead — onnxruntime-web
// does not run meaningfully under jsdom.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}', 'scripts/**/*.mjs'],
      exclude: ['src/main.tsx', 'src/**/*.d.ts']
    }
  }
});
