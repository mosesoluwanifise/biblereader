import React from 'react';
import { X, Sparkles, Cpu, HardDrive, Trash2 } from 'lucide-react';
import { VoiceOption } from '../services/tts/types';
import { PRESET_VOICES } from '../services/tts/supertonicEngine';

interface VoiceSelectorProps {
  isOpen: boolean;
  onClose: () => void;
  selectedVoice: VoiceOption;
  onSelectVoice: (voice: VoiceOption) => void;
  clonedVoices: VoiceOption[];
  onDeleteClonedVoice: (voiceId: string) => void;
  onOpenCloningModal: () => void;
}

export const VoiceSelector: React.FC<VoiceSelectorProps> = ({
  isOpen,
  onClose,
  selectedVoice,
  onSelectVoice,
  clonedVoices,
  onDeleteClonedVoice,
  onOpenCloningModal
}) => {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">Select Reading Voice</h3>
          <button className="btn btn-secondary btn-icon" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <h4 style={{ fontSize: '0.85rem', color: 'var(--accent-gold)', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '1px' }}>
            Free Tier Preset Voices (Supertonic On-Device)
          </h4>
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

        <div>
          <h4 style={{ fontSize: '0.85rem', color: 'var(--accent-gold)', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '1px' }}>
            Paid Tier Cloned Voices (Pocket TTS CPU)
          </h4>
          {clonedVoices.length === 0 ? (
            <div style={{ background: 'var(--bg-card)', padding: '1rem', borderRadius: 'var(--radius-md)', textAlign: 'center' }}>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
                You haven't cloned any voices yet. Upload a short audio clip (5–30s) to hear Scripture in your own voice.
              </p>
              <button className="btn btn-primary" onClick={() => { onClose(); onOpenCloningModal(); }}>
                <Sparkles size={16} />
                <span>Clone Your Voice Now</span>
              </button>
            </div>
          ) : (
            <div className="voice-grid">
              {clonedVoices.map((voice) => (
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
                    <span className="badge-tag badge-cloned">
                      <HardDrive size={10} style={{ marginRight: 2 }} />
                      Cloned
                    </span>
                  </div>
                  <span className="voice-desc">{voice.description}</span>
                  <button
                    className="btn btn-secondary"
                    style={{ padding: '2px 6px', fontSize: '0.75rem', marginTop: '0.5rem', color: '#ef4444' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteClonedVoice(voice.id);
                    }}
                    title="Delete Cloned Voice (Revokes immediately, purges in 24h)"
                  >
                    <Trash2 size={12} />
                    <span>Delete</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
