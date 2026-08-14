---
date: 2026-08-13
topic: bible-voice-reader
---

## Summary

A commercial Progressive Web App that reads the Bible aloud using voice cloning — users upload a short audio clip and hear Scripture in their own voice or a loved one's voice, with word-by-word text highlighting synced to the audio. Ships with curated preset voices on a free tier and gates voice cloning behind a paid subscription.

---

## Problem Frame

People who want to hear Scripture read aloud today choose between robotic built-in TTS or pre-recorded audiobooks narrated by strangers. Neither delivers the intimacy of hearing a familiar voice — a parent who passed away, a spouse, a pastor, one's own voice — reading the words. The emotional gap between "a narrator reads the Bible to me" and "my grandmother reads the Bible to me" is the entire product.

Existing Bible apps with audio features (YouVersion, Bible Gateway, Dwell) offer professional narrations but no personalization. Voice cloning technology is now good enough and cheap enough to close this gap, but no Bible-focused product has connected the two.

---

## Key Decisions

**Hybrid dual-engine TTS architecture.** Preset voices run in-browser via Supertonic (ONNX/WebGPU), costing zero server compute. Voice cloning runs server-side via Pocket TTS (Kyutai, MIT) on standard CPU instances. Both engines are permissively licensed (MIT) and run without GPUs.

**Supertonic for preset voices (in-browser).** The Supertonic ONNX models (99M params, 44.1kHz, 31 languages) run in-browser via `@supertone/supertonic-web` using WebGPU/WASM. No server infrastructure is needed for free-tier playback.

**Pocket TTS for voice cloning (server-side CPU, MIT).** Pocket TTS by Kyutai Labs is a 100M-parameter model designed specifically for CPU inference. It performs zero-shot voice cloning from a 5-second sample at ~6x real-time speed on CPU with ~200ms time-to-first-audio. This eliminates the need for expensive GPU servers, allowing the backend to run on standard low-cost CPU VPS instances ($5–$20/mo). Word-level timestamps come from WhisperX forced alignment on CPU.

**Server-side CPU backend for cloned voices only.** The backend handles voice cloning enrollment, Pocket TTS synthesis, and WhisperX alignment. Because preset voice playback is entirely client-side, server load is low and cheap to scale.

**Public domain Bible translations only.** KJV, WEB (World English Bible), and ASV avoid licensing fees and legal complexity.

**Freemium monetization.** Preset voices are free and run on-device. Voice cloning requires a paid subscription, which easily covers the minimal CPU server costs.

---

## Actors

- A1. **Reader** — a person who wants to listen to Bible passages in a personalized voice. May be free-tier (preset voices) or paid (voice cloning).
- A2. **Voice Donor** — the person whose voice is cloned. May be the Reader themselves or someone else (a loved one, a pastor). Provides a short audio reference clip.
- A3. **TTS Server** — the backend service that runs voice cloning enrollment, Pocket TTS synthesis on CPU, and WhisperX alignment. Not involved in preset voice playback.
- A4. **Browser TTS Engine** — the Supertonic ONNX model running in the user's browser via WebGPU/WASM. Handles all preset voice synthesis on-device.

---

## Requirements

**Core reading experience**

- R1. The app displays Bible text organized by book, chapter, and verse, with navigation to any passage.
- R2. Audio playback highlights each word in the displayed text as it is spoken, synchronized to the TTS output's word-level timestamps.
- R3. The user can play, pause, and resume audio at any point within a chapter.
- R4. The app supports continuous playback across chapters within a book (auto-advance).

**Voice selection and cloning**

- R5. The app ships with at least 3 curated preset voices (varying in gender, tone, and pacing) available to all users at no cost, synthesized on-device via Supertonic.
- R6. Paid users can create a custom cloned voice by uploading a short audio reference clip (5–30 seconds of clear speech).
- R7. The app stores each user's cloned voice profile server-side and associates it with their account.
- R8. Users can switch between preset voices (on-device) and their cloned voices (server-streamed) at any time during a reading session.
- R9. Users can delete their cloned voice and its source audio at any time, revoking access immediately and purging server storage within 24 hours.

**Bible content**

- R10. The app includes at least three public domain translations at launch: KJV, WEB, and ASV.
- R11. The user can switch translations without losing their reading position.

**Platform and installation**

- R12. The app is a Progressive Web App installable on mobile (iOS, Android) and desktop (Windows, macOS, Linux) from the browser.
- R13. The app works in modern browsers (Chrome, Safari, Firefox, Edge) using WebGPU where available, with automatic WebAssembly (WASM) fallback for browsers without WebGPU support.

**Privacy and data handling**

- R14. Voice reference audio uploaded for cloning is used only to generate the user's voice profile and is not shared with third parties.
- R15. Users are informed before upload about what data is collected, how it is used, and how to delete it.

**Monetization**

- R16. Free-tier users access all Bible text and preset voices without payment.
- R17. Voice cloning requires an active paid subscription.

---

## Key Flows

- F1. First-time reading (preset voice, on-device)
  - **Trigger:** Reader opens the app for the first time.
  - **Actors:** A1, A4
  - **Steps:** Reader sees an onboarding screen introducing voice selection. The Supertonic ONNX model downloads in the background (~100-200MB, cached after first load). Reader picks a preset voice. Reader navigates to a Bible passage. Reader taps play. Supertonic synthesizes audio on-device. Text highlights word-by-word in sync.
  - **Covered by:** R1, R2, R3, R5

- F2. Voice cloning setup
  - **Trigger:** Paid user wants to hear Scripture in a custom voice.
  - **Actors:** A1, A2, A3
  - **Steps:** Reader navigates to voice settings. Reader selects "Clone a voice." App displays privacy disclosure and recording instructions. Reader uploads an audio clip (or records one in-app). App sends the clip to the TTS Server. Server processes the clip and returns a voice profile. Reader can now select the cloned voice for playback.
  - **Covered by:** R6, R7, R14, R15

- F3. Reading session with cloned voice
  - **Trigger:** Reader selects a cloned voice and navigates to a passage.
  - **Actors:** A1, A3
  - **Steps:** Reader taps play. PWA sends text to TTS Server with the user's voice profile. Server returns audio stream with word-level timestamps. PWA plays audio and highlights text in sync. At chapter end, auto-advances to the next chapter if continuous playback is enabled.
  - **Covered by:** R2, R3, R4, R8

- F4. Voice deletion
  - **Trigger:** Reader wants to remove their cloned voice.
  - **Actors:** A1, A3
  - **Steps:** Reader navigates to voice settings. Reader selects "Delete voice." App confirms the action. Server deletes the voice profile and source audio. Reader's voice selection reverts to a preset voice.
  - **Covered by:** R9

---

## Acceptance Examples

- AE1. **Word sync accuracy** — Covers R2. Given a chapter of 30 verses playing in a cloned voice, the highlighted word stays within ±150ms of the spoken audio throughout the passage, with no visible drift by the end of the chapter.

- AE2. **Voice cloning from short clip** — Covers R6. Given a 15-second recording of clear English speech, the server produces a voice profile that generates recognizable output within 60 seconds of upload. The generated speech is intelligible and tonally consistent across a full chapter reading.

- AE3. **Preset voice playback without account** — Covers R5, R16. A user who has not created an account can select a preset voice, navigate to Genesis 1, tap play, and hear the chapter read aloud with word highlighting — no paywall, no sign-up gate, no server round-trip. Audio is synthesized entirely on-device by Supertonic.

- AE4. **Voice deletion is complete** — Covers R9, R14. After a user deletes their cloned voice, access is revoked immediately and the source audio file and derived voice profile are removed from server storage within 24 hours. Subsequent playback requests for that voice return an error, and the app gracefully falls back to a preset voice.

- AE5. **Translation switching preserves position** — Covers R11. Given a user reading John 3:16 in KJV, when they switch translation to WEB, the app updates the displayed text to John 3:16 in WEB and maintains the active audio playback or cursor position.

---

## Success Criteria

- Word-level highlight sync is perceptually accurate (no visible drift over a full chapter).
- Voice cloning produces recognizable output from a 5–30 second reference clip.
- Real-time synthesis latency is under 3 seconds from play-tap to first audio (on a stable connection).
- The app scores 90+ on Lighthouse PWA audit.
- Free-tier users can read and listen indefinitely without hitting artificial limits on preset voice playback.

---

## Scope Boundaries

**Deferred for later**

- Reading plans and devotionals
- Bookmarks, highlights, and personal notes
- Search across Bible text
- Offline playback (requires caching generated audio)
- Multiple cloned voices per account
- Social features (sharing passages, group reading)
- Additional paid translations (NIV, ESV, etc.)

**Outside this product's identity**

- Bible study tools (commentary, cross-references, concordance)
- AI-generated Bible summaries or explanations
- Community/social network features
- Video or animated content

---

## Dependencies / Assumptions

- Supertonic ONNX models (~100-200MB) must be downloaded and cached in the browser on first use. Subsequent visits load from cache.
- Supertonic does not natively expose word-level timestamps via its web API. Word-level timing for preset voices must be derived from the duration predictor's intermediate tensor outputs or estimated from phoneme durations.
- Pocket TTS (100M params) runs efficiently on standard CPU hardware without GPU acceleration.
- Chatterbox / Pocket TTS do not emit word-level timestamps natively. WhisperX forced alignment provides word-level timing for cloned voice audio as a server-side post-processing step on CPU.
- Standard CPU server infrastructure ($5–$20/mo instances) is sufficient for paid-tier voice cloning — no expensive GPU hosting required.
- Public domain Bible text is available in a structured, verse-indexed format (e.g., from open APIs or static JSON datasets).
- Browser support for WebGPU is required for optimal Supertonic performance. WASM fallback is available but slower. WebGPU is supported in Chrome, Edge, and Safari (2025+); Firefox support is experimental.

---

## Outstanding Questions

**Deferred to planning**

- What CPU server hosting provider and instance specs (vCPU count, RAM) deliver optimal throughput for concurrent Pocket TTS requests?
- How should the Supertonic ONNX model download be handled UX-wise (progress bar, background download, lazy load on first play)?
- Can Supertonic's duration predictor tensor outputs be exposed via `onnxruntime-web` to derive word-level timing, or is phoneme-duration estimation sufficient for perceptual sync?
- What subscription price point and tier structure balances accessibility with server cost recovery?
- Should the app support in-app voice recording, or require users to upload a pre-recorded file?
