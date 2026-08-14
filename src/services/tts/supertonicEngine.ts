import { VoiceOption } from './types';

export const PRESET_VOICES: VoiceOption[] = [
  {
    id: 'supertonic-david',
    name: 'David (Narrative Male)',
    description: 'Warm, resonant male voice for narrative Scripture',
    isCloned: false,
    gender: 'male',
    accent: 'American'
  },
  {
    id: 'supertonic-hannah',
    name: 'Hannah (Gentle Female)',
    description: 'Clear, soft female voice with natural cadence',
    isCloned: false,
    gender: 'female',
    accent: 'American'
  },
  {
    id: 'supertonic-samuel',
    name: 'Samuel (Reverent Male)',
    description: 'Deep, solemn male voice for Psalms & Wisdom',
    isCloned: false,
    gender: 'male',
    accent: 'British'
  },
  {
    id: 'supertonic-ruth',
    name: 'Ruth (Solemn Female)',
    description: 'Reverent British female voice for poetry',
    isCloned: false,
    gender: 'female',
    accent: 'British'
  },
  {
    id: 'supertonic-solomon',
    name: 'Solomon (Majestic Bass)',
    description: 'Deep bass male voice for Old Testament books',
    isCloned: false,
    gender: 'male',
    accent: 'American'
  },
  {
    id: 'supertonic-esther',
    name: 'Esther (Graceful Female)',
    description: 'Clear, compassionate female narration',
    isCloned: false,
    gender: 'female',
    accent: 'American'
  },
  {
    id: 'supertonic-elijah',
    name: 'Elijah (Prophetic Male)',
    description: 'Strong, authoritative male voice for Prophets',
    isCloned: false,
    gender: 'male',
    accent: 'American'
  },
  {
    id: 'supertonic-mary',
    name: 'Mary (Devotional Female)',
    description: 'Warm, contemplative female voice for Gospels',
    isCloned: false,
    gender: 'female',
    accent: 'American'
  },
  {
    id: 'supertonic-paul',
    name: 'Paul (Apostolic Male)',
    description: 'Direct, persuasive male voice for Epistles',
    isCloned: false,
    gender: 'male',
    accent: 'British'
  },
  {
    id: 'supertonic-lydia',
    name: 'Lydia (Peaceful Female)',
    description: 'Calming, serene female voice for peaceful meditation',
    isCloned: false,
    gender: 'female',
    accent: 'American'
  }
];

export class SupertonicEngine {
  private activeUtterance: SpeechSynthesisUtterance | null = null;
  private availableVoices: SpeechSynthesisVoice[] = [];
  private isPlaying: boolean = false;

  constructor() {
    this.initVoices();
  }

  private initVoices(): void {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      const load = () => {
        this.availableVoices = window.speechSynthesis.getVoices();
      };
      load();
      window.speechSynthesis.onvoiceschanged = load;
    }
  }

  private getVoicesList(): SpeechSynthesisVoice[] {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length > 0) this.availableVoices = voices;
    }
    return this.availableVoices;
  }

  /**
   * Selects a distinct voice matching gender, accent, and pitch parameters.
   */
  private selectVoiceForPreset(presetId: string): { voice: SpeechSynthesisVoice | null; pitch: number; rate: number } {
    const voices = this.getVoicesList();
    const preset = PRESET_VOICES.find(v => v.id === presetId);
    if (!preset) return { voice: null, pitch: 1.0, rate: 0.90 };

    const englishVoices = voices.filter(v => v.lang.startsWith('en'));
    const pool = englishVoices.length > 0 ? englishVoices : voices;

    const maleVoices = pool.filter(v => {
      const n = v.name.toLowerCase();
      return (n.includes('male') || n.includes('david') || n.includes('guy') || n.includes('mark') || n.includes('george') || n.includes('daniel') || n.includes('oliver') || n.includes('james')) && !n.includes('female') && !n.includes('zira');
    });

    const femaleVoices = pool.filter(v => {
      const n = v.name.toLowerCase();
      return n.includes('female') || n.includes('zira') || n.includes('jenny') || n.includes('aria') || n.includes('samantha') || n.includes('victoria') || n.includes('catherine');
    });

    let selectedVoice: SpeechSynthesisVoice | null = null;
    let pitch = 1.0;
    let rate = 0.90;

    switch (presetId) {
      case 'supertonic-david':
        selectedVoice = maleVoices.find(v => v.name.toLowerCase().includes('david') || v.name.toLowerCase().includes('guy')) || maleVoices[0] || pool[0];
        pitch = 0.95;
        rate = 0.90;
        break;
      case 'supertonic-hannah':
        selectedVoice = femaleVoices.find(v => v.name.toLowerCase().includes('jenny') || v.name.toLowerCase().includes('zira')) || femaleVoices[0] || pool[0];
        pitch = 1.05;
        rate = 0.92;
        break;
      case 'supertonic-samuel':
        selectedVoice = maleVoices.find(v => v.name.toLowerCase().includes('george') || v.name.toLowerCase().includes('uk') || v.name.toLowerCase().includes('daniel')) || maleVoices[0] || pool[0];
        pitch = 0.82; // Deep reverent
        rate = 0.88;
        break;
      case 'supertonic-ruth':
        selectedVoice = femaleVoices.find(v => v.name.toLowerCase().includes('catherine') || v.name.toLowerCase().includes('uk') || v.name.toLowerCase().includes('aria')) || femaleVoices[0] || pool[0];
        pitch = 0.95;
        rate = 0.88;
        break;
      case 'supertonic-solomon':
        selectedVoice = maleVoices.find(v => v.name.toLowerCase().includes('mark') || v.name.toLowerCase().includes('david')) || maleVoices[0] || pool[0];
        pitch = 0.72; // Deep bass
        rate = 0.85;
        break;
      case 'supertonic-esther':
        selectedVoice = femaleVoices.find(v => v.name.toLowerCase().includes('samantha') || v.name.toLowerCase().includes('victoria')) || femaleVoices[0] || pool[0];
        pitch = 1.10;
        rate = 0.92;
        break;
      case 'supertonic-elijah':
        selectedVoice = maleVoices.find(v => v.name.toLowerCase().includes('guy') || v.name.toLowerCase().includes('james')) || maleVoices[0] || pool[0];
        pitch = 1.00;
        rate = 0.95;
        break;
      case 'supertonic-mary':
        selectedVoice = femaleVoices.find(v => v.name.toLowerCase().includes('jenny') || v.name.toLowerCase().includes('aria')) || femaleVoices[0] || pool[0];
        pitch = 1.00;
        rate = 0.88;
        break;
      case 'supertonic-paul':
        selectedVoice = maleVoices.find(v => v.name.toLowerCase().includes('oliver') || v.name.toLowerCase().includes('george')) || maleVoices[0] || pool[0];
        pitch = 0.90;
        rate = 0.92;
        break;
      case 'supertonic-lydia':
        selectedVoice = femaleVoices.find(v => v.name.toLowerCase().includes('aria') || v.name.toLowerCase().includes('zira')) || femaleVoices[0] || pool[0];
        pitch = 1.15;
        rate = 0.86;
        break;
      default:
        selectedVoice = pool[0];
    }

    return { voice: selectedVoice, pitch, rate };
  }

  /**
   * Speaks text aloud and emits word index boundary callbacks for text highlighting.
   */
  public speakText(
    text: string,
    voiceId: string,
    startWordOffset: number = 0,
    onBoundary: (wordIndex: number) => void,
    onEnd: () => void
  ): void {
    this.stop();
    this.isPlaying = true;

    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      onEnd();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    const voiceConfig = this.selectVoiceForPreset(voiceId);

    utterance.rate = voiceConfig.rate;
    utterance.pitch = voiceConfig.pitch;

    if (voiceConfig.voice) {
      utterance.voice = voiceConfig.voice;
      console.log(`[Supertonic] Playing ${voiceId} with voice: ${voiceConfig.voice.name}, pitch: ${voiceConfig.pitch}`);
    }

    // Build word list & character boundaries
    const wordsList = text.trim().split(/\s+/);
    const wordCharOffsets: number[] = [];
    let currentPos = 0;

    for (let i = 0; i < wordsList.length; i++) {
      wordCharOffsets.push(currentPos);
      currentPos += wordsList[i].length + 1; // +1 space
    }

    // Word boundary listener for text highlighting
    utterance.onboundary = (event) => {
      if (!this.isPlaying) return;
      if (event.name === 'word' || event.charIndex !== undefined) {
        const charIdx = event.charIndex;
        let relativeWordIdx = 0;

        for (let i = 0; i < wordCharOffsets.length; i++) {
          if (wordCharOffsets[i] <= charIdx) {
            relativeWordIdx = i;
          } else {
            break;
          }
        }
        
        const absoluteWordIndex = startWordOffset + relativeWordIdx;
        onBoundary(absoluteWordIndex);
      }
    };

    utterance.onend = () => {
      if (this.isPlaying) {
        this.isPlaying = false;
        this.activeUtterance = null;
        onEnd();
      }
    };

    utterance.onerror = (err) => {
      console.error('[Supertonic] Speech synthesis error:', err);
      if (this.isPlaying) {
        this.isPlaying = false;
        this.activeUtterance = null;
        onEnd();
      }
    };

    this.activeUtterance = utterance;
    window.speechSynthesis.resume();
    window.speechSynthesis.speak(utterance);
  }

  public stop(): void {
    this.isPlaying = false;
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      if (this.activeUtterance) {
        this.activeUtterance.onboundary = null;
        this.activeUtterance.onend = null;
        this.activeUtterance.onerror = null;
        this.activeUtterance = null;
      }
      window.speechSynthesis.cancel();
    }
  }
}

export const supertonicEngine = new SupertonicEngine();
