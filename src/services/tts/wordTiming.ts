import { WordTimestamp } from './types';
import { countWords } from '../text';

export { countWords } from '../text';

/**
 * Word timings interpolated inside a model-anchored sentence duration.
 *
 * The duration predictor returns a single scalar for the whole utterance, not
 * per-token durations (measured, not assumed — see the U11 spike). So word
 * positions within a sentence are estimated rather than observed.
 *
 * What keeps that honest is the anchoring: the engine synthesizes one sentence
 * at a time, and each sentence's start and end are exact. Error is bounded
 * inside a sentence and cannot accumulate, so a chapter never drifts however
 * long it runs — which is the half of the sync requirement that users actually
 * notice.
 *
 * Weighting is by character count because the model tokenizes per character,
 * so characters are the closest proxy available for how long a word takes.
 * Trailing punctuation gets extra weight to approximate the pause it induces.
 */

/** Extra character-equivalents charged for the pause a mark introduces. */
const PAUSE_WEIGHT: Record<string, number> = {
  ',': 2,
  ';': 3,
  ':': 3,
  '.': 4,
  '!': 4,
  '?': 4,
  '—': 3,
  '…': 4
};

export function pauseWeightOf(word: string): number {
  let extra = 0;
  for (let i = word.length - 1; i >= 0; i -= 1) {
    const weight = PAUSE_WEIGHT[word[i]];
    if (weight === undefined) break;
    extra += weight;
  }
  return extra;
}

/** Character-equivalent cost of a word, used to share out the sentence time. */
export function weightOf(word: string): number {
  // Every word costs at least one unit so a bare "I" still occupies time.
  return Math.max(1, word.replace(/\s/g, '').length) + pauseWeightOf(word);
}

/**
 * Distributes `totalSeconds` across the words of `text`.
 *
 * The returned spans are contiguous and monotonic, the first starts at 0, and
 * the last ends exactly at `totalSeconds` — so a caller can rely on the
 * sentence boundary being exact even though interior positions are estimates.
 */
export function interpolateWordTimings(text: string, totalSeconds: number, startOffset = 0): WordTimestamp[] {
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0 || !(totalSeconds > 0)) return [];

  const weights = words.map(weightOf);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  const timings: WordTimestamp[] = [];
  let elapsed = 0;

  for (let i = 0; i < words.length; i += 1) {
    const start = elapsed;
    elapsed += (weights[i] / totalWeight) * totalSeconds;
    // Pin the final end to the anchor so rounding cannot walk past it.
    const end = i === words.length - 1 ? totalSeconds : elapsed;
    timings.push({ word: words[i], start: startOffset + start, end: startOffset + end });
  }

  return timings;
}

/** Normalizes passage text exactly as splitSentences does. */
export function normalizePassageText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Splits a passage into sentences for synthesis.
 *
 * Chunking matters twice over: it bounds time-to-first-audio, and it is what
 * makes each sentence an independent timing anchor. Chapter-length utterances
 * would put every word's position at the mercy of one estimate.
 */
export function splitSentences(text: string, maxChars = 240): string[] {
  const normalized = normalizePassageText(text);
  if (normalized.length === 0) return [];

  const sentences: string[] = [];
  // Split only on sentence-final punctuation.
  //
  // An earlier version also split on colons and semicolons, reasoning that
  // Scripture uses them as breath points. It sounded broken: each fragment is
  // synthesized as a standalone utterance, so "And God said, Let there be
  // light:" got a full falling cadence and a trailing pause before "and there
  // was light." Clauses have to stay with their sentence for the model to
  // phrase them as one thought.
  const parts = normalized.split(/(?<=[.!?])\s+/);

  for (const part of parts) {
    if (part.length <= maxChars) {
      if (part.trim()) sentences.push(part.trim());
      continue;
    }
    // Over-long sentence: fall back to the weaker breaks we no longer split on
    // by default, then to hard word wrapping, so a single unpunctuated verse
    // cannot produce a minutes-long utterance.
    let buffer = '';
    for (const clause of part.split(/(?<=[;:,])\s+/)) {
      for (const word of clause.split(' ')) {
        if (buffer.length + word.length + 1 > maxChars && buffer) {
          sentences.push(buffer.trim());
          buffer = '';
        }
        buffer += (buffer ? ' ' : '') + word;
      }
    }
    if (buffer.trim()) sentences.push(buffer.trim());
  }

  return sentences;
}

/** Shifts a sentence's timings onto the passage timeline. */
export function offsetTimings(timings: WordTimestamp[], seconds: number): WordTimestamp[] {
  return timings.map((t) => ({ ...t, start: t.start + seconds, end: t.end + seconds }));
}

/**
 * Folds runs of capitals to title case for the synthesizer.
 *
 * The model reads a run of capitals as an initialism and spells it out, so the
 * KJV small-caps convention — LORD and GOD for the divine name, plus phrases
 * set in capitals like I AM THAT I AM — was narrated as "L-O-R-D". Single
 * letters are left alone so "I" and "O" keep working.
 *
 * Case-only by construction, so character and word counts are unchanged and
 * the word timings interpolated from the original text stay aligned with the
 * audio. Callers pass the displayed text through this on its way to the model
 * only; the verse on screen keeps its original capitalisation.
 */
export function softenAllCaps(text: string): string {
  return text.replace(/\p{Lu}{2,}(?:'\p{Lu}+)?/gu, (shout) => shout.charAt(0) + shout.slice(1).toLowerCase());
}
