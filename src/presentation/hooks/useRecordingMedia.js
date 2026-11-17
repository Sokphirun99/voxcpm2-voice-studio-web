/**
 * @fileoverview Presentation hook managing audio Blob object URLs, waveform decoding, and playback timing.
 */

import { useEffect, useState } from 'react';
import { ensureAudioWavBlob, tryReadWavDurationSeconds } from '../../domain/wavCodec.js';
import { useStudioServices } from '../StudioContext.jsx';

const EMPTY_MEDIA_STATE = { url: null, peaks: [], duration: 0, seconds: 0, playing: false };

/**
 * Creates an object URL for a Blob when running in a browser supporting `URL.createObjectURL`.
 * @param {Blob} blob - Audio Blob.
 * @returns {string|null} Object URL or null in non-browser runtimes.
 */
function createPlayableObjectUrl(blob) {
  return typeof URL?.createObjectURL === 'function' ? URL.createObjectURL(blob) : null;
}

/**
 * Revokes a previously created Blob object URL safely when supported.
 * @param {string|null} url - Object URL to release.
 */
function revokePlayableObjectUrl(url) {
  if (url && typeof URL?.revokeObjectURL === 'function') URL.revokeObjectURL(url);
}

/**
 * Extracts WAV duration directly from the recording Blob header without waiting for `<audio>` metadata events.
 * @param {Blob} blob - Normalized WAV Blob.
 * @returns {Promise<number>} Duration in seconds, or 0 if unavailable.
 */
async function readDurationFromWavHeader(blob) {
  if (!blob || typeof blob.arrayBuffer !== 'function') return 0;
  return tryReadWavDurationSeconds(await blob.arrayBuffer());
}

/**
 * Decodes waveform peaks and optional duration through the injected `audioDecoder` port.
 * @param {{ blob: Blob, audioDecoder: import('../../domain/ports.js').AudioDecoderPort }} params - Decode dependencies.
 * @returns {Promise<{ peaks: number[], duration: number }>} Decoded peaks and duration.
 */
async function decodeAudioSummaryWithFallback({ blob, audioDecoder }) {
  if (typeof audioDecoder.decodeAudioSummary === 'function') {
    return audioDecoder.decodeAudioSummary(blob);
  }
  const peaks = await audioDecoder.decodePeaks(blob);
  return { peaks, duration: 0 };
}

/**
 * Manages object URL lifecycle, MIME normalization, WAV/WebAudio duration extraction, and peak decoding.
 * Inputs: `{ blob, seed } | null`.
 * Outputs: `[mediaState, setMediaState]` tuple.
 * Side effects: creates and revokes Blob object URLs; reads WAV headers and invokes `audioDecoder`.
 * Failure modes: logs decode errors via injected `logger` while preserving playback duration when known.
 * @param {{ blob: Blob, seed: number|null }|null} recording - Current generated audio recording.
 * @returns {Array} Tuple `[media, setMedia]`.
 */
export function useRecordingMedia(recording) {
  const { audioDecoder, logger } = useStudioServices();
  const [media, setMedia] = useState(EMPTY_MEDIA_STATE);

  useEffect(() => {
    if (!recording?.blob) {
      setMedia(EMPTY_MEDIA_STATE);
      return;
    }
    let active = true;
    const playableBlob = ensureAudioWavBlob(recording.blob);
    const objectUrl = createPlayableObjectUrl(playableBlob);
    setMedia({ ...EMPTY_MEDIA_STATE, url: objectUrl });
    void readDurationFromWavHeader(playableBlob)
      .then(duration => { if (active && duration > 0) setMedia(previous => ({ ...previous, duration: previous.duration || duration })); })
      .catch(error => logger.error('useRecordingMedia.header', error, { size: playableBlob.size }));
    void decodeAudioSummaryWithFallback({ blob: playableBlob, audioDecoder })
      .then(({ peaks, duration }) => { if (active) setMedia(previous => ({ ...previous, peaks, duration: previous.duration || duration })); })
      .catch(error => logger.error('useRecordingMedia', error, { size: playableBlob.size }));
    return () => { active = false; revokePlayableObjectUrl(objectUrl); };
  }, [recording, audioDecoder, logger]);

  return [media, setMedia];
}
