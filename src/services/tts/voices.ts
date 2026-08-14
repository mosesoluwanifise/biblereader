import { VoiceOption } from './types';

/**
 * The ten voice styles actually shipped in the Supertonic bundle.
 *
 * These replace the ten fabricated presets the prototype advertised — names
 * like "David (Narrative Male)" that all collapsed onto whatever one to three
 * voices the host OS happened to provide. Each id here corresponds to a real
 * style embedding file in the model bundle.
 *
 * Descriptions characterise the style; they do not promise a named persona.
 */
export const PRESET_VOICES: VoiceOption[] = [
  { id: 'F1', name: 'Clara', description: 'Warm female narration, even pacing', gender: 'female' },
  { id: 'F2', name: 'Miriam', description: 'Bright female voice, lighter tone', gender: 'female' },
  { id: 'F3', name: 'Naomi', description: 'Measured female voice for poetry and wisdom', gender: 'female' },
  { id: 'F4', name: 'Tabitha', description: 'Soft female voice, gentle delivery', gender: 'female' },
  { id: 'F5', name: 'Dorcas', description: 'Fuller female voice, deliberate pace', gender: 'female' },
  { id: 'M1', name: 'Silas', description: 'Warm male narration, even pacing', gender: 'male' },
  { id: 'M2', name: 'Amos', description: 'Deeper male voice for narrative and history', gender: 'male' },
  { id: 'M3', name: 'Josiah', description: 'Clear male voice, brisker pace', gender: 'male' },
  { id: 'M4', name: 'Ezra', description: 'Resonant male voice, unhurried', gender: 'male' },
  { id: 'M5', name: 'Boaz', description: 'Low male voice for prophets and epistles', gender: 'male' }
];

export const DEFAULT_VOICE_ID = 'M1';

export function findVoice(id: string): VoiceOption {
  return PRESET_VOICES.find((v) => v.id === id) ?? PRESET_VOICES.find((v) => v.id === DEFAULT_VOICE_ID)!;
}
