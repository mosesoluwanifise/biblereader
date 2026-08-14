import { SynthesisResult, VoiceOption } from './types';
import { interpolateWordTimings } from './wordTiming';

/**
 * Interim narration while the Supertonic bundle downloads (R22, KTD6).
 *
 * Supertonic is ~383 MB. Blocking the first play on that download leaves a new
 * reader with silence and no explanation, and a reader whose download fails or
 * whose cache was evicted with nothing at all. This tier speaks immediately
 * using the platform's own voices.
 *
 * It is deliberately not equivalent: `speechSynthesis` gives no audio buffer
 * and fires word-boundary events unreliably on mobile, so callers get
 * verse-level rather than word-level highlighting while it is active. The UI
 * labels the difference rather than pretending it is the same engine.
 */

function pickVoice(preferred: VoiceOption | null): SpeechSynthesisVoice | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return null;

  const english = voices.filter((v) => v.lang.toLowerCase().startsWith('en'));
  const pool = english.length > 0 ? english : voices;
  if (!preferred?.gender) return pool[0];

  // Best-effort gender match; the host voice set is whatever the OS provides.
  const wanted = preferred.gender === 'female' ? /female|zira|samantha|aria|jenny|victoria/i : /male|david|guy|mark|george|daniel/i;
  return pool.find((v) => wanted.test(v.name)) ?? pool[0];
}

export function isWebSpeechAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export interface SpokenHandle {
  cancel(): void;
}

/**
 * Speaks `text` and resolves when it finishes. Resolves rather than rejects on
 * cancellation so the caller's queue can move on cleanly.
 */
export function speakWithWebSpeech(
  text: string,
  voice: VoiceOption | null,
  onWord: (wordIndex: number) => void,
  estimatedDuration: number
): { done: Promise<void>; handle: SpokenHandle } {
  if (!isWebSpeechAvailable()) {
    return { done: Promise.resolve(), handle: { cancel: () => {} } };
  }

  const synth = window.speechSynthesis;
  const utterance = new SpeechSynthesisUtterance(text);
  const selected = pickVoice(voice);
  if (selected) utterance.voice = selected;
  utterance.rate = 0.95;

  const words = text.trim().split(/\s+/).filter(Boolean);
  let cancelled = false;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;

  const done = new Promise<void>((resolve) => {
    const finish = () => {
      if (fallbackTimer !== null) clearInterval(fallbackTimer);
      fallbackTimer = null;
      resolve();
    };

    let sawBoundary = false;
    utterance.onboundary = (event) => {
      if (cancelled) return;
      sawBoundary = true;
      if (fallbackTimer !== null) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
      // charIndex -> word index
      const upto = text.slice(0, event.charIndex).trim();
      const index = upto.length === 0 ? 0 : upto.split(/\s+/).length;
      onWord(Math.min(index, words.length - 1));
    };
    utterance.onend = finish;
    utterance.onerror = finish;

    synth.cancel();
    synth.speak(utterance);

    // Chrome on Android and iOS Safari frequently never fire `onboundary`.
    // Drive an estimated clock until a real boundary proves otherwise.
    const started = Date.now();
    fallbackTimer = setInterval(() => {
      if (cancelled || sawBoundary || words.length === 0) return;
      const elapsed = (Date.now() - started) / 1000;
      const spans = interpolateWordTimings(text, estimatedDuration);
      const active = spans.findIndex((s) => elapsed >= s.start && elapsed < s.end);
      if (active >= 0) onWord(active);
    }, 120);
  });

  return {
    done,
    handle: {
      cancel: () => {
        cancelled = true;
        utterance.onboundary = null;
        utterance.onend = null;
        utterance.onerror = null;
        if (fallbackTimer !== null) clearInterval(fallbackTimer);
        try {
          synth.cancel();
        } catch {
          /* already stopped */
        }
      }
    }
  };
}

/** Rough duration estimate at ~150 wpm, for driving the fallback clock. */
export function estimateDuration(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(0.4, (words / 150) * 60);
}

/** Shape-compatible result for callers that expect a SynthesisResult. */
export function webSpeechResultShape(text: string, duration: number): SynthesisResult {
  return {
    audio: new Float32Array(0),
    sampleRate: 44100,
    duration,
    words: interpolateWordTimings(text, duration)
  };
}
