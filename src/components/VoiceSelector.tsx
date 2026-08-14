import React from 'react';
import { X, Cpu } from 'lucide-react';
import { VoiceOption } from '../services/tts/types';
import { PRESET_VOICES } from '../services/tts/supertonicEngine';

interface VoiceSelectorProps {
  isOpen: boolean;
  onClose: () => void;
  selectedVoice: VoiceOption;
  onSelectVoice: (voice: VoiceOption) => void;
}

export const VoiceSelector: React.FC<VoiceSelectorProps> = ({
  isOpen,
  onClose,
  selectedVoice,
  onSelectVoice
}) => {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">Select Reading Voice</h3>
          <button className="btn btn-secondary btn-icon" onClick={onClose} aria-label="Close voice selector">
            <X size={18} />
          </button>
        </div>

        <div className="voice-grid">
          {PRESET_VOICES.map((voice) => (
            <div
              key={voice.id}
              className={`voice-card ${selectedVoice.id === voice.id ? 'selected' : ''}`}
              onClick={() => {
                onSelectVoice(voice);
                onClose();
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="voice-name">{voice.name}</span>
                <span className="badge-tag badge-free">
                  <Cpu size={10} style={{ marginRight: 2 }} />
                  On-Device
                </span>
              </div>
              <span className="voice-desc">{voice.description}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
