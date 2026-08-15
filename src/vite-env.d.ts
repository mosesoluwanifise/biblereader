/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * URL prefix for onnxruntime-web's own WASM runtime files, used in place of
   * the locally bundled copy. Set only by scripts/build-for-cloudflare.mjs —
   * see src/services/tts/synthesis.worker.ts for why.
   */
  readonly VITE_ORT_WASM_BASE?: string;
}
