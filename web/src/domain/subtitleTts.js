/**
 * @fileoverview Pure domain helpers for per-frame and selected-batch subtitle Text-to-Speech generation and WAV stitching.
 */

import { DEFAULT_STEPS, STYLE_MODES } from './presets.js';
import { pickSegmentText } from './subtitles.js';
import { concatenateWavBlobs, ensureAudioWavBlob } from './wavCodec.js';

export const DEFAULT_SUBTITLE_TTS_GUIDANCE = 2;
export const DEFAULT_SUBTITLE_TTS_STEPS = DEFAULT_STEPS;
export const SUBTITLE_VOICEOVER_PAUSE_MS = 220;

const KHMER_SCRIPT_PATTERN = /[\u1780-\u17FF]/;

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
