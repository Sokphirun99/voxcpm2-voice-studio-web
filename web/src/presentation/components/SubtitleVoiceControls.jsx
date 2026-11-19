/**
 * @fileoverview Selection toolbar and bottom combined voiceover player for generating VoxCPM2 speech directly from subtitle frames.
 */

import React from 'react';
import { Blocks } from 'loading-dev';
import { formatTime } from '../../domain/audioValidation.js';
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

/**
 * Renders the top selection & voice character controls above extracted subtitle frames.
 * Inputs: `{ totalSegments, selectedCount, allSelected, characters, anchors, selectedVoiceId, busy, voiceBusy, batchProgress, onToggleSelectAll, onClearSelection, onChangeVoice, onGenerateSelected, onCancelVoice }`.
 * Outputs: `<div className="subtitle-voice-toolbar">`.
 * Side effects: updates selection, active character voice, or triggers/cancels batch TTS generation.
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
  busy,
  voiceBusy,
  batchProgress = null,
  onToggleSelectAll,
  onClearSelection,
  onChangeVoice,
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

/**
 * Renders the combined generated voiceover audio player and WAV download bar directly below the subtitle list.
 * Inputs: `{ combinedClip, busy, onDownload }`.
 * Outputs: `<section id="subtitle-voice-output">` or null when no voice clips exist yet.
 * Side effects: plays audio via native HTML5 `<audio>` and triggers `.wav` file download.
 * Failure modes: returns null cleanly before any frame voice is generated.
 * @param {{ combinedClip: object|null, busy?: boolean, onDownload: () => void }} props - Output card props.
 * @returns {React.ReactElement|null} Combined voiceover output card or null.
 */
export function SubtitleVoiceOutputCard({ combinedClip, busy = false, onDownload }) {
  if (!combinedClip?.url) return null;
  const frameWord = combinedClip.count === 1 ? 'frame' : 'frames';
  const scopeLabel = combinedClip.scope === 'selected' ? `Selected voiceover · ${combinedClip.count} ${frameWord}` : `Generated voiceover · ${combinedClip.count} ${frameWord}`;
  const durationLabel = combinedClip.durationSeconds ? formatTime(combinedClip.durationSeconds) : '';
  const metaParts = [combinedClip.characterName, durationLabel].filter(Boolean).join(' · ');

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
          disabled={busy}
          onClick={onDownload}
        >
          <Icon name="arrow_down_to_line" />
          <span>Download voice (.wav)</span>
        </button>
      </div>
      <audio controls className="subtitle-voice-audio" src={combinedClip.url} preload="metadata" />
    </section>
  );
}
