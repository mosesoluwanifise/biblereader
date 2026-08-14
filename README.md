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
| `npm run build:bible` | Generate `public/bibles/` from the upstream text source |
| `npm run build:models` | Download, quantize, and license the Supertonic model bundle |

Playwright needs its browsers once before `test:e2e`:

```bash
npx playwright install
```

## Architecture

- `src/services/bible/` — book catalog, text loading, offline cache
- `src/services/tts/` — Supertonic ONNX engine, word timing, Web Speech fallback
- `src/services/audio/` — playback controller and highlight clock
- `scripts/` — build-time data and model pipelines
- `public/bibles/` — generated per-book text, committed
- `public/models/` — generated model bundle, not committed (~138 MB)

## Licensing

Application code in this repository is the project's own.

Bible translations (KJV, WEB, ASV) are public domain.

Supertonic model weights are distributed under **BigScience Open RAIL-M**.
Commercial use is permitted, but the license carries use-based restrictions
and distribution conditions that this application must honor — see the Model
licensing section of `walkthrough.md` and `docs/TERMS.md`.
