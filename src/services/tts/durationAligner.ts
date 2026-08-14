import { WordTimestamp } from './types';
import { splitIntoWords } from '../bible/bibleService';

/**
 * Estimates word-level start and end timestamps based on speech rate and character distribution.
 * Used for Supertonic preset voices running in-browser when exact tensor duration outputs are mapped.
 */
export function generateEstimatedTimestamps(text: string, totalDurationSeconds: number): WordTimestamp[] {
  const words = splitIntoWords(text);
  if (words.length === 0 || totalDurationSeconds <= 0) return [];

  // Calculate total character weight (longer words get proportionally longer duration)
  const totalChars = words.reduce((sum, w) => sum + w.word.replace(/\s/g, '').length, 0);
  
  let currentTime = 0;
  const timestamps: WordTimestamp[] = [];

  for (let i = 0; i < words.length; i++) {
    const charCount = words[i].word.replace(/\s/g, '').length || 1;
    const wordDuration = (charCount / totalChars) * totalDurationSeconds;
    const start = Math.round(currentTime * 1000) / 1000;
    const end = Math.round((currentTime + wordDuration) * 1000) / 1000;

    timestamps.push({
      word: words[i].word,
      start,
      end
    });

    currentTime += wordDuration;
  }

  return timestamps;
}
