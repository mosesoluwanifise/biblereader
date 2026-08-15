import React from 'react';
import { X, Type, Gauge } from 'lucide-react';

interface ReaderSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  fontScale: number;
  onFontScale: (value: number) => void;
  speed: number;
  onSpeed: (value: number) => void;
}

const FONT_STEPS = [0.85, 1, 1.15, 1.3, 1.6];
const SPEED_STEPS = [0.8, 0.9, 1.05, 1.2, 1.4];

export const ReaderSettings: React.FC<ReaderSettingsProps> = ({
  isOpen,
  onClose,
  fontScale,
  onFontScale,
  speed,
  onSpeed
}) => {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">Reading settings</h3>
          <button className="btn btn-secondary btn-icon" onClick={onClose} aria-label="Close settings">
            <X size={18} />
          </button>
        </div>

        <fieldset className="setting-group">
          <legend className="setting-label">
            <Type size={14} aria-hidden="true" />
            <span>Text size</span>
          </legend>
          <div className="setting-options" role="group">
            {FONT_STEPS.map((step) => (
              <button
                key={step}
                type="button"
                className={`setting-option ${fontScale === step ? 'setting-option--on' : ''}`}
                aria-pressed={fontScale === step}
                onClick={() => onFontScale(step)}
                style={{ fontSize: `${0.75 + (step - 0.85) * 0.5}rem` }}
              >
                A
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="setting-group">
          <legend className="setting-label">
            <Gauge size={14} aria-hidden="true" />
            <span>Narration speed</span>
          </legend>
          <div className="setting-options" role="group">
            {SPEED_STEPS.map((step) => (
              <button
                key={step}
                type="button"
                className={`setting-option ${speed === step ? 'setting-option--on' : ''}`}
                aria-pressed={speed === step}
                onClick={() => onSpeed(step)}
              >
                {step === 1.05 ? 'Normal' : `${step.toFixed(2).replace(/0$/, '')}x`}
              </button>
            ))}
          </div>
          {/* Speed changes the duration the model is asked to fill, rather than
              resampling finished audio, so pitch is unaffected. It applies from
              the next sentence because the current one is already synthesized. */}
          <p className="setting-hint">Applies from the next sentence.</p>
        </fieldset>
      </div>
    </div>
  );
};
