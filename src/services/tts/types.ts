export interface WordTimestamp {
  word: string;
  start: number; // seconds
  end: number; // seconds
}

/** Which engine tier produced a given playback session. */
export type EngineTier = 'supertonic' | 'web-speech';

export interface SynthesisResult {
  audio: Float32Array;
  sampleRate: number;
  /** Actual audio length in seconds. */
  duration: number;
  /** Word spans within this utterance, starting at 0. */
  words: WordTimestamp[];
}

export interface VoiceOption {
  id: string;
  name: string;
  description: string;
  accent?: string;
  gender?: 'male' | 'female';
}
