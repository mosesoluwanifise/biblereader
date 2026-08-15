import React, { useEffect, useState } from 'react';
import { X, Type, Gauge, Download, Check } from 'lucide-react';
import { TranslationCode } from '../services/bible/types';
import { downloadTranslation, offlineCoverage } from '../services/pwa/offlineManager';

interface ReaderSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  fontScale: number;
  onFontScale: (value: number) => void;
  speed: number;
  onSpeed: (value: number) => void;
  translation: TranslationCode;
}

const FONT_STEPS = [0.85, 1, 1.15, 1.3, 1.6];
const SPEED_STEPS = [0.8, 0.9, 1.05, 1.2, 1.4];

export const ReaderSettings: React.FC<ReaderSettingsProps> = ({
  isOpen,
  onClose,
  fontScale,
  onFontScale,
  speed,
  onSpeed,
  translation
}) => {
  const [coverage, setCoverage] = useState<number | null>(null);
  const [downloading, setDownloading] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    void offlineCoverage(translation).then(setCoverage);
  }, [isOpen, translation]);

  if (!isOpen) return null;

  const startDownload = async () => {
    setDownloading({ done: 0, total: 66 });
    await downloadTranslation(translation, (p) => setDownloading({ done: p.done, total: p.total }));
    setDownloading(null);
    setCoverage(await offlineCoverage(translation));
  };

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
              resampling finished audio, so pitch is unaffected. Existing
              prepared audio is identity-bound and narration restarts. */}
          <p className="setting-hint">Restarts narration at the new speed.</p>
        </fieldset>

        <fieldset className="setting-group">
          <legend className="setting-label">
            <Download size={14} aria-hidden="true" />
            <span>Offline reading</span>
          </legend>

          {downloading ? (
            <>
              <progress className="setting-progress" value={downloading.done} max={downloading.total} />
              <p className="setting-hint">
                Downloading {translation}… {downloading.done} of {downloading.total} books
              </p>
            </>
          ) : coverage !== null && coverage >= 1 ? (
            <p className="setting-hint setting-hint--done">
              <Check size={14} aria-hidden="true" /> {translation} is available offline.
            </p>
          ) : (
            <>
              <button type="button" className="btn btn-secondary" onClick={startDownload}>
                <Download size={14} aria-hidden="true" />
                <span>Download {translation} for offline</span>
              </button>
              <p className="setting-hint">
                {coverage === null
                  ? 'Chapters are saved as you read them.'
                  : `About ${Math.round(coverage * 100)}% saved from reading so far. Roughly 5 MB in total.`}
              </p>
            </>
          )}
        </fieldset>
      </div>
    </div>
  );
};
