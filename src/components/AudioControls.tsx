import React from 'react';
import { Play, Pause, RotateCcw, Cpu, Loader2, AlertCircle } from 'lucide-react';
import { VoiceOption } from '../services/tts/types';
import { PlaybackState, type PlaybackModelPhase } from '../services/audio/playbackController';

type NarrationStatus =
  | 'provider-fallback'
  | 'download'
  | 'compile'
  | 'warmup'
  | 'rebuffering'
  | 'device-too-slow'
  | 'retry'
  | 'preparing'
  | 'idle';

interface AudioControlsProps {
  passageTitle: string;
  voice: VoiceOption;
  playbackState: PlaybackState;
  /** 0..1 while the Supertonic bundle downloads, null otherwise. */
  modelProgress: number | null;
  modelPhase?: PlaybackModelPhase | null;
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
  modelProgress,
  modelPhase,
  errorMessage,
  disabled,
  onTogglePlay,
  onRestart,
  onOpenVoiceSelector
}) => {
  const isPlaying = playbackState === 'playing' || playbackState === 'rebuffering';
  const isBusy = playbackState === 'preparing';

  const status = narrationStatus(playbackState, modelProgress, modelPhase, errorMessage);
  const isRetryable = status === 'retry' || status === 'device-too-slow';

  const statusLabel = {
    'provider-fallback': 'Trying a compatible audio engine…',
    download: `Downloading voice model… ${Math.round((modelProgress ?? 0) * 100)}%`,
    compile: 'Compiling voice model…',
    warmup: 'Warming up narration…',
    rebuffering: 'Rebuffering narration…',
    'device-too-slow': errorMessage ?? 'This device is too slow for continuous narration.',
    retry: `${errorMessage} Retry available.`,
    preparing: 'Preparing narration…',
    idle: passageTitle
  }[status];

  return (
    <div
      className="player-bar"
      role="region"
      aria-label="Audio narration controls"
      data-narration-status={status}
      aria-busy={isBusy || status === 'rebuffering' || status === 'provider-fallback'}
    >
      <div className="player-main">
        <div className="player-info">
          <span className={`player-passage ${errorMessage ? 'player-passage--error' : ''}`}>
            {errorMessage && <AlertCircle size={13} aria-hidden="true" />}
            {statusLabel}
          </span>

          <span className="player-meta">
            <button type="button" className="player-voice-tag" onClick={onOpenVoiceSelector}>
              <Cpu size={12} aria-hidden="true" />
              <span>{voice.name}</span>
            </button>

            {status === 'download' ? (
              <span
                className="player-upgrade"
                role="progressbar"
                aria-label="Downloading voice model"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round((modelProgress ?? 0) * 100)}
              >
                {statusLabel}
              </span>
            ) : status !== 'idle' ? (
              <span className="player-upgrade" role="status" aria-live="polite">{statusLabel}</span>
            ) : null}
          </span>
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
            disabled={disabled || isBusy}
            aria-label={isPlaying ? 'Pause' : isRetryable ? 'Retry narration' : 'Play'}
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

        {/* Attachment A(e): synthesized audio is disclosed as machine-generated,
            and the disclosure links the terms carrying the use restrictions. */}
        <a
          className="player-disclosure"
          href="/models/supertonic-3/LICENSE"
          target="_blank"
          rel="noreferrer"
          title="Narration is generated on your device by an AI speech model. Opens the model licence."
        >
          AI voice
        </a>
      </div>
    </div>
  );
};

function narrationStatus(
  playbackState: PlaybackState,
  modelProgress: number | null,
  modelPhase: PlaybackModelPhase | null | undefined,
  errorMessage: string | null
): NarrationStatus {
  if (modelPhase === 'provider-fallback') return 'provider-fallback';
  if (modelPhase === 'warmup') return 'warmup';
  if (modelPhase === 'compile') return 'compile';
  if (modelPhase === 'download' || modelProgress !== null) return 'download';
  if (playbackState === 'rebuffering') return 'rebuffering';
  if (playbackState === 'device-too-slow') return 'device-too-slow';
  if (errorMessage) return 'retry';
  if (playbackState === 'preparing') return 'preparing';
  return 'idle';
}
