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
export const MIN_FADE_DURATION_MS = 50;
export const EDGE_FADE_MS = 5;
export const DEFAULT_PAUSE_MS = 160;

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
 * Inputs: timing specification ({ byteRate, blockAlign, pauseMs }).
 * Outputs: zero-filled PCM silence Uint8Array.
 * Side effects: none.
 * Failure modes: returns empty Uint8Array for non-finite or negative pauseMs.
 * @param {{ byteRate: number, blockAlign: number, pauseMs: number }} spec - Timing specification.
 * @returns {Uint8Array} Zero-filled PCM silence slice.
 */
export function buildSilenceBytes({ byteRate, blockAlign, pauseMs }) {
  if (!Number.isFinite(pauseMs) || pauseMs <= 0) return new Uint8Array(0);
  const rawBytes = Math.round((byteRate * pauseMs) / MS_PER_SECOND);
  const alignedBytes = Math.floor(rawBytes / blockAlign) * blockAlign;
  return new Uint8Array(Math.max(0, alignedBytes));
}

/**
 * Creates a standard 44-byte RIFF/WAVE PCM header.
 * Inputs: format and payload size metadata.
 * Outputs: 44-byte Uint8Array WAV header.
 * Side effects: none.
 * Failure modes: none.
 * @param {{ numChannels: number, sampleRate: number, byteRate: number, blockAlign: number, bitsPerSample: number, dataLength: number }} meta - PCM format and total payload size.
 * @returns {Uint8Array} 44-byte WAV header.
 */
export function buildWaveHeader(meta) {
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

function applyFadeGains(view, spec) {
  const { fadeFrames, frameCount, info } = spec;
  for (let i = 0; i < fadeFrames; i++) {
    const headGain = i / fadeFrames;
    const tailGain = (fadeFrames - 1 - i) / fadeFrames;
    const tailFrame = frameCount - fadeFrames + i;
    for (let ch = 0; ch < info.numChannels; ch++) {
      const headOff = i * info.blockAlign + ch * 2;
      const tailOff = tailFrame * info.blockAlign + ch * 2;
      view.setInt16(headOff, Math.round(view.getInt16(headOff, true) * headGain), true);
      view.setInt16(tailOff, Math.round(view.getInt16(tailOff, true) * tailGain), true);
    }
  }
}

/**
 * Scales start and end edge frames smoothly in a 16-bit PCM byte array to eliminate boundary clicks.
 * Inputs: 16-bit PCM buffer, WAV format metadata, optional fade duration in milliseconds.
 * Outputs: none (mutates pcmBytes in place).
 * Side effects: modifies pcmBytes.
 * Failure modes: returns early if buffer is too short or parameters invalid.
 * @param {Uint8Array} pcmBytes - Copied 16-bit PCM buffer.
 * @param {object} info - WAV format metadata.
 * @param {number} [fadeMs=5] - Boundary fade duration.
 */
export function applyBoundaryMicroFades(pcmBytes, info, fadeMs = EDGE_FADE_MS) {
  const bits = info?.bitsPerSample ?? PCM_BITS_16;
  if (!pcmBytes?.buffer || !info?.blockAlign || !info?.sampleRate || bits !== PCM_BITS_16) return;
  const frameCount = Math.floor(pcmBytes.byteLength / info.blockAlign);
  const minFadeFrames = Math.round((info.sampleRate * MIN_FADE_DURATION_MS) / MS_PER_SECOND);
  const fadeFrames = Math.min(Math.round((info.sampleRate * fadeMs) / MS_PER_SECOND), Math.floor(frameCount / 2));
  if (frameCount < minFadeFrames || fadeFrames <= 0) return;
  const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength);
  applyFadeGains(view, { fadeFrames, frameCount, info });
}

function applyMicroFadeInPlace(pcmBytes, info) {
  applyBoundaryMicroFades(pcmBytes, info, EDGE_FADE_MS);
}

/**
 * Extracts a trimmed, micro-faded PCM segment from a validated WAV buffer when 16-bit PCM constraints apply.
 * Inputs: raw WAV ArrayBuffer and parsed format metadata.
 * Outputs: clean PCM byte Uint8Array.
 * Side effects: none.
 * Failure modes: returns un-trimmed raw slice if non-16-bit PCM.
 * @param {ArrayBuffer} buffer - Raw WAV buffer.
 * @param {object} info - Parsed WAV format metadata.
 * @returns {Uint8Array} Clean PCM byte slice.
 */
export function prepareCleanPcmSlice(buffer, info) {
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
export async function concatenateWavBlobs(blobs, pauseMs = DEFAULT_PAUSE_MS) {
  if (!Array.isArray(blobs) || blobs.length === 0) {
    throw new SynthesisError('No generated audio segments to combine.', { code: 'EMPTY_AUDIO_SEGMENTS' });
  }
  if (blobs.length === 1) return ensureAudioWavBlob(blobs[0]);
  return stitchDecodedSegments(await decodeWavSegments(blobs), blobs.map(() => pauseMs));
}

function assertSegmentWaveFormat(base, current, index) {
  if (current.sampleRate !== base.sampleRate) {
    throw new SynthesisError(
      `Segment #${index + 1} has mismatched sample rate: expected ${base.sampleRate} Hz, received ${current.sampleRate} Hz.`,
      { code: 'WAV_FORMAT_MISMATCH' }
    );
  }
  if (current.numChannels !== base.numChannels) {
    throw new SynthesisError(
      `Segment #${index + 1} has mismatched channels: expected ${base.numChannels}, received ${current.numChannels}.`,
      { code: 'WAV_FORMAT_MISMATCH' }
    );
  }
  if (current.bitsPerSample !== base.bitsPerSample) {
    throw new SynthesisError(
      `Segment #${index + 1} has mismatched bit depth: expected ${base.bitsPerSample}-bit, received ${current.bitsPerSample}-bit.`,
      { code: 'WAV_FORMAT_MISMATCH' }
    );
  }
}

/**
 * Stitches decoded PCM slices into one WAV, inserting frame-aligned silence between neighbours.
 * @param {Array<{ info: object, pcm: Uint8Array }>} decoded - Decoded segments (2 or more).
 * @param {number[]} gapsAfterMs - `gapsAfterMs[i]` is the silence inserted after segment `i`; the last value is unused.
 * @returns {Blob} Combined `audio/wav` Blob.
 */
function stitchDecodedSegments(decoded, gapsAfterMs) {
  const base = decoded[0].info;
  const parts = [];
  let dataLength = 0;
  for (let i = 0; i < decoded.length; i++) {
    assertSegmentWaveFormat(base, decoded[i].info, i);
    const silence = i > 0 ? buildSilenceBytes({ byteRate: base.byteRate, blockAlign: base.blockAlign, pauseMs: gapsAfterMs[i - 1] }) : null;
    if (silence && silence.byteLength > 0) { parts.push(silence); dataLength += silence.byteLength; }
    parts.push(decoded[i].pcm);
    dataLength += decoded[i].pcm.byteLength;
  }
  return new Blob([buildWaveHeader({ ...base, dataLength }), ...parts], { type: 'audio/wav' });
}

/**
 * Resolves the silence after one entry: non-finite values fall back to `defaultPauseMs`, negatives become 0.
 * @param {unknown} pauseAfterMs - Entry pause in milliseconds.
 * @param {number} defaultPauseMs - Fallback gap.
 * @returns {number} Gap in milliseconds (`>= 0`).
 */
function resolveEntryPauseMs(pauseAfterMs, defaultPauseMs) {
  return Number.isFinite(pauseAfterMs) ? Math.max(0, pauseAfterMs) : defaultPauseMs;
}

/**
 * Concatenates PCM WAV Blobs with an individually specified silence after each clip.
 * Inputs: ordered entries `{ blob, pauseAfterMs }` and an optional `defaultPauseMs` (160) used when an entry omits `pauseAfterMs`.
 * Outputs: combined `audio/wav` Blob; a single entry returns its MIME-normalized Blob unchanged.
 * Side effects: reads binary buffers from each entry's Blob.
 * Failure modes: throws SynthesisError for an empty list, an entry without a Blob, invalid WAV headers, or mismatched formats.
 * Notes: `pauseAfterMs` is the gap *between* clips, so the last entry's value is ignored; `0` means no gap.
 * Gaps are zero-filled PCM rounded down to whole sample frames (exact for common rates such as 16/24/48 kHz).
 * @param {Array<{ blob: Blob, pauseAfterMs?: number|null }>} entries - Ordered clips with trailing pauses.
 * @param {number} [defaultPauseMs=160] - Gap used when `pauseAfterMs` is missing or not a finite number.
 * @returns {Promise<Blob>} Single stitched WAV Blob.
 */
export async function concatenateWavBlobsWithPauses(entries, defaultPauseMs = DEFAULT_PAUSE_MS) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new SynthesisError('No generated audio segments to combine.', { code: 'EMPTY_AUDIO_SEGMENTS' });
  }
  if (entries.some(entry => !entry?.blob)) {
    throw new SynthesisError('A generated audio segment is missing its audio.', { code: 'EMPTY_AUDIO_SEGMENTS' });
  }
  if (entries.length === 1) return ensureAudioWavBlob(entries[0].blob);
  const decoded = await decodeWavSegments(entries.map(entry => entry.blob));
  return stitchDecodedSegments(decoded, entries.map(entry => resolveEntryPauseMs(entry.pauseAfterMs, defaultPauseMs)));
}

/**
 * Replaces one generated chunk and re-stitches the full ordered PCM WAV without mutating the input chunks.
 * Inputs: `{ chunks, index, nextChunk, pauseMs }`; `pauseMs` is the default gap, and each chunk's own `pauseAfterMs` (from `[pause ...]` markers) is preserved.
 * Outputs: `{ chunks, blob }` with the swapped chunk metadata and freshly concatenated WAV.
 * Side effects: reads binary WAV data from each chunk Blob.
 * Failure modes: throws SynthesisError when the chunk list, index, or replacement audio is invalid.
 * @param {{ chunks: object[], index: number, nextChunk: object, pauseMs?: number }} params - Replacement spec.
 * @returns {Promise<{ chunks: object[], blob: Blob }>} Updated chunks and stitched WAV.
 */
export async function replaceChunkAndRestitch({ chunks, index, nextChunk, pauseMs = DEFAULT_PAUSE_MS } = {}) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new SynthesisError('No generated segments to restitch.', { code: 'EMPTY_AUDIO_SEGMENTS' });
  }
  if (!Number.isInteger(index) || index < 0 || index >= chunks.length) {
    throw new SynthesisError('Choose a valid generated segment to replace.', { code: 'INVALID_CHUNK_INDEX' });
  }
  if (!nextChunk?.blob) {
    throw new SynthesisError('Regenerated segment is missing audio.', { code: 'EMPTY_AUDIO_SEGMENTS' });
  }
  const nextChunks = chunks.map((chunk, chunkIndex) => (
    chunkIndex === index ? { ...chunk, ...nextChunk, index } : chunk
  ));
  const blob = await concatenateWavBlobsWithPauses(nextChunks.map(chunk => ({ blob: chunk.blob, pauseAfterMs: chunk.pauseAfterMs })), pauseMs);
  return { chunks: nextChunks, blob };
}
