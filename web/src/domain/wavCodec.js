/**
 * @fileoverview Pure domain PCM WAV inspector and multi-chunk concatenator for consistent long single-character playback.
 */

import { SynthesisError } from './errors.js';

const RIFF_HEADER_BYTES = 44;
const PCM_AUDIO_FORMAT = 1;
const CHUNK_HEADER_BYTES = 8;
const FIRST_SUBCHUNK_OFFSET = 12;
const MS_PER_SECOND = 1000;
const PCM_BITS_16 = 16;
const SILENCE_AMP_THRESHOLD = 128;
const MIN_TRIM_DURATION_MS = 250;
const TRIM_HEAD_PAD_MS = 45;
const TRIM_TAIL_PAD_MS = 80;
const MIN_FADE_DURATION_MS = 50;
const EDGE_FADE_MS = 5;

/**
 * Reads a 4-character ASCII tag from a DataView.
 * @param {DataView} view - Binary view.
 * @param {number} offset - Byte offset.
 * @returns {string} 4-character ASCII tag.
 */
function readTag(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

/**
 * Writes a 4-character ASCII tag into a DataView.
 * @param {DataView} view - Target view.
 * @param {number} offset - Byte offset.
 * @param {string} tag - 4-character ASCII string.
 */
function writeTag(view, offset, tag) {
  for (let i = 0; i < 4; i++) view.setUint8(offset + i, tag.charCodeAt(i));
}

/**
 * Walks RIFF subchunks to locate a named chunk (`fmt ` or `data`).
 * @param {DataView} view - WAV DataView.
 * @param {string} targetTag - Chunk tag to find.
 * @returns {{ offset: number, size: number }|null} Data payload offset and byte length.
 */
function findWaveChunk(view, targetTag) {
  let cursor = FIRST_SUBCHUNK_OFFSET;
  while (cursor + CHUNK_HEADER_BYTES <= view.byteLength) {
    const tag = readTag(view, cursor);
    const size = view.getUint32(cursor + 4, true);
    const payloadOffset = cursor + CHUNK_HEADER_BYTES;
    if (tag === targetTag) return { offset: payloadOffset, size };
    cursor = payloadOffset + size + (size % 2);
  }
  return null;
}

/**
 * Reads raw PCM format fields from a WAV `fmt ` subchunk without throwing.
 * @param {DataView} view - WAV DataView.
 * @param {number} offset - `fmt ` payload byte offset.
 * @returns {{ audioFormat: number, numChannels: number, sampleRate: number, byteRate: number, blockAlign: number, bitsPerSample: number }|null} Format fields or null if unsupported/invalid.
 */
function readPcmFmtFields(view, offset) {
  if (offset + 16 > view.byteLength) return null;
  const audioFormat = view.getUint16(offset, true);
  const numChannels = view.getUint16(offset + 2, true);
  const sampleRate = view.getUint32(offset + 4, true);
  const byteRate = view.getUint32(offset + 8, true);
  const blockAlign = view.getUint16(offset + 12, true);
  const bitsPerSample = view.getUint16(offset + 14, true);
  if (audioFormat !== PCM_AUDIO_FORMAT || !numChannels || !sampleRate || !byteRate || !blockAlign) {
    return null;
  }
  return { audioFormat, numChannels, sampleRate, byteRate, blockAlign, bitsPerSample };
}

/**
 * Wraps an audio Blob as `audio/wav` when its MIME type is missing or generic binary (`application/octet-stream`).
 * Inputs: WAV `Blob`.
 * Outputs: `Blob` guaranteed to report `audio/wav`.
 * Side effects: none.
 * Failure modes: throws TypeError if `blob` is not a Blob-like object.
 * @param {Blob} blob - Candidate WAV Blob.
 * @returns {Blob} MIME-normalized WAV Blob.
 */
export function ensureAudioWavBlob(blob) {
  if (!blob || typeof blob.arrayBuffer !== 'function') {
    throw new TypeError('Expected a valid audio Blob.');
  }
  return blob.type === 'audio/wav' ? blob : new Blob([blob], { type: 'audio/wav' });
}

/**
 * Validates and extracts PCM WAV header metadata without throwing on invalid input.
 * @param {ArrayBuffer} buffer - Candidate WAV binary buffer.
 * @returns {{ metadata: object|null, message: string|null }} Parsed metadata or error reason.
 */
function parseWavHeaderMetadata(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < RIFF_HEADER_BYTES) {
    return { metadata: null, message: 'VoxCPM2 returned an incomplete audio file.' };
  }
  const view = new DataView(buffer);
  if (readTag(view, 0) !== 'RIFF' || readTag(view, 8) !== 'WAVE') {
    return { metadata: null, message: 'VoxCPM2 returned a non-WAV audio payload.' };
  }
  const fmt = findWaveChunk(view, 'fmt ');
  const data = findWaveChunk(view, 'data');
  if (!fmt || !data || fmt.size < 16 || data.offset + data.size > buffer.byteLength) {
    return { metadata: null, message: 'VoxCPM2 returned a corrupted WAV structure.' };
  }
  const fields = readPcmFmtFields(view, fmt.offset);
  if (!fields) return { metadata: null, message: 'Unsupported WAV encoding returned by VoxCPM2.' };
  return { metadata: { ...fields, dataOffset: data.offset, dataSize: data.size }, message: null };
}

/**
 * Inspects a RIFF/WAVE PCM buffer and extracts audio format and data slice metadata.
 * Inputs: `ArrayBuffer` containing a WAV file.
 * Outputs: `{ audioFormat, numChannels, sampleRate, byteRate, blockAlign, bitsPerSample, dataOffset, dataSize }`.
 * Side effects: none.
 * Failure modes: throws SynthesisError (`INVALID_WAV`) if headers or PCM fields are malformed.
 * @param {ArrayBuffer} buffer - Raw WAV binary buffer.
 * @returns {{ audioFormat: number, numChannels: number, sampleRate: number, byteRate: number, blockAlign: number, bitsPerSample: number, dataOffset: number, dataSize: number }} Parsed metadata.
 */
export function inspectWavBuffer(buffer) {
  const { metadata, message } = parseWavHeaderMetadata(buffer);
  if (!metadata) throw new SynthesisError(message, { code: 'INVALID_WAV' });
  return metadata;
}

/**
 * Extracts playback duration in seconds from a WAV buffer, returning 0 if headers are invalid or incomplete.
 * Inputs: candidate binary `ArrayBuffer`.
 * Outputs: finite duration in seconds (`>= 0`).
 * Side effects: none.
 * Failure modes: returns 0 without throwing when the buffer is not valid PCM WAV.
 * @param {ArrayBuffer} buffer - Candidate WAV binary buffer.
 * @returns {number} Duration in seconds, or 0 if unreadable.
 */
export function tryReadWavDurationSeconds(buffer) {
  const { metadata } = parseWavHeaderMetadata(buffer);
  if (!metadata || metadata.byteRate <= 0) return 0;
  const seconds = metadata.dataSize / metadata.byteRate;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

/**
 * Computes playback duration in seconds from a PCM WAV ArrayBuffer.
 * Inputs: WAV `ArrayBuffer`.
 * Outputs: duration in seconds.
 * Side effects: none.
 * Failure modes: throws SynthesisError if WAV buffer is malformed.
 * @param {ArrayBuffer} buffer - WAV binary buffer.
 * @returns {number} Duration in seconds.
 */
export function readWavDurationSeconds(buffer) {
  const info = inspectWavBuffer(buffer);
  return info.dataSize / info.byteRate;
}

/**
 * Builds a frame-aligned zero-byte silence buffer for inserting pauses between stitched clips.
 * @param {{ byteRate: number, blockAlign: number, pauseMs: number }} spec - Timing specification.
 * @returns {Uint8Array} Zero-filled PCM silence slice.
 */
function buildSilenceBytes({ byteRate, blockAlign, pauseMs }) {
  if (!Number.isFinite(pauseMs) || pauseMs <= 0) return new Uint8Array(0);
  const rawBytes = Math.round((byteRate * pauseMs) / MS_PER_SECOND);
  const alignedBytes = Math.floor(rawBytes / blockAlign) * blockAlign;
  return new Uint8Array(Math.max(0, alignedBytes));
}

/**
 * Creates a standard 44-byte RIFF/WAVE PCM header.
 * @param {{ numChannels: number, sampleRate: number, byteRate: number, blockAlign: number, bitsPerSample: number, dataLength: number }} meta - PCM format and total payload size.
 * @returns {Uint8Array} 44-byte WAV header.
 */
function buildWaveHeader(meta) {
  const header = new ArrayBuffer(RIFF_HEADER_BYTES);
  const view = new DataView(header);
  writeTag(view, 0, 'RIFF');
  view.setUint32(4, RIFF_HEADER_BYTES - 8 + meta.dataLength, true);
  writeTag(view, 8, 'WAVE');
  writeTag(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, PCM_AUDIO_FORMAT, true);
  view.setUint16(22, meta.numChannels, true);
  view.setUint32(24, meta.sampleRate, true);
  view.setUint32(28, meta.byteRate, true);
  view.setUint16(32, meta.blockAlign, true);
  view.setUint16(34, meta.bitsPerSample, true);
  writeTag(view, 36, 'data');
  view.setUint32(40, meta.dataLength, true);
  return new Uint8Array(header);
}

/**
 * Checks whether two decoded WAV segment formats can be concatenated directly.
 * @param {object} base - First segment format.
 * @param {object} current - Current segment format.
 * @returns {boolean} True if formats match.
 */
function hasMatchingWaveFormat(base, current) {
  return (
    current.sampleRate === base.sampleRate &&
    current.numChannels === base.numChannels &&
    current.bitsPerSample === base.bitsPerSample
  );
}

/**
 * Returns true if every channel sample in a 16-bit PCM frame falls within the silence threshold.
 * @param {DataView} view - PCM DataView.
 * @param {number} frameOffset - Frame byte offset.
 * @param {number} channels - Channel count.
 * @returns {boolean} True when silent.
 */
function isSilentPcm16Frame(view, frameOffset, channels) {
  for (let ch = 0; ch < channels; ch++) {
    if (Math.abs(view.getInt16(frameOffset + ch * 2, true)) > SILENCE_AMP_THRESHOLD) return false;
  }
  return true;
}

/**
 * Finds padded active frame bounds (`[startFrame, endFrame)`) when segment exceeds minimum trim length.
 * @param {ArrayBuffer} buffer - WAV ArrayBuffer.
 * @param {object} info - Parsed WAV format metadata.
 * @returns {{ startFrame: number, endFrame: number }} Slice bounds in frames.
 */
function resolveTrimFrameRange(buffer, info) {
  const totalFrames = Math.floor(info.dataSize / info.blockAlign);
  const minTrimFrames = Math.round((info.sampleRate * MIN_TRIM_DURATION_MS) / MS_PER_SECOND);
  if (totalFrames < minTrimFrames) return { startFrame: 0, endFrame: totalFrames };
  const view = new DataView(buffer, info.dataOffset, totalFrames * info.blockAlign);
  let first = -1;
  for (let f = 0; f < totalFrames; f++) {
    if (!isSilentPcm16Frame(view, f * info.blockAlign, info.numChannels)) { first = f; break; }
  }
  if (first === -1) return { startFrame: 0, endFrame: totalFrames };
  let last = first;
  for (let f = totalFrames - 1; f > first; f--) {
    if (!isSilentPcm16Frame(view, f * info.blockAlign, info.numChannels)) { last = f; break; }
  }
  const headPad = Math.round((info.sampleRate * TRIM_HEAD_PAD_MS) / MS_PER_SECOND);
  const tailPad = Math.round((info.sampleRate * TRIM_TAIL_PAD_MS) / MS_PER_SECOND);
  return { startFrame: Math.max(0, first - headPad), endFrame: Math.min(totalFrames, last + 1 + tailPad) };
}

/**
 * Scales start and end edge frames smoothly in a freshly allocated 16-bit PCM byte array.
 * @param {Uint8Array} pcmBytes - Copied 16-bit PCM buffer.
 * @param {object} info - WAV format metadata.
 */
function applyMicroFadeInPlace(pcmBytes, info) {
  const frameCount = Math.floor(pcmBytes.byteLength / info.blockAlign);
  const minFadeFrames = Math.round((info.sampleRate * MIN_FADE_DURATION_MS) / MS_PER_SECOND);
  const fadeFrames = Math.min(Math.round((info.sampleRate * EDGE_FADE_MS) / MS_PER_SECOND), Math.floor(frameCount / 2));
  if (frameCount < minFadeFrames || fadeFrames <= 0) return;
  const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength);
  for (let i = 0; i < fadeFrames; i++) {
    const startGain = (i + 1) / fadeFrames;
    const endGain = (fadeFrames - i) / fadeFrames;
    const tailFrame = frameCount - fadeFrames + i;
    for (let ch = 0; ch < info.numChannels; ch++) {
      const headOff = i * info.blockAlign + ch * 2;
      const tailOff = tailFrame * info.blockAlign + ch * 2;
      view.setInt16(headOff, Math.round(view.getInt16(headOff, true) * startGain), true);
      view.setInt16(tailOff, Math.round(view.getInt16(tailOff, true) * endGain), true);
    }
  }
}

/**
 * Extracts a trimmed, micro-faded PCM segment from a validated WAV buffer when 16-bit PCM constraints apply.
 * @param {ArrayBuffer} buffer - Raw WAV buffer.
 * @param {object} info - Parsed WAV format metadata.
 * @returns {Uint8Array} Clean PCM byte slice.
 */
function prepareCleanPcmSlice(buffer, info) {
  if (info.bitsPerSample !== PCM_BITS_16 || info.blockAlign !== info.numChannels * 2) {
    return new Uint8Array(buffer, info.dataOffset, info.dataSize);
  }
  const { startFrame, endFrame } = resolveTrimFrameRange(buffer, info);
  const byteStart = info.dataOffset + startFrame * info.blockAlign;
  const byteEnd = info.dataOffset + endFrame * info.blockAlign;
  const pcmCopy = new Uint8Array(buffer.slice(byteStart, byteEnd));
  applyMicroFadeInPlace(pcmCopy, info);
  return pcmCopy;
}

/**
 * Trims excessive leading/trailing silence and adds 5ms edge micro-fades on a single WAV Blob.
 * Inputs: WAV `Blob`.
 * Outputs: cleaned `Blob` with `audio/wav` MIME type.
 * Side effects: reads binary bytes from input `Blob`.
 * Failure modes: throws SynthesisError if WAV headers are invalid.
 * @param {Blob} blob - Source WAV Blob.
 * @returns {Promise<Blob>} Trimmed and smoothed WAV Blob.
 */
export async function smoothAndTrimWavBlob(blob) {
  const normalized = ensureAudioWavBlob(blob);
  const buffer = await normalized.arrayBuffer();
  const info = inspectWavBuffer(buffer);
  const pcm = prepareCleanPcmSlice(buffer, info);
  return new Blob([buildWaveHeader({ ...info, dataLength: pcm.byteLength }), pcm], { type: 'audio/wav' });
}

/**
 * Safely trims silence and smooths edges on valid 16-bit PCM WAV Blobs while leaving minimal test/non-PCM Blobs intact.
 * Inputs: WAV `Blob`.
 * Outputs: smoothed `audio/wav` `Blob` or MIME-normalized original when PCM header is absent.
 * Side effects: reads binary bytes from input `Blob`.
 * Failure modes: throws TypeError only if `blob` is not a Blob-like object.
 * @param {Blob} blob - Candidate WAV Blob.
 * @returns {Promise<Blob>} Normalized/smoothed WAV Blob.
 */
export async function trySmoothWavBlob(blob) {
  const normalized = ensureAudioWavBlob(blob);
  const buffer = await normalized.arrayBuffer();
  const { metadata } = parseWavHeaderMetadata(buffer);
  if (!metadata || metadata.bitsPerSample !== PCM_BITS_16) return normalized;
  const pcm = prepareCleanPcmSlice(buffer, metadata);
  return new Blob([buildWaveHeader({ ...metadata, dataLength: pcm.byteLength }), pcm], { type: 'audio/wav' });
}

/**
 * Decodes an array of WAV Blobs into trimmed, micro-faded PCM slices.
 * @param {Blob[]} blobs - Input WAV Blobs.
 * @returns {Promise<Array<{ info: object, pcm: Uint8Array }>>} Decoded PCM slices.
 */
function decodeWavSegments(blobs) {
  return Promise.all(
    blobs.map(async blob => {
      const buffer = await blob.arrayBuffer();
      const info = inspectWavBuffer(buffer);
      return { info, pcm: prepareCleanPcmSlice(buffer, info) };
    })
  );
}

/**
 * Concatenates multiple PCM WAV Blobs of matching sample rate/channels into one continuous WAV Blob.
 * Inputs: array of WAV `Blob`s and optional pause duration in milliseconds (`pauseMs`).
 * Outputs: combined `Blob` with `audio/wav` MIME type.
 * Side effects: reads binary buffers from each input `Blob`.
 * Failure modes: throws SynthesisError if list is empty, WAV headers are invalid, or formats mismatch.
 * @param {Blob[]} blobs - Ordered WAV segments.
 * @param {number} [pauseMs=160] - Silence gap inserted between segments.
 * @returns {Promise<Blob>} Single stitched WAV Blob.
 */
export async function concatenateWavBlobs(blobs, pauseMs = 160) {
  if (!Array.isArray(blobs) || blobs.length === 0) {
    throw new SynthesisError('No generated audio segments to combine.', { code: 'EMPTY_AUDIO_SEGMENTS' });
  }
  if (blobs.length === 1) return ensureAudioWavBlob(blobs[0]);
  const decoded = await decodeWavSegments(blobs);
  const base = decoded[0].info;
  const silence = buildSilenceBytes({ byteRate: base.byteRate, blockAlign: base.blockAlign, pauseMs });
  const parts = [];
  let dataLength = 0;
  for (let i = 0; i < decoded.length; i++) {
    if (!hasMatchingWaveFormat(base, decoded[i].info)) {
      throw new SynthesisError('Generated segments have mismatched WAV audio formats.', { code: 'WAV_FORMAT_MISMATCH' });
    }
    if (i > 0 && silence.byteLength > 0) { parts.push(silence); dataLength += silence.byteLength; }
    parts.push(decoded[i].pcm);
    dataLength += decoded[i].pcm.byteLength;
  }
  return new Blob([buildWaveHeader({ ...base, dataLength }), ...parts], { type: 'audio/wav' });
}
