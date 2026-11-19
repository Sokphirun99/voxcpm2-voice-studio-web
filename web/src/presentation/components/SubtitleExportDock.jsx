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

/**
 * Renders the Subtitle workspace footer with live status, export buttons, optional speaker TTS filter, and burn-in action.
 * Inputs: `{ hasSegments, hasSubtitleText, canBurn, isAudioOnly, speakers, speakerNames, ttsSpeakerId, onChangeTtsSpeakerId, busy, busyAction, busyMeta, status, onExportFile, onCopyDialogue, onBurnVideo, onSendToTts }`.
 * Outputs: `<section className="playback subtitle-dock">`.
 * Side effects: triggers file download, clipboard copy, MP4 burn-in, or TTS transfer.
 * Failure modes: disables invalid export buttons cleanly until extraction completes or when audio-only.
 * @param {object} props - Export dock props.
 * @returns {React.ReactElement} Subtitle export dock.
 */
export function SubtitleExportDock({
  hasSegments,
  hasSubtitleText = hasSegments,
  selectedCount = 0,
  canBurn,
  isAudioOnly = false,
  speakers = [],
  speakerNames = {},
  ttsSpeakerId = '',
  onChangeTtsSpeakerId,
  busy,
  busyAction,
  busyMeta = null,
  status,
  onExportFile,
  onCopyDialogue,
  onBurnVideo,
  onSendToTts,
}) {
  const showSpeakerFilter = hasSegments && speakers.length > 1;
  const sendTtsLabel = selectedCount > 0 ? `Send selected to TTS (${selectedCount})` : 'Send to Text to speech';
  let burnTitle;
  if (isAudioOnly) burnTitle = 'MP4 burn-in is only available for video files';
  else if (hasSegments && !hasSubtitleText) burnTitle = 'Add subtitle text before exporting burned MP4';
  else if (hasSegments && !canBurn) burnTitle = 'MP4 burn-in requires FFmpeg with libass support';
  const isDockIdle = !hasSegments && !busy && !status?.error;
  return (
    <section className="playback subtitle-dock" aria-label="Subtitle export" data-idle={isDockIdle ? 'true' : 'false'}>
      <div className="subtitle-dock-actions">
        <ExportFormatButtons hasSegments={hasSegments} busy={busy} onExportFile={onExportFile} onCopyDialogue={onCopyDialogue} />
        <div className="subtitle-export-primary">
          <button type="button" id="subtitle-burn-btn" className="button button-secondary"
            title={burnTitle} disabled={!hasSegments || !hasSubtitleText || !canBurn || isAudioOnly || busy} onClick={onBurnVideo}>
            <Icon name="arrow_down_to_line" />
            <span>{busyAction === 'burn' ? 'Rendering MP4...' : 'Export burned MP4'}</span>
          </button>
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
