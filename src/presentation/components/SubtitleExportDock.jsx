/**
 * @fileoverview Bottom export dock for Video-to-Subtitle: TXT, SRT, VTT, burned MP4 export, and TTS handoff.
 */

import React from 'react';
import { Icon } from './Icon.jsx';

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
      <button type="button" className="button button-secondary" disabled={!hasSegments || busy} onClick={() => onExportFile('txt')}>
        <Icon name="arrow_down_to_line" /><span>Download .txt</span>
      </button>
    </div>
  );
}

/**
 * Renders the Subtitle workspace footer with live status and export/handoff actions.
 * Inputs: `{ hasSegments, canBurn, busy, busyAction, status, onExportFile, onCopyDialogue, onBurnVideo, onSendToTts }`.
 * Outputs: `<section className="playback subtitle-dock">`.
 * Side effects: triggers file download, clipboard copy, MP4 burn-in, or TTS transfer.
 * Failure modes: disables invalid export buttons cleanly until extraction completes.
 * @param {object} props - Export dock props.
 * @returns {React.ReactElement} Subtitle export dock.
 */
export function SubtitleExportDock({
  hasSegments,
  canBurn,
  busy,
  busyAction,
  status,
  onExportFile,
  onCopyDialogue,
  onBurnVideo,
  onSendToTts,
}) {
  return (
    <section className="playback subtitle-dock" aria-label="Subtitle export" data-idle={hasSegments || busy ? 'false' : 'true'}>
      <div className="subtitle-dock-actions">
        <ExportFormatButtons hasSegments={hasSegments} busy={busy} onExportFile={onExportFile} onCopyDialogue={onCopyDialogue} />
        <div className="subtitle-export-primary">
          <button type="button" id="subtitle-burn-btn" className="button button-secondary"
            disabled={!hasSegments || !canBurn || busy} onClick={onBurnVideo}>
            <Icon name="arrow_down_to_line" />
            <span>{busyAction === 'burn' ? 'Rendering MP4...' : 'Export burned MP4'}</span>
          </button>
          <button type="button" id="subtitle-send-tts-btn" className="button button-primary"
            disabled={!hasSegments || busy} onClick={onSendToTts}>
            <Icon name="waveform" /><span>Send to Text to speech</span>
          </button>
        </div>
      </div>
      <div className={status.error ? 'status is-error' : 'status'} role="status" aria-live="polite">
        {status.message || 'Upload a video or audio clip, extract subtitles, and export dialogue or burned-in MP4.'}
      </div>
    </section>
  );
}
