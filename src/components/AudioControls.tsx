import React from 'react';
import { Play, Pause, RotateCcw, Volume2, Sparkles, Cpu, HardDrive } from 'lucide-react';
import { VoiceOption } from '../services/tts/types';

interface AudioControlsProps {
  passageTitle: string;
  voice: VoiceOption;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onRestart: () => void;
  onOpenVoiceSelector: () => void;
}

export const AudioControls: React.FC<AudioControlsProps> = ({
  passageTitle,
  voice,
  isPlaying,
  onTogglePlay,
  onRestart,
  onOpenVoiceSelector
}) => {
  return (
    <div className="player-bar">
      <div className="player-main">
        <div className="player-info">
          <span className="player-passage">{passageTitle}</span>
          <span className="player-voice-tag" onClick={onOpenVoiceSelector} style={{ cursor: 'pointer' }}>
            {voice.isCloned ? <HardDrive size={12} /> : <Cpu size={12} />}
            <span>{voice.name}</span>
          </span>
        </div>

        <div className="player-controls">
          <button className="btn btn-secondary btn-icon" onClick={onRestart} title="Restart Chapter">
            <RotateCcw size={18} />
          </button>

          <button
            className="btn-play-pause"
            onClick={onTogglePlay}
            title={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? <Pause size={24} /> : <Play size={24} style={{ marginLeft: 2 }} />}
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)' }}>
          <Volume2 size={18} />
        </div>
      </div>
    </div>
  );
};
