/**
 * @fileoverview Self-contained Function 2 workspace: Multi-language Video -> Subtitle Extractor, Editor, Translator, and Burn-in Studio.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Blocks } from 'loading-dev';
import {
  SOURCE_LANGUAGE_OPTIONS,
  SUBTITLE_BACKGROUND_OPTIONS,
  SUBTITLE_FONT_SCALE_OPTIONS,
  SUBTITLE_POSITION_OPTIONS,
  getSpeakerColor,
  resolveSpeakerLabel,
} from '../../domain/subtitles.js';
import { useVideoSubtitles } from '../hooks/useVideoSubtitles.js';
import { Icon } from './Icon.jsx';
import { SubtitleExportDock } from './SubtitleExportDock.jsx';
import { SubtitleSegmentRow } from './SubtitleSegmentRow.jsx';

const GENERATE_SPINNER_SIZE_PX = 16;

const SPEAKER_COUNT_OPTIONS = Object.freeze([
  { id: '0', label: 'Auto-detect speakers' },
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
        {!busy && (
          <button type="button" id="subtitle-clear-btn" className="button subtle-button cancel-button"
            disabled={!hasFile && !hasSegments} onClick={onClear}>Clear</button>
        )}
        {busy && (
          <button type="button" id="subtitle-cancel-btn" className="button subtle-button cancel-button" onClick={onCancel}>
            <Icon name="stop_fill" /><span>Cancel</span>
          </button>
        )}
        <button type="button" id="subtitle-extract-btn" className={busy ? 'button generate is-generating' : 'button generate'}
          disabled={!hasFile || busy} aria-busy={busy || undefined} onClick={onExtract}>
          {busy ? <Blocks size={GENERATE_SPINNER_SIZE_PX} className="generate-spinner" /> : <Icon name="subtitles" />}
          <span>{busy ? 'Extracting…' : 'Extract subtitles'}</span>
        </button>
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
  const { videoRef, vttUrl, useTranslation, bilingual, selectVideoFile, handleVideoMetadata, handleVideoTimeUpdate } = ctrl;
  const { videoFile, videoUrl, videoSize, isAudioOnly, detectedLanguage, busyAction } = ctrl.state;
  const trackRef = useRef(null);
  const busy = Boolean(busyAction);
  const isPortrait = Boolean(videoSize && videoSize.height > videoSize.width);
  const aspectStyle = videoSize ? { '--video-aspect': `${videoSize.width} / ${videoSize.height}` } : undefined;
  const trackLabel = bilingual ? 'Original + Khmer' : useTranslation ? 'Khmer' : 'Original';

  const showTrack = () => {
    const trackEl = trackRef.current;
    if (trackEl?.track) trackEl.track.mode = 'showing';
  };

  useEffect(() => {
    if (vttUrl) showTrack();
  }, [vttUrl, trackLabel]);

  return (
    <section className="subtitle-video-card" aria-label="Video preview">
      {videoUrl ? (
        <div
          className="subtitle-video-frame"
          data-orientation={isPortrait ? 'portrait' : 'landscape'}
          data-media-kind={isAudioOnly ? 'audio' : 'video'}
          style={aspectStyle}
        >
          <video
            ref={videoRef}
            src={videoUrl}
            controls
            playsInline
            className="subtitle-video-player"
            onLoadedMetadata={e => { handleVideoMetadata?.(e.currentTarget); showTrack(); }}
            onTimeUpdate={e => handleVideoTimeUpdate?.(e.currentTarget.currentTime)}
          >
            {vttUrl && (
              <track
                ref={trackRef}
                kind="subtitles"
                src={vttUrl}
                srcLang={useTranslation ? 'km' : (detectedLanguage || 'en')}
                label={trackLabel}
                default
                onLoad={showTrack}
              />
            )}
          </video>
        </div>
      ) : null}
      <label className="subtitle-upload-dropzone" htmlFor="subtitle-video-input">
        <input id="subtitle-video-input" type="file" accept="video/*,audio/*,.mkv,.avi,.m4v,.aac,.ogg,.flac"
          disabled={busy} onChange={e => { selectVideoFile(e.target.files?.[0]); e.target.value = ''; }} />
        <Icon name="upload" />
        <span className="subtitle-upload-copy">
          <strong>{videoFile ? videoFile.name : 'Choose a video or audio clip'}</strong>
          <span>{videoFile ? 'Click to replace file (.mp4, .mov, .mkv, .webm, .mp3, .wav)' : 'Movies, news, podcasts, or audio clips (max 500 MB)'}</span>
        </span>
      </label>
    </section>
  );
}

function SpeakerRosterCard({ speakers, speakerNames, includeSpeaker, busy, onRename }) {
  const showRoster = speakers.length > 1 || (speakers.length === 1 && includeSpeaker);
  if (!showRoster) return null;
  return (
    <div className="subtitle-roster">
      <span className="field-label">{speakers.length === 1 ? 'Speaker (1)' : `Speakers (${speakers.length})`}</span>
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

function BurnStyleControls({ subtitleStyle, busy, onChangeStyle }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="subtitle-style-section">
      <button type="button" className="advanced-button" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <span>Burn-in subtitle style</span>
        <Icon name="chevron_down" />
      </button>
      <div className="subtitle-style-grid" hidden={!open}>
        <label className="field-compact">
          <span className="field-label">Position</span>
          <div className="select-field select-field--plain">
            <select id="subtitle-style-position" value={subtitleStyle.position} disabled={busy}
              onChange={e => onChangeStyle('position', e.target.value)}>
              {SUBTITLE_POSITION_OPTIONS.map(opt => <option key={opt.id} value={opt.id}>{opt.label}</option>)}
            </select>
            <Icon name="chevron_down" className="select-chevron" />
          </div>
        </label>
        <label className="field-compact">
          <span className="field-label">Text size</span>
          <div className="select-field select-field--plain">
            <select id="subtitle-style-scale" value={subtitleStyle.fontScale} disabled={busy}
              onChange={e => onChangeStyle('fontScale', e.target.value)}>
              {SUBTITLE_FONT_SCALE_OPTIONS.map(opt => <option key={opt.id} value={opt.id}>{opt.label}</option>)}
            </select>
            <Icon name="chevron_down" className="select-chevron" />
          </div>
        </label>
        <label className="field-compact">
          <span className="field-label">Background</span>
          <div className="select-field select-field--plain">
            <select id="subtitle-style-bg" value={subtitleStyle.backgroundStyle} disabled={busy}
              onChange={e => onChangeStyle('backgroundStyle', e.target.value)}>
              {SUBTITLE_BACKGROUND_OPTIONS.map(opt => <option key={opt.id} value={opt.id}>{opt.label}</option>)}
            </select>
            <Icon name="chevron_down" className="select-chevron" />
          </div>
        </label>
      </div>
    </div>
  );
}

function SubtitleToggleRow({ id, label, checked, disabled, hidden = false, onChange }) {
  const labelId = `${id}-label`;
  return (
    <div className="subtitle-toggle-row" hidden={hidden} data-disabled={disabled ? 'true' : undefined}>
      <span id={labelId} className="subtitle-toggle-label">{label}</span>
      <input
        id={id}
        className="subtitle-switch"
        type="checkbox"
        role="switch"
        aria-labelledby={labelId}
        checked={checked}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
      />
    </div>
  );
}

function SubtitleSettingsForm({ ctrl }) {
  const { options, segments, detectedLanguage, busyAction, videoFile, isAudioOnly } = ctrl.state;
  const busy = Boolean(busyAction);
  const hasTranslation = Boolean(ctrl.hasTranslation);
  const canTranslateToKhmer = options.sourceLanguage !== 'km' && detectedLanguage !== 'km';
  const showSpeakerLabelToggle = options.detectSpeakers || ctrl.speakers.length > 1;
  return (
    <div className="subtitle-settings-stack">
      <div className="subtitle-option-grid" data-columns={options.detectSpeakers ? '2' : '1'}>
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
        <div className="field field-compact" hidden={!options.detectSpeakers}>
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
        <SubtitleToggleRow
          id="subtitle-detect-speakers"
          label="Detect speakers"
          checked={options.detectSpeakers}
          disabled={busy}
          onChange={checked => ctrl.updateOption('detectSpeakers', checked)}
        />
        {options.sourceLanguage !== 'km' && (
          <SubtitleToggleRow
            id="subtitle-auto-translate"
            label="Translate to Khmer"
            checked={options.translateToKhmer}
            disabled={busy}
            onChange={checked => ctrl.updateOption('translateToKhmer', checked)}
          />
        )}
        <SubtitleToggleRow
          id="subtitle-include-speaker"
          label="Show speaker names"
          checked={options.includeSpeaker}
          disabled={busy}
          hidden={!showSpeakerLabelToggle}
          onChange={checked => ctrl.updateOption('includeSpeaker', checked)}
        />
      </div>
      {segments.length > 0 && (canTranslateToKhmer || hasTranslation) && (
        <div className="subtitle-translate-bar">
          {canTranslateToKhmer && (
            <button type="button" id="subtitle-translate-btn" className="button button-secondary" disabled={busy} onClick={() => void ctrl.translateNow()}>
              {busyAction === 'translate' ? 'Translating…' : hasTranslation ? 'Re-translate Khmer' : 'Translate to Khmer'}
            </button>
          )}
          {hasTranslation && (
            <div className="select-field select-field--plain">
              <select aria-label="Preview language" value={options.previewMode} disabled={busy}
                onChange={e => ctrl.updateOption('previewMode', e.target.value)}>
                <option value="translated">Khmer subtitles</option>
                <option value="original">Original subtitles</option>
                <option value="bilingual">Bilingual (Original + Khmer)</option>
              </select>
              <Icon name="chevron_down" className="select-chevron" />
            </div>
          )}
        </div>
      )}
      {videoFile && !isAudioOnly && (
        <BurnStyleControls subtitleStyle={options.subtitleStyle} busy={busy} onChangeStyle={ctrl.updateSubtitleStyle} />
      )}
    </div>
  );
}

function FindReplaceBar({ busy, countMatches, onReplace }) {
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [feedback, setFeedback] = useState('');
  const liveMatches = findText ? countMatches({ findText, caseSensitive }) : null;

  const handleSubmit = e => {
    e.preventDefault();
    if (!findText) return;
    const summary = onReplace({ findText, replaceText, caseSensitive });
    setFeedback(summary?.matchCount ? `Replaced ${summary.matchCount}` : 'No matches');
  };

  return (
    <form className="subtitle-find-bar" onSubmit={handleSubmit}>
      <input id="subtitle-find-input" type="text" placeholder="Find text…" aria-label="Find subtitle text"
        value={findText} disabled={busy} onChange={e => { setFindText(e.target.value); setFeedback(''); }} />
      <input id="subtitle-replace-input" type="text" placeholder="Replace with…" aria-label="Replace subtitle text"
        value={replaceText} disabled={busy} onChange={e => { setReplaceText(e.target.value); setFeedback(''); }} />
      <label className="subtitle-find-case">
        <input type="checkbox" checked={caseSensitive} disabled={busy} onChange={e => { setCaseSensitive(e.target.checked); setFeedback(''); }} />
        <span>Aa</span>
      </label>
      <button type="submit" id="subtitle-replace-all-btn" className="button button-secondary" disabled={busy || !findText}>
        Replace all
      </button>
      {(liveMatches || feedback) && (
        <span className="subtitle-find-count" role="status">
          {feedback || `${liveMatches.matchCount} ${liveMatches.matchCount === 1 ? 'match' : 'matches'}`}
        </span>
      )}
    </form>
  );
}

function SubtitleCueList({ ctrl }) {
  const { segments, speakerNames, detectedLanguage, busyAction } = ctrl.state;
  const [showFind, setShowFind] = useState(false);
  const busy = Boolean(busyAction);
  if (!segments.length) {
    return (
      <div className="subtitle-empty-state">
        <Icon name="subtitles" />
        <strong>No dialogue extracted yet</strong>
        <p>Upload a video or audio clip and click Extract subtitles to generate clean, editable subtitles.</p>
      </div>
    );
  }
  const hasMultiSpeakers = ctrl.speakers.length > 1;
  return (
    <div className="subtitle-cue-list">
      <div className="subtitle-cue-meta">
        <span>
          {segments.length} {segments.length === 1 ? 'segment' : 'segments'}
          {hasMultiSpeakers ? ` · ${ctrl.speakers.length} speakers` : ''}
        </span>
        <div className="subtitle-cue-meta-right">
          {detectedLanguage ? <span>Detected: {detectedLanguage.toUpperCase()}</span> : null}
          <button type="button" id="subtitle-find-toggle" className="button subtle-button subtitle-cue-btn"
            aria-expanded={showFind} onClick={() => setShowFind(v => !v)}>
            <Icon name="search" /><span>Find &amp; replace</span>
          </button>
        </div>
      </div>
      {showFind && <FindReplaceBar busy={busy} countMatches={ctrl.countMatches} onReplace={ctrl.findAndReplace} />}
      {segments.map((seg, index) => (
        <SubtitleSegmentRow
          key={seg.id}
          segment={seg}
          speakers={ctrl.speakers}
          speakerNames={speakerNames}
          useTranslation={ctrl.useTranslation}
          showSpeakerBadge={hasMultiSpeakers}
          isActive={seg.id === ctrl.activeSegmentId}
          canMergeNext={index < segments.length - 1}
          busy={busy}
          onSeek={ctrl.seekToSegment}
          onUpdate={ctrl.updateSegment}
          onUpdateTiming={ctrl.updateSegmentTiming}
          onSplit={ctrl.splitSegment}
          onMergeNext={ctrl.mergeSegmentWithNext}
          onDelete={ctrl.deleteSegment}
        />
      ))}
    </div>
  );
}

/**
 * Self-contained Video-to-Subtitle workspace panel hosted inside the Studio shell.
 * Inputs: `{ notices, hidden, onSendToTts, onStateChange, onNotify, onUnlockSound }`.
 * Outputs: `<div className="workspace-panel subtitle-workspace">` element.
 * Side effects: delegates transcription, diarization, translation, and MP4 burn-in via useVideoSubtitles.
 * Failure modes: displays service connectivity or processing errors cleanly in banners/dock/toasts.
 * @param {object} props - Workspace props.
 * @returns {React.ReactElement} Video-to-Subtitle workspace element.
 */
export function VideoSubtitleWorkspace({ notices, hidden = false, onSendToTts, onStateChange, onNotify, onUnlockSound }) {
  const ctrl = useVideoSubtitles({ onStateChange, onNotify, onUnlockSound });
  const { state, health, speakers } = ctrl;
  const busy = Boolean(state.busyAction);
  const handleSendToTts = () => {
    const handoff = ctrl.getTtsHandoff();
    if (!handoff.text) {
      onNotify?.({ kind: 'error', title: 'No text to send', message: 'Selected speaker has no subtitle text yet.' });
      return;
    }
    if (handoff.truncated) {
      const msg = handoff.includedSegments < handoff.totalSegments
        ? `Loaded first ${handoff.includedSegments} of ${handoff.totalSegments} segments (2,000-character TTS limit).`
        : `Trimmed script to the 2,000-character TTS limit (${handoff.totalGraphemes.toLocaleString()} characters total).`;
      onNotify?.({ kind: 'success', title: 'Script trimmed for Text to speech', message: msg });
    }
    onSendToTts?.(handoff.text);
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
          <SpeakerRosterCard
            speakers={speakers}
            speakerNames={state.speakerNames}
            includeSpeaker={ctrl.effectiveIncludeSpeaker}
            busy={busy}
            onRename={ctrl.updateSpeakerName}
          />
        </section>
        <section className="subtitle-right-pane studio-form" aria-label="Extracted dialogue subtitles">
          <SubtitleCueList ctrl={ctrl} />
        </section>
      </div>
      <SubtitleExportDock
        hasSegments={state.segments.length > 0}
        hasSubtitleText={ctrl.hasSubtitleText}
        canBurn={Boolean(state.jobId) && health.burnInSupported !== false}
        isAudioOnly={state.isAudioOnly}
        speakers={speakers}
        speakerNames={state.speakerNames}
        ttsSpeakerId={ctrl.ttsSpeakerId}
        onChangeTtsSpeakerId={ctrl.setTtsSpeakerId}
        busy={busy}
        busyAction={state.busyAction}
        busyMeta={ctrl.busyMeta}
        status={state.status}
        onExportFile={ctrl.exportFile}
        onCopyDialogue={() => void ctrl.copyDialogue()}
        onBurnVideo={() => void ctrl.burnVideo()}
        onSendToTts={handleSendToTts}
      />
    </div>
  );
}
