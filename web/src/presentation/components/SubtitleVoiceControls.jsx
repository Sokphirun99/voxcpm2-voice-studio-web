/**
 * @fileoverview Selection toolbar and bottom combined voiceover player for generating VoxCPM2 speech directly from subtitle frames.
 */

import React from 'react';
import { Blocks } from 'loading-dev';
import { formatTime } from '../../domain/audioValidation.js';
import {
  DEFAULT_DUB_AUDIO_MODE,
  DUB_AUDIO_MODE_OPTIONS,
  SUBTITLE_VOICEOVER_GAP_OPTIONS,
  SUBTITLE_VOICEOVER_PAUSE_MS,
  formatSubtitleVoiceoverGapLabel,
} from '../../domain/subtitleTts.js';
import { Icon } from './Icon.jsx';

const VOICE_SPINNER_SIZE_PX = 14;

function formatVoiceOptionLabel(character, hasAnchor) {
  const base = character.role ? `${character.name} — ${character.role}` : character.name;
  return hasAnchor ? `${base} (Locked)` : base;
}

function formatGenerateButtonLabel({ voiceBusy, batchProgress, selectedCount }) {
  if (voiceBusy && batchProgress) {
    return `Generating ${batchProgress.completed + 1}/${batchProgress.total}…`;
  }
  if (voiceBusy) return 'Generating voice…';
  if (selectedCount > 0) return `Generate voice (${selectedCount})`;
  return 'Generate selected voice';
}

function SubtitleGapSelector({ pauseGapMs, disabled, onChange }) {
  return (
    <div className="subtitle-voice-gap-group">
      <label className="subtitle-gap-label" htmlFor="subtitle-tts-gap">Gap</label>
      <div className="select-field select-field--plain subtitle-voice-gap-wrap">
        <select
          id="subtitle-tts-gap"
          aria-label="Pause gap between subtitle frames"
          value={String(pauseGapMs)}
          disabled={disabled}
          onChange={e => onChange?.(Number(e.target.value))}
        >
          {SUBTITLE_VOICEOVER_GAP_OPTIONS.map(opt => (
            <option key={opt.ms} value={String(opt.ms)}>{opt.label}</option>
          ))}
        </select>
        <Icon name="chevron_down" className="select-chevron" />
      </div>
    </div>
  );
}

/**
 * Renders the top selection, voice character, and frame pause-gap controls above extracted subtitle frames.
 * Inputs: `{ totalSegments, selectedCount, allSelected, characters, anchors, selectedVoiceId, pauseGapMs, busy, voiceBusy, batchProgress, onToggleSelectAll, onClearSelection, onChangeVoice, onChangePauseGap, onGenerateSelected, onCancelVoice }`.
 * Outputs: `<div className="subtitle-voice-toolbar">`.
 * Side effects: updates selection, active character voice, frame stitching pause gap, or triggers/cancels batch TTS generation.
 * Failure modes: disables generation cleanly when 0 frames are selected or another operation is running.
 * @param {object} props - Toolbar props.
 * @returns {React.ReactElement} Subtitle voiceover toolbar.
 */
export function SubtitleVoiceToolbar({
  totalSegments,
  selectedCount,
  allSelected,
  characters,
  anchors = {},
  selectedVoiceId,
  pauseGapMs = SUBTITLE_VOICEOVER_PAUSE_MS,
  busy,
  voiceBusy,
  batchProgress = null,
  onToggleSelectAll,
  onClearSelection,
  onChangeVoice,
  onChangePauseGap,
  onGenerateSelected,
  onCancelVoice,
}) {
  const disableControls = busy || voiceBusy;
  const generateLabel = formatGenerateButtonLabel({ voiceBusy, batchProgress, selectedCount });
  return (
    <div className="subtitle-voice-toolbar" role="region" aria-label="Subtitle voiceover controls">
      <div className="subtitle-voice-select-group">
        <label className="subtitle-select-all-label">
          <input
            id="subtitle-select-all"
            type="checkbox"
            className="subtitle-select-checkbox"
            checked={allSelected}
            disabled={disableControls || totalSegments === 0}
            onChange={onToggleSelectAll}
          />
          <span>{selectedCount > 0 ? `${selectedCount} of ${totalSegments} selected` : 'Select all'}</span>
        </label>
        {selectedCount > 0 && !disableControls && (
          <button type="button" id="subtitle-clear-selection" className="button subtle-button subtitle-cue-btn" onClick={onClearSelection}>
            Clear
          </button>
        )}
      </div>
      <div className="subtitle-voice-actions">
        <div className="select-field select-field--plain subtitle-voice-select-wrap">
          <select
            id="subtitle-tts-voice"
            aria-label="Voice for subtitle speech"
            value={selectedVoiceId}
            disabled={disableControls}
            onChange={e => onChangeVoice(e.target.value)}
          >
            {characters.map(ch => (
              <option key={ch.id} value={ch.id}>{formatVoiceOptionLabel(ch, Boolean(anchors[ch.id]))}</option>
            ))}
          </select>
          <Icon name="chevron_down" className="select-chevron" />
        </div>
        <SubtitleGapSelector pauseGapMs={pauseGapMs} disabled={disableControls} onChange={onChangePauseGap} />
        {voiceBusy ? (
          <button type="button" id="subtitle-cancel-voice-btn" className="button subtle-button cancel-button subtitle-voice-btn" onClick={onCancelVoice}>
            <Icon name="stop_fill" /><span>Cancel</span>
          </button>
        ) : null}
        <button
          type="button"
          id="subtitle-generate-voice-btn"
          className="button button-primary subtitle-voice-btn"
          disabled={disableControls || selectedCount === 0}
          title={selectedCount === 0 ? 'Select one or more subtitle frames first' : undefined}
          onClick={onGenerateSelected}
        >
          {voiceBusy ? <Blocks size={VOICE_SPINNER_SIZE_PX} className="generate-spinner" /> : <Icon name="waveform" />}
          <span>{generateLabel}</span>
        </button>
      </div>
    </div>
  );
}

function resolveDubDisabledReason({ isAudioOnly, hasJobId }) {
  if (isAudioOnly) return 'Upload a video file to export a dubbed MP4.';
  if (!hasJobId) return 'Extract subtitles from a video first to export a dubbed MP4.';
  return undefined;
}

function SubtitleDubExportBar({ dubAudioMode, dubBusy, disabled, disabledReason, onChangeDubAudioMode, onExportDub }) {
  return (
    <div className="subtitle-voice-dub-row">
      <div className="subtitle-voice-dub-mode">
        <label className="subtitle-dub-label" htmlFor="subtitle-dub-audio-mode">Original audio</label>
        <div className="select-field select-field--plain subtitle-voice-dub-select-wrap">
          <select
            id="subtitle-dub-audio-mode"
            aria-label="Original audio"
            value={dubAudioMode}
            disabled={disabled}
            onChange={e => onChangeDubAudioMode?.(e.target.value)}
          >
            {DUB_AUDIO_MODE_OPTIONS.map(opt => (
              <option key={opt.id} value={opt.id}>{opt.label}</option>
            ))}
          </select>
          <Icon name="chevron_down" className="select-chevron" />
        </div>
      </div>
      <button
        type="button"
        id="subtitle-export-dub-btn"
        className="button button-primary subtitle-voice-btn"
        disabled={disabled}
        title={disabledReason}
        onClick={onExportDub}
      >
        {dubBusy ? <Blocks size={VOICE_SPINNER_SIZE_PX} className="generate-spinner" /> : <Icon name="arrow_down_to_line" />}
        <span>{dubBusy ? 'Exporting dubbed MP4…' : 'Export dubbed MP4'}</span>
      </button>
    </div>
  );
}

/**
 * Renders the combined generated voiceover audio player, WAV download bar, and dubbed MP4 export controls directly below the subtitle list.
 * Inputs: `{ combinedClip, busy, dubAudioMode, dubBusy, canExportDub, isAudioOnly, hasJobId, onDownload, onChangeDubAudioMode, onExportDub }`.
 * Outputs: `<section id="subtitle-voice-output">` or null when no voice clips exist yet.
 * Side effects: plays audio via native HTML5 `<audio>`, downloads `.wav`, or exports time-aligned dubbed `.mp4`.
 * Failure modes: returns null cleanly before any frame voice is generated; disables dubbing for audio-only or missing `jobId`.
 * @param {object} props - Output card props.
 * @returns {React.ReactElement|null} Combined voiceover output card or null.
 */
export function SubtitleVoiceOutputCard({
  combinedClip,
  busy = false,
  dubAudioMode = DEFAULT_DUB_AUDIO_MODE,
  dubBusy = false,
  canExportDub = false,
  isAudioOnly = false,
  hasJobId = false,
  onDownload,
  onChangeDubAudioMode,
  onExportDub,
}) {
  if (!combinedClip?.url) return null;
  const frameWord = combinedClip.count === 1 ? 'frame' : 'frames';
  const scopeLabel = combinedClip.scope === 'selected' ? `Selected voiceover · ${combinedClip.count} ${frameWord}` : `Generated voiceover · ${combinedClip.count} ${frameWord}`;
  const durationLabel = combinedClip.durationSeconds ? formatTime(combinedClip.durationSeconds) : '';
  const gapLabel = combinedClip.count >= 2 && combinedClip.pauseGapMs != null
    ? `${formatSubtitleVoiceoverGapLabel(combinedClip.pauseGapMs)} gap`
    : '';
  const metaParts = [combinedClip.characterName, durationLabel, gapLabel].filter(Boolean).join(' · ');
  const dubDisabled = busy || dubBusy || !canExportDub;
  const dubDisabledReason = !canExportDub ? resolveDubDisabledReason({ isAudioOnly, hasJobId }) : undefined;

  return (
    <section id="subtitle-voice-output" className="subtitle-voice-output" aria-label="Generated subtitle voiceover">
      <div className="subtitle-voice-output-head">
        <div className="subtitle-voice-output-copy">
          <strong><Icon name="waveform" /><span>{scopeLabel}</span></strong>
          {metaParts ? <span>{metaParts}</span> : null}
        </div>
        <button
          type="button"
          id="subtitle-download-voice-btn"
          className="button button-secondary subtitle-voice-btn"
          disabled={busy || dubBusy}
          onClick={onDownload}
        >
          <Icon name="arrow_down_to_line" />
          <span>Download voice (.wav)</span>
        </button>
      </div>
      <audio controls className="subtitle-voice-audio" src={combinedClip.url} preload="metadata" />
      <SubtitleDubExportBar
        dubAudioMode={dubAudioMode}
        dubBusy={dubBusy}
        disabled={dubDisabled}
        disabledReason={dubDisabledReason}
        onChangeDubAudioMode={onChangeDubAudioMode}
        onExportDub={onExportDub}
      />
    </section>
  );
}
