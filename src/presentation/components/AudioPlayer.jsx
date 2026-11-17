/**
 * @fileoverview Audio waveform player, character voice-pin action, and WAV download dock.
 */

import React, { useEffect, useRef, useState } from 'react';
import { formatTime, readPlaybackDuration, readPlaybackSeconds } from '../../domain/audioValidation.js';
import { useStudioServices } from '../StudioContext.jsx';
import { useRecordingMedia } from '../hooks/useRecordingMedia.js';
import { Icon } from './Icon.jsx';

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
function PlaybackInfo({ status }) {
  return (
    <div className="playback-info">
      <div className="playback-heading">
        <h2 id="playback-title">Generated audio</h2>
        <span className="audio-format">WAV · 48 kHz</span>
      </div>
      <p id="generation-status" className={status.error ? 'generation-status is-error' : 'generation-status'} role="status">
        {status.message}
      </p>
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

/**
 * Renders play/pause, waveform scrubber, character voice-pin button, and WAV download link.
 * @param {object} props - Controls props.
 * @returns {React.ReactElement} Player controls row.
 */
function PlaybackControls({ media, recording, activeCharacter, activeAnchor, onTogglePlay, onSeek, onPinTake }) {
  const downloadName = recording?.seed != null ? `voxcpm2-${recording.seed}.wav` : 'voxcpm2.wav';
  const pin = resolvePinControlState({ recording, activeCharacter, activeAnchor });
  return (
    <div className="player">
      <button type="button" className="button play-button" id="play"
        aria-label={media.playing ? 'Pause audio' : 'Play audio'} disabled={!media.duration} onClick={onTogglePlay}>
        <Icon name={media.playing ? 'pause_fill' : 'play_fill'} />
      </button>
      <AudioTrackBar media={media} onSeek={onSeek} />
      <div className="player-actions">
        <button type="button" className={pin.isLocked ? 'button lock-button is-locked' : 'button lock-button'}
          id="lock-voice" disabled={pin.disabled} aria-pressed={pin.isLocked} onClick={onPinTake} title={pin.title}>
          <Icon name="lock" /><span>{pin.label}</span>
        </button>
        <a className="button download-button" id="download" href={media.url || undefined}
          download={downloadName} aria-disabled={media.url ? undefined : true}>
          <Icon name="arrow_down_to_line" /><span>Download WAV</span>
        </a>
      </div>
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
 * Renders the playback dock with status line, play/pause toggle, waveform scrubber, character lock, and WAV download.
 * Inputs: `{ recording, activeCharacter, activeAnchor, status, onPinTake, onPlaybackError }`.
 * Outputs: `<section className="playback">` element.
 * Side effects: mounts a fresh `<audio>` per recording URL, tracks playback timing, and delegates decoding to `useRecordingMedia`.
 * Failure modes: calls `onPlaybackError` if `<audio>` fails to load or `play()` rejects.
 * @param {object} props - Player props.
 * @returns {React.ReactElement} Audio player dock.
 */
export function AudioPlayer({ recording, activeCharacter, activeAnchor, status, onPinTake, onPlaybackError }) {
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
    <section className="playback" aria-labelledby="playback-title">
      <PlaybackInfo status={status} />
      <PlaybackControls media={media} recording={recording} activeCharacter={activeCharacter}
        activeAnchor={activeAnchor} onSeek={handleSeek} onPinTake={onPinTake}
        onTogglePlay={() => void toggleAudioElement({ element: audio.current, logger, onPlaybackError })} />
      <PlaybackAudioElement audioRef={audio} url={media.url} logger={logger} setMedia={setMedia} onPlaybackError={onPlaybackError} />
    </section>
  );
}
