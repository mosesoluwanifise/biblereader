import React from 'react';
import { BookOpen, Sparkles, UserCheck, ShieldCheck } from 'lucide-react';
import { TranslationCode } from '../services/bible/types';
import { VoiceOption } from '../services/tts/types';

interface HeaderProps {
  currentTranslation: TranslationCode;
  onSelectTranslation: (t: TranslationCode) => void;
  currentVoice: VoiceOption;
  onOpenVoiceSelector: () => void;
  onOpenVoiceCloning: () => void;
  isSubscribed: boolean;
  onToggleSubscription: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentTranslation,
  onSelectTranslation,
  currentVoice,
  onOpenVoiceSelector,
  onOpenVoiceCloning,
  isSubscribed,
  onToggleSubscription
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
          title="Switch Bible Translation (R11: Preserves Reading Position)"
        >
          <option value="KJV">KJV — King James</option>
          <option value="WEB">WEB — World English</option>
          <option value="ASV">ASV — American Standard</option>
        </select>

        <button className="select-badge" onClick={onOpenVoiceSelector} title="Change Voice">
          <Sparkles size={16} className="text-gold" />
          <span>{currentVoice.name}</span>
        </button>

        <button 
          className={`btn ${isSubscribed ? 'btn-secondary' : 'btn-primary'}`}
          onClick={onOpenVoiceCloning}
        >
          <UserCheck size={16} />
          <span>{currentVoice.isCloned ? 'My Cloned Voice' : 'Clone A Voice'}</span>
        </button>
      </div>
    </header>
  );
};
