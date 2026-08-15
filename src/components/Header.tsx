import React from 'react';
import { BookOpen, Sparkles, Settings } from 'lucide-react';
import { TranslationCode } from '../services/bible/types';
import { VoiceOption } from '../services/tts/types';

interface HeaderProps {
  currentTranslation: TranslationCode;
  onSelectTranslation: (t: TranslationCode) => void;
  currentVoice: VoiceOption;
  onOpenVoiceSelector: () => void;
  onOpenSettings: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentTranslation,
  onSelectTranslation,
  currentVoice,
  onOpenVoiceSelector,
  onOpenSettings
}) => {
  return (
    <header className="app-header">
      <div className="brand-title">
        <BookOpen className="brand-icon" size={28} />
        <span>Scripture Voice</span>
      </div>

      <div className="header-controls">
        <select
          className="select-badge"
          value={currentTranslation}
          onChange={(e) => onSelectTranslation(e.target.value as TranslationCode)}
          aria-label="Bible translation"
          title="Switch translation — reading position is preserved"
        >
          <option value="KJV">KJV — King James</option>
          <option value="WEB">WEB — World English</option>
          <option value="ASV">ASV — American Standard</option>
        </select>

        <button className="select-badge" onClick={onOpenVoiceSelector} title="Change voice">
          <Sparkles size={16} className="text-gold" />
          <span>{currentVoice.name}</span>
        </button>

        <button
          className="select-badge"
          onClick={onOpenSettings}
          aria-label="Reading settings"
          title="Text size and narration speed"
        >
          <Settings size={16} />
        </button>
      </div>
    </header>
  );
};
