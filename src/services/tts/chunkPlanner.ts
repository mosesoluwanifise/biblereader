import type { PlannedChunkSegment, PlannedSynthesisChunk } from './types';
import { countWords, normalizePassageText, splitSentences } from './wordTiming';

export interface ChunkPlanningOptions {
  /** Maximum size of the first latency-oriented segment. */
  startupMaxChars?: number;
  /** Maximum size of each packed steady-state chunk. */
  steadyMaxChars?: number;
  /** Word index of the selected text within its containing passage. */
  startWordOffset?: number;
}

const DEFAULT_STARTUP_MAX_CHARS = 120;
const DEFAULT_STEADY_MAX_CHARS = 280;

interface SourceSegment {
  sentenceIndex: number;
  text: string;
  sourceStart: number;
  sourceEnd: number;
  wordOffset: number;
  wordCount: number;
}

/**
 * Plans synthesis without performing inference or estimating audio timings.
 *
 * The first sentence-like segment is kept alone to minimize time to first
 * audio. Remaining adjacent segments are packed to amortize inference while
 * retaining enough metadata to allocate sentence timings after synthesis.
 */
export function planSynthesisChunks(
  text: string,
  options: ChunkPlanningOptions = {}
): PlannedSynthesisChunk[] {
  const startupMaxChars = positiveInteger(options.startupMaxChars, DEFAULT_STARTUP_MAX_CHARS);
  const steadyMaxChars = positiveInteger(options.steadyMaxChars, DEFAULT_STEADY_MAX_CHARS);
  const startWordOffset = nonNegativeInteger(options.startWordOffset, 0);
  const normalized = normalizePassageText(text);
  if (!normalized) return [];

  // The startup ceiling also bounds the sentence-like primitives. Steady-state
  // packing then joins adjacent primitives up to its larger ceiling.
  const sentences = splitSentences(normalized, Math.min(startupMaxChars, steadyMaxChars));
  const segments = locateSourceSegments(normalized, sentences, startWordOffset);
  if (segments.length === 0) return [];

  const chunks: PlannedSynthesisChunk[] = [buildChunk('startup', [segments[0]])];
  let packed: SourceSegment[] = [];
  let packedLength = 0;

  for (const segment of segments.slice(1)) {
    const nextLength = packedLength + (packed.length > 0 ? 1 : 0) + segment.text.length;
    if (packed.length > 0 && nextLength > steadyMaxChars) {
      chunks.push(buildChunk('steady', packed));
      packed = [];
      packedLength = 0;
    }
    packed.push(segment);
    packedLength += (packed.length > 1 ? 1 : 0) + segment.text.length;
  }

  if (packed.length > 0) chunks.push(buildChunk('steady', packed));
  return chunks;
}

function locateSourceSegments(
  normalized: string,
  sentences: string[],
  startWordOffset: number
): SourceSegment[] {
  const result: SourceSegment[] = [];
  let sourceCursor = 0;
  let wordCursor = startWordOffset;

  for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex += 1) {
    const sentence = sentences[sentenceIndex];
    const sourceStart = normalized.indexOf(sentence, sourceCursor);
    if (sourceStart < 0) {
      throw new Error('Sentence splitter output could not be mapped back to normalized source text');
    }
    const wordCount = countWords(sentence);
    result.push({
      sentenceIndex,
      text: sentence,
      sourceStart,
      sourceEnd: sourceStart + sentence.length,
      wordOffset: wordCursor,
      wordCount
    });
    sourceCursor = sourceStart + sentence.length;
    wordCursor += wordCount;
  }

  return result;
}

function buildChunk(kind: PlannedSynthesisChunk['kind'], sourceSegments: SourceSegment[]): PlannedSynthesisChunk {
  let text = '';
  const segments: PlannedChunkSegment[] = [];

  for (const source of sourceSegments) {
    if (text) text += ' ';
    const textStart = text.length;
    text += source.text;
    segments.push({
      sentenceIndex: source.sentenceIndex,
      textStart,
      textEnd: text.length,
      wordOffset: source.wordOffset,
      wordCount: source.wordCount
    });
  }

  const first = sourceSegments[0];
  const last = sourceSegments[sourceSegments.length - 1];
  return {
    kind,
    text,
    sourceStart: first.sourceStart,
    sourceEnd: last.sourceEnd,
    wordOffset: first.wordOffset,
    wordCount: sourceSegments.reduce((total, segment) => total + segment.wordCount, 0),
    segments
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : Math.max(1, Math.floor(value));
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : Math.max(0, Math.floor(value));
}
