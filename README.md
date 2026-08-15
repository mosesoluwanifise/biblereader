# Scripture Voice

An offline Bible reader with on-device narration and word-level highlighting.
All 66 books of KJV, WEB, and ASV ship with the application; speech is
synthesized in the browser, so reading and listening work with no network and
no account.

Installable as a PWA on mobile and desktop.

## Status

V1 is in progress. `walkthrough.md` records what is built, what is planned,
and the defects carried in from the pre-V1 prototype. The plan driving the
work is `docs/plans/2026-08-14-001-feat-scripture-voice-v1-plan.md`.

Voice cloning is **not** part of V1. It is deferred, not cancelled — see the
Scope Boundaries section of the plan for the licensing and biometric-data
constraints that need resolving first.

## Getting started

```bash
npm install
```

Generate the bundled Bible text (once; the output is committed):

```bash
npm run build:bible
```

Then start the dev server:

```bash
npm run dev
```

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server on port 3000 |
| `npm run build` | Type-check and produce a production build |
| `npm run preview` | Serve the production build locally |
| `npm test` | Vitest logic tier |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:e2e` | Playwright browser tier |
| `npm run test:e2e:smoke` | Deterministic Chromium smoke; does not download the voice model |
| `npm run test:supertonic:qualify` | Opt-in real-model qualification (requires environment flags below) |
| `npm run build:bible` | Generate `public/bibles/` from the upstream text source |
| `npm run build:models` | Download and license the Supertonic fp32 model bundle |
| `npm run build:cloudflare` | Production build for Cloudflare Pages — see below |
| `npm run deploy:models` | Push the model bundle to R2 for the Cloudflare deploy |

Playwright needs its browsers once before `test:e2e`:

```bash
npx playwright install
```

## Supertonic performance qualification

Ordinary CI runs only `chromium-smoke`. It verifies the page, deployment
headers, and the bounded diagnostics harness without fetching the roughly
398 MB model. No hardware performance claim is made by that test.

Real-device qualification is explicit. Install/build the model assets, then
set the flag in the shell that launches Playwright:

```powershell
$env:SUPERTONIC_QUALIFY = '1'
npm run test:supertonic:qualify
```

That adds three serial Chromium projects: real WebGPU, forced WASM, and a
WebGPU-initialization-failure fixture that must atomically fall back to WASM.
The test attaches `supertonic-qualification.json` under `test-results/`; it
contains no Bible text. Warm current-passage and primed-navigation runs must
schedule first audio within 3 seconds. Initialization is reported separately
from those warm gates.

Optional evidence flags:

```powershell
$env:SUPERTONIC_COLD = '1'              # label the fresh context as cold evidence
$env:SUPERTONIC_LONG = '1'              # run Psalms 119 continuity (up to 25 min)
$env:SUPERTONIC_EXPECT_SUPPORTED = '1'  # require completion and zero synthesis underruns
```

Do not set `SUPERTONIC_EXPECT_SUPPORTED` until the hardware/browser class is
named in the run record. A skipped WebGPU adapter, missing model, timeout, or
`device-too-slow` result is an outcome, not a passing hardware claim.

The artifact reports provider, steps, isolation, hardware concurrency/thread
capacity, browser major, model/runtime versions, a capability fingerprint,
and p50/p95/p99 prepared-chunk wall time. That end-to-end chunk time includes
the isolated duration predictions used for packed sentence anchors. Production
factor is **audio seconds / complete chunk synthesis wall seconds**. It also
reports minimum scheduled-ahead time, synthesis underruns and their duration,
platform interruptions, cancellation latency, and peak prepared bytes sampled
by the browser test. Cold evidence keeps download, compilation, and warm-up
phases separate from warm-engine time-to-first-audio.

Five-step synthesis remains disabled unless
`VITE_SUPERTONIC_FIVE_STEP_QUALITY_APPROVED` equals the exact model manifest
version recorded in a completed quality artifact. Removing or changing that
deployment value is the reduced-step kill switch: persisted five-step state is
cleared before the next load, while eight-step profiles remain valid. The
provider path has no hidden speed benchmark on Play; initialization fallback
is one atomic attempt and an unhealthy release should be rolled back rather
than repeatedly rebuilding session sets in a user session.

## Hosting requirement

The production host **must** send these two headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without them `crossOriginIsolated` is false and `SharedArrayBuffer` is
unavailable, so the WASM runtime cannot use its normal thread capacity. The
effect depends on the browser and hardware and must be recorded by the
qualification artifact; it is not assumed from one development machine. The
dev and preview servers set the headers via `vite.config.ts`; static hosts need
their own config.

## Deploying to Cloudflare Pages

Cloudflare Pages caps a single static asset at 25 MiB. Two things in this
project are over that on their own — `vector_estimator.onnx` alone is 244.7 MB
— so a plain `vite build` cannot ship as-is. `npm run build:cloudflare` and the
files below exist to work around that, without changing how any other host
(a VPS, Vercel, Netlify, GitHub Pages) is expected to serve this app; those
keep using `npm run build`.

**What moves off Pages' own static-asset storage, and where it goes instead:**

| File(s) | Why | Served from |
| --- | --- | --- |
| The Supertonic model bundle (`public/models/`, ~383 MB) | `vector_estimator.onnx` is 244.7 MB on its own | R2, proxied same-origin by `functions/models/[[path]].js` |
| onnxruntime-web's own WASM runtime (26.8 MB) | The threaded SIMD JSEP build — needed for both the `wasm` and `webgpu` execution providers — is just over the cap | [jsDelivr](https://www.jsdelivr.com/), pinned to the exact installed `onnxruntime-web` version |

Routing the model bundle through a same-origin Function rather than a separate
R2 custom domain matters specifically because of
`Cross-Origin-Embedder-Policy: require-corp` (see Hosting requirement above):
a cross-origin subresource needs a matching CORP or CORS header or COEP blocks
it outright, and same-origin sidesteps the question entirely. `MODEL_BASE` in
`src/services/tts/synthesis.worker.ts` is already a relative path, so nothing
in the app needed to change for this. jsDelivr already serves the WASM runtime
with `Cross-Origin-Resource-Policy: cross-origin`, so it doesn't need the same
treatment — verified byte-for-byte identical to the local install via sha256
before relying on it.

### One-time setup

```bash
npx wrangler login
npx wrangler r2 bucket create scripture-voice-models
npm run build:models   # if you haven't already — produces public/models/
npm run deploy:models  # uploads the bundle to the bucket just created
```

Then in the Cloudflare dashboard, create a Pages project connected to this
repository (or run `git push` to trigger it if already connected) with:

- **Build command:** `npm run build:cloudflare`
- **Build output directory:** `dist`
- **Settings → Functions → R2 bucket bindings:** add binding `MODELS` →
  bucket `scripture-voice-models` (must match `wrangler.toml`)

No environment variables need setting in the dashboard — `build:cloudflare`
computes the jsDelivr URL from the installed `onnxruntime-web` version itself,
so it can't drift out of sync with the bundled JS glue that talks to it.

### If the model bundle is ever updated

Re-run `npm run build:models && npm run deploy:models`. R2 keys aren't
content-hashed, so the new bundle overwrites the old one at the same paths;
Cloudflare's edge cache for `/models/*` is set `immutable, max-age=31536000`
(see `functions/models/[[path]].js`), so purge the cache for that path in the
dashboard after a re-upload, or existing visitors' browsers and Cloudflare's
edge will keep serving the previous bundle until it expires on its own.

## Architecture

- `src/services/bible/` — book catalog, text loading, offline cache
- `src/services/tts/` — Supertonic ONNX engine, chunk planning, timing, and bounded diagnostics
- `src/services/audio/` — playback controller and highlight clock
- `scripts/` — build-time data and model pipelines
- `public/bibles/` — generated per-book text, committed
- `public/models/` — generated model bundle, not committed (~383 MB fp32)

## Licensing

Application code in this repository is licensed under the
[Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution.

Bible translations (KJV, WEB, ASV) are public domain.

Supertonic model weights are distributed under **BigScience Open RAIL-M**.
Commercial use is permitted, but the license carries use-based restrictions
and distribution conditions that this application must honor — see the Model
licensing section of `walkthrough.md` and `docs/TERMS.md`.
