/**
 * @fileoverview Self-contained Function 2 workspace: Multi-language Video -> Multi-speaker Subtitle & Dialogue Extractor.
 */

import React from 'react';
import { SOURCE_LANGUAGE_OPTIONS, getSpeakerColor, resolveSpeakerLabel } from '../../domain/subtitles.js';
import { useVideoSubtitles } from '../hooks/useVideoSubtitles.js';
import { Icon } from './Icon.jsx';
import { SubtitleExportDock } from './SubtitleExportDock.jsx';
import { SubtitleSegmentRow } from './SubtitleSegmentRow.jsx';

const SPEAKER_COUNT_OPTIONS = Object.freeze([
  { id: '0', label: 'Auto-detect speakers' },
  { id: '1', label: '1 speaker (Solo)' },
  { id: '2', label: '2 speakers (Dialogue)' },
  { id: '3', label: '3 speakers' },
  { id: '4', label: '4 speakers' },
  { id: '6', label: '5+ speakers' },
]);

function SubtitleToolbar({ busy, hasFile, hasSegments, onClear, onCancel, onExtract }) {
  return (
    <header className="studio-toolbar">
      <h1>Video to subtitle</h1>
      <div className="toolbar-actions">
        <button type="button" id="subtitle-clear-btn" className="button cancel-button"
          disabled={(!hasFile && !hasSegments) || busy} onClick={onClear}>Clear</button>
        {busy ? (
          <button type="button" id="subtitle-cancel-btn" className="button cancel-button" onClick={onCancel}>Cancel</button>
        ) : (
          <button type="button" id="subtitle-extract-btn" className="button generate" disabled={!hasFile} onClick={onExtract}>
            <Icon name="subtitles" /><span>Extract subtitles</span>
          </button>
        )}
      </div>
    </header>
  );
}

function MediaOfflineBanner({ health, onRefresh }) {
  if (!health.checked || health.online) return null;
  return (
    <div className="engine-alert-popup" role="alert">
      <span className="engine-alert-dot" aria-hidden="true" />
      <div className="engine-alert-body">
        <strong>Video subtitle service offline</strong>
        <span>{health.reason || 'Local Whisper / Diarization server is not reachable on port 8810.'}</span>
      </div>
      <div className="engine-alert-actions">
        <button type="button" className="button engine-retry-button" onClick={onRefresh}>Refresh</button>
      </div>
    </div>
  );
}

function VideoPreviewCard({ ctrl }) {
  const { videoRef, vttUrl, useTranslation, selectVideoFile } = ctrl;
  const { videoFile, videoUrl, detectedLanguage, busyAction } = ctrl.state;
  const busy = Boolean(busyAction);
  return (
    <section className="subtitle-video-card" aria-label="Video preview">
      {videoUrl ? (
        <div className="subtitle-video-frame">
          <video ref={videoRef} src={videoUrl} controls playsInline className="subtitle-video-player">
            {vttUrl && (
              <track key={vttUrl} kind="subtitles" src={vttUrl}
                srcLang={useTranslation ? 'km' : (detectedLanguage || 'en')}
                label={useTranslation ? 'Khmer' : 'Original'} default />
            )}
          </video>
        </div>
      ) : null}
      <label className="subtitle-upload-dropzone" htmlFor="subtitle-video-input">
        <input id="subtitle-video-input" type="file" accept="video/*,audio/*,.mkv,.avi,.m4v"
          disabled={busy} onChange={e => { selectVideoFile(e.target.files?.[0]); e.target.value = ''; }} />
        <Icon name="upload" />
        <span className="subtitle-upload-copy">
          <strong>{videoFile ? videoFile.name : 'Choose a video or dialogue clip'}</strong>
          <span>{videoFile ? 'Click to replace file (.mp4, .mov, .mkv, .webm)' : 'Movies, news, podcasts, or multi-speaker clips (max 500 MB)'}</span>
        </span>
      </label>
    </section>
  );
}

function SpeakerRosterCard({ speakers, speakerNames, busy, onRename }) {
  if (!speakers.length) return null;
  return (
    <div className="subtitle-roster">
      <span className="field-label">Speakers ({speakers.length})</span>
      <div className="subtitle-roster-list">
        {speakers.map(id => (
          <label key={id} className="subtitle-roster-chip" style={{ '--spk-color': getSpeakerColor(id) }}>
            <span className="subtitle-speaker-dot" aria-hidden="true" />
            <input type="text" className="subtitle-roster-input" disabled={busy}
              aria-label={`Rename ${id}`} placeholder={resolveSpeakerLabel(id)}
              value={speakerNames[id] || ''} onChange={e => onRename(id, e.target.value)} />
          </label>
        ))}
      </div>
    </div>
  );
}

function SubtitleSettingsForm({ ctrl }) {
  const { options, segments, busyAction } = ctrl.state;
  const busy = Boolean(busyAction);
  const hasTranslation = segments.some(s => Boolean(s?.translatedText?.trim()));
  return (
    <div className="subtitle-settings-stack">
      <div className="subtitle-option-grid">
        <div className="field field-compact">
          <label className="field-label" htmlFor="subtitle-source-lang">Video language</label>
          <div className="select-field select-field--plain">
            <select id="subtitle-source-lang" value={options.sourceLanguage} disabled={busy}
              onChange={e => ctrl.updateOption('sourceLanguage', e.target.value)}>
              {SOURCE_LANGUAGE_OPTIONS.map(opt => <option key={opt.id} value={opt.id}>{opt.label}</option>)}
            </select>
            <Icon name="chevron_down" className="select-chevron" />
          </div>
        </div>
        <div className="field field-compact">
          <label className="field-label" htmlFor="subtitle-speaker-count">Speakers</label>
          <div className="select-field select-field--plain">
            <select id="subtitle-speaker-count" value={options.speakerCount} disabled={busy}
              onChange={e => ctrl.updateOption('speakerCount', e.target.value)}>
              {SPEAKER_COUNT_OPTIONS.map(opt => <option key={opt.id} value={opt.id}>{opt.label}</option>)}
            </select>
            <Icon name="chevron_down" className="select-chevron" />
          </div>
        </div>
      </div>
      <div className="field-row-toggles">
        <label className="locked-checkbox subtitle-toggle" htmlFor="subtitle-auto-translate">
          <span>Translate to Khmer</span>
          <input id="subtitle-auto-translate" type="checkbox"
            checked={options.translateToKhmer} disabled={busy}
            onChange={e => ctrl.updateOption('translateToKhmer', e.target.checked)} />
        </label>
        <label className="locked-checkbox subtitle-toggle" htmlFor="subtitle-include-speaker">
          <span>Speaker tags</span>
          <input id="subtitle-include-speaker" type="checkbox"
            checked={options.includeSpeaker} disabled={busy}
            onChange={e => ctrl.updateOption('includeSpeaker', e.target.checked)} />
        </label>
      </div>
      {segments.length > 0 && (
        <div className="subtitle-translate-bar">
          <button type="button" id="subtitle-translate-btn" className="button button-secondary" disabled={busy} onClick={() => void ctrl.translateNow()}>
            {busyAction === 'translate' ? 'Translating...' : hasTranslation ? 'Re-translate Khmer' : 'Translate to Khmer'}
          </button>
          {hasTranslation && (
            <div className="select-field select-field--plain">
              <select aria-label="Preview language" value={options.previewMode} disabled={busy}
                onChange={e => ctrl.updateOption('previewMode', e.target.value)}>
                <option value="translated">Khmer subtitles</option>
                <option value="original">Original subtitles</option>
              </select>
              <Icon name="chevron_down" className="select-chevron" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SubtitleCueList({ ctrl }) {
  const { segments, speakerNames, options, detectedLanguage, busyAction } = ctrl.state;
  const busy = Boolean(busyAction);
  if (!segments.length) {
    return (
      <div className="subtitle-empty-state">
        <Icon name="subtitles" />
        <strong>No dialogue extracted yet</strong>
        <p>Upload any multi-speaker video (stories, news, interviews) and click Extract subtitles to split speakers, preview live captions, translate to Khmer, or burn subtitles into MP4.</p>
      </div>
    );
  }
  return (
    <div className="subtitle-cue-list">
      <div className="subtitle-cue-meta">
        <span>{segments.length} segments · {ctrl.speakers.length} speaker(s)</span>
        {detectedLanguage ? <span>Detected: {detectedLanguage.toUpperCase()}</span> : null}
      </div>
      {segments.map(seg => (
        <SubtitleSegmentRow key={seg.id} segment={seg} speakers={ctrl.speakers} speakerNames={speakerNames}
          showTranslationInput={options.translateToKhmer} busy={busy}
          onSeek={ctrl.seekToSegment} onUpdate={ctrl.updateSegment} />
      ))}
    </div>
  );
}

/**
 * Self-contained Video-to-Subtitle workspace panel hosted inside the Studio shell.
 * Inputs: `{ notices, hidden, onSendToTts, onStateChange }`.
 * Outputs: `<div className="workspace-panel subtitle-workspace">` element.
 * Side effects: delegates transcription, diarization, translation, and MP4 burn-in via useVideoSubtitles.
 * Failure modes: displays service connectivity or processing errors cleanly in banners/dock.
 * @param {object} props - Workspace props.
 * @returns {React.ReactElement} Video-to-Subtitle workspace element.
 */
export function VideoSubtitleWorkspace({ notices, hidden = false, onSendToTts, onStateChange }) {
  const ctrl = useVideoSubtitles({ onStateChange });
  const { state, health, speakers } = ctrl;
  const busy = Boolean(state.busyAction);
  const handleSendToTts = () => {
    const script = ctrl.getTtsScript();
    if (script) onSendToTts?.(script);
  };
  return (
    <div className="workspace-panel subtitle-workspace" hidden={hidden}>
      <div className="workspace-notices">
        {notices}
        <MediaOfflineBanner health={health} onRefresh={() => void ctrl.refreshHealth()} />
      </div>
      <SubtitleToolbar busy={busy} hasFile={Boolean(state.videoFile)} hasSegments={state.segments.length > 0}
        onClear={ctrl.clearWorkspace} onCancel={ctrl.cancel} onExtract={() => void ctrl.extractSubtitles()} />
      <div className="studio-grid subtitle-grid">
        <section className="subtitle-left-pane" aria-label="Video and controls">
          <VideoPreviewCard ctrl={ctrl} />
          <SubtitleSettingsForm ctrl={ctrl} />
          <SpeakerRosterCard speakers={speakers} speakerNames={state.speakerNames} busy={busy} onRename={ctrl.updateSpeakerName} />
        </section>
        <section className="subtitle-right-pane studio-form" aria-label="Extracted dialogue subtitles">
          <SubtitleCueList ctrl={ctrl} />
        </section>
      </div>
      <SubtitleExportDock
        hasSegments={state.segments.length > 0}
        canBurn={Boolean(state.jobId) && health.burnInSupported !== false}
        busy={busy}
        busyAction={state.busyAction}
        status={state.status}
        onExportFile={ctrl.exportFile}
        onCopyDialogue={() => void ctrl.copyDialogue()}
        onBurnVideo={() => void ctrl.burnVideo()}
        onSendToTts={handleSendToTts}
      />
    </div>
  );
}
