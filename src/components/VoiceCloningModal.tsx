import React, { useState } from 'react';
import { X, Upload, Shield, AlertCircle, CheckCircle2 } from 'lucide-react';
import { uploadVoiceSample } from '../services/api/voiceCloningApi';
import { VoiceOption } from '../services/tts/types';

interface VoiceCloningModalProps {
  isOpen: boolean;
  onClose: () => void;
  onVoiceCloned: (voice: VoiceOption) => void;
}

export const VoiceCloningModal: React.FC<VoiceCloningModalProps> = ({
  isOpen,
  onClose,
  onVoiceCloned
}) => {
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  if (!isOpen) return null;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setError(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Please provide a name for this voice profile.');
      return;
    }
    if (!file) {
      setError('Please upload a 5–30 second audio clip.');
      return;
    }

    setIsUploading(true);
    setError(null);

    try {
      const res = await uploadVoiceSample(name, file);
      const newVoice: VoiceOption = {
        id: res.profile.id,
        name: res.profile.name,
        description: `Custom cloned voice from ${res.profile.sample_duration_sec}s reference audio`,
        isCloned: true
      };

      setSuccess(true);
      setTimeout(() => {
        onVoiceCloned(newVoice);
        setIsUploading(false);
        setSuccess(false);
        setName('');
        setFile(null);
        onClose();
      }, 1000);
    } catch (err: any) {
      setIsUploading(false);
      setError(err.message || 'Failed to clone voice.');
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">Clone a Voice (Paid Tier)</h3>
          <button className="btn btn-secondary btn-icon" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.4rem' }}>
              Voice Name (e.g., "Grandmother's Voice", "My Voice")
            </label>
            <input
              type="text"
              className="select-input"
              style={{ width: '100%' }}
              placeholder="Enter a descriptive name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.4rem' }}>
              Reference Audio Clip (5–30 seconds of clear speech)
            </label>
            <label className="uploader-box" style={{ display: 'block' }}>
              <Upload size={32} style={{ color: 'var(--accent-gold)', marginBottom: '0.5rem' }} />
              <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>
                {file ? file.name : 'Click or drop audio file here (.mp3, .wav, .m4a)'}
              </div>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                Recommended: 10–15 seconds of clear, uninterrupted speaking
              </span>
              <input
                type="file"
                accept="audio/*"
                onChange={handleFileChange}
                style={{ display: 'none' }}
              />
            </label>
          </div>

          {/* R14 & R15 Privacy Disclosure */}
          <div style={{ background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.2)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', marginBottom: '1rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#60a5fa', fontWeight: 600, marginBottom: '0.25rem' }}>
              <Shield size={14} />
              <span>Privacy & Voice Data Guarantee (R14, R15)</span>
            </div>
            Uploaded audio is used strictly to synthesize voice embeddings for your account. We never sell, share, or train public models on your voice data. You can delete your voice profile at any time with immediate revocation and complete server purge within 24 hours.
          </div>

          {error && (
            <div style={{ color: '#ef4444', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '1rem' }}>
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          )}

          {success && (
            <div style={{ color: '#10b981', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '1rem' }}>
              <CheckCircle2 size={16} />
              <span>Voice profile created successfully! Loading...</span>
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: '100%', justifyContent: 'center' }}
            disabled={isUploading}
          >
            {isUploading ? 'Extracting Voice Embedding...' : 'Synthesize My Voice Profile'}
          </button>
        </form>
      </div>
    </div>
  );
};
