import { describe, it, expect } from 'vitest';
import {
  interpolateWordTimings,
  splitSentences,
  weightOf,
  pauseWeightOf,
  offsetTimings
} from '../../src/services/tts/wordTiming';

describe('interpolateWordTimings', () => {
  it('produces one span per word', () => {
    const t = interpolateWordTimings('In the beginning God created', 5);
    expect(t.map((w) => w.word)).toEqual(['In', 'the', 'beginning', 'God', 'created']);
  });

  it('anchors the first span at zero and the last at the model duration', () => {
    // This is the property that stops a chapter drifting: every sentence ends
    // exactly where the model said it would, so error cannot accumulate.
    const total = 4.437;
    const t = interpolateWordTimings('In the beginning God created the heaven and the earth.', total);
    expect(t[0].start).toBe(0);
    expect(t.at(-1)!.end).toBe(total);
  });

  it('produces contiguous, monotonically increasing spans', () => {
    const t = interpolateWordTimings('The LORD is my shepherd; I shall not want.', 6);
    for (let i = 0; i < t.length; i += 1) {
      expect(t[i].end).toBeGreaterThan(t[i].start);
      if (i > 0) expect(t[i].start).toBeCloseTo(t[i - 1].end, 10);
    }
  });

  it('gives longer words more time than shorter ones', () => {
    const [a, , c] = interpolateWordTimings('I am extraordinarily', 3);
    const short = a.end - a.start;
    const long = c.end - c.start;
    expect(long).toBeGreaterThan(short);
  });

  it('charges trailing punctuation extra time for its pause', () => {
    const plain = interpolateWordTimings('light light', 2);
    const punctuated = interpolateWordTimings('light. light', 2);
    // The first word carries a period, so it should occupy more of the budget.
    expect(punctuated[0].end).toBeGreaterThan(plain[0].end);
  });

  it('applies a start offset without changing span widths', () => {
    const base = interpolateWordTimings('one two three', 3);
    const shifted = interpolateWordTimings('one two three', 3, 10);
    expect(shifted[0].start).toBe(10);
    expect(shifted.at(-1)!.end).toBe(13);
    for (let i = 0; i < base.length; i += 1) {
      expect(shifted[i].end - shifted[i].start).toBeCloseTo(base[i].end - base[i].start, 10);
    }
  });

  it('returns nothing for empty text or a non-positive duration', () => {
    expect(interpolateWordTimings('', 5)).toEqual([]);
    expect(interpolateWordTimings('   ', 5)).toEqual([]);
    expect(interpolateWordTimings('word', 0)).toEqual([]);
    expect(interpolateWordTimings('word', -1)).toEqual([]);
  });

  it('handles a single word by giving it the whole duration', () => {
    const t = interpolateWordTimings('Selah', 1.25);
    expect(t).toHaveLength(1);
    expect(t[0].start).toBe(0);
    expect(t[0].end).toBe(1.25);
  });

  it('covers the full duration with no gaps, whatever the text', () => {
    const total = 9.5;
    const t = interpolateWordTimings('And God said, Let there be light: and there was light.', total);
    const covered = t.reduce((sum, w) => sum + (w.end - w.start), 0);
    expect(covered).toBeCloseTo(total, 6);
  });
});

describe('weightOf', () => {
  it('charges at least one unit so a single-letter word still takes time', () => {
    expect(weightOf('I')).toBeGreaterThanOrEqual(1);
  });

  it('counts pause weight only for trailing marks', () => {
    expect(pauseWeightOf('word')).toBe(0);
    expect(pauseWeightOf('word,')).toBeGreaterThan(0);
    expect(pauseWeightOf('word.')).toBeGreaterThan(pauseWeightOf('word,'));
    // A mid-word apostrophe is not a pause.
    expect(pauseWeightOf("God's")).toBe(0);
  });
});

describe('splitSentences', () => {
  it('splits on sentence-ending punctuation', () => {
    const s = splitSentences('In the beginning God created. And the earth was void. And God said.');
    expect(s).toHaveLength(3);
    expect(s[0]).toBe('In the beginning God created.');
  });

  it('keeps clauses with their sentence rather than splitting on ; or :', () => {
    // Splitting here used to sound broken: each fragment is synthesized as a
    // standalone utterance, so "Let there be light:" got a full falling cadence
    // and a trailing pause before "and there was light."
    expect(splitSentences('The LORD is my shepherd; I shall not want.')).toEqual([
      'The LORD is my shepherd; I shall not want.'
    ]);
    expect(splitSentences('And God said, Let there be light: and there was light.')).toEqual([
      'And God said, Let there be light: and there was light.'
    ]);
  });

  it('still uses weaker breaks when a sentence exceeds the cap', () => {
    const long = `${'word '.repeat(30).trim()}; ${'other '.repeat(30).trim()}.`;
    const parts = splitSentences(long, 100);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(100);
  });

  it('keeps every chunk within the length cap', () => {
    // A long unpunctuated verse must not become one enormous utterance —
    // that would put every word at the mercy of a single duration estimate.
    const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
    const s = splitSentences(long, 100);
    expect(s.length).toBeGreaterThan(1);
    for (const chunk of s) expect(chunk.length).toBeLessThanOrEqual(100);
  });

  it('loses no words when wrapping a long clause', () => {
    const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ');
    const rejoined = splitSentences(long, 80).join(' ');
    expect(rejoined.split(/\s+/)).toHaveLength(60);
  });

  it('normalizes whitespace and drops empty input', () => {
    expect(splitSentences('  ')).toEqual([]);
    expect(splitSentences('a   b\n\nc')).toEqual(['a b c']);
  });

  it('preserves the full text across the split', () => {
    const text = 'And God saw the light, that it was good: and God divided the light from the darkness.';
    const joined = splitSentences(text).join(' ');
    expect(joined.replace(/\s+/g, ' ')).toBe(text);
  });
});

describe('alignment against padded audio', () => {
  it('places every word inside the speech, not the model padding', () => {
    // The model returns ~0.5s of silence before speech and ~0.6s after. Spans
    // interpolated across the whole buffer put the highlight ahead of the
    // voice at the start and behind it at the end — 12-17% of every sentence.
    const buffer = 3.52;
    const speechStart = 0.4;
    const speechDuration = 2.59;

    const spans = interpolateWordTimings(
      'In the beginning God created the heaven and the earth.',
      speechDuration,
      speechStart
    );

    expect(spans[0].start).toBeCloseTo(speechStart, 6);
    expect(spans.at(-1)!.end).toBeCloseTo(speechStart + speechDuration, 6);

    // Nothing may spill into either silence.
    for (const span of spans) {
      expect(span.start).toBeGreaterThanOrEqual(speechStart - 1e-9);
      expect(span.end).toBeLessThanOrEqual(speechStart + speechDuration + 1e-9);
      expect(span.end).toBeLessThan(buffer);
    }
  });

  it('leaves no word highlighted before the first sound', () => {
    const spans = interpolateWordTimings('Jesus wept.', 1.2, 0.45);
    expect(spans[0].start).toBeGreaterThan(0);
    expect(spans[0].start).toBeCloseTo(0.45, 6);
  });
});

describe('offsetTimings', () => {
  it('shifts a sentence onto the passage timeline', () => {
    const shifted = offsetTimings(interpolateWordTimings('one two', 2), 5);
    expect(shifted[0].start).toBe(5);
    expect(shifted.at(-1)!.end).toBe(7);
  });
});

describe('sentence anchoring across a passage', () => {
  it('accumulates no drift over many sentences', () => {
    // The core claim behind KTD5's fallback: because each sentence is anchored
    // by its own model-predicted duration, the end of sentence N is exact
    // regardless of how approximate the word positions inside it were.
    const durations = [4.437, 8.268, 1.362, 13.585, 2.9];
    const texts = [
      'In the beginning God created the heaven and the earth.',
      'And God said, Let there be light and there was light.',
      'Jesus wept.',
      'The LORD is my shepherd I shall not want he maketh me to lie down.',
      'And it was so.'
    ];

    let clock = 0;
    for (let i = 0; i < texts.length; i += 1) {
      const spans = offsetTimings(interpolateWordTimings(texts[i], durations[i]), clock);
      expect(spans[0].start).toBeCloseTo(clock, 9);
      clock += durations[i];
      expect(spans.at(-1)!.end).toBeCloseTo(clock, 9);
    }

    expect(clock).toBeCloseTo(durations.reduce((a, b) => a + b, 0), 9);
  });
});
