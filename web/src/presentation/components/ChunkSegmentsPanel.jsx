/**
 * @fileoverview Collapsible per-segment script editor with isolated playback and one-chunk regeneration.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { formatTime } from '../../domain/audioValidation.js';
import { Icon } from './Icon.jsx';

/**
 * Revokes a chunk object URL only when the runtime supports it.
 * @param {string|null} url - Object URL to release.
 */
function revokeObjectUrl(url) {
  if (url && typeof URL?.revokeObjectURL === 'function') URL.revokeObjectURL(url);
}

/**
 * Formats one chunk duration for its row label.
 * @param {number} seconds - Duration metadata.
 * @returns {string} `m:ss` label or an em dash when unavailable.
 */
function formatChunkDuration(seconds) {
  return Number.isFinite(seconds) && seconds > 0 ? formatTime(seconds) : '—';
}

/**
 * Renders the collapsible Segments drawer for a multi-chunk recording.
 * Inputs: `{ recording, busy, regeneratingIndex, disabled, onRegenerate, onPlaybackError }`.
 * Outputs: `<details className="segments-drawer">` element or null below two chunks.
 * Side effects: creates and revokes one object URL for the currently playing chunk.
 * Failure modes: reports playback failures through `onPlaybackError` while keeping the drawer usable.
 * @param {object} props - Segment drawer props.
 * @returns {React.ReactElement|null} Segment drawer or null.
 */
export function ChunkSegmentsPanel({ recording, busy = false, regeneratingIndex = null, disabled = false, onRegenerate, onPlaybackError }) {
  const chunks = Array.isArray(recording?.chunks) ? recording.chunks : [];
  const [edits, setEdits] = useState({});
  const [playing, setPlaying] = useState(null);
  const audioRef = useRef(null);
  const playingRef = useRef(null);

  useEffect(() => { setEdits({}); }, [recording?.id]);

  const releasePlaying = useCallback((updateState = true) => {
    const current = playingRef.current;
    if (!current) return;
    audioRef.current?.pause?.();
    revokeObjectUrl(current.url);
    playingRef.current = null;
    if (updateState) setPlaying(null);
  }, []);

  // Replacing the merged take must release the chunk URL created for the old audio.
  useEffect(() => {
    if (playingRef.current) releasePlaying(true);
  }, [recording?.id, recording?.blob, releasePlaying]);

  // Unmount cleanup must never leak a chunk object URL.
  useEffect(() => () => {
    const current = playingRef.current;
    if (!current) return;
    audioRef.current?.pause?.();
    revokeObjectUrl(current.url);
    playingRef.current = null;
  }, []);

  useEffect(() => {
    if (!playing?.url) return;
    const promise = audioRef.current?.play?.();
    if (promise?.catch) promise.catch(() => { releasePlaying(true); onPlaybackError?.(); });
  }, [playing, releasePlaying, onPlaybackError]);

  if (chunks.length < 2) return null;

  const togglePlay = index => {
    const current = playingRef.current;
    if (current?.index === index) {
      releasePlaying(true);
      return;
    }
    if (current) releasePlaying(true);
    const blob = chunks[index]?.blob;
    if (!blob || typeof URL?.createObjectURL !== 'function') return;
    const url = URL.createObjectURL(blob);
    playingRef.current = { index, url };
    setPlaying({ index, url });
  };

  const regenerate = async index => {
    const currentText = (edits[index] ?? chunks[index]?.text ?? '').trim();
    if (!currentText || busy || disabled) return;
    const updated = await onRegenerate?.(index, currentText);
    const nextText = updated?.chunks?.[index]?.text;
    if (nextText == null) return;
    setEdits(previous => {
      if (nextText === currentText) {
        const { [index]: _removed, ...rest } = previous;
        return rest;
      }
      return { ...previous, [index]: nextText };
    });
  };

  return (
    <details className="segments-drawer" open>
      <summary className="segments-summary">
        <Icon name="list_bullet" />
        <span>Segments ({chunks.length})</span>
        {busy && regeneratingIndex != null && (
          <span className="segments-summary-status" role="status">
            Regenerating segment {regeneratingIndex + 1}…
          </span>
        )}
        <Icon name="chevron_down" />
      </summary>
      <div className="segments-body">
        <p className="segments-note">
          Fix one mispronounced part and regenerate only that segment. The merged take updates instantly.
        </p>
        <ol className="segment-list">
          {chunks.map((chunk, index) => {
            const value = edits[index] ?? chunk.text ?? '';
            const isPlaying = playing?.index === index;
            const isRegenerating = busy && regeneratingIndex === index;
            return (
              <li className={isRegenerating ? 'segment-row is-regenerating' : 'segment-row'} key={`${recording?.id || 'take'}-${chunk.index}`}>
                <div className="segment-row-head">
                  <span className="segment-index">Segment {index + 1}</span>
                  <span className="segment-duration">{formatChunkDuration(chunk.durationSeconds)}</span>
                </div>
                <textarea className="segment-text" aria-label={`Segment ${index + 1} text`} rows={2}
                  spellCheck={false} value={value} disabled={disabled}
                  onChange={event => setEdits(previous => ({ ...previous, [index]: event.target.value }))} />
                <div className="segment-actions">
                  <button type="button" className="button subtle-button segment-play"
                    aria-label={`${isPlaying ? 'Pause' : 'Play'} segment ${index + 1}`} aria-pressed={isPlaying}
                    disabled={disabled || !chunk.blob} onClick={() => togglePlay(index)}>
                    <Icon name={isPlaying ? 'pause_fill' : 'play_fill'} />
                    <span>{isPlaying ? 'Pause' : 'Play'}</span>
                  </button>
                  <button type="button" className="button subtle-button segment-regenerate"
                    aria-label={`Regenerate segment ${index + 1}`}
                    disabled={busy || disabled || !value.trim()} onClick={() => void regenerate(index)}>
                    <Icon name="merge" />
                    <span>{isRegenerating ? 'Regenerating…' : 'Regenerate'}</span>
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
      <audio key={playing?.url || 'segment-idle'} ref={audioRef} className="segment-audio" src={playing?.url || undefined}
        preload="none" autoPlay onEnded={() => releasePlaying(true)}
        onError={() => { releasePlaying(true); onPlaybackError?.(); }} />
    </details>
  );
}
