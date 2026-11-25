/**
 * @fileoverview Selection toolbar and bottom combined voiceover player for generating VoxCPM2 speech directly from subtitle frames.
 */

import React, { useState } from 'react';
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

function resolveDubDisabledReason({ isAudioOnly, hasJobId, unresolvedMismatchCount = 0 }) {
  if (isAudioOnly) return 'Upload a video file to export a dubbed MP4.';
  if (!hasJobId) return 'Extract subtitles from a video first to export a dubbed MP4.';
  if (unresolvedMismatchCount > 0) {
    const word = unresolvedMismatchCount === 1 ? 'mismatch' : 'mismatches';
    return `Resolve ${unresolvedMismatchCount} speech duration ${word} before exporting dubbed MP4.`;
  }
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

function SubtitleVoiceModeToggle({ mode, onChangeMode }) {
  return (
    <div className="subtitle-voice-mode-toggle" role="group" aria-label="Playback mode">
      <button
        type="button"
        id="subtitle-mode-aligned-btn"
        className={mode === 'aligned' ? 'subtitle-voice-mode-tab is-active' : 'subtitle-voice-mode-tab'}
        aria-pressed={mode === 'aligned'}
        onClick={() => onChangeMode('aligned')}
      >
        Time-aligned dub
      </button>
      <button
        type="button"
        id="subtitle-mode-sequential-btn"
        className={mode === 'sequential' ? 'subtitle-voice-mode-tab is-active' : 'subtitle-voice-mode-tab'}
        aria-pressed={mode === 'sequential'}
        onClick={() => onChangeMode('sequential')}
      >
        Sequential voice
      </button>
    </div>
  );
}

function formatVoiceHeaderMeta(activeClip) {
  const durationLabel = activeClip.durationSeconds ? formatTime(activeClip.durationSeconds) : '';
  const gapLabel = activeClip.count >= 2 && activeClip.pauseGapMs != null
    ? `${formatSubtitleVoiceoverGapLabel(activeClip.pauseGapMs)} gap` : '';
  return [activeClip.characterName, durationLabel, gapLabel].filter(Boolean).join(' · ');
}

function SubtitleVoiceHeaderCopy({ activeClip, unresolvedMismatchCount = 0 }) {
  const frameWord = activeClip.count === 1 ? 'frame' : 'frames';
  const scope = activeClip.scope === 'selected' ? 'Selected voiceover' : 'Generated voiceover';
  const scopeLabel = `${scope} · ${activeClip.count} ${frameWord}`;
  const metaLabel = formatVoiceHeaderMeta(activeClip);
  const warnTitle = activeClip.warnings?.map(w => w.message).join('\n') || '';
  return (
    <div className="subtitle-voice-output-copy">
      <strong><Icon name="waveform" /><span>{scopeLabel}</span></strong>
      {metaLabel && <span>{metaLabel}</span>}
      {unresolvedMismatchCount > 0 && (
        <span className="subtitle-voice-mismatch-pill">
          {unresolvedMismatchCount} duration {unresolvedMismatchCount === 1 ? 'mismatch' : 'mismatches'}
        </span>
      )}
      {unresolvedMismatchCount === 0 && activeClip.warnings?.length > 0 && (
        <span className="subtitle-voice-warn-pill" title={warnTitle}>
          {activeClip.warnings.length} clamped to fit
        </span>
      )}
    </div>
  );
}

function SubtitleVoiceDownloadActions({ busy, dubBusy, onDownload, onDownloadAligned, hasAligned, canExportAligned = hasAligned }) {
  const alignedDisabled = busy || dubBusy || !canExportAligned;
  const alignedTitle = !canExportAligned
    ? 'Resolve speech duration mismatches before exporting time-aligned WAV'
    : 'Export synchronized time-aligned WAV ready for video editors';
  return (
    <div className="subtitle-voice-download-group">
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
      {hasAligned && onDownloadAligned && (
        <button
          type="button"
          id="subtitle-download-aligned-voice-btn"
          className="button button-primary subtitle-voice-btn"
          disabled={alignedDisabled}
          title={alignedTitle}
          onClick={onDownloadAligned}
        >
          <Icon name="waveform" />
          <span>Time-aligned dub WAV</span>
        </button>
      )}
    </div>
  );
}

function SubtitleVoiceCardHeader({ activeClip, hasAligned, mode, onChangeMode, actionsProps, unresolvedMismatchCount = 0 }) {
  return (
    <div className="subtitle-voice-output-head">
      <SubtitleVoiceHeaderCopy activeClip={activeClip} unresolvedMismatchCount={unresolvedMismatchCount} />
      {hasAligned && <SubtitleVoiceModeToggle mode={mode} onChangeMode={onChangeMode} />}
      <SubtitleVoiceDownloadActions {...actionsProps} hasAligned={hasAligned} />
    </div>
  );
}

function DurationMismatchExportBanner({ durationMismatches, busy, onJumpToMismatch, onFixSafeMismatches }) {
  if (!durationMismatches?.hasUnresolved) return null;
  const { unresolved, unresolvedCount } = durationMismatches;
  const hasSafeExtend = unresolved.some(item => item.remedies?.canExtendCue);
  const word = unresolvedCount === 1 ? 'mismatch' : 'mismatches';
  return (
    <div className="subtitle-mismatch-export-banner" role="alert">
      <div className="subtitle-mismatch-banner-head">
        <Icon name="alert_circle" className="subtitle-validation-icon" />
        <div className="subtitle-mismatch-banner-copy">
          <strong>Resolve {unresolvedCount} speech duration {word} before final dub export</strong>
          <span>Speech exceeds allocated subtitle intervals — choose an explicit remedy on each cue rather than silent trimming.</span>
        </div>
        {hasSafeExtend && onFixSafeMismatches && (
          <button type="button" id="subtitle-fix-safe-mismatches-btn" className="button subtle-button subtitle-validation-fix-btn"
            disabled={busy} onClick={onFixSafeMismatches}>Extend safe cues</button>
        )}
      </div>
      <div className="subtitle-mismatch-chip-list">
        {unresolved.map(item => (
          <button key={item.segmentId} type="button" className="button subtle-button subtitle-mismatch-jump-chip"
            title={item.message} onClick={() => onJumpToMismatch?.(item.segmentId)}>
            Cue #{item.cueNumber} (+{item.excessDuration.toFixed(2)}s)
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Renders the combined generated voiceover audio player, WAV download bar, and dubbed MP4 export controls directly below the subtitle list.
 * Inputs: `{ combinedClip, alignedClip, durationMismatches, canExportAlignedVoice, busy, dubAudioMode, dubBusy, canExportDub, isAudioOnly, hasJobId, onDownload, onDownloadAligned, onChangeDubAudioMode, onExportDub, onJumpToMismatch, onFixSafeMismatches }`.
 * Outputs: `<section id="subtitle-voice-output">` or null when no voice clips exist yet.
 * Side effects: plays audio via native HTML5 `<audio>`, downloads `.wav`, or exports time-aligned dubbed `.mp4`.
 * Failure modes: returns null cleanly before any frame voice is generated; disables dubbing for audio-only, missing `jobId`, or unresolved duration mismatches.
 * @param {object} props - Output card props.
 * @returns {React.ReactElement|null} Combined voiceover output card or null.
 */
export function SubtitleVoiceOutputCard({
  combinedClip,
  alignedClip = null,
  durationMismatches = null,
  canExportAlignedVoice,
  busy = false,
  dubAudioMode = DEFAULT_DUB_AUDIO_MODE,
  dubBusy = false,
  canExportDub = false,
  isAudioOnly = false,
  hasJobId = false,
  onDownload,
  onDownloadAligned,
  onChangeDubAudioMode,
  onExportDub,
  onJumpToMismatch = null,
  onFixSafeMismatches = null,
}) {
  const [mode, setMode] = useState('sequential');
  const hasCombined = Boolean(combinedClip?.url);
  const hasAligned = Boolean(alignedClip?.url);
  const effectiveMode = (mode === 'aligned' && hasAligned) || (!hasCombined && hasAligned) ? 'aligned' : 'sequential';
  const activeClip = effectiveMode === 'aligned' ? alignedClip : combinedClip;
  if (!activeClip?.url) return null;
  const unresolvedMismatchCount = durationMismatches?.unresolvedCount || 0;
  const canExportAligned = canExportAlignedVoice ?? (hasAligned && unresolvedMismatchCount === 0);
  const dubDisabled = busy || dubBusy || !canExportDub || unresolvedMismatchCount > 0;
  const dubDisabledReason = dubDisabled ? resolveDubDisabledReason({ isAudioOnly, hasJobId, unresolvedMismatchCount }) : undefined;

  return (
    <section id="subtitle-voice-output" className="subtitle-voice-output" aria-label="Generated subtitle voiceover">
      <SubtitleVoiceCardHeader
        activeClip={activeClip}
        hasAligned={hasAligned}
        mode={effectiveMode}
        onChangeMode={setMode}
        unresolvedMismatchCount={unresolvedMismatchCount}
        actionsProps={{ busy, dubBusy, onDownload, onDownloadAligned, canExportAligned }}
      />
      <DurationMismatchExportBanner
        durationMismatches={durationMismatches}
        busy={busy || dubBusy}
        onJumpToMismatch={onJumpToMismatch}
        onFixSafeMismatches={onFixSafeMismatches}
      />
      <audio key={activeClip.url} controls className="subtitle-voice-audio" src={activeClip.url} preload="metadata" />
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
