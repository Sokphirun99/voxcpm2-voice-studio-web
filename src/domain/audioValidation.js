/**
 * @fileoverview Pure domain audio formatting, waveform math, playback event guards, and upload content validation.
 */

import { ValidationError } from './errors.js';

const MAX_WAVEFORM_BUCKETS = 320;
const MIN_PEAK_FLOOR = 0.001;
const HEADER_INSPECT_BYTES = 16;

export const MAX_REFERENCE_AUDIO_BYTES = 20 * 1024 * 1024;
export const ALLOWED_AUDIO_MIME_TYPES = new Set([
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'audio/flac',
  'audio/x-flac',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/webm',
]);

/**
 * Formats seconds into `m:ss` display notation.
 * Inputs: duration in seconds.
 * Outputs: formatted timestamp string.
 * Side effects: none.
 * Failure modes: returns `'0:00'` for negative or non-finite values.
 * @param {number} seconds - Duration in seconds.
 * @returns {string} Formatted `m:ss` string.
 */
export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * Computes normalized square-root peak amplitudes from PCM samples.
 * Inputs: numeric sample sequence and optional maximum bucket count.
 * Outputs: normalized peak values in [0, 1].
 * Side effects: none.
 * Failure modes: returns empty array for empty sample sequences.
 * @param {ArrayLike<number>} samples - Audio channel PCM samples.
 * @param {number} [maxBuckets=320] - Target number of waveform buckets.
 * @returns {number[]} Normalized peak amplitudes.
 */
export function computePeaksFromSamples(samples, maxBuckets = MAX_WAVEFORM_BUCKETS) {
  if (!samples || samples.length === 0) return [];
  const buckets = Math.min(maxBuckets, samples.length);
  const values = [];
  for (let i = 0; i < buckets; i++) {
    let peak = 0;
    const start = Math.floor((i * samples.length) / buckets);
    const end = Math.floor(((i + 1) * samples.length) / buckets);
    for (let j = start; j < end; j++) peak = Math.max(peak, Math.abs(samples[j]));
    values.push(peak);
  }
  const max = Math.max(MIN_PEAK_FLOOR, ...values);
  return values.map(peak => Math.sqrt(peak / max));
}

/**
 * Checks whether leading file bytes match a supported audio container signature.
 * Inputs: Uint8Array header bytes.
 * Outputs: boolean true when recognized as WAV, MP3/ADTS, FLAC, OGG, MP4/M4A, or WebM.
 * Side effects: none.
 * Failure modes: returns false for short or unrecognized byte arrays.
 * @param {Uint8Array} bytes - Leading bytes from an audio file/blob.
 * @returns {boolean} True when magic bytes match a supported audio format.
 */
export function hasValidAudioMagicBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return false;
  const tag4 = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const tag8 = bytes.length >= 12 ? String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) : '';
  if (tag4 === 'RIFF' && tag8 === 'WAVE') return true;
  if (tag4 === 'fLaC' || tag4 === 'OggS' || tag4.startsWith('ID3')) return true;
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return true;
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return true;
  return bytes.length >= 8 && String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]) === 'ftyp';
}

/**
 * Validates reference audio size, MIME type, and leading magic bytes.
 * Inputs: Blob or File object.
 * Outputs: Promise resolving when valid.
 * Side effects: reads leading 16 bytes from the Blob slice.
 * Failure modes: throws ValidationError when empty, oversized, wrong MIME, or invalid bytes.
 * @param {Blob|File} file - Candidate reference audio file.
 * @returns {Promise<void>} Resolves if valid.
 */
export async function validateAudioFile(file) {
  if (!file || typeof file.slice !== 'function' || file.size === 0) {
    throw new ValidationError('Select a non-empty audio file.', 'referenceAudio', 'EMPTY_AUDIO');
  }
  if (file.size > MAX_REFERENCE_AUDIO_BYTES) {
    throw new ValidationError('Reference audio must be 20 MB or smaller.', 'referenceAudio', 'AUDIO_TOO_LARGE');
  }
  if (file.type && !ALLOWED_AUDIO_MIME_TYPES.has(file.type.toLowerCase())) {
    throw new ValidationError('Unsupported audio format. Use WAV, MP3, M4A, FLAC, OGG, or WebM.', 'referenceAudio', 'UNSUPPORTED_AUDIO_TYPE');
  }
  const header = new Uint8Array(await file.slice(0, HEADER_INSPECT_BYTES).arrayBuffer());
  if (!hasValidAudioMagicBytes(header)) {
    throw new ValidationError('The selected file does not appear to be valid audio.', 'referenceAudio', 'INVALID_AUDIO_CONTENT');
  }
}

/**
 * Extracts a finite non-negative time reading from an audio element event safely.
 * Inputs: DOM timeupdate event with `currentTarget`.
 * Outputs: finite number >= 0.
 * Side effects: none.
 * Failure modes: returns 0 if `currentTarget` or `currentTime` is unavailable/non-finite.
 * @param {{ currentTarget?: { currentTime?: number }|null }} event - Audio element event.
 * @returns {number} Playback position in seconds.
 */
export function readPlaybackSeconds(event) {
  const value = event?.currentTarget?.currentTime;
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Extracts a finite non-negative duration reading from an audio metadata event safely.
 * Inputs: DOM loadedmetadata event with `currentTarget`.
 * Outputs: finite number >= 0.
 * Side effects: none.
 * Failure modes: returns 0 if duration is unavailable/non-finite.
 * @param {{ currentTarget?: { duration?: number }|null }} event - Audio metadata event.
 * @returns {number} Duration in seconds.
 */
export function readPlaybackDuration(event) {
  const value = event?.currentTarget?.duration;
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
