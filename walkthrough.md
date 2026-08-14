# Scripture Voice — Architecture Walkthrough

This document describes what the application actually does today. Anything not
yet built is marked as such. The V1 target is defined in
`docs/plans/2026-08-14-001-feat-scripture-voice-v1-plan.md`.

## Build status

| Area | State |
| --- | --- |
| Bible text catalog (66 books, chapter bounds) | Built |
| Test harness (Vitest + Playwright) | Built |
| Bundled Bible text (KJV / WEB / ASV) | Not built — U2 |
| Local-first text service with offline cache | Not built — U3 |
| Voice cloning removal | Not built — U4 |
| Supertonic ONNX synthesis | Not built — U5, U6, U11 |
| Word-level timing | Not built — U7 |
| Playback controller (pause/resume, auto-advance) | Broken — U8 |
| Reading position, auto-scroll | Not built — U9 |
| PWA install, offline caching, MediaSession | Broken — U10 |

## Known defects at the baseline commit

These are real and reproducible on `main` as imported. They are the reason V1
is a rebuild rather than an increment.

- `SupertonicEngine` is `window.speechSynthesis` with pitch and rate offsets.
  It performs no ONNX inference; `onnxruntime-web` is a dependency with no
  imports. The ten "preset voices" collapse onto whatever one to three voices
  the host OS provides.
- Voice cloning processes no audio. The backend assigns a UUID and stores a
  dict; cloned voices fall through to the default system voice at playback.
- Chapter text is fetched live from `bible-api.com` on every cache miss. The
  fallback path parses `data.verses` from a source that returns `data`, so it
  has never succeeded.
- Auto-advance calls `setChapter` and then invokes a `handleTogglePlay`
  captured from the previous render. It re-reads the prior chapter
  indefinitely while the UI displays the next one.
- Pause calls `speechSynthesis.cancel()`, which discards position. Resuming
  restarts the chapter.
- The play path awaits a network fetch before speaking, which severs the iOS
  user-gesture chain, so playback never starts on iOS Safari.
- The manifest references icons that do not exist in any directory, so the
  browser install gate fails and the app is not installable.
- The service worker precaches five build assets. No Bible text or model asset
  is cached, so there is no offline support.

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
