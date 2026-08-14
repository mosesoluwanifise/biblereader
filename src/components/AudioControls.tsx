import React from 'react';
import { Play, Pause, RotateCcw, Cpu, Loader2, AlertCircle } from 'lucide-react';
import { VoiceOption } from '../services/tts/types';
import { PlaybackState } from '../services/audio/playbackController';
import { EngineStatus } from '../services/tts/supertonicEngine';

interface AudioControlsProps {
  passageTitle: string;
  voice: VoiceOption;
  playbackState: PlaybackState;
  engineStatus: EngineStatus;
  errorMessage: string | null;
  disabled: boolean;
  onTogglePlay: () => void;
  onRestart: () => void;
  onOpenVoiceSelector: () => void;
}

export const AudioControls: React.FC<AudioControlsProps> = ({
  passageTitle,
  voice,
  playbackState,
  engineStatus,
  errorMessage,
  disabled,
  onTogglePlay,
  onRestart,
  onOpenVoiceSelector
}) => {
  const isPlaying = playbackState === 'playing';
  const isBusy = playbackState === 'preparing' || engineStatus === 'loading';

  const label = errorMessage
    ? errorMessage
    : engineStatus === 'loading'
      ? 'Preparing voice…'
      : playbackState === 'preparing'
        ? 'Synthesizing…'
        : passageTitle;

  return (
    <div className="player-bar">
      <div className="player-main">
        <div className="player-info">
          <span className={`player-passage ${errorMessage ? 'player-passage--error' : ''}`}>
            {errorMessage && <AlertCircle size={13} aria-hidden="true" />}
            {label}
          </span>
          <button type="button" className="player-voice-tag" onClick={onOpenVoiceSelector}>
            <Cpu size={12} aria-hidden="true" />
            <span>{voice.name}</span>
          </button>
        </div>

        <div className="player-controls">
          <button
            className="btn btn-secondary btn-icon"
            onClick={onRestart}
            aria-label="Stop and return to the start of the chapter"
          >
            <RotateCcw size={18} aria-hidden="true" />
          </button>

          <button
            className="btn-play-pause"
            onClick={onTogglePlay}
            disabled={disabled}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isBusy ? (
              <Loader2 size={22} className="spin" aria-hidden="true" />
            ) : isPlaying ? (
              <Pause size={24} aria-hidden="true" />
            ) : (
              <Play size={24} style={{ marginLeft: 2 }} aria-hidden="true" />
            )}
          </button>
        </div>

        {/* Attachment A(e): synthesized audio is disclosed as machine-generated. */}
        <span className="player-disclosure" title="Narration is generated on your device by an AI speech model">
          AI voice
        </span>
      </div>
    </div>
  );
};
