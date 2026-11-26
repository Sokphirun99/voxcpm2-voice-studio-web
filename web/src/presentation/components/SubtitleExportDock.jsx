/**
 * @fileoverview Bottom export dock for Video-to-Subtitle: TXT, SRT, VTT, burned MP4 export, speaker-scoped TTS handoff, and live status.
 */

import React from 'react';
import { resolveSpeakerLabel } from '../../domain/subtitles.js';
import { Icon } from './Icon.jsx';
import { LiveStatusText } from './LiveStatusText.jsx';

function ExportFormatButtons({ hasSegments, busy, onExportFile, onCopyDialogue }) {
  return (
    <div className="subtitle-export-group">
      <button type="button" className="button button-secondary" aria-label="Copy dialogue" title="Copy dialogue"
        disabled={!hasSegments || busy} onClick={onCopyDialogue}>
        <Icon name="copy" /><span>Copy</span>
      </button>
      <button type="button" className="button button-secondary" disabled={!hasSegments || busy} onClick={() => onExportFile('srt')}>
        <Icon name="arrow_down_to_line" /><span>Download .srt</span>
      </button>
      <button type="button" className="button button-secondary" disabled={!hasSegments || busy} onClick={() => onExportFile('vtt')}>
        <Icon name="arrow_down_to_line" /><span>Download .vtt</span>
      </button>
      <button type="button" className="button button-secondary" disabled={!hasSegments || busy} onClick={() => onExportFile('txt')}>
        <Icon name="arrow_down_to_line" /><span>Download .txt</span>
      </button>
    </div>
  );
}

function resolveAlignedExportTitle({ hasAlignedVoice, canExportAlignedVoice, unresolvedMismatchCount }) {
  if (!hasAlignedVoice) return 'Generate subtitle voice clips before exporting time-aligned WAV';
  if (!canExportAlignedVoice && unresolvedMismatchCount > 0) {
    const word = unresolvedMismatchCount === 1 ? 'mismatch' : 'mismatches';
    return `Resolve ${unresolvedMismatchCount} speech duration ${word} before exporting time-aligned WAV`;
  }
  return 'Export synchronized time-aligned voiceover WAV for video editing';
}

function ExportAlignedDubButton({ hasAlignedVoice, canExportAlignedVoice = hasAlignedVoice, unresolvedMismatchCount = 0, busy, onExportAlignedVoice }) {
  if (!onExportAlignedVoice) return null;
  const title = resolveAlignedExportTitle({ hasAlignedVoice, canExportAlignedVoice, unresolvedMismatchCount });
  return (
    <button
      type="button"
      id="subtitle-export-aligned-wav-btn"
      className="button button-secondary"
      disabled={!hasAlignedVoice || !canExportAlignedVoice || busy}
      title={title}
      onClick={onExportAlignedVoice}
    >
      <Icon name="waveform" />
      <span>Time-aligned dub WAV</span>
    </button>
  );
}

/**
 * Renders the Subtitle workspace footer with live status, export buttons, optional speaker TTS filter, and burn-in action.
 * Inputs: `{ hasSegments, hasSubtitleText, selectedCount, canBurn, hasVideoJob, isAudioOnly, speakers, speakerNames, ttsSpeakerId, onChangeTtsSpeakerId, busy, busyAction, busyMeta, status, hasAlignedVoice, canExportAlignedVoice, unresolvedMismatchCount, onExportAlignedVoice, onExportFile, onCopyDialogue, onBurnVideo, onSendToTts }`.
 * Outputs: `<section className="playback subtitle-dock">`.
 * Side effects: triggers file download, clipboard copy, MP4 burn-in, or TTS transfer.
 * Failure modes: disables invalid export buttons cleanly until extraction completes, when audio-only, or when duration mismatches remain.
 * @param {object} props - Export dock props.
 * @returns {React.ReactElement} Subtitle export dock.
 */
export function SubtitleExportDock({
  hasSegments,
  hasSubtitleText = hasSegments,
  selectedCount = 0,
  canBurn,
  hasVideoJob = false,
  isAudioOnly = false,
  speakers = [],
  speakerNames = {},
  ttsSpeakerId = '',
  onChangeTtsSpeakerId,
  busy,
  busyAction,
  busyMeta = null,
  status,
  hasAlignedVoice = false,
  canExportAlignedVoice = hasAlignedVoice,
  unresolvedMismatchCount = 0,
  onExportAlignedVoice = null,
  onOpenExportProject = null,
  exportHistoryCount = 0,
  onExportFile,
  onCopyDialogue,
  onBurnVideo,
  onSendToTts,
}) {
  const showSpeakerFilter = hasSegments && speakers.length > 1;
  const sendTtsLabel = selectedCount > 0 ? `Send selected to TTS (${selectedCount})` : 'Send to Text to speech';
  let burnTitle;
  if (isAudioOnly) burnTitle = 'MP4 burn-in is only available for video files';
  else if (hasSegments && !hasVideoJob) burnTitle = 'Load a video and link it before exporting burned MP4';
  else if (hasSegments && !hasSubtitleText) burnTitle = 'Add subtitle text before exporting burned MP4';
  else if (hasSegments && !canBurn) burnTitle = 'MP4 burn-in requires FFmpeg with libass support';
  const isDockIdle = !hasSegments && !busy && !status?.error;
  return (
    <section className="playback subtitle-dock" aria-label="Subtitle export" data-idle={isDockIdle ? 'true' : 'false'}>
      <div className="subtitle-dock-actions">
        <ExportFormatButtons hasSegments={hasSegments} busy={busy} onExportFile={onExportFile} onCopyDialogue={onCopyDialogue} />
        <div className="subtitle-export-primary">
          <button type="button" id="subtitle-burn-btn" className="button button-secondary"
            title={burnTitle} disabled={!hasSegments || !hasSubtitleText || !hasVideoJob || !canBurn || isAudioOnly || busy} onClick={onBurnVideo}>
            <Icon name="arrow_down_to_line" />
            <span>{busyAction === 'burn' ? 'Rendering MP4...' : 'Export burned MP4'}</span>
          </button>
          <ExportAlignedDubButton
            hasAlignedVoice={hasAlignedVoice}
            canExportAlignedVoice={canExportAlignedVoice}
            unresolvedMismatchCount={unresolvedMismatchCount}
            busy={busy}
            onExportAlignedVoice={onExportAlignedVoice}
          />
          {onOpenExportProject && (
            <button
              type="button"
              id="subtitle-export-project-btn"
              className="button button-secondary"
              disabled={busy}
              onClick={onOpenExportProject}
            >
              <Icon name="arrow_down_to_line" />
              <span>Export project{exportHistoryCount > 0 ? ` (${exportHistoryCount})` : ''}</span>
            </button>
          )}
          {showSpeakerFilter && (
            <div className="select-field select-field--plain subtitle-tts-speaker-wrap">
              <select id="subtitle-tts-speaker" aria-label="Speaker for Text to speech" value={ttsSpeakerId} disabled={busy}
                onChange={e => onChangeTtsSpeakerId?.(e.target.value)}>
                <option value="">All speakers</option>
                {speakers.map(id => <option key={id} value={id}>{resolveSpeakerLabel(id, speakerNames)}</option>)}
              </select>
              <Icon name="chevron_down" className="select-chevron" />
            </div>
          )}
          <button type="button" id="subtitle-send-tts-btn" className="button button-primary"
            disabled={!hasSegments || busy} onClick={onSendToTts}>
            <Icon name="waveform" /><span>{sendTtsLabel}</span>
          </button>
        </div>
      </div>
      <LiveStatusText
        as="div"
        className={status.error ? 'status is-error' : 'status'}
        role="status"
        ariaLive="polite"
        status={status}
        busyStartedAt={busyMeta?.startedAt || null}
        busyMessage={busyMeta?.message || ''}
        fallbackMessage="Upload a video or audio clip, extract subtitles, and export dialogue or burned-in MP4."
      />
    </section>
  );
}
