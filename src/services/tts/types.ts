export interface WordTimestamp {
  word: string;
  start: number; // seconds
  end: number; // seconds
}

export interface SynthesisResult {
  audio: Float32Array;
  sampleRate: number;
  /** Actual audio length in seconds. */
  duration: number;
  /** Word spans within this utterance, starting at 0. */
  words: WordTimestamp[];
}

export interface EngineRuntimeInfo {
  provider: 'webgpu' | 'wasm';
  steps: number;
  modelVersion: string | null;
  ortVersion: string;
}

export interface PlannedChunkSegment {
  /** Index in the sentence-like segments returned by splitSentences(). */
  sentenceIndex: number;
  /** Half-open character span within the packed chunk text. */
  textStart: number;
  textEnd: number;
  /** Offset of the first word in the selected passage's global word stream. */
  wordOffset: number;
  wordCount: number;
}

export interface PlannedSynthesisChunk {
  kind: 'startup' | 'steady';
  text: string;
  /** Half-open character span within the normalized selected source text. */
  sourceStart: number;
  sourceEnd: number;
  wordOffset: number;
  wordCount: number;
  segments: PlannedChunkSegment[];
}

export interface VoiceOption {
  id: string;
  name: string;
  description: string;
  accent?: string;
  gender?: 'male' | 'female';
}
