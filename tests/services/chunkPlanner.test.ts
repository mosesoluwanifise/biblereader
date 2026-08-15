import { describe, expect, it } from 'vitest';
import { planSynthesisChunks } from '../../src/services/tts/chunkPlanner';
import { normalizePassageText } from '../../src/services/tts/wordTiming';

describe('planSynthesisChunks', () => {
  it('returns one startup chunk for a one-sentence passage', () => {
    const chunks = planSynthesisChunks('Jesus wept.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ kind: 'startup', text: 'Jesus wept.', wordOffset: 0, wordCount: 2 });
    expect(chunks[0].segments).toHaveLength(1);
  });

  it('keeps startup short and packs many short sentences for steady state', () => {
    const text = Array.from({ length: 12 }, (_, i) => `Sentence ${i} is brief.`).join(' ');
    const chunks = planSynthesisChunks(text, { startupMaxChars: 80, steadyMaxChars: 240 });
    expect(chunks[0].segments).toHaveLength(1);
    expect(chunks.slice(1).some((chunk) => chunk.segments.length > 1)).toBe(true);
    expect(chunks.length).toBeLessThan(12);
    for (const chunk of chunks.slice(1)) expect(chunk.text.length).toBeLessThanOrEqual(240);
  });

  it('wraps long unpunctuated input without losing or reordering words', () => {
    const text = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ');
    const chunks = planSynthesisChunks(text, { startupMaxChars: 60, steadyMaxChars: 150 });
    expect(chunks.flatMap((chunk) => chunk.text.split(' '))).toEqual(text.split(' '));
    expect(chunks[0].text.length).toBeLessThanOrEqual(60);
    for (const chunk of chunks.slice(1)) expect(chunk.text.length).toBeLessThanOrEqual(150);
  });

  it('covers normalized source and packed text exactly once with monotonic metadata', () => {
    const source = '  First sentence.\n\nSecond   sentence is here! Third one?  ';
    const normalized = normalizePassageText(source);
    const chunks = planSynthesisChunks(source, { startupMaxChars: 30, steadyMaxChars: 55 });

    expect(chunks.map((chunk) => chunk.text).join(' ')).toBe(normalized);
    let expectedSentence = 0;
    let expectedWord = 0;
    let expectedSourceStart = 0;
    for (const chunk of chunks) {
      expect(chunk.sourceStart).toBe(expectedSourceStart);
      expect(normalized.slice(chunk.sourceStart, chunk.sourceEnd)).toBe(chunk.text);
      expect(chunk.wordOffset).toBe(expectedWord);
      let localCursor = 0;
      for (const segment of chunk.segments) {
        expect(segment.sentenceIndex).toBe(expectedSentence++);
        expect(segment.textStart).toBe(localCursor);
        expect(segment.wordOffset).toBe(expectedWord);
        const segmentText = chunk.text.slice(segment.textStart, segment.textEnd);
        expect(segmentText.split(' ')).toHaveLength(segment.wordCount);
        localCursor = segment.textEnd + 1;
        expectedWord += segment.wordCount;
      }
      expect(chunk.wordCount).toBe(expectedWord - chunk.wordOffset);
      expectedSourceStart = chunk.sourceEnd + 1;
    }
    expect(expectedSourceStart - 1).toBe(normalized.length);
  });

  it('applies a selected-passage starting word offset', () => {
    const chunks = planSynthesisChunks('And God said. Let there be light.', { startWordOffset: 37 });
    expect(chunks[0].wordOffset).toBe(37);
    expect(chunks[0].segments[0].wordOffset).toBe(37);
    const segments = chunks.flatMap((chunk) => chunk.segments);
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i].wordOffset).toBe(segments[i - 1].wordOffset + segments[i - 1].wordCount);
    }
  });

  it('handles empty, abbreviation, and punctuation-only inputs deterministically', () => {
    expect(planSynthesisChunks('   ')).toEqual([]);
    const chunks = planSynthesisChunks('St. John met Dr. Luke. ... ! ?');
    expect(chunks.map((chunk) => chunk.text).join(' ')).toBe('St. John met Dr. Luke. ... ! ?');
    expect(chunks.flatMap((chunk) => chunk.segments).map((segment) => segment.sentenceIndex)).toEqual([
      0, 1, 2, 3, 4, 5
    ]);
  });
});
