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

Speech runs on Supertonic ONNX in a worker. Playback waits for that engine
rather than speaking on a platform voice first, and its output is routed
through an `<audio>` element so the OS treats it as media — which is what
earns background playback and the lock-screen transport.

## Known limitations

- Background playback is verified in the browser: audio flows through the
  media element and `mediaSession.playbackState` tracks the transport. It has
  not been measured against a physically locked handset, and iOS is the
  likeliest place for it to fall short — that platform suspends Web Audio
  aggressively. If the stream route is refused, the sink falls back to the
  speakers, so audio keeps working with or without the lock-screen session.
- Narration is generated per session and the model samples from a random
  prior, so two readings of the same verse differ. Quality varies slightly
  between draws.
- Provider throughput is hardware- and browser-specific. The engine selects
  one atomic WebGPU or WASM session set, warms it before reporting ready, and
  records real synthesis production factors. No provider is described as
  universally faster.
- Playback schedules the first completed startup chunk immediately. Later
  sentences are packed into larger chunks and produced only to a 20-second
  horizon. There is no fixed six-second lead-in hiding an unsustainable
  producer; synthesis-caused underruns are measured separately from a
  suspended or interrupted audio graph, and repeated slow-production evidence
  reaches a retryable `device-too-slow` state.

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

The default Playwright project is a deterministic Chromium diagnostic smoke
and does not fetch model weights. `SUPERTONIC_QUALIFY=1` adds opt-in real-model
WebGPU, forced-WASM, and initialization-fallback projects. Their attached JSON
separates cold download/compile/warm-up evidence from warm scheduled-first-
audio gates, records percentile and continuity metrics, and never contains
Scripture text. Long-chapter qualification is separately enabled with
`SUPERTONIC_LONG=1`; until such a run completes on a named reference class,
this repository makes no zero-underrun claim for that class.

ONNX Runtime 1.18 does not expose the worker's internal `GPUDevice`, so a true
mid-session device-loss reset is a manual hardware/browser profile rather than
a fabricated unit fixture. Record the reset mechanism, retryable terminal
state, provider, and diagnostic attachment alongside the automated WebGPU
initialization-failure result.

## Model licensing

Supertonic weights are distributed under BigScience Open RAIL-M. Commercial
use is permitted, but shipping weights to the browser is Distribution under
that license and carries conditions: the license text must travel with the
weights, quantization requires a change notice, the Attachment A use
restrictions must bind end users through the application's terms, and
synthesized audio must be disclosed as machine-generated. U5 covers this.

The inference code is separate and unencumbered — the `supertonic` npm package
is MIT, and Section 4(a) exempts Complementary Material from pass-through.
