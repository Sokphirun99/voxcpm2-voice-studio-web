/**
 * @fileoverview Accessible Export Project modal showing Audio, Subtitle, and Supported Video presets,
 * live expected outputs (codec, duration, language, filename), warnings/blockers, and persisted export history.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_DUB_MIX_SETTINGS,
  DEFAULT_DUB_SUBTITLE_MODE,
  DUB_MIX_BOUNDS,
  EXPORT_PRESET_CATEGORIES,
  VIDEO_AUDIO_MODES,
  VIDEO_EXPORT_AUDIO_MODE_OPTIONS,
  VIDEO_SUBTITLE_MODE_OPTIONS,
  clampDubMixField,
  evaluateExportPresets,
  formatGainDbLabel,
  formatGainPercentLabel,
  hasCustomDubMixSettings,
  normalizeDubMixSettings,
  normalizeVideoAudioMode,
  normalizeVideoSubtitleMode,
  resolveExportFilenameStem,
} from '../../domain/exportPresets.js';
import { Icon } from './Icon.jsx';

const CATEGORY_TITLES = Object.freeze({
  audio: 'Audio presets (WAV)',
  subtitle: 'Subtitle & script presets',
  video: 'Supported video presets (MP4)',
});

function useDialogSync(dialogRef, open) {
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const isCurrentlyOpen = Boolean(el.open || el.hasAttribute?.('open'));
    if (open && !isCurrentlyOpen) {
      if (typeof el.showModal === 'function') el.showModal();
      else el.setAttribute('open', '');
    } else if (!open && isCurrentlyOpen) {
      if (typeof el.close === 'function') el.close();
      else el.removeAttribute('open');
    }
  }, [dialogRef, open]);
}

function handleDialogBackdropClick(event, dialogRef, onClose) {
  if (event.target !== dialogRef.current) return;
  dialogRef.current?.close?.();
  onClose?.();
}

function formatDurationLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Dynamic';
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${String(secs).padStart(2, '0')}s`;
}

function formatHistoryTimestamp(isoString) {
  if (!isoString) return '';
  const parsed = Date.parse(isoString);
  if (!Number.isFinite(parsed)) return '';
  return new Date(parsed).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatLanguageSummary(expected) {
  if (!expected?.languageCode) return expected?.languageLabel || 'Undetermined';
  return `${expected.languageLabel} (${expected.languageCode})`;
}

function PresetSpecsList({ expected }) {
  const rateText = expected.sampleRate ? `${Math.round(expected.sampleRate / 1000)} kHz` : null;
  const codecDisplay = rateText && !expected.codec.includes('kHz') ? `${expected.codec} · ${rateText}` : expected.codec;
  return (
    <dl className="export-preset-specs">
      <div className="export-preset-spec-row">
        <dt>Filename</dt>
        <dd><code className="export-filename-code">{expected.filename}</code></dd>
      </div>
      <div className="export-preset-spec-row">
        <dt>Codec</dt>
        <dd>{codecDisplay}</dd>
      </div>
      <div className="export-preset-spec-row">
        <dt>Duration</dt>
        <dd>{formatDurationLabel(expected.durationSeconds)}</dd>
      </div>
      <div className="export-preset-spec-row">
        <dt>Language</dt>
        <dd>{formatLanguageSummary(expected)}</dd>
      </div>
      {expected.audioModeLabel && (
        <div className="export-preset-spec-row">
          <dt>Audio mode</dt>
          <dd title={expected.audioModeLabel}>{expected.audioModeLabel}</dd>
        </div>
      )}
      {expected.subtitleModeLabel && (
        <div className="export-preset-spec-row">
          <dt>Subtitles</dt>
          <dd title={expected.subtitleModeLabel}>{expected.subtitleModeLabel}</dd>
        </div>
      )}
    </dl>
  );
}

function PresetMessages({ blockers, warnings }) {
  if (!blockers.length && !warnings.length) return null;
  return (
    <div className="export-preset-messages">
      {blockers.map((msg, idx) => (
        <p key={`b-${idx}`} className="export-preset-blocker" role="alert">
          <Icon name="circle_alert" /><span>{msg}</span>
        </p>
      ))}
      {warnings.map((msg, idx) => (
        <p key={`w-${idx}`} className="export-preset-warning">
          <Icon name="circle_alert" /><span>{msg}</span>
        </p>
      ))}
    </div>
  );
}

function ExportPresetCard({ preset, busy, activePresetId, onRun }) {
  const isRunning = busy && activePresetId === preset.id;
  return (
    <article className="export-preset-card" data-preset-id={preset.id} data-available={preset.available ? 'true' : 'false'}>
      <div className="export-preset-head">
        <div>
          <h4>{preset.label}</h4>
          <p className="export-preset-desc">{preset.description}</p>
        </div>
        <span className="export-format-badge">{preset.format}</span>
      </div>
      <PresetSpecsList expected={preset.expectedOutput} />
      <PresetMessages blockers={preset.blockers} warnings={preset.warnings} />
      <div className="export-preset-actions">
        <button
          type="button"
          id={`export-preset-btn-${preset.id}`}
          className={preset.category === 'video' ? 'button button-primary' : 'button button-secondary'}
          disabled={!preset.available || busy}
          onClick={() => onRun(preset)}
        >
          <Icon name="arrow_down_to_line" />
          <span>{isRunning ? `Exporting ${preset.format}…` : `Export ${preset.format}`}</span>
        </button>
      </div>
    </article>
  );
}

function ExportMixSlider({ id, label, valueText, field, value, disabled, onChange }) {
  const spec = DUB_MIX_BOUNDS[field];
  return (
    <label className="export-mix-slider-field" htmlFor={id} data-disabled={disabled ? 'true' : undefined}>
      <span className="export-mix-slider-head">
        <span>{label}</span>
        <strong>{valueText}</strong>
      </span>
      <input
        id={id}
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={value}
        disabled={disabled}
        onChange={e => onChange(field, Number(e.target.value))}
      />
    </label>
  );
}

function ExportDubMixControls({ draft, setDraft }) {
  const mix = normalizeDubMixSettings(draft.dubMixSettings);
  const audioMode = draft.dubAudioMode;
  const isCustom = hasCustomDubMixSettings(mix);
  const duckLabel = `${formatGainPercentLabel(mix.duckVolume)} (${formatGainDbLabel(mix.duckVolume)})`;
  const updateField = (field, val) => setDraft(prev => ({
    ...prev,
    dubMixSettings: Object.freeze({ ...normalizeDubMixSettings(prev.dubMixSettings), [field]: clampDubMixField(field, val) }),
  }));
  return (
    <div className="export-mix-controls" aria-label="Dubbing audio mix and ducking controls">
      <ExportMixSlider
        id="export-orig-volume"
        label="Original audio level"
        valueText={audioMode === VIDEO_AUDIO_MODES.REPLACE ? 'Muted' : formatGainPercentLabel(mix.originalVolume)}
        field="originalVolume"
        value={mix.originalVolume}
        disabled={audioMode === VIDEO_AUDIO_MODES.REPLACE}
        onChange={updateField}
      />
      <ExportMixSlider
        id="export-dub-volume"
        label="Dubbed voice level"
        valueText={audioMode === VIDEO_AUDIO_MODES.ORIGINAL ? 'Excluded' : formatGainPercentLabel(mix.dubVolume)}
        field="dubVolume"
        value={mix.dubVolume}
        disabled={audioMode === VIDEO_AUDIO_MODES.ORIGINAL}
        onChange={updateField}
      />
      <ExportMixSlider
        id="export-duck-volume"
        label="Ducking floor"
        valueText={audioMode === VIDEO_AUDIO_MODES.DUCK ? duckLabel : 'Off'}
        field="duckVolume"
        value={mix.duckVolume}
        disabled={audioMode !== VIDEO_AUDIO_MODES.DUCK}
        onChange={updateField}
      />
      <button
        type="button"
        id="export-reset-mix-btn"
        className="button subtle-button export-reset-mix-btn"
        disabled={!isCustom}
        onClick={() => setDraft(prev => ({ ...prev, dubMixSettings: DEFAULT_DUB_MIX_SETTINGS }))}
      >
        Reset mix
      </button>
    </div>
  );
}

function SubtitleExportControls({ draft, setDraft, hasTranslation, showSpeakerOption }) {
  return (
    <>
      <label className="export-control-field" htmlFor="export-language-mode">
        <span>Text / Caption language</span>
        <select
          id="export-language-mode"
          value={draft.languageMode}
          onChange={e => { const val = e.target.value; setDraft(prev => ({ ...prev, languageMode: val })); }}
        >
          <option value="original">Original language</option>
          {hasTranslation && <option value="translated">Translated language</option>}
          {hasTranslation && <option value="bilingual">Bilingual (Original + Translation)</option>}
        </select>
      </label>
      <label className="export-control-field" htmlFor="export-dub-audio-mode">
        <span>Dubbed MP4 audio mode</span>
        <select
          id="export-dub-audio-mode"
          value={draft.dubAudioMode}
          onChange={e => { const val = e.target.value; setDraft(prev => ({ ...prev, dubAudioMode: val })); }}
        >
          {VIDEO_EXPORT_AUDIO_MODE_OPTIONS.map(opt => (
            <option key={opt.id} value={opt.id}>{opt.label}</option>
          ))}
        </select>
      </label>
      <label className="export-control-field" htmlFor="export-dub-subtitle-mode">
        <span>Dubbed MP4 subtitles</span>
        <select
          id="export-dub-subtitle-mode"
          value={draft.dubSubtitleMode}
          onChange={e => { const val = e.target.value; setDraft(prev => ({ ...prev, dubSubtitleMode: val })); }}
        >
          {VIDEO_SUBTITLE_MODE_OPTIONS.map(opt => (
            <option key={opt.id} value={opt.id}>{opt.label}</option>
          ))}
        </select>
      </label>
      <ExportDubMixControls draft={draft} setDraft={setDraft} />
      <div className="export-control-toggles">
        {showSpeakerOption && (
          <label className="export-checkbox-label" htmlFor="export-include-speaker">
            <input
              id="export-include-speaker"
              type="checkbox"
              checked={draft.includeSpeaker}
              onChange={e => { const checked = e.target.checked; setDraft(prev => ({ ...prev, includeSpeaker: checked })); }}
            />
            <span>Include speaker labels</span>
          </label>
        )}
        <label className="export-checkbox-label" htmlFor="export-language-suffix">
          <input
            id="export-language-suffix"
            type="checkbox"
            checked={draft.includeLanguageSuffix}
            onChange={e => { const checked = e.target.checked; setDraft(prev => ({ ...prev, includeLanguageSuffix: checked })); }}
          />
          <span>Append language code to subtitle filename</span>
        </label>
      </div>
    </>
  );
}

function ExportHistoryList({ exportHistory = [] }) {
  return (
    <section className="export-history-section" aria-label="Project export history">
      <div className="export-section-head">
        <h3>Project export history</h3>
        <span className="export-history-count">{exportHistory.length}</span>
      </div>
      {exportHistory.length === 0 ? (
        <p className="export-history-empty" id="export-history-empty">
          No exports recorded in this project yet.
        </p>
      ) : (
        <ul className="export-history-list" id="export-history-list">
          {exportHistory.map(item => (
            <li key={item.id} className="export-history-row" data-export-format={item.format}>
              <div className="export-history-main">
                <span className="export-format-badge">{item.format}</span>
                <div className="export-history-meta">
                  <strong className="export-history-filename">{item.filename}</strong>
                  <span>
                    {[
                      item.label,
                      item.audioMode ? `Audio: ${item.audioMode}` : null,
                      item.subtitleMode ? `Subs: ${item.subtitleMode}` : null,
                      item.languageLabel && item.languageLabel !== 'Undetermined' ? `${item.languageLabel}${item.languageCode ? ` (${item.languageCode})` : ''}` : null,
                      Number.isFinite(item.durationSeconds) && item.durationSeconds > 0 ? formatDurationLabel(item.durationSeconds) : null,
                    ].filter(Boolean).join(' · ')}
                  </span>
                </div>
              </div>
              <time className="export-history-time" dateTime={item.exportedAt}>
                {formatHistoryTimestamp(item.exportedAt)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function buildInitialExportDraft(context = {}) {
  const defaultStem = resolveExportFilenameStem({
    filenameStem: context.filenameStem,
    videoFileName: context.videoFileName,
    projectTitle: context.projectTitle,
    fallback: context.workspace === 'tts' ? 'voxcpm2-narration' : 'subtitle',
  });
  const rawMode = context.languageMode || (context.bilingual ? 'bilingual' : (context.useTranslation ? 'translated' : 'original'));
  const mode = (!context.hasTranslation && (rawMode === 'translated' || rawMode === 'bilingual')) ? 'original' : rawMode;
  return {
    filenameStem: defaultStem,
    languageMode: mode,
    includeSpeaker: Boolean(context.includeSpeaker),
    includeLanguageSuffix: Boolean(context.includeLanguageSuffix),
    dubAudioMode: normalizeVideoAudioMode(context.dubAudioMode, VIDEO_AUDIO_MODES.DUCK),
    dubSubtitleMode: normalizeVideoSubtitleMode(context.dubSubtitleMode, DEFAULT_DUB_SUBTITLE_MODE),
    dubMixSettings: normalizeDubMixSettings(context.dubMixSettings),
  };
}

function useExportModalDraftSync({ open, workspace, context, closedRef, setDraft, setActivePresetId, setModalError }) {
  const wasOpenRef = useRef(false);
  const prevWorkspaceRef = useRef(workspace);
  const contextRef = useRef(context);
  contextRef.current = context;

  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    const workspaceChanged = open && prevWorkspaceRef.current !== workspace;
    wasOpenRef.current = open;
    prevWorkspaceRef.current = workspace;
    if (!open) {
      closedRef.current = false;
      setActivePresetId('');
      setModalError('');
      return;
    }
    if (justOpened || workspaceChanged) {
      closedRef.current = false;
      setDraft(buildInitialExportDraft({ ...contextRef.current, workspace }));
      setModalError('');
    }
  }, [open, workspace, closedRef, setDraft, setActivePresetId, setModalError]);
}

function useExportModalController({ dialogRef, open, workspace, context, busy, onExportPreset, onClose }) {
  const closedRef = useRef(false);
  const [draft, setDraft] = useState(() => buildInitialExportDraft({ ...context, workspace }));
  const [activePresetId, setActivePresetId] = useState('');
  const [modalError, setModalError] = useState('');

  useDialogSync(dialogRef, open);
  useExportModalDraftSync({ open, workspace, context, closedRef, setDraft, setActivePresetId, setModalError });

  const evaluatedPresets = useMemo(
    () => evaluateExportPresets({ ...context, ...draft, workspace }),
    [context, draft, workspace]
  );
  const groupedSections = useMemo(() => (
    EXPORT_PRESET_CATEGORIES
      .map(cat => ({ category: cat, title: CATEGORY_TITLES[cat], items: evaluatedPresets.filter(p => p.category === cat) }))
      .filter(sec => sec.items.length > 0)
  ), [evaluatedPresets]);

  const requestClose = () => {
    if (closedRef.current || !open) return;
    closedRef.current = true;
    dialogRef.current?.close?.();
    onClose?.();
  };

  const handleRunPreset = async preset => {
    if (!onExportPreset || !preset?.available || busy) return;
    setModalError('');
    setActivePresetId(preset.id);
    try {
      await onExportPreset(preset, draft);
    } catch (err) {
      setModalError(err?.message || `Could not export ${preset.label}.`);
    } finally {
      setActivePresetId('');
    }
  };

  return { draft, setDraft, activePresetId, modalError, groupedSections, requestClose, handleRunPreset };
}

/**
 * Renders the Export Project modal with category-grouped Audio, Subtitle, and MP4 presets,
 * expected output verification, warnings/blockers, and saved project export history.
 * Inputs: `{ open, workspace, context, exportHistory, busy, onExportPreset, onClose }`.
 * Outputs: `<dialog id="export-project-dialog">`.
 * Side effects: triggers file exports via `onExportPreset` and manages modal open/close state.
 * Failure modes: catches export failures and surfaces actionable alert text inside the modal.
 * @param {object} props - Modal props.
 * @returns {React.ReactElement} Export Project dialog.
 */
export function ExportProjectModal({
  open = false,
  workspace = 'subtitle',
  context = {},
  exportHistory = [],
  busy = false,
  onExportPreset,
  onClose,
}) {
  const dialogRef = useRef(null);
  const {
    draft, setDraft, activePresetId, modalError, groupedSections, requestClose, handleRunPreset,
  } = useExportModalController({ dialogRef, open, workspace, context, busy, onExportPreset, onClose });

  return (
    <dialog
      ref={dialogRef}
      id="export-project-dialog"
      className="voice-library export-project-dialog"
      aria-modal="true"
      aria-labelledby="export-project-title"
      aria-describedby="export-project-desc"
      onClose={requestClose}
      onCancel={e => { e.preventDefault?.(); requestClose(); }}
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault?.(); requestClose(); } }}
      onClick={e => handleDialogBackdropClick(e, dialogRef, requestClose)}
    >
      <div className="library-header">
        <div>
          <h2 id="export-project-title">Export project</h2>
          <p id="export-project-desc">
            Choose an audio, subtitle, or supported MP4 preset and verify codec, duration, language, and filename before downloading.
          </p>
        </div>
        <div className="library-header-actions">
          <button
            type="button"
            id="export-project-close-btn"
            className="button subtle-button"
            aria-label="Close export project dialog"
            onClick={requestClose}
          >
            Close
          </button>
        </div>
      </div>

      <div className="export-controls-bar">
        <label className="export-control-field" htmlFor="export-filename-stem">
          <span>Output filename base</span>
          <input
            id="export-filename-stem"
            type="text"
            value={draft.filenameStem}
            placeholder={workspace === 'tts' ? 'voxcpm2-narration' : 'subtitle'}
            onChange={e => { const val = e.target.value; setDraft(prev => ({ ...prev, filenameStem: val })); }}
          />
        </label>
        {workspace === 'subtitle' && (
          <SubtitleExportControls
            draft={draft}
            setDraft={setDraft}
            hasTranslation={Boolean(context.hasTranslation)}
            showSpeakerOption={Boolean(context.canShowSpeakerOption ?? context.hasMultiSpeakers ?? context.includeSpeaker)}
          />
        )}
      </div>

      {modalError && <p className="terminology-error" role="alert">{modalError}</p>}

      <div className="library-scroll export-modal-scroll">
        {groupedSections.map(section => (
          <section key={section.category} className="export-category-section" aria-label={section.title}>
            <h3 className="export-category-heading">{section.title}</h3>
            <div className="export-preset-grid">
              {section.items.map(preset => (
                <ExportPresetCard
                  key={preset.id}
                  preset={preset}
                  busy={busy || Boolean(activePresetId)}
                  activePresetId={activePresetId}
                  onRun={handleRunPreset}
                />
              ))}
            </div>
          </section>
        ))}
        <ExportHistoryList exportHistory={exportHistory} />
      </div>
    </dialog>
  );
}
