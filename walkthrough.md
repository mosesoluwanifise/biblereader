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
| Supertonic ONNX synthesis | Built |
| Word-level timing | Built |
| Playback controller (pause/resume, auto-advance) | Built |
| Reading position, auto-scroll, settings | Built |
| PWA install, offline caching, MediaSession | Built |

Speech runs on Supertonic ONNX in a worker, with `window.speechSynthesis`
as a labelled interim tier while the model downloads.

Two books are missing from the bundled text: Obadiah (KJV) and Psalms and
Obadiah (WEB). Requesting them blocked the upstream source; they need a
refetch once that lifts. Those passages show a retryable error rather than
wrong text.

## Known limitations

- iOS suspends Web Audio when the screen locks, so lock-screen controls work
  while the app is foregrounded but playback still stops on lock. Routing
  output through an `<audio>` element would fix it.
- Narration is generated per session and the model samples from a random
  prior, so two readings of the same verse differ. Quality varies slightly
  between draws.
- Synthesis runs at roughly 1.3x realtime on four WASM threads. Slower
  devices will fall behind and lean on the interim tier.
- Obadiah (KJV) and Psalms and Obadiah (WEB) are absent pending a refetch.

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

Text ships as bundled per-book JSON under
`public/bibles/{translation}/{book}.json`, generated once by
`scripts/build-bible-data.mjs` from `bible-api.com` and committed.

The source changed mid-project: the original one inlined translator footnotes
into the verse text with no separate field, contaminating 18.8% of KJV verses.
In WEB the notes are spliced mid-sentence with no delimiter, so no reliable
strip is possible without risking truncated Scripture. The ingest now rejects
footnote markers, replacement characters, and lone surrogates outright, and
the same checks run against cached files so a stale build is rebuilt rather
than skipped.

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
