export interface WordTimestamp {
  word: string;
  start: number; // seconds
  end: number; // seconds
}

/** Which engine tier produced a given playback session. */
export type EngineTier = 'supertonic' | 'web-speech';

export interface VoiceOption {
  id: string;
  name: string;
  description: string;
  accent?: string;
  gender?: 'male' | 'female';
}
