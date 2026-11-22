/**
 * @fileoverview Audio waveform player, character voice-pin action, and WAV download dock.
 */

import React, { useEffect, useRef, useState } from 'react';
import { formatTime, readPlaybackDuration, readPlaybackSeconds } from '../../domain/audioValidation.js';
import { formatVerificationSummary } from '../../domain/speechVerification.js';
import { useStudioServices } from '../StudioContext.jsx';
import { useRecordingMedia } from '../hooks/useRecordingMedia.js';
import { Icon } from './Icon.jsx';
import { LiveStatusText } from './LiveStatusText.jsx';

const BAR_STEP_PX = 5;
const BAR_WIDTH_PX = 2.5;
const IDLE_BAR_WIDTH_PX = 2;

/**
 * Draws a dotted idle baseline when no decoded waveform peaks are loaded.
 * @param {CanvasRenderingContext2D} context - 2D canvas context.
 * @param {{ width: number, height: number }} size - CSS pixel dimensions.
 * @param {string} color - Track color.
 */
function drawIdleBaseline(context, size, color) {
  context.fillStyle = color;
  for (let x = 1; x < size.width; x += BAR_STEP_PX) {
    context.fillRect(x, size.height / 2, IDLE_BAR_WIDTH_PX, 1);
  }
}

/**
 * Draws amplitude bars colored by playback progress onto the canvas.
 * @param {{ context: CanvasRenderingContext2D, size: { width: number, height: number }, peaks: number[], progress: number, colors: { track: string, played: string } }} params - Render params.
 */
function drawAmplitudeBars({ context, size, peaks, progress, colors }) {
  const bars = Math.max(1, Math.floor(size.width / BAR_STEP_PX));
  for (let i = 0; i < bars; i++) {
    const level = peaks[Math.floor((i * peaks.length) / bars)];
    const barHeight = Math.max(2, level * (size.height - 4));
    context.fillStyle = i / bars <= progress ? colors.played : colors.track;
    context.fillRect((i * size.width) / bars + 1, (size.height - barHeight) / 2, BAR_WIDTH_PX, barHeight);
  }
}

/**
 * Configures DPI scaling and delegates to idle or active waveform drawing.
 * @param {{ element: HTMLCanvasElement, size: { width: number, height: number }, peaks: number[], progress: number }} params - Canvas draw state.
 */
function renderWaveformCanvas({ element, size, peaks, progress }) {
  const context = element.getContext('2d');
  if (!context) return;
  const density = window.devicePixelRatio || 1;
  element.width = Math.round(size.width * density);
  element.height = Math.round(size.height * density);
  context.scale(density, density);
  const styles = getComputedStyle(element);
  const track = styles.getPropertyValue('--wave-neutral');
  if (!peaks.length) {
    drawIdleBaseline(context, size, track);
    return;
  }
  drawAmplitudeBars({ context, size, peaks, progress, colors: { track, played: styles.getPropertyValue('--accent') } });
}

/**
 * Responsive canvas waveform display tracking playback progress and appearance changes.
 * @param {{ peaks: number[], progress: number }} props - Normalized peaks and [0, 1] progress.
 * @returns {React.ReactElement} Canvas element.
 */
function Waveform({ peaks, progress }) {
  const canvas = useRef(null);
  const [size, setSize] = useState(null);

  useEffect(() => {
    const observer = new ResizeObserver(([{ contentRect }]) => setSize({ width: contentRect.width, height: contentRect.height }));
    observer.observe(canvas.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!size?.width || !size.height) return;
    const draw = () => renderWaveformCanvas({ element: canvas.current, size, peaks, progress });
    const appearance = window.matchMedia('(prefers-color-scheme: dark)');
    draw();
    appearance.addEventListener('change', draw);
    return () => appearance.removeEventListener('change', draw);
  }, [size, peaks, progress]);

  return <canvas id="waveform" ref={canvas} aria-hidden="true" />;
}

/**
 * Renders playback heading and generation status message.
 * @param {{ status: { message: string, error: boolean } }} props - Status props.
 * @returns {React.ReactElement} Status block.
 */
function PlaybackInfo({ status, busyMeta }) {
  return (
    <div className="playback-info">
      <div className="playback-heading">
        <h2 id="playback-title">Generated audio</h2>
        <span className="audio-format">WAV · 48 kHz</span>
      </div>
      <LiveStatusText
        id="generation-status"
        className={status.error ? 'generation-status is-error' : 'generation-status'}
        role="status"
        status={status}
        busyStartedAt={busyMeta?.startedAt || null}
        busyMessage={busyMeta?.message || ''}
      />
    </div>
  );
}

/**
 * Toggles HTMLAudioElement playback safely, reloading stale elements before playing and logging errors.
 * Inputs: `{ element, logger, onPlaybackError }`.
 * Outputs: Promise settling after play/pause completes.
 * Side effects: mutates HTMLAudioElement playback state; logs errors via `logger`.
 * Failure modes: calls `onPlaybackError` if `element.play()` rejects.
 * @param {{ element: HTMLAudioElement|null, logger: import('../../domain/ports.js').LoggerPort, onPlaybackError: () => void }} params - Toggle params.
 */
export async function toggleAudioElement({ element, logger, onPlaybackError }) {
  if (!element) return;
  if (!element.paused) {
    element.pause();
    return;
  }
  const hasSrc = Boolean(element.src || element.getAttribute?.('src'));
  if ((element.error || element.readyState === 0) && hasSrc && typeof element.load === 'function') {
    element.load();
  }
  try {
    await element.play();
  } catch (error) {
    logger.error('AudioPlayer.toggleAudioElement', error);
    onPlaybackError();
  }
}

/**
 * Renders the waveform progress scrubber and elapsed/total timestamps.
 * @param {{ media: object, onSeek: (event: Event) => void }} props - Scrubber props.
 * @returns {React.ReactElement} Track bar element.
 */
function AudioTrackBar({ media, onSeek }) {
  const progress = media.duration ? media.seconds / media.duration : 0;
  return (
    <div className="audio-track">
      <div className="waveform">
        <Waveform peaks={media.peaks} progress={progress} />
        <input id="seek" type="range" aria-label="Audio position" min="0" max={media.duration || 1}
          step="0.01" value={media.seconds} disabled={!media.duration} onChange={onSeek}
          aria-valuetext={`${formatTime(media.seconds)} of ${formatTime(media.duration)}`} />
      </div>
      <div className="timestamps" aria-hidden="true">
        <span id="elapsed">{formatTime(media.seconds)}</span>
        <span id="duration">{formatTime(media.duration)}</span>
      </div>
    </div>
  );
}

/**
 * Resolves the character voice-lock button label, state, and tooltip from the active recording and character.
 * Inputs: `{ recording, activeCharacter, activeAnchor }`.
 * Outputs: `{ label, disabled, isLocked, title }`.
 * Side effects: none.
 * Failure modes: degrades safely when recording or activeCharacter is missing.
 * @param {{ recording: object|null, activeCharacter: object, activeAnchor: object|null }} spec - Player lock context.
 * @returns {{ label: string, disabled: boolean, isLocked: boolean, title: string }} Button UI state.
 */
export function resolvePinControlState({ recording, activeCharacter, activeAnchor }) {
  const activeName = activeCharacter?.name || 'character';
  if (!recording) {
    return { label: 'Lock voice', disabled: true, isLocked: false, title: 'Generate speech before locking a voice' };
  }
  if (recording.characterId && recording.characterId !== activeCharacter?.id) {
    const owner = recording.characterName || recording.characterId;
    return {
      label: `Recorded as ${owner}`,
      disabled: true,
      isLocked: false,
      title: `This audio belongs to ${owner}. Select ${owner} or generate new speech for ${activeName}.`,
    };
  }
  if (activeAnchor?.takeId === recording.id) {
    return { label: `Locked to ${activeName}`, disabled: true, isLocked: true, title: `${activeName} already uses this voice take` };
  }
  if (activeAnchor) {
    return { label: `Use as ${activeName}'s voice`, disabled: false, isLocked: false, title: `Replace ${activeName}'s locked voice with this take` };
  }
  return { label: `Set as ${activeName}'s voice`, disabled: false, isLocked: false, title: `Bind this audio take as ${activeName}'s exclusive voice` };
}

function SpeechVerificationPanel({ verification }) {
  if (!verification || (!verification.result && !verification.error)) return null;
  if (verification.error) {
    return (
      <div className="speech-verify-card is-fail" role="status">
        <div className="speech-verify-head">
          <span className="speech-verify-badge is-fail">Check failed</span>
          <span className="speech-verify-copy">{verification.error}</span>
        </div>
        <button type="button" className="button subtle-button speech-verify-dismiss"
          aria-label="Dismiss word check" onClick={verification.onDismiss}>
          <Icon name="xmark" />
        </button>
      </div>
    );
  }
  const summary = formatVerificationSummary(verification.result);
  const heard = verification.result?.heardText || '';
  const missing = Array.isArray(verification.result?.missingTerms) ? verification.result.missingTerms : [];
  return (
    <div className={`speech-verify-card is-${summary.tone}`} role="status" data-verdict={summary.tone}>
      <div className="speech-verify-head">
        <span className={`speech-verify-badge is-${summary.tone}`}>{summary.label}</span>
        <span className="speech-verify-copy" dir="auto">
          {heard ? `Whisper heard: ${heard}` : 'Whisper did not detect clear speech.'}
        </span>
        {missing.length > 0 && (
          <span className="speech-verify-missing" dir="auto">
            Missing / unclear: {missing.join(', ')}
          </span>
        )}
      </div>
      <button type="button" className="button subtle-button speech-verify-dismiss"
        aria-label="Dismiss word check" onClick={verification.onDismiss}>
        <Icon name="xmark" />
      </button>
    </div>
  );
}

/**
 * Formats one take pill label as `Take N · m:ss` when duration metadata is available.
 * @param {object} take - Session recording.
 * @param {number} index - Zero-based take index.
 * @returns {string} Accessible take label.
 */
function formatTakeLabel(take, index) {
  const label = `Take ${index + 1}`;
  const seconds = take?.audioDurationSeconds;
  return Number.isFinite(seconds) && seconds > 0 ? `${label} · ${formatTime(seconds)}` : label;
}

/**
 * Renders compact A/B take selector pills for the bounded session history.
 * @param {{ takes: object[], activeTakeId: string|null, onSelectTake?: Function, onDeleteTake?: Function }} props - Take history props.
 * @returns {React.ReactElement|null} Take strip or null when fewer than two takes exist.
 */
function TakeHistoryPills({ takes, activeTakeId, onSelectTake, onDeleteTake }) {
  if (!Array.isArray(takes) || takes.length <= 1) return null;
  return (
    <div className="take-history" role="group" aria-label="Generated takes">
      <span className="take-history-label" aria-hidden="true">Takes</span>
      <div className="take-history-pills">
        {takes.map((take, index) => {
          const label = formatTakeLabel(take, index);
          const isActive = take.id === activeTakeId;
          const detail = [take.characterName, take.transcript].filter(Boolean).join(' · ');
          return (
            <span className={isActive ? 'take-pill-group is-active' : 'take-pill-group'} key={take.id}>
              <button type="button" className="button take-pill" aria-pressed={isActive}
                aria-label={label} title={detail || label} onClick={() => onSelectTake?.(take.id)}>
                {label}
              </button>
              {isActive && onDeleteTake && (
                <button type="button" className="button take-pill-delete" aria-label={`Delete ${label}`}
                  title={`Delete ${label}`} onClick={() => onDeleteTake(take.id)}>
                  <Icon name="xmark" />
                </button>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function resolveNarrationDownloadName(recording) {
  if (recording?.filename) return recording.filename;
  if (recording?.isAssembled || recording?.isRestitched) return 'voxcpm2-assembled-narration.wav';
  if (recording?.isMultiSpeaker) return 'voxcpm2-multi-speaker.wav';
  if (recording?.seed != null) return `voxcpm2-${recording.seed}.wav`;
  return 'voxcpm2.wav';
}

function PlaybackActionButtons({ media, recording, activeCharacter, activeAnchor, verification, onPinTake }) {
  const downloadName = resolveNarrationDownloadName(recording);
  const downloadLabel = recording?.isAssembled ? 'Export Narration' : 'Download WAV';
  const downloadTitle = recording?.isAssembled ? 'Export complete assembled narration WAV' : 'Download WAV';
  const pin = resolvePinControlState({ recording, activeCharacter, activeAnchor });
  const canVerify = Boolean(verification?.canVerify && verification?.onVerify);
  return (
    <div className="player-actions">
      {verification?.onVerify && (
        <button type="button" className="button subtle-button verify-button" id="verify-speech-btn"
          disabled={!canVerify || verification.checking} aria-busy={verification.checking || undefined}
          title="Double-check spoken Khmer words using Whisper" onClick={verification.onVerify}>
          <Icon name="check_circle" /><span>{verification.checking ? 'Checking…' : 'Check words'}</span>
        </button>
      )}
      <button type="button" className={pin.isLocked ? 'button lock-button is-locked' : 'button lock-button'}
        id="lock-voice" disabled={pin.disabled} aria-pressed={pin.isLocked} onClick={onPinTake} title={pin.title}>
        <Icon name="lock" /><span>{pin.label}</span>
      </button>
      <a className="button download-button" id="download" href={media.url || undefined}
        download={downloadName} aria-disabled={media.url ? undefined : true} title={downloadTitle}>
        <Icon name="arrow_down_to_line" /><span>{downloadLabel}</span>
      </a>
    </div>
  );
}

/**
 * Renders play/pause, waveform scrubber, optional Whisper word-check button, character voice-pin button, and WAV download link.
 * @param {object} props - Controls props.
 * @returns {React.ReactElement} Player controls row.
 */
function PlaybackControls(props) {
  const { media, onTogglePlay, onSeek } = props;
  return (
    <div className="player">
      <button type="button" className="button play-button" id="play"
        aria-label={media.playing ? 'Pause audio' : 'Play audio'} disabled={!media.duration} onClick={onTogglePlay}>
        <Icon name={media.playing ? 'pause_fill' : 'play_fill'} />
      </button>
      <AudioTrackBar media={media} onSeek={onSeek} />
      <PlaybackActionButtons {...props} />
    </div>
  );
}

const PROGRESS_EPSILON_SECONDS = 0.01;

/**
 * Syncs duration immediately when a mounted `<audio>` element already holds metadata (`readyState >= 1`).
 * @param {{ audioRef: React.RefObject<HTMLAudioElement|null>, url: string|null, setMedia: Function }} params - Sync inputs.
 */
function useAudioMetadataSync({ audioRef, url, setMedia }) {
  useEffect(() => {
    const element = audioRef.current;
    if (!url || !element) return;
    const duration = readPlaybackDuration({ currentTarget: element });
    if (duration > 0) setMedia(previous => ({ ...previous, duration }));
  }, [audioRef, url, setMedia]);
}

/**
 * Advances scrubber timestamps smoothly via `requestAnimationFrame` while `<audio>` plays.
 * @param {{ audioRef: React.RefObject<HTMLAudioElement|null>, playing: boolean, setMedia: Function }} params - Progress sync inputs.
 */
function usePlayingProgressSync({ audioRef, playing, setMedia }) {
  useEffect(() => {
    if (!playing || typeof globalThis.requestAnimationFrame !== 'function') return;
    let frameId = 0;
    const tick = () => {
      const next = readPlaybackSeconds({ currentTarget: audioRef.current });
      setMedia(prev => (Math.abs(next - prev.seconds) >= PROGRESS_EPSILON_SECONDS ? { ...prev, seconds: next } : prev));
      frameId = globalThis.requestAnimationFrame(tick);
    };
    frameId = globalThis.requestAnimationFrame(tick);
    return () => globalThis.cancelAnimationFrame(frameId);
  }, [audioRef, playing, setMedia]);
}

/**
 * Reads audio duration synchronously during DOM event dispatch before React defers the state updater.
 * @param {Event} event - Audio element readiness event.
 * @param {Function} setMedia - React state setter.
 */
function syncAudioDurationFromEvent(event, setMedia) {
  const duration = readPlaybackDuration(event);
  if (duration > 0) setMedia(previous => ({ ...previous, duration }));
}

/**
 * Reads audio position synchronously during `timeupdate` before the browser clears `event.currentTarget`.
 * @param {Event} event - Audio element `timeupdate` event.
 * @param {Function} setMedia - React state setter.
 */
function syncAudioSecondsFromEvent(event, setMedia) {
  const seconds = readPlaybackSeconds(event);
  setMedia(previous => ({ ...previous, seconds }));
}

/**
 * Logs `<audio>` element errors and transitions player state out of playing.
 * @param {{ event: Event, url: string|null, logger: import('../../domain/ports.js').LoggerPort, setMedia: Function, onPlaybackError: () => void }} params - Error handler context.
 */
function reportAudioElementError({ event, url, logger, setMedia, onPlaybackError }) {
  if (!url) return;
  logger.error('AudioPlayer.audioElement', event?.currentTarget?.error || new Error('Audio playback failed'));
  setMedia(previous => ({ ...previous, playing: false }));
  onPlaybackError();
}

/**
 * Renders an isolated `<audio>` element keyed by URL so each recording mounts with clean media state.
 * @param {{ audioRef: React.RefObject<HTMLAudioElement|null>, url: string|null, logger: import('../../domain/ports.js').LoggerPort, setMedia: Function, onPlaybackError: () => void }} props - Media element props.
 * @returns {React.ReactElement} Keyed `<audio>` element.
 */
function PlaybackAudioElement({ audioRef, url, logger, setMedia, onPlaybackError }) {
  const syncDuration = event => syncAudioDurationFromEvent(event, setMedia);
  const syncSeconds = event => syncAudioSecondsFromEvent(event, setMedia);
  const handleError = event => reportAudioElementError({ event, url, logger, setMedia, onPlaybackError });
  return (
    <audio key={url || 'empty'} id="audio" ref={audioRef} src={url || undefined} preload="auto"
      onLoadedMetadata={syncDuration} onDurationChange={syncDuration} onLoadedData={syncDuration} onCanPlay={syncDuration}
      onTimeUpdate={syncSeconds}
      onPlay={() => setMedia(previous => ({ ...previous, playing: true }))}
      onPause={() => setMedia(previous => ({ ...previous, playing: false }))}
      onEnded={() => setMedia(previous => ({ ...previous, playing: false, seconds: 0 }))}
      onError={handleError} />
  );
}

/**
 * Renders the playback dock with status line, play/pause toggle, waveform scrubber, take A/B pills, character lock, and WAV download.
 * Inputs: `{ recording, takes, activeTakeId, activeCharacter, activeAnchor, status, onPinTake, onSelectTake, onDeleteTake, onPlaybackError }`.
 * Outputs: `<section className="playback">` element.
 * Side effects: mounts a fresh `<audio>` per recording URL, tracks playback timing, and delegates decoding to `useRecordingMedia`.
 * Failure modes: calls `onPlaybackError` if `<audio>` fails to load or `play()` rejects.
 * @param {object} props - Player props.
 * @returns {React.ReactElement} Audio player dock.
 */
export function AudioPlayer({ recording, takes = [], activeTakeId = null, activeCharacter, activeAnchor, status, busyMeta = null, verification = null, onPinTake, onSelectTake, onDeleteTake, onPlaybackError }) {
  const { logger } = useStudioServices();
  const audio = useRef(null);
  const [media, setMedia] = useRecordingMedia(recording);
  useAudioMetadataSync({ audioRef: audio, url: media.url, setMedia });
  usePlayingProgressSync({ audioRef: audio, playing: media.playing, setMedia });

  const handleSeek = event => {
    const position = event.currentTarget.valueAsNumber;
    if (!audio.current) return;
    audio.current.currentTime = position;
    setMedia(previous => ({ ...previous, seconds: position }));
  };

  return (
    <section className="playback" data-has-audio={media.url ? 'true' : 'false'} aria-labelledby="playback-title">
      <PlaybackInfo status={status} busyMeta={busyMeta} />
      <PlaybackControls media={media} recording={recording} activeCharacter={activeCharacter}
        activeAnchor={activeAnchor} verification={verification} onSeek={handleSeek} onPinTake={onPinTake}
        onTogglePlay={() => void toggleAudioElement({ element: audio.current, logger, onPlaybackError })} />
      <TakeHistoryPills takes={takes} activeTakeId={activeTakeId || recording?.id || null}
        onSelectTake={onSelectTake} onDeleteTake={onDeleteTake} />
      <SpeechVerificationPanel verification={verification} />
      <PlaybackAudioElement audioRef={audio} url={media.url} logger={logger} setMedia={setMedia} onPlaybackError={onPlaybackError} />
    </section>
  );
}
