export interface WordTimestamp {
  word: string;
  start: number; // in seconds
  end: number;   // in seconds
}

export interface VoiceOption {
  id: string;
  name: string;
  description: string;
  isCloned: boolean;
  accent?: string;
  gender?: 'male' | 'female';
  previewUrl?: string;
}

export interface TTSStreamResult {
  audioUrl: string;
  timestamps: WordTimestamp[];
  engine: 'supertonic' | 'pocket-tts';
}
