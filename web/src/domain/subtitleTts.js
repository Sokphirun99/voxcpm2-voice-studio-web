/**
 * @fileoverview Pure domain helpers for per-frame and selected-batch subtitle Text-to-Speech generation, timeline alignment, and WAV stitching.
 */

import { SynthesisError } from './errors.js';
import { assertMatchingWaveFormats, assertPcmFormat } from './audioAssembly.js';
import { DEFAULT_STEPS, STYLE_MODES } from './presets.js';
import { pickSegmentText } from './subtitles.js';
import {
  applyBoundaryMicroFades,
  buildWaveHeader,
  concatenateWavBlobs,
  ensureAudioWavBlob,
  inspectWavBuffer,
  prepareCleanPcmSlice,
} from './wavCodec.js';

export const DEFAULT_SUBTITLE_TTS_GUIDANCE = 2;
export const DEFAULT_SUBTITLE_TTS_STEPS = DEFAULT_STEPS;
export const DEFAULT_ALIGNED_FADE_MS = 5;
export const DEFAULT_TIME_ALIGNED_SUFFIX = '-time-aligned-dub';
export const SUBTITLE_VOICEOVER_GAP_OPTIONS = Object.freeze([
  Object.freeze({ ms: 100, label: '0.1s' }),
  Object.freeze({ ms: 200, label: '0.2s' }),
  Object.freeze({ ms: 500, label: '0.5s' }),
  Object.freeze({ ms: 1000, label: '1.0s' }),
]);
export const SUBTITLE_VOICEOVER_PAUSE_MS = 200;
export const DUB_AUDIO_MODE_OPTIONS = Object.freeze([
  Object.freeze({ id: 'duck', label: 'Duck (-16 dB)' }),
  Object.freeze({ id: 'mute', label: 'Mute original' }),
  Object.freeze({ id: 'keep', label: 'Keep original' }),
]);
export const DEFAULT_DUB_AUDIO_MODE = 'duck';

const VALID_SUBTITLE_VOICEOVER_GAPS = new Set(SUBTITLE_VOICEOVER_GAP_OPTIONS.map(option => option.ms));
const VALID_DUB_AUDIO_MODES = new Set(DUB_AUDIO_MODE_OPTIONS.map(option => option.id));
const KHMER_SCRIPT_PATTERN = /[\u1780-\u17FF]/;

/**
 * Validates a dubbed MP4 original-audio mix mode against `duck`, `mute`, and `keep`.
 * Inputs: candidate mode string.
 * Outputs: normalized mode string, defaulting to `DEFAULT_DUB_AUDIO_MODE` (`'duck'`).
 * Side effects: none.
 * Failure modes: returns `'duck'` for unrecognized or non-string inputs.
 * @param {unknown} rawMode - Candidate mix mode.
 * @returns {'duck'|'mute'|'keep'} Validated mix mode.
 */
export function normalizeDubAudioMode(rawMode) {
  const cleaned = typeof rawMode === 'string' ? rawMode.trim().toLowerCase() : '';
  return VALID_DUB_AUDIO_MODES.has(cleaned) ? cleaned : DEFAULT_DUB_AUDIO_MODE;
}

/**
 * Validates a subtitle voiceover pause gap against the supported selector presets (`100`, `200`, `500`, `1000` ms).
 * Inputs: candidate gap duration in milliseconds.
 * Outputs: supported preset duration in milliseconds, defaulting to `SUBTITLE_VOICEOVER_PAUSE_MS` (`200`).
 * Side effects: none.
 * Failure modes: returns `200` for unrecognized, non-numeric, or empty values.
 * @param {unknown} rawMs - Candidate pause duration in milliseconds.
 * @returns {number} Validated pause gap in milliseconds.
 */
export function normalizeSubtitleVoiceoverGapMs(rawMs) {
  const numeric = Number(rawMs);
  return VALID_SUBTITLE_VOICEOVER_GAPS.has(numeric) ? numeric : SUBTITLE_VOICEOVER_PAUSE_MS;
}

/**
 * Formats a subtitle voiceover gap in milliseconds into its short human label (`0.2s`).
 * Inputs: gap duration in milliseconds.
 * Outputs: formatted seconds label.
 * Side effects: none.
 * Failure modes: falls back to the default `0.2s` label for unrecognized values.
 * @param {unknown} rawMs - Pause gap in milliseconds.
 * @returns {string} Compact label such as `0.2s` or `1.0s`.
 */
export function formatSubtitleVoiceoverGapLabel(rawMs) {
  const normalized = normalizeSubtitleVoiceoverGapMs(rawMs);
  const match = SUBTITLE_VOICEOVER_GAP_OPTIONS.find(option => option.ms === normalized);
  return match ? match.label : '0.2s';
}

/**
 * Returns true when `text` contains Khmer Unicode characters so Khmer number normalization applies automatically.
 * Inputs: candidate string.
 * Outputs: boolean indicating Khmer script presence.
 * Side effects: none.
 * Failure modes: returns false for non-string or empty inputs.
 * @param {unknown} text - Text to inspect.
 * @returns {boolean} True when Khmer characters are present.
 */
export function isKhmerScriptText(text) {
  return typeof text === 'string' && KHMER_SCRIPT_PATTERN.test(text);
}

/**
 * Resolves the exact single-language text that should be spoken for one subtitle frame.
 * Inputs: subtitle `segment` and `useTranslation` flag.
 * Outputs: trimmed speech string (empty string if blank).
 * Side effects: none.
 * Failure modes: returns `''` for null/invalid segment inputs.
 * @param {{ text?: string, translatedText?: string }|null} segment - Subtitle cue record.
 * @param {boolean} [useTranslation=false] - Whether translated text mode is active.
 * @returns {string} Trimmed text to synthesize.
 */
export function resolveSubtitleSpeechText(segment, useTranslation = false) {
  if (!segment) return '';
  if (useTranslation) return (segment.translatedText || '').trim();
  return pickSegmentText(segment, false, false);
}

/**
 * Computes a stable cache/staleness signature for a generated subtitle voice clip.
 * Inputs: `{ text, characterId, anchorTag }`.
 * Outputs: canonical signature string.
 * Side effects: none.
 * Failure modes: coerces missing fields safely to empty strings.
 * @param {{ text?: string, characterId?: string, anchorTag?: string }} [spec] - Signature inputs.
 * @returns {string} Signature string.
 */
export function buildSubtitleSpeechSignature({ text = '', characterId = '', anchorTag = '' } = {}) {
  return `${characterId}\0${anchorTag}\0${String(text).trim()}`;
}

/**
 * Returns the subset of `segments` whose `id` is present in `selectedIds`, preserving timeline order.
 * Inputs: ordered `segments` array and iterable `selectedIds`.
 * Outputs: filtered ordered segment array.
 * Side effects: none.
 * Failure modes: returns `[]` for invalid/empty inputs.
 * @param {Array<{ id: string }>} segments - Ordered subtitle segments.
 * @param {Iterable<string>|null|undefined} selectedIds - Selected segment IDs.
 * @returns {Array<object>} Selected segments in timeline order.
 */
export function selectOrderedSegments(segments, selectedIds) {
  if (!Array.isArray(segments) || !segments.length || !selectedIds) return [];
  const lookup = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  if (!lookup.size) return [];
  return segments.filter(seg => Boolean(seg?.id && lookup.has(seg.id)));
}

/**
 * Builds the `synthesizeSpeech.execute` command payload for a subtitle frame.
 * Inputs: `{ text, character, anchor, cachedUpload, seed }`.
 * Outputs: synthesis command object compatible with `createSynthesizeSpeechUseCase`.
 * Side effects: none.
 * Failure modes: returns a command object with safe defaults; validation occurs in `validateGenerationInput`.
 * @param {{ text: string, character: object, anchor?: object|null, cachedUpload?: object|null, seed?: number|string|null }} params - Synthesis spec.
 * @returns {object} Synthesis command payload.
 */
export function buildSubtitleSynthesisCommand({ text, character, anchor = null, cachedUpload = null, seed = '' }) {
  const cleanText = String(text || '').trim();
  const effectiveSeed = seed != null && seed !== '' ? seed : (!anchor && character?.defaultSeed != null ? character.defaultSeed : '');
  return {
    script: cleanText,
    character,
    anchor,
    cachedUpload,
    guidance: DEFAULT_SUBTITLE_TTS_GUIDANCE,
    steps: DEFAULT_SUBTITLE_TTS_STEPS,
    seed: effectiveSeed,
    autoFormatKhmer: isKhmerScriptText(cleanText),
    styleMode: STYLE_MODES.AUTO,
    customStyle: '',
    denoiseReference: false,
    masterAudio: true,
  };
}

/**
 * Combines one or more generated subtitle WAV clips into a single continuous WAV Blob.
 * Inputs: ordered array of `Blob` clips and optional pause duration in ms (`pauseMs`).
 * Outputs: single `audio/wav` `Blob` (returns null if no blobs provided).
 * Side effects: reads binary buffers from input blobs when stitching 2+ clips.
 * Failure modes: throws SynthesisError if multi-clip PCM headers are invalid or mismatched.
 * @param {Blob[]} blobs - Ordered WAV audio blobs.
 * @param {number} [pauseMs=SUBTITLE_VOICEOVER_PAUSE_MS] - Silence gap between subtitle frames.
 * @returns {Promise<Blob|null>} Combined WAV Blob or null when empty.
 */
export async function buildCombinedVoiceoverBlob(blobs, pauseMs = SUBTITLE_VOICEOVER_PAUSE_MS) {
  if (!Array.isArray(blobs) || blobs.length === 0) return null;
  if (blobs.length === 1) return ensureAudioWavBlob(blobs[0]);
  return concatenateWavBlobs(blobs, pauseMs);
}

/**
 * Derives a clean `.wav` export filename from the active video filename and suffix.
 * Inputs: optional `videoFile` and filename `suffix`.
 * Outputs: sanitized `.wav` filename string.
 * Side effects: none.
 * Failure modes: falls back to `subtitle` stem when file name is unavailable.
 * @param {{ name?: string }|null|undefined} videoFile - Source media file.
 * @param {string} [suffix='-voiceover'] - Descriptive suffix appended before `.wav`.
 * @returns {string} Export filename ending in `.wav`.
 */
export function buildVoiceoverDownloadFilename(videoFile, suffix = '-voiceover') {
  const stem = String(videoFile?.name || 'subtitle').replace(/\.[^.]+$/, '') || 'subtitle';
  return `${stem}${suffix}.wav`;
}

/**
 * Collects time-aligned WAV clips for dubbed MP4 export, respecting selected frames when any selected frame has audio.
 * Inputs: ordered `segments`, `selectedIds`, and `segmentClips` map.
 * Outputs: ordered array of `{ segmentId, start, end, blob }`.
 * Side effects: none.
 * Failure modes: returns `[]` when no matching segments have generated audio blobs.
 * @param {Array<{ id: string, start?: number, end?: number }>} segments - Timeline subtitle segments.
 * @param {Iterable<string>|null|undefined} selectedIds - Active selection IDs.
 * @param {Record<string, { blob?: Blob }>} segmentClips - Generated clip records keyed by segment ID.
 * @returns {Array<{ segmentId: string, start: number, end: number, blob: Blob }>} Ordered dub clips.
 */
export function buildDubExportClips(segments, selectedIds, segmentClips) {
  if (!Array.isArray(segments) || !segments.length || !segmentClips) return [];
  const selected = selectOrderedSegments(segments, selectedIds).filter(seg => Boolean(segmentClips[seg.id]?.blob));
  const matched = selected.length > 0 ? selected : segments.filter(seg => Boolean(segmentClips[seg.id]?.blob));
  return matched.map(seg => {
    const start = Number.isFinite(Number(seg.start)) ? Math.max(0, Number(seg.start)) : 0;
    const rawEnd = Number.isFinite(Number(seg.end)) ? Number(seg.end) : start;
    return { segmentId: seg.id, start, end: Math.max(start, rawEnd), blob: segmentClips[seg.id].blob };
  });
}

/**
 * Derives a clean `-dubbed.mp4` export filename from the active video file.
 * Inputs: optional `videoFile`.
 * Outputs: sanitized filename ending in `-dubbed.mp4`.
 * Side effects: none.
 * Failure modes: falls back to `subtitle-dubbed.mp4` when filename is unavailable.
 * @param {{ name?: string }|null|undefined} videoFile - Source video file.
 * @returns {string} Export filename ending in `-dubbed.mp4`.
 */
export function buildDubDownloadFilename(videoFile) {
  const stem = String(videoFile?.name || 'subtitle').replace(/\.[^.]+$/, '') || 'subtitle';
  return `${stem}-dubbed.mp4`;
}

/**
 * Derives a clean time-aligned dub `.wav` export filename from the active video file.
 * Inputs: optional `videoFile` and filename `suffix`.
 * Outputs: sanitized filename ending in `.wav`.
 * Side effects: none.
 * Failure modes: falls back to `subtitle` stem when filename is unavailable.
 * @param {{ name?: string }|null|undefined} videoFile - Source media file.
 * @param {string} [suffix='-time-aligned-dub'] - Descriptive suffix appended before `.wav`.
 * @returns {string} Export filename ending in `.wav`.
 */
export function buildTimeAlignedDubDownloadFilename(videoFile, suffix = DEFAULT_TIME_ALIGNED_SUFFIX) {
  return buildVoiceoverDownloadFilename(videoFile, suffix);
}

function filterAndOrderTargetClips(segments, selectedIds, segmentClips) {
  if (!Array.isArray(segments) || !segments.length || !segmentClips) return [];
  const selected = selectOrderedSegments(segments, selectedIds).filter(s => Boolean(segmentClips[s.id]?.blob));
  const pool = selected.length > 0 ? selected : segments.filter(s => Boolean(segmentClips[s.id]?.blob));
  return pool
    .map(s => {
      const start = Number.isFinite(Number(s.start)) ? Math.max(0, Number(s.start)) : 0;
      const rawEnd = Number.isFinite(Number(s.end)) ? Number(s.end) : start;
      return { id: s.id, start, end: Math.max(start, rawEnd), blob: segmentClips[s.id].blob };
    })
    .sort((a, b) => a.start - b.start);
}

async function decodeAlignmentClip(item, index, baseInfo, expectedSampleRate) {
  const buffer = await item.blob.arrayBuffer();
  const info = inspectWavBuffer(buffer);
  assertPcmFormat(info, index);
  if (expectedSampleRate && info.sampleRate !== expectedSampleRate) {
    throw new SynthesisError(
      `Segment #${index + 1} has mismatched sample rate: expected ${expectedSampleRate} Hz, received ${info.sampleRate} Hz.`,
      { code: 'WAV_FORMAT_MISMATCH' }
    );
  }
  if (baseInfo) assertMatchingWaveFormats(baseInfo, info, index);
  const pcm = prepareCleanPcmSlice(buffer, info);
  return { ...item, info, pcm };
}

async function decodeTargetClips(targets, sampleRate) {
  const decoded = [];
  for (let i = 0; i < targets.length; i++) {
    const baseInfo = i > 0 ? decoded[0].info : null;
    decoded.push(await decodeAlignmentClip(targets[i], i, baseInfo, sampleRate));
  }
  return decoded;
}

function resolveNextBoundaryFrame(index, ordered, totalDuration, sampleRate) {
  if (index < ordered.length - 1) {
    return Math.round(ordered[index + 1].start * sampleRate);
  }
  if (Number.isFinite(totalDuration) && totalDuration > 0) {
    return Math.round(totalDuration * sampleRate);
  }
  return Infinity;
}

function placeClipWithinWindow(spec) {
  const { clipPcm, targetStartFrame, boundaryFrame, baseInfo } = spec;
  const clipFrames = Math.floor(clipPcm.byteLength / baseInfo.blockAlign);
  const maxAvailableFrames = Math.max(0, boundaryFrame - targetStartFrame);
  if (clipFrames <= maxAvailableFrames) {
    return { pcm: clipPcm, placedFrames: clipFrames, clamped: false, requestedFrames: clipFrames };
  }
  const clampedBytes = new Uint8Array(clipPcm.slice(0, maxAvailableFrames * baseInfo.blockAlign));
  applyBoundaryMicroFades(clampedBytes, baseInfo, DEFAULT_ALIGNED_FADE_MS);
  return { pcm: clampedBytes, placedFrames: maxAvailableFrames, clamped: true, requestedFrames: clipFrames };
}

function createClampedWarning(item, requestedFrames, maxFrames, sampleRate) {
  const requestedSec = requestedFrames / sampleRate;
  const maxSec = maxFrames / sampleRate;
  return {
    segmentId: item.id,
    requestedDuration: requestedSec,
    maxDuration: maxSec,
    message: `Clip for cue #${item.id} (${requestedSec.toFixed(2)}s) exceeded window (${maxSec.toFixed(2)}s); clamped with micro-fade.`,
  };
}

function assembleAlignedTrackFrames(decoded, totalDuration, baseInfo) {
  const { sampleRate, blockAlign } = baseInfo;
  const parts = [];
  const warnings = [];
  let currentFrame = 0;
  for (let i = 0; i < decoded.length; i++) {
    const item = decoded[i];
    const startFrame = Math.round(item.start * sampleRate);
    if (startFrame > currentFrame) {
      parts.push(new Uint8Array((startFrame - currentFrame) * blockAlign));
      currentFrame = startFrame;
    }
    const boundary = resolveNextBoundaryFrame(i, decoded, totalDuration, sampleRate);
    const res = placeClipWithinWindow({ clipPcm: item.pcm, targetStartFrame: startFrame, boundaryFrame: boundary, baseInfo });
    if (res.clamped) warnings.push(createClampedWarning(item, res.requestedFrames, res.placedFrames, sampleRate));
    parts.push(res.pcm);
    currentFrame += res.placedFrames;
  }
  return { parts, currentFrame, warnings };
}

function appendTrailingSilence(parts, totalDuration, currentFrame, baseInfo) {
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) return currentFrame;
  const targetTotal = Math.round(totalDuration * baseInfo.sampleRate);
  if (targetTotal <= currentFrame) return currentFrame;
  parts.push(new Uint8Array((targetTotal - currentFrame) * baseInfo.blockAlign));
  return targetTotal;
}

function createTrackWavBlob(baseInfo, parts) {
  const dataLength = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const header = buildWaveHeader({ ...baseInfo, dataLength });
  return new Blob([header, ...parts], { type: 'audio/wav' });
}

async function applyTrackMastering(blob, audioMaster, signal) {
  if (!audioMaster?.masterWav) return { blob, mastered: false };
  try {
    const res = await audioMaster.masterWav(blob, { signal });
    return { blob: res.blob || blob, mastered: res.mastered ?? true };
  } catch (_err) {
    return { blob, mastered: false };
  }
}

/**
 * Assembles generated subtitle clips into a single time-aligned PCM WAV track.
 * Inputs: { segments, segmentClips, totalDuration, sampleRate, audioMaster, signal, selectedIds }.
 * Outputs: Promise resolving to { blob, duration, clipCount, warnings, sampleRate, mastered }.
 * Side effects: reads ArrayBuffer from clips, applies optional audio mastering.
 * Failure modes: returns empty descriptor on missing clips; throws SynthesisError on WAV format mismatch.
 * @param {object} params - Assembly spec.
 * @returns {Promise<{ blob: Blob|null, duration: number, clipCount: number, warnings: Array<object>, sampleRate: number, mastered: boolean }>} Aligned WAV result.
 */
export async function assembleTimelineAlignedVoiceover(spec = {}) {
  const { segments = [], segmentClips = {}, totalDuration = 0, sampleRate = null, audioMaster = null, signal = null, selectedIds = null } = spec;
  const targets = filterAndOrderTargetClips(segments, selectedIds, segmentClips);
  if (!targets.length) {
    return { blob: null, duration: 0, clipCount: 0, warnings: [], sampleRate: sampleRate || 0, mastered: false };
  }
  const decoded = await decodeTargetClips(targets, sampleRate);
  const baseInfo = decoded[0].info;
  const { parts, currentFrame, warnings } = assembleAlignedTrackFrames(decoded, totalDuration, baseInfo);
  const finalFrame = appendTrailingSilence(parts, totalDuration, currentFrame, baseInfo);
  const rawBlob = createTrackWavBlob(baseInfo, parts);
  const { blob, mastered } = await applyTrackMastering(rawBlob, audioMaster, signal);
  return { blob, duration: finalFrame / baseInfo.sampleRate, clipCount: targets.length, warnings, sampleRate: baseInfo.sampleRate, mastered };
}
