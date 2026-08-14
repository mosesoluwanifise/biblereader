# Scripture Voice — Architecture Walkthrough

This document describes what the application actually does today. Anything not
yet built is marked as such. The V1 target is defined in
`docs/plans/2026-08-14-001-feat-scripture-voice-v1-plan.md`.

## Build status

| Area | State |
| --- | --- |
| Bible text catalog (66 books, chapter bounds) | Built |
| Test harness (Vitest + Playwright) | Built |
| Bundled Bible text (KJV / WEB / ASV) | Built |
| Local-first text service with offline cache | Built |
| Voice cloning removal | Done |
| Supertonic ONNX synthesis | Not built — U11, U5, U6 |
| Word-level timing | Not built — U7 |
| Playback controller (pause/resume, auto-advance) | Broken — U8 |
| Reading position, auto-scroll | Not built — U9 |
| PWA install, offline caching, MediaSession | Broken — U10 |

Speech still runs on `window.speechSynthesis`. Until U6 lands, the
playback defects listed below are live.

## Defects still open

- `SupertonicEngine` is `window.speechSynthesis` with pitch and rate offsets.
  It performs no ONNX inference. The ten "preset voices" collapse onto
  whatever one to three voices the host OS provides. U6 replaces this with
  real inference over the ten shipped voice styles.
- Auto-advance sets the next chapter and then invokes a `handleTogglePlay`
  captured from the previous render, so it replays the prior chapter while the
  UI shows the next one. U8 replaces the timer with effect-driven advance.
- Pause calls `speechSynthesis.cancel()`, which discards position. Resuming
  restarts the chapter. U8.
- The play path awaits chapter text before speaking, severing the iOS
  user-gesture chain, so playback never starts on iOS Safari. U8.
- The manifest references icons that exist in no directory, so the browser
  install gate fails and the app is not installable. U10.
- The service worker precaches five build assets and no Bible text, so the
  offline guarantee depends entirely on the IndexedDB layer today. U10.

## Defects fixed

- Chapter text was fetched live from `bible-api.com` on every cache miss, and
  its fallback parsed `data.verses` from a source that returns `data` — that
  path had never once succeeded. Text now loads from bundled assets.
- Load failure returned an empty array, which the reader rendered as a blank
  screen indistinguishable from a real empty chapter. Failure is now a typed
  result with a visible, retryable error state.
- Chapter advance dead-ended at the last chapter of every book instead of
  crossing into the next one.
- The upstream text source emits every verse twice. Ingest deduplicates, and
  fails loudly if duplicate rows ever disagree.

## Bible text

`src/services/bible/bibleService.ts` holds the complete 66-book catalog with
per-book chapter counts, split by testament for navigation. That catalog is
correct and is the validation oracle for the U2 ingest pipeline.

Text delivery is being moved from live API calls to bundled per-book JSON
under `public/bibles/{translation}/{book}.json`, generated once by
`scripts/build-bible-data.mjs` from `wldeh/bible-api` and committed to the
repository. See KTD1 and KTD2 in the V1 plan for why that source and that
packaging.

## Testing

Two tiers, because one does not cover this application:

- **Vitest** (`vitest.config.ts`, jsdom) for pure logic — text normalization,
  caching, timing math, reducers.
- **Playwright** (`playwright.config.ts`) for anything needing a real browser:
  audio output, WebGPU versus WASM execution-provider selection, service
  worker behavior, and the PWA install gate. `onnxruntime-web` does not run
  meaningfully under jsdom.

## Model licensing

Supertonic weights are distributed under BigScience Open RAIL-M. Commercial
use is permitted, but shipping weights to the browser is Distribution under
that license and carries conditions: the license text must travel with the
weights, quantization requires a change notice, the Attachment A use
restrictions must bind end users through the application's terms, and
synthesized audio must be disclosed as machine-generated. U5 covers this.

The inference code is separate and unencumbered — the `supertonic` npm package
is MIT, and Section 4(a) exempts Complementary Material from pass-through.
