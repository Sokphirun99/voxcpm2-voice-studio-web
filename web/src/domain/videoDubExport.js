/**
 * @fileoverview Pure domain models, strict validators, mixing/ducking gain bounds,
 * and human-readable descriptors for Video Dubbing & MP4 Export (R3-09).
 */

import { ValidationError } from './errors.js';

export const VIDEO_AUDIO_MODES = Object.freeze({
  DUCK: 'duck',
  REPLACE: 'mute',
  MIX: 'keep',
  ORIGINAL: 'original',
});

export const VIDEO_SUBTITLE_MODES = Object.freeze({
  NONE: 'none',
  BURNED: 'burned',
  SOFT: 'soft',
});

export const DEFAULT_DUB_SUBTITLE_MODE = VIDEO_SUBTITLE_MODES.NONE;

export const VIDEO_EXPORT_AUDIO_MODE_OPTIONS = Object.freeze([
  Object.freeze({ id: VIDEO_AUDIO_MODES.DUCK, label: 'Mixed · Auto-duck original' }),
  Object.freeze({ id: VIDEO_AUDIO_MODES.REPLACE, label: 'Replacement dubbing (mute original)' }),
  Object.freeze({ id: VIDEO_AUDIO_MODES.MIX, label: 'Mixed · Keep original balance' }),
  Object.freeze({ id: VIDEO_AUDIO_MODES.ORIGINAL, label: 'Original video audio only' }),
]);

export const VIDEO_SUBTITLE_MODE_OPTIONS = Object.freeze([
  Object.freeze({ id: VIDEO_SUBTITLE_MODES.NONE, label: 'No subtitles' }),
  Object.freeze({ id: VIDEO_SUBTITLE_MODES.BURNED, label: 'Burned-in subtitles (ASS)' }),
  Object.freeze({ id: VIDEO_SUBTITLE_MODES.SOFT, label: 'Embedded subtitle track (MP4)' }),
]);

export const DEFAULT_DUB_MIX_SETTINGS = Object.freeze({
  originalVolume: 1,
  dubVolume: 1,
  duckVolume: 0.15,
});

export const DUB_MIX_BOUNDS = Object.freeze({
  originalVolume: Object.freeze({ min: 0.05, max: 1.5, step: 0.05, defaultValue: 1 }),
  dubVolume: Object.freeze({ min: 0.25, max: 1.5, step: 0.05, defaultValue: 1 }),
  duckVolume: Object.freeze({ min: 0.05, max: 0.85, step: 0.05, defaultValue: 0.15 }),
});

const CANONICAL_AUDIO_MODE_MAP = Object.freeze({
  duck: VIDEO_AUDIO_MODES.DUCK,
  mute: VIDEO_AUDIO_MODES.REPLACE,
  replace: VIDEO_AUDIO_MODES.REPLACE,
  keep: VIDEO_AUDIO_MODES.MIX,
  mix: VIDEO_AUDIO_MODES.MIX,
  original: VIDEO_AUDIO_MODES.ORIGINAL,
});

const VALID_SUBTITLE_MODES = new Set(Object.values(VIDEO_SUBTITLE_MODES));
const FLOAT_EPSILON = 1e-4;
const DB_MULTIPLIER = 20;

/**
 * Resolves a candidate video audio mode (including `'replace'`/`'mix'` aliases) without silent fallback.
 * Inputs: `rawMode` candidate string.
 * Outputs: canonical mode (`'duck' | 'mute' | 'keep' | 'original'`) or `null` when unrecognized.
 * Side effects: none.
 * Failure modes: returns `null` for non-string or unsupported values.
 * @param {unknown} rawMode - Candidate video audio mode.
 * @returns {'duck'|'mute'|'keep'|'original'|null} Canonical audio mode or null.
 */
export function resolveCanonicalVideoAudioMode(rawMode) {
  if (typeof rawMode !== 'string') return null;
  const cleaned = rawMode.trim().toLowerCase();
  return Object.hasOwn(CANONICAL_AUDIO_MODE_MAP, cleaned) ? CANONICAL_AUDIO_MODE_MAP[cleaned] : null;
}

/**
 * Strictly validates a video audio mode, throwing ValidationError rather than changing it silently.
 * Inputs: `rawMode` candidate value.
 * Outputs: canonical audio mode string.
 * Side effects: none.
 * Failure modes: throws ValidationError (`INVALID_VIDEO_AUDIO_MODE`) on unsupported mode.
 * @param {unknown} rawMode - Candidate audio mode.
 * @returns {'duck'|'mute'|'keep'|'original'} Validated canonical audio mode.
 */
export function assertVideoAudioMode(rawMode) {
  const canonical = resolveCanonicalVideoAudioMode(rawMode);
  if (!canonical) {
    throw new ValidationError(
      `Unsupported video audio mode '${String(rawMode ?? '')}'. Choose original, replace/mute, duck, or keep/mix.`,
      'audioMode',
      'INVALID_VIDEO_AUDIO_MODE'
    );
  }
  return canonical;
}

/**
 * Normalizes persisted or initial UI video audio mode state, falling back only when unset/corrupt.
 * Inputs: `rawMode` and optional `fallback`.
 * Outputs: canonical audio mode string.
 * Side effects: none.
 * Failure modes: returns `fallback` when `rawMode` is unrecognized.
 * @param {unknown} rawMode - Candidate audio mode.
 * @param {'duck'|'mute'|'keep'|'original'} [fallback='duck'] - Default mode.
 * @returns {'duck'|'mute'|'keep'|'original'} Normalized audio mode.
 */
export function normalizeVideoAudioMode(rawMode, fallback = VIDEO_AUDIO_MODES.DUCK) {
  return resolveCanonicalVideoAudioMode(rawMode) || fallback;
}

/**
 * Resolves a candidate video subtitle mode (`'none'`, `'burned'`, `'soft'`) without silent fallback.
 * Inputs: `rawMode` candidate string.
 * Outputs: canonical subtitle mode or `null` when unrecognized.
 * Side effects: none.
 * Failure modes: returns `null` for non-string or unsupported values.
 * @param {unknown} rawMode - Candidate subtitle mode.
 * @returns {'none'|'burned'|'soft'|null} Canonical subtitle mode or null.
 */
export function resolveCanonicalVideoSubtitleMode(rawMode) {
  if (typeof rawMode !== 'string') return null;
  const cleaned = rawMode.trim().toLowerCase();
  return VALID_SUBTITLE_MODES.has(cleaned) ? cleaned : null;
}

/**
 * Strictly validates a video subtitle mode, throwing ValidationError rather than changing it silently.
 * Inputs: `rawMode` candidate value.
 * Outputs: canonical subtitle mode (`'none' | 'burned' | 'soft'`).
 * Side effects: none.
 * Failure modes: throws ValidationError (`INVALID_VIDEO_SUBTITLE_MODE`) on unsupported mode.
 * @param {unknown} rawMode - Candidate subtitle mode.
 * @returns {'none'|'burned'|'soft'} Validated subtitle mode.
 */
export function assertVideoSubtitleMode(rawMode) {
  const canonical = resolveCanonicalVideoSubtitleMode(rawMode);
  if (!canonical) {
    throw new ValidationError(
      `Unsupported video subtitle mode '${String(rawMode ?? '')}'. Choose none, burned, or soft.`,
      'subtitleMode',
      'INVALID_VIDEO_SUBTITLE_MODE'
    );
  }
  return canonical;
}

/**
 * Normalizes persisted or initial UI video subtitle mode state.
 * Inputs: `rawMode` and optional `fallback`.
 * Outputs: canonical subtitle mode string.
 * Side effects: none.
 * Failure modes: returns `fallback` when `rawMode` is unrecognized.
 * @param {unknown} rawMode - Candidate subtitle mode.
 * @param {'none'|'burned'|'soft'} [fallback='none'] - Default subtitle mode.
 * @returns {'none'|'burned'|'soft'} Normalized subtitle mode.
 */
export function normalizeVideoSubtitleMode(rawMode, fallback = DEFAULT_DUB_SUBTITLE_MODE) {
  return resolveCanonicalVideoSubtitleMode(rawMode) || fallback;
}

/**
 * Clamps a single mixing/ducking gain field (`originalVolume`, `dubVolume`, `duckVolume`) to safe bounds.
 * Inputs: `field` key and `rawValue`.
 * Outputs: rounded gain number within `DUB_MIX_BOUNDS[field]`.
 * Side effects: none.
 * Failure modes: returns field default when `rawValue` is non-finite or `field` is unknown.
 * @param {'originalVolume'|'dubVolume'|'duckVolume'} field - Gain field name.
 * @param {unknown} rawValue - Candidate numeric value.
 * @returns {number} Clamped linear gain.
 */
export function clampDubMixField(field, rawValue) {
  const spec = DUB_MIX_BOUNDS[field];
  if (!spec) return 1;
  if (rawValue === null || rawValue === undefined || rawValue === '' || typeof rawValue === 'boolean') {
    return spec.defaultValue;
  }
  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric)) return spec.defaultValue;
  const clamped = Math.min(spec.max, Math.max(spec.min, numeric));
  return Math.round(clamped * 100) / 100;
}

/**
 * Normalizes an arbitrary mix settings object into a frozen `{ originalVolume, dubVolume, duckVolume }`.
 * Inputs: optional `rawSettings` object.
 * Outputs: frozen mix settings object.
 * Side effects: none.
 * Failure modes: falls back per-field to `DEFAULT_DUB_MIX_SETTINGS` when omitted/corrupt.
 * @param {object|null|undefined} [rawSettings] - Raw mix settings.
 * @returns {Readonly<{ originalVolume: number, dubVolume: number, duckVolume: number }>} Frozen mix settings.
 */
export function normalizeDubMixSettings(rawSettings = null) {
  const src = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
  return Object.freeze({
    originalVolume: clampDubMixField('originalVolume', src.originalVolume),
    dubVolume: clampDubMixField('dubVolume', src.dubVolume),
    duckVolume: clampDubMixField('duckVolume', src.duckVolume),
  });
}

function validateSingleMixGain(field, rawValue) {
  const spec = DUB_MIX_BOUNDS[field];
  if (rawValue === undefined || rawValue === null) return spec.defaultValue;
  if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) {
    throw new ValidationError(`${field} must be a finite number.`, field, 'INVALID_DUB_MIX_SETTINGS');
  }
  if (rawValue < spec.min - FLOAT_EPSILON || rawValue > spec.max + FLOAT_EPSILON) {
    throw new ValidationError(
      `${field} must be between ${spec.min} and ${spec.max}.`,
      field,
      'INVALID_DUB_MIX_SETTINGS'
    );
  }
  return Math.round(rawValue * 100) / 100;
}

/**
 * Strictly validates dubbing mix/ducking gains at export time, rejecting out-of-bounds values.
 * Inputs: optional `rawSettings` object.
 * Outputs: frozen validated `{ originalVolume, dubVolume, duckVolume }`.
 * Side effects: none.
 * Failure modes: throws ValidationError (`INVALID_DUB_MIX_SETTINGS`) on invalid or out-of-range values.
 * @param {object|null|undefined} [rawSettings] - Candidate mix settings.
 * @returns {Readonly<{ originalVolume: number, dubVolume: number, duckVolume: number }>} Validated mix settings.
 */
export function validateDubMixSettings(rawSettings = null) {
  if (rawSettings === null || rawSettings === undefined) return DEFAULT_DUB_MIX_SETTINGS;
  if (typeof rawSettings !== 'object' || Array.isArray(rawSettings)) {
    throw new ValidationError('Mix settings must be an object.', 'mixSettings', 'INVALID_DUB_MIX_SETTINGS');
  }
  return Object.freeze({
    originalVolume: validateSingleMixGain('originalVolume', rawSettings.originalVolume),
    dubVolume: validateSingleMixGain('dubVolume', rawSettings.dubVolume),
    duckVolume: validateSingleMixGain('duckVolume', rawSettings.duckVolume),
  });
}

/**
 * Returns true when any gain in `settings` differs from `DEFAULT_DUB_MIX_SETTINGS`.
 * Inputs: optional `settings` object.
 * Outputs: boolean indicating customized mix/ducking gains.
 * Side effects: none.
 * Failure modes: returns false for null/default inputs.
 * @param {object|null|undefined} [settings] - Mix settings to inspect.
 * @returns {boolean} True when customized.
 */
export function hasCustomDubMixSettings(settings) {
  if (!settings || typeof settings !== 'object') return false;
  const norm = normalizeDubMixSettings(settings);
  return (
    Math.abs(norm.originalVolume - DEFAULT_DUB_MIX_SETTINGS.originalVolume) > FLOAT_EPSILON ||
    Math.abs(norm.dubVolume - DEFAULT_DUB_MIX_SETTINGS.dubVolume) > FLOAT_EPSILON ||
    Math.abs(norm.duckVolume - DEFAULT_DUB_MIX_SETTINGS.duckVolume) > FLOAT_EPSILON
  );
}

/**
 * Formats a positive linear gain into a rounded decibel string (e.g. `0.15` -> `'-16 dB'`).
 * Inputs: positive `gain` number.
 * Outputs: formatted dB string.
 * Side effects: none.
 * Failure modes: returns `'0 dB'` for invalid/non-positive inputs.
 * @param {number} gain - Linear amplitude multiplier.
 * @returns {string} Decibel label.
 */
export function formatGainDbLabel(gain) {
  if (!Number.isFinite(gain) || gain <= 0) return '0 dB';
  const db = Math.round(DB_MULTIPLIER * Math.log10(gain));
  if (db === 0) return '0 dB';
  return db > 0 ? `+${db} dB` : `${db} dB`;
}

/**
 * Formats a linear gain multiplier as a whole-number percentage string (`100%`).
 * Inputs: `gain` multiplier.
 * Outputs: percentage label string.
 * Side effects: none.
 * Failure modes: defaults to `'100%'` for non-finite values.
 * @param {number} gain - Linear amplitude multiplier.
 * @returns {string} Percentage label.
 */
export function formatGainPercentLabel(gain) {
  if (!Number.isFinite(gain) || gain < 0) return '100%';
  return `${Math.round(gain * 100)}%`;
}

/**
 * Formats a concise human-readable description of the active video audio mode and mixing/ducking gains.
 * Inputs: `audioMode` and optional `mixSettings`.
 * Outputs: summary string suitable for preset specs and export history.
 * Side effects: none.
 * Failure modes: normalizes unrecognized values safely for display.
 * @param {string} audioMode - Video audio mode.
 * @param {object} [mixSettings] - Active mix settings.
 * @returns {string} Readable audio mode summary.
 */
export function formatVideoAudioModeSummary(audioMode, mixSettings = DEFAULT_DUB_MIX_SETTINGS) {
  const mode = normalizeVideoAudioMode(audioMode);
  const mix = normalizeDubMixSettings(mixSettings);
  const origPct = formatGainPercentLabel(mix.originalVolume);
  const voicePct = formatGainPercentLabel(mix.dubVolume);
  if (mode === VIDEO_AUDIO_MODES.ORIGINAL) {
    return mix.originalVolume === 1 ? 'Original audio' : `Original audio (${origPct})`;
  }
  if (mode === VIDEO_AUDIO_MODES.REPLACE) {
    return mix.dubVolume === 1 ? 'Replacement dubbing (original muted)' : `Replacement dubbing · Voice ${voicePct}`;
  }
  if (mode === VIDEO_AUDIO_MODES.MIX) {
    return `Mixed audio · Orig ${origPct} · Voice ${voicePct}`;
  }
  const duckPct = formatGainPercentLabel(mix.duckVolume);
  const duckDb = formatGainDbLabel(mix.duckVolume);
  return `Auto-duck mix · Duck ${duckPct} (${duckDb}) · Orig ${origPct} · Voice ${voicePct}`;
}

/**
 * Formats a concise human-readable description of the active video subtitle mode and caption language.
 * Inputs: `subtitleMode` and optional `langInfo` (`{ languageMode, bcp47, label }`).
 * Outputs: summary string suitable for preset specs and export history.
 * Side effects: none.
 * Failure modes: defaults cleanly to `'No subtitles'` when unset.
 * @param {string} subtitleMode - Video subtitle mode (`'none'`, `'burned'`, `'soft'`).
 * @param {{ languageMode?: string, bcp47?: string, label?: string }} [langInfo] - Resolved subtitle language info.
 * @returns {string} Readable subtitle mode summary.
 */
export function formatVideoSubtitleModeSummary(subtitleMode, langInfo = {}) {
  const mode = normalizeVideoSubtitleMode(subtitleMode);
  if (mode === VIDEO_SUBTITLE_MODES.NONE) return 'No subtitles';
  const prefix = mode === VIDEO_SUBTITLE_MODES.BURNED ? 'Burned-in ASS' : 'Embedded track (mov_text)';
  const langTag = langInfo?.bcp47 ? `${langInfo.label || langInfo.bcp47} (${langInfo.bcp47})` : (langInfo?.label || '');
  const bilingualNote = langInfo?.languageMode === 'bilingual' ? 'Bilingual · ' : '';
  return langTag && langTag !== 'Undetermined' ? `${prefix} · ${bilingualNote}${langTag}` : prefix;
}
