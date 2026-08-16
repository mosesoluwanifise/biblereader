/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * URL prefix for onnxruntime-web's own WASM runtime files, used in place of
   * the locally bundled copy. Set only by scripts/build-for-cloudflare.mjs —
   * see src/services/tts/synthesis.worker.ts for why.
   */
  readonly VITE_ORT_WASM_BASE?: string;
  /** Exact model version whose five-step profile passed the release listening/timing gate. */
  readonly VITE_SUPERTONIC_FIVE_STEP_QUALITY_APPROVED?: string;
  /** Set to "0" to disable automatic execution-provider fallback. */
  readonly VITE_SUPERTONIC_PROVIDER_FALLBACK_ENABLED?: string;
  /** Set to "0" to disable current/next passage synthesis speculation without disabling narration. */
  readonly VITE_SUPERTONIC_SPECULATIVE_PREPARATION?: string;
}
