import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/favicon.svg', 'icons/apple-touch-icon.png'],
      workbox: {
        // Precache the app shell only. The ONNX runtime binary (~27 MB), the
        // model bundle (~100 MB), and the bundled Bible text (~13 MB) are far
        // too large to fetch on install — they are cached on first read
        // instead, so the app stays installable on a mobile connection.
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        globIgnores: ['**/ort-*.wasm', '**/models/**', '**/bibles/**'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallbackDenylist: [/^\/models\//, /^\/bibles\//],
        runtimeCaching: [
          {
            // Bible text: immutable once generated, so cache-first is safe and
            // makes offline reading work after a chapter has been visited.
            urlPattern: ({ url }) => url.pathname.startsWith('/bibles/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'scripture-text',
              expiration: { maxEntries: 220, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          {
            // Model weights and the ORT runtime: large, immutable, and keyed by
            // the manifest version, so a model update lands as new URLs rather
            // than a stale cache hit.
            urlPattern: ({ url }) => url.pathname.startsWith('/models/') || /ort-.*\.wasm$/.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'voice-model',
              expiration: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
              rangeRequests: true
            }
          }
        ]
      },
      manifest: {
        name: 'Scripture Voice — Bible Reader',
        short_name: 'Scripture Voice',
        description: 'Read and listen to the Bible offline, with on-device narration and word-by-word highlighting',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icons/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      }
    })
  ],
  // onnxruntime-web ships prebuilt WASM; excluding it from dep optimization
  // keeps the dev server from rewriting the binary's loader paths.
  optimizeDeps: { exclude: ['onnxruntime-web'] },

  /**
   * Cross-origin isolation. Without these headers `crossOriginIsolated` is
   * false, SharedArrayBuffer is unavailable, and onnxruntime-web silently
   * drops to a single WASM thread — which is most of why our synthesis ran
   * 4.6x slower than the reference pipeline over identical weights.
   *
   * Production hosting must send the same two headers; they are not part of
   * the built assets. See README.
   */
  server: {
    port: 3000,
    host: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  }
});
