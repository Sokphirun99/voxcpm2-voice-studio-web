/**
 * @fileoverview Pure domain subtitle alignment helpers, WebVTT/SRT/Dialogue formatters, segment edits, and speaker utilities.
 */

import { MAX_SCRIPT_LENGTH, countGraphemes } from './presets.js';
import { ValidationError } from './errors.js';
export {
  DEFAULT_ENGLISH_TARGET,
  DEFAULT_KHMER_TARGET,
  DEFAULT_SOURCE_LANGUAGE,
  ISO_TO_NLLB,
  POPULAR_SOURCE_LANGUAGE_IDS,
  POPULAR_TARGET_LANGUAGE_IDS,
  SOURCE_LANGUAGE_OPTIONS,
  TARGET_LANGUAGE_OPTIONS,
  groupLanguageOptions,
  isSameSubtitleLanguage,
  normalizeTargetLanguageCode,
  pickDefaultTargetLanguage,
  resolveTargetLanguageMeta,
} from './subtitleLanguages.js';

export const SUBTITLE_SPEAKER_COLORS = Object.freeze([
  '#eeeeec',
  '#ffe678',
  '#a7bdd5',
  '#a0f2b5',
  '#ffa69e',
  '#ebbaf2',
]);

export const SUBTITLE_POSITION_OPTIONS = Object.freeze([
  { id: 'bottom', label: 'Bottom' },
  { id: 'middle', label: 'Middle' },
  { id: 'top', label: 'Top' },
]);

export const SUBTITLE_FONT_SCALE_OPTIONS = Object.freeze([
  { id: 'small', label: 'Small' },
  { id: 'medium', label: 'Medium' },
  { id: 'large', label: 'Large' },
]);

export const SUBTITLE_BACKGROUND_OPTIONS = Object.freeze([
  { id: 'box', label: 'Dark box' },
  { id: 'outline', label: 'Outline' },
  { id: 'clean', label: 'Clean shadow' },
]);

export const SUBTITLE_STYLE_DEFAULTS = Object.freeze({
  position: 'bottom',
  fontScale: 'medium',
  backgroundStyle: 'box',
});

export const MODEL_DOWNLOAD_HINTS = Object.freeze({
  whisper: 'First-time transcription will download Whisper Large-v3-Turbo (~1.5 GB).',
  khmerAsr: 'First-time Khmer speech recognition will download Qwen3-ASR-0.6B-Khmer (~1.5 GB).',
  translator: 'First-time translation will download NLLB-200 (~2.4 GB).',
  diarization: 'First-time speaker detection will download diarization models (~35 MB).',
});

/**
 * Resolves download hints for models required by the features currently enabled.
 * @param {{ whisper?: boolean, khmerAsr?: boolean, translator?: boolean, diarization?: boolean } | null} models - Local cache readiness.
 * @param {{ sourceLanguage?: string, detectSpeakers?: boolean, doubleCheckKhmer?: boolean, translateToKhmer?: boolean }} [options] - Active extraction options.
 * @returns {string[]} Ordered hint messages; empty when every required model is cached or readiness is unknown.
 */
export function resolveModelReadinessHints(models, options = {}) {
  if (!models || typeof models !== 'object') return [];
  const missing = key => models[key] === false;
  const khmerSource = options.sourceLanguage === 'km' || options.sourceLanguage === 'auto';
  const needsKhmerAsr = khmerSource || Boolean(options.doubleCheckKhmer);
  const hints = [];
  if (missing('whisper')) hints.push(MODEL_DOWNLOAD_HINTS.whisper);
  if (needsKhmerAsr && missing('khmerAsr')) hints.push(MODEL_DOWNLOAD_HINTS.khmerAsr);
  if (options.detectSpeakers && missing('diarization')) hints.push(MODEL_DOWNLOAD_HINTS.diarization);
  if (options.translateToKhmer && missing('translator')) hints.push(MODEL_DOWNLOAD_HINTS.translator);
  return hints;
}

const AUDIO_ONLY_EXT_PATTERN = /\.(mp3|wav|m4a|aac|ogg|flac)$/i;
const VIDEO_EXT_PATTERN = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const MIN_SPLIT_GAP_SEC = 0.1;
export const MIN_CUE_DURATION_SEC = 0.05;
export const DEFAULT_TIMING_PRECISION = 1;
export const PRECISE_TIMING_PRECISION = 3;
export const TIMING_NUDGE_COARSE_SEC = 0.2;
export const TIMING_NUDGE_FINE_SEC = 0.05;
export const MAX_SUBTITLE_FILE_BYTES = 2 * 1024 * 1024;

export const OVERLAP_RESOLVE_MODES = Object.freeze({
  TRIM_PREVIOUS: 'trim_previous',
  SHIFT_FORWARD: 'shift_forward',
  TRIM_NEXT: 'trim_next',
});

export const OVERLAP_BEHAVIOR_MODES = Object.freeze({
  ALLOW: 'allow',
  PREVENT: 'prevent',
  REJECT: 'reject',
  SHIFT_NEXT: 'shift_next',
});

/**
 * Formats seconds as `HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` (VTT).
 * @param {number} seconds - Non-negative time in seconds.
 * @param {string} [decimalSep=','] - Decimal separator (`,` or `.`).
 * @returns {string} Formatted subtitle timestamp.
 */
export function formatSubtitleTime(seconds, decimalSep = ',') {
  const safeMs = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
  const hours = Math.floor(safeMs / 3_600_000);
  const mins = Math.floor((safeMs % 3_600_000) / 60_000);
  const secs = Math.floor((safeMs % 60_000) / 1000);
  const ms = safeMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}${decimalSep}${String(ms).padStart(3, '0')}`;
}

const SUBTITLE_TIMESTAMP_PATTERNS = Object.freeze({
  srt: /^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$/,
  vtt: /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/,
});

/**
 * Normalizes subtitle text and rejects unreadable or oversized files.
 * @param {string} rawText - UTF-8 subtitle file content.
 * @returns {string} LF-normalized content without a BOM.
 */
function normalizeSubtitleInput(rawText) {
  if (typeof rawText !== 'string') {
    throw new ValidationError('Subtitle file must contain text.', 'file', 'INVALID_SUBTITLE_FILE');
  }
  if (new TextEncoder().encode(rawText).byteLength > MAX_SUBTITLE_FILE_BYTES) {
    throw new ValidationError('Subtitle files must be 2 MB or smaller.', 'file', 'SUBTITLE_FILE_TOO_LARGE');
  }
  return rawText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/**
 * Parses one `HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` / `MM:SS.mmm` (VTT) timestamp.
 * @param {string} raw - Timestamp token.
 * @param {'srt'|'vtt'} format - Timestamp dialect.
 * @returns {number|null} Seconds, or null when malformed.
 */
function parseCueTimestamp(raw, format) {
  const match = SUBTITLE_TIMESTAMP_PATTERNS[format]?.exec(raw.trim());
  if (!match) return null;
  const [, hours = '0', minutes, seconds, millis] = match;
  const total = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(millis) / 1000;
  return Number.isFinite(total) ? total : null;
}

/**
 * Parses a `start --> end` timing line, ignoring trailing VTT cue settings.
 * @param {string} line - Candidate timing line.
 * @param {'srt'|'vtt'} format - Timestamp dialect.
 * @returns {{ start: number, end: number }|null} Timing pair or null.
 */
function parseCueTiming(line, format) {
  const match = /^\s*(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(line);
  if (!match) return null;
  const start = parseCueTimestamp(match[1], format);
  const end = parseCueTimestamp(match[2], format);
  return start !== null && end !== null ? { start, end } : null;
}

/**
 * Removes inline WebVTT/SRT formatting tags without touching the DOM.
 * @param {string} text - Raw cue line.
 * @returns {string} Plain cue text.
 */
function stripSubtitleTags(text) {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .trim();
}

/**
 * Extracts an optional `[Speaker]` or `Speaker:` prefix from cue text.
 * @param {string} text - Plain cue text.
 * @returns {{ speakerName: string, text: string }} Speaker label and remaining text.
 */
function extractSubtitleSpeaker(text) {
  const match = /^\[([^\]\n]+)\]\s*/.exec(text) || /^([^:\n]{1,80}):\s*/.exec(text);
  if (!match) return { speakerName: '', text };
  return { speakerName: match[1].trim(), text: text.slice(match[0].length).trim() };
}

/**
 * Parses one SRT/VTT cue block, skipping headers, notes, and malformed cues.
 * @param {string} block - Blank-line-delimited cue block.
 * @param {'srt'|'vtt'} format - Timestamp dialect.
 * @returns {{ start: number, end: number, speakerName: string, text: string }|null} Cue or null.
 */
function parseSubtitleCueBlock(block, format) {
  const lines = block.split('\n');
  if (/^(WEBVTT|NOTE(?:\s|$)|STYLE(?:\s|$)|REGION(?:\s|$))/.test(lines[0].trim())) return null;
  const timingIndex = lines.findIndex((line, index) => index < 3 && parseCueTiming(line, format));
  if (timingIndex < 0) return null;
  const timing = parseCueTiming(lines[timingIndex], format);
  const body = lines.slice(timingIndex + 1).map(stripSubtitleTags).filter(Boolean).join('\n');
  const speaker = extractSubtitleSpeaker(body);
  return timing && speaker.text ? { ...timing, ...speaker } : null;
}

/**
 * Parses blank-line-delimited SRT/VTT blocks into monotonic subtitle segments.
 * @param {string} rawText - UTF-8 subtitle file content.
 * @param {'srt'|'vtt'} format - Timestamp dialect.
 * @returns {Array<object>} Parsed subtitle segments.
 */
function parseSubtitleBlocks(rawText, format) {
  const normalized = normalizeSubtitleInput(rawText);
  const speakerIds = new Map();
  const segments = [];
  let lastStart = -1;
  for (const block of normalized.split(/\n[ \t]*\n+/)) {
    const cue = parseSubtitleCueBlock(block.trim(), format);
    if (!cue || cue.start < lastStart || cue.end <= cue.start) continue;
    lastStart = cue.start;
    const labelKey = cue.speakerName.toLocaleLowerCase();
    if (cue.speakerName && !speakerIds.has(labelKey)) speakerIds.set(labelKey, `speaker-${speakerIds.size + 1}`);
    const speakerId = cue.speakerName ? speakerIds.get(labelKey) : 'speaker-1';
    segments.push({
      id: `cue-${segments.length + 1}`,
      start: cue.start,
      end: cue.end,
      text: cue.text,
      translatedText: '',
      speakerId,
      speakerName: cue.speakerName,
    });
  }
  if (!segments.length) throw new ValidationError('No valid subtitle cues were found.', 'file', 'NO_VALID_SUBTITLE_CUES');
  return segments;
}

/**
 * Parses SubRip text into normalized subtitle cues.
 * @param {string} rawText - UTF-8 SRT text.
 * @returns {Array<object>} Parsed subtitle segments.
 */
export function parseSrt(rawText) {
  return parseSubtitleBlocks(rawText, 'srt');
}

/**
 * Parses WebVTT text into normalized subtitle cues.
 * @param {string} rawText - UTF-8 VTT text.
 * @returns {Array<object>} Parsed subtitle segments.
 */
export function parseVtt(rawText) {
  return parseSubtitleBlocks(rawText, 'vtt');
}

/**
 * Chooses the subtitle parser from a `.srt` or `.vtt` filename.
 * @param {string} rawText - UTF-8 subtitle text.
 * @param {string} fileName - Uploaded subtitle filename.
 * @returns {Array<object>} Parsed subtitle segments.
 */
export function parseSubtitleFileText(rawText, fileName) {
  const extension = String(fileName || '').toLowerCase().match(/\.(srt|vtt)$/)?.[1];
  if (extension === 'srt') return parseSrt(rawText);
  if (extension === 'vtt') return parseVtt(rawText);
  throw new ValidationError('Choose a .srt or .vtt subtitle file.', 'file', 'UNSUPPORTED_SUBTITLE_FILE');
}

/**
 * Formats non-negative seconds concisely as `MM:SS` or `HH:MM:SS`.
 * @param {number} seconds - Non-negative timestamp seconds.
 * @returns {string} Short clock label.
 */
export function formatShortClock(seconds) {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Resolves a human-readable display name for `speakerId`.
 * @param {string} speakerId - Canonical speaker ID such as `speaker-1`.
 * @param {Record<string, string>} [speakerNames] - Custom speaker display names.
 * @returns {string} Speaker label.
 */
export function resolveSpeakerLabel(speakerId, speakerNames = {}) {
  const custom = speakerNames?.[speakerId]?.trim();
  if (custom) return custom;
  const match = /^speaker-(\d+)$/.exec(String(speakerId || ''));
  return match ? `Speaker ${match[1]}` : String(speakerId || 'Speaker 1');
}

/**
 * Picks a deterministic display color for `speakerId`.
 * @param {string} speakerId - Speaker ID.
 * @returns {string} CSS hex color.
 */
export function getSpeakerColor(speakerId) {
  const match = /^speaker-(\d+)$/.exec(String(speakerId || ''));
  const idx = match ? Math.max(0, Number(match[1]) - 1) : 0;
  return SUBTITLE_SPEAKER_COLORS[idx % SUBTITLE_SPEAKER_COLORS.length];
}

/**
 * Collects unique ordered speaker IDs appearing across subtitle segments.
 * @param {Array<{ speakerId: string }>} segments - Timed subtitle segments.
 * @returns {string[]} Unique ordered speaker IDs.
 */
export function collectUniqueSpeakers(segments) {
  const seen = new Set();
  const ordered = [];
  for (const seg of segments || []) {
    if (!seg?.speakerId || seen.has(seg.speakerId)) continue;
    seen.add(seg.speakerId);
    ordered.push(seg.speakerId);
  }
  return ordered;
}

/**
 * Determines whether an uploaded File/media item is audio-only (lacks a video track).
 * @param {{ name?: string, type?: string }|null|undefined} file - Uploaded media descriptor.
 * @returns {boolean} True when file is audio-only.
 */
export function isAudioOnlyFile(file) {
  if (!file) return false;
  const name = String(file.name || '');
  const mime = String(file.type || '');
  if (AUDIO_ONLY_EXT_PATTERN.test(name)) return true;
  if (VIDEO_EXT_PATTERN.test(name)) return false;
  return mime.startsWith('audio/');
}

/**
 * Picks translated, original, or bilingual stacked text for display/export.
 * @param {object} seg - Subtitle segment object.
 * @param {boolean} [useTranslation=false] - Whether translation view/export is active.
 * @param {boolean} [bilingual=false] - Whether to stack original + translation.
 * @returns {string} Display text.
 */
export function pickSegmentText(seg, useTranslation = false, bilingual = false) {
  const original = typeof seg?.text === 'string' ? seg.text.trim() : '';
  const translated = typeof seg?.translatedText === 'string' ? seg.translatedText.trim() : '';
  if (bilingual && original && translated && original !== translated) return `${original}\n${translated}`;
  if (useTranslation && translated) return translated;
  return original;
}

/**
 * Normalizes CRLF line endings and collapses blank lines inside a single SRT/VTT cue body.
 * @param {string} text - Raw cue text.
 * @returns {string} Cue-safe text without internal blank lines.
 */
function normalizeCueText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n(?:[ \t]*\n)+/g, '\n')
    .trim();
}

/**
 * Formats subtitle segments into SubRip (`.srt`) text.
 * @param {object} [spec] - SRT formatting specification.
 * @returns {string} SubRip content.
 */
export function buildSrt({ segments = [], speakerNames = {}, includeSpeaker = true, useTranslation = false, bilingual = false } = {}) {
  const blocks = [];
  for (const seg of segments) {
    const body = normalizeCueText(pickSegmentText(seg, useTranslation, bilingual));
    if (!body) continue;
    const prefix = includeSpeaker ? `[${resolveSpeakerLabel(seg.speakerId, speakerNames)}] ` : '';
    const timing = `${formatSubtitleTime(seg.start, ',')} --> ${formatSubtitleTime(seg.end, ',')}`;
    blocks.push(`${blocks.length + 1}\n${timing}\n${prefix}${body}`);
  }
  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}

/**
 * Formats subtitle segments into WebVTT (`.vtt`) text for `<video><track>` preview.
 * @param {object} [spec] - WebVTT formatting specification.
 * @returns {string} WebVTT content.
 */
export function buildVtt({ segments = [], speakerNames = {}, includeSpeaker = true, useTranslation = false, bilingual = false } = {}) {
  const blocks = ['WEBVTT'];
  for (const seg of segments) {
    const body = normalizeCueText(pickSegmentText(seg, useTranslation, bilingual));
    if (!body) continue;
    const prefix = includeSpeaker ? `${resolveSpeakerLabel(seg.speakerId, speakerNames)}: ` : '';
    const timing = `${formatSubtitleTime(seg.start, '.')} --> ${formatSubtitleTime(seg.end, '.')}`;
    blocks.push(`${timing}\n${prefix}${body}`);
  }
  return `${blocks.join('\n\n')}\n`;
}

/**
 * Groups consecutive utterances by the same speaker into a readable conversation script.
 * @param {object} [spec] - Dialogue script formatting options.
 * @returns {string} Multi-speaker transcript text.
 */
export function buildDialogueText({
  segments = [],
  speakerNames = {},
  includeTimestamps = true,
  useTranslation = false,
  includeSpeaker = true,
  bilingual = false,
} = {}) {
  const turns = [];
  for (const seg of segments) {
    const body = pickSegmentText(seg, useTranslation, bilingual);
    if (!body) continue;
    const prev = turns[turns.length - 1];
    if (prev && prev.speakerId === seg.speakerId) {
      prev.end = Math.max(prev.end, seg.end);
      prev.parts.push(body);
    } else {
      turns.push({ speakerId: seg.speakerId, start: seg.start, end: seg.end, parts: [body] });
    }
  }
  return turns
    .map(t => {
      const stamp = includeTimestamps ? `[${formatShortClock(t.start)} - ${formatShortClock(t.end)}] ` : '';
      const spk = includeSpeaker ? `${resolveSpeakerLabel(t.speakerId, speakerNames)}: ` : '';
      if (bilingual) {
        const header = `${stamp}${spk}`.trimEnd();
        const joined = t.parts.join('\n');
        return header ? `${header}\n${joined}` : joined;
      }
      return `${stamp}${spk}${t.parts.join(' ')}`;
    })
    .join('\n');
}

/**
 * Extracts clean plain spoken lines from segments for direct TTS synthesis without timestamps/labels.
 * @param {{ segments?: Array<object>, useTranslation?: boolean, speakerId?: string }} [spec] - Extraction spec.
 * @returns {string} Plain joined speech script.
 */
export function buildTtsScriptFromSegments({ segments = [], useTranslation = true, speakerId = '' } = {}) {
  const lines = [];
  for (const seg of segments) {
    if (speakerId && seg.speakerId !== speakerId) continue;
    const text = pickSegmentText(seg, useTranslation);
    if (text) lines.push(text);
  }
  return lines.join(' ');
}

function sliceGraphemeLimit(text, maxGraphemes) {
  let out = '';
  let count = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) {
    if (count >= maxGraphemes) break;
    out += segment;
    count += 1;
  }
  return out.trim();
}

/**
 * Extracts spoken lines for TTS handoff bounded cleanly to `maxGraphemes` at segment boundaries.
 * @param {{ segments?: Array<object>, useTranslation?: boolean, speakerId?: string, maxGraphemes?: number }} [spec] - Handoff spec.
 * @returns {{ text: string, includedSegments: number, totalSegments: number, totalGraphemes: number, truncated: boolean }} Handoff bundle.
 */
export function buildBoundedTtsHandoff({ segments = [], useTranslation = true, speakerId = '', maxGraphemes = MAX_SCRIPT_LENGTH } = {}) {
  const lines = segments
    .filter(seg => !speakerId || seg.speakerId === speakerId)
    .map(seg => pickSegmentText(seg, useTranslation))
    .filter(Boolean);
  const totalGraphemes = countGraphemes(lines.join(' '));
  let text = '';
  let includedSegments = 0;
  for (const line of lines) {
    const candidate = text ? `${text} ${line}` : line;
    if (countGraphemes(candidate) <= maxGraphemes) {
      text = candidate;
      includedSegments += 1;
    } else {
      if (!text) {
        text = sliceGraphemeLimit(line, maxGraphemes);
        includedSegments = text ? 1 : 0;
      }
      break;
    }
  }
  return {
    text,
    includedSegments,
    totalSegments: lines.length,
    totalGraphemes,
    truncated: includedSegments < lines.length || totalGraphemes > maxGraphemes,
  };
}

/**
 * Finds the ID of the subtitle segment active at `currentTimeSeconds`.
 * @param {Array<{ id: string, start: number, end: number }>} segments - Timed subtitle segments.
 * @param {number} currentTimeSeconds - Current media playback timestamp.
 * @returns {string} Active segment ID or empty string.
 */
export function findActiveSegmentId(segments, currentTimeSeconds) {
  if (!Array.isArray(segments) || !Number.isFinite(currentTimeSeconds)) return '';
  const match = segments.find(seg => currentTimeSeconds >= Number(seg.start) && currentTimeSeconds <= Number(seg.end));
  return match?.id || '';
}

/**
 * Rounds non-negative seconds to exact millisecond precision.
 * Inputs: seconds timestamp. Outputs: rounded seconds with <= 3 decimal places.
 * Side effects: none. Failure modes: returns 0 on non-finite input.
 * @param {number} seconds - Input timestamp in seconds.
 * @returns {number} Rounded seconds.
 */
export function roundToMs(seconds) {
  if (!Number.isFinite(seconds)) return 0;
  return Math.round(seconds * 1000) / 1000;
}

function resolveTimestampPrecision(seconds, precision) {
  if (typeof precision === 'number' && Number.isFinite(precision)) {
    return Math.max(0, Math.min(PRECISE_TIMING_PRECISION, Math.floor(precision)));
  }
  if (precision && typeof precision === 'object' && Number.isFinite(precision.precision)) {
    return Math.max(0, Math.min(PRECISE_TIMING_PRECISION, Math.floor(precision.precision)));
  }
  const hasSubTenth = Math.abs(roundToMs(seconds) - Math.round(seconds * 10) / 10) > 1e-4;
  return hasSubTenth ? PRECISE_TIMING_PRECISION : DEFAULT_TIMING_PRECISION;
}

/**
 * Formats seconds as `MM:SS.d`, `MM:SS.mmm`, or `H:MM:SS.mmm` for inline editing.
 * Inputs: seconds timestamp, optional precision. Outputs: formatted clock string.
 * Side effects: none. Failure modes: clamps non-finite to 0.
 * @param {number} seconds - Non-negative timestamp in seconds.
 * @param {number|object} [precision] - Decimal precision (1-3) or option object.
 * @returns {string} Editable timestamp string.
 */
export function formatEditableTimestamp(seconds, precision = null) {
  const prec = resolveTimestampPrecision(seconds, precision);
  const factor = Math.pow(10, prec);
  const clamped = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * factor) / factor : 0;
  const totalUnits = Math.round(clamped * factor);
  const hours = Math.floor(totalUnits / (3600 * factor));
  const mins = Math.floor((totalUnits % (3600 * factor)) / (60 * factor));
  const secs = Math.floor((totalUnits % (60 * factor)) / factor);
  const fraction = totalUnits % factor;
  const fracLabel = prec > 0 ? `.${String(fraction).padStart(prec, '0')}` : '';
  const secLabel = `${String(secs).padStart(2, '0')}${fracLabel}`;
  if (hours > 0) return `${hours}:${String(mins).padStart(2, '0')}:${secLabel}`;
  return `${String(mins).padStart(2, '0')}:${secLabel}`;
}

/**
 * Validates a cue timing interval returning a typed validation result.
 * Inputs: timing parameters `{ start, end, minDuration, maxDuration }`. Outputs: validation object.
 * Side effects: none. Failure modes: returns structured failure object on invalid timing.
 * @param {object} params - Interval parameters.
 * @param {number} params.start - Cue start time in seconds.
 * @param {number} params.end - Cue end time in seconds.
 * @param {number} [params.minDuration=MIN_SPLIT_GAP_SEC] - Minimum required duration.
 * @param {number|null} [params.maxDuration=null] - Maximum media duration bound.
 * @returns {{ valid: boolean, error: string|null, code: string|null, field: string|null }} Result.
 */
export function validateCueInterval({ start, end, minDuration = MIN_SPLIT_GAP_SEC, maxDuration = null }) {
  if (!Number.isFinite(start) || start < 0) {
    return { valid: false, error: 'Start time must be a non-negative number.', code: 'INVALID_START_TIME', field: 'start' };
  }
  if (!Number.isFinite(end)) {
    return { valid: false, error: 'End time must be a valid number.', code: 'INVALID_END_TIME', field: 'end' };
  }
  if (end <= start) {
    return { valid: false, error: 'End time must be greater than start time.', code: 'END_BEFORE_START', field: 'end' };
  }
  if (roundToMs(end - start) < minDuration) {
    return { valid: false, error: `Duration must be at least ${minDuration}s.`, code: 'DURATION_TOO_SHORT', field: 'duration' };
  }
  if (Number.isFinite(maxDuration) && maxDuration > 0 && end > maxDuration) {
    return { valid: false, error: `End time exceeds media duration of ${maxDuration}s.`, code: 'EXCEEDS_MEDIA_DURATION', field: 'end' };
  }
  return { valid: true, error: null, code: null, field: null };
}

/**
 * Asserts that a cue interval is valid, throwing ValidationError when invalid.
 * Inputs: timing parameters. Outputs: void.
 * Side effects: throws on failure. Failure modes: ValidationError.
 * @param {object} params - Interval parameters.
 * @throws {ValidationError} When interval is invalid.
 */
export function assertValidCueInterval(params) {
  const result = validateCueInterval(params);
  if (!result.valid) {
    throw new ValidationError(result.error, result.field, result.code);
  }
}

function buildOverlapDescriptor(a, b, indexA, indexB) {
  const start = Math.max(roundToMs(a.start), roundToMs(b.start));
  const end = Math.min(roundToMs(a.end), roundToMs(b.end));
  if (end <= start) return null;
  return {
    cueAId: a.id,
    cueBId: b.id,
    indexA,
    indexB,
    overlapStart: start,
    overlapEnd: end,
    overlapDuration: roundToMs(end - start),
  };
}

/**
 * Detects overlapping time intervals across cues in a segment list.
 * Inputs: timed segments array. Outputs: array of detected overlap records.
 * Side effects: none. Failure modes: empty array on invalid inputs.
 * @param {Array<object>} segments - Timed subtitle segments.
 * @returns {Array<object>} List of detected overlap descriptors.
 */
export function detectCueOverlaps(segments) {
  if (!Array.isArray(segments) || segments.length < 2) return [];
  const overlaps = [];
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const desc = buildOverlapDescriptor(segments[i], segments[j], i, j);
      if (desc) overlaps.push(desc);
    }
  }
  return overlaps;
}

/**
 * Finds any overlap involving the specified segment ID.
 * Inputs: segments array, segment ID. Outputs: overlap record or null.
 * Side effects: none. Failure modes: null if not overlapping.
 * @param {Array<object>} segments - Timed subtitle segments.
 * @param {string} segId - Target segment ID.
 * @returns {object|null} Overlap record or null.
 */
export function findCueOverlap(segments, segId) {
  if (!segId) return null;
  const overlaps = detectCueOverlaps(segments);
  return overlaps.find(o => o.cueAId === segId || o.cueBId === segId) || null;
}

/**
 * Retrieves the pause/gap duration before and after a specified cue.
 * Inputs: segments array, segment ID. Outputs: gap duration info.
 * Side effects: none. Failure modes: null gap bounds when on edge cues.
 * @param {Array<object>} segments - Timed subtitle segments.
 * @param {string} segId - Target segment ID.
 * @returns {{ pauseBefore: number|null, pauseAfter: number|null, isOverlapping: boolean }} Gap info.
 */
export function getCuePause(segments, segId) {
  const list = segments || [];
  const idx = list.findIndex(s => s.id === segId);
  if (idx < 0) return { pauseBefore: null, pauseAfter: null, isOverlapping: false };
  const cur = list[idx];
  const prev = idx > 0 ? list[idx - 1] : null;
  const next = idx < list.length - 1 ? list[idx + 1] : null;
  const pauseBefore = prev ? roundToMs(cur.start - prev.end) : null;
  const pauseAfter = next ? roundToMs(next.start - cur.end) : null;
  const isOverlapping = (pauseBefore !== null && pauseBefore < 0) || (pauseAfter !== null && pauseAfter < 0);
  return { pauseBefore, pauseAfter, isOverlapping };
}

/**
 * Clamps a cue interval within neighbor boundaries and minimum duration limits.
 * Inputs: interval object, constraints. Outputs: clamped interval object.
 * Side effects: none. Failure modes: enforces safe positive values.
 * @param {{ start: number, end: number }} interval - Target interval.
 * @param {object} [constraints] - Clamping bounds.
 * @returns {{ start: number, end: number }} Clamped interval.
 */
export function clampCueInterval(interval, { minStart = 0, maxEnd = Infinity, minDuration = MIN_SPLIT_GAP_SEC } = {}) {
  const safeMinStart = Math.max(0, Number.isFinite(minStart) ? minStart : 0);
  const start = Math.max(safeMinStart, roundToMs(interval?.start ?? safeMinStart));
  const rawEnd = roundToMs(interval?.end ?? start + minDuration);
  const minEnd = roundToMs(start + minDuration);
  const safeMaxEnd = Number.isFinite(maxEnd) ? Math.max(minEnd, maxEnd) : Infinity;
  const end = Math.min(safeMaxEnd, Math.max(minEnd, rawEnd));
  return { start, end };
}

/**
 * Snaps a candidate timestamp to an anchor timestamp when within threshold distance.
 * Inputs: candidate timestamp, target timestamp, snap threshold. Outputs: snapped or original timestamp.
 * Side effects: none. Failure modes: returns 0 on invalid candidate.
 * @param {number} timestamp - Current timestamp.
 * @param {number} targetTimestamp - Snap target timestamp.
 * @param {number} [threshold=0.15] - Maximum snapping distance in seconds.
 * @returns {number} Snapped or original timestamp.
 */
export function snapCueTimestamp(timestamp, targetTimestamp, threshold = 0.15) {
  if (!Number.isFinite(timestamp)) return 0;
  if (!Number.isFinite(targetTimestamp)) return roundToMs(timestamp);
  if (Math.abs(timestamp - targetTimestamp) <= threshold) {
    return roundToMs(targetTimestamp);
  }
  return roundToMs(timestamp);
}

function shiftSubsequentCues(list, startIndex, delta, rippleAll) {
  const endIndex = rippleAll ? list.length - 1 : startIndex;
  return list.map((seg, i) => {
    if (i < startIndex || i > endIndex) return seg;
    return {
      ...seg,
      start: roundToMs(seg.start + delta),
      end: roundToMs(seg.end + delta),
    };
  });
}

/**
 * Adjusts the pause gap between a cue and its successor.
 * Inputs: segments array, cue ID, target pause in seconds, options. Outputs: updated segments array.
 * Side effects: none. Failure modes: returns input array when last cue or ID not found.
 * @param {Array<object>} segments - Timed subtitle segments.
 * @param {string} segId - Target segment ID.
 * @param {number} pauseSec - Desired pause in seconds (>= 0).
 * @param {object} [options] - Adjustment options.
 * @returns {Array<object>} Updated segments list.
 */
export function adjustCuePause(segments, segId, pauseSec, options = {}) {
  const list = segments || [];
  const idx = list.findIndex(s => s.id === segId);
  if (idx < 0 || idx >= list.length - 1) return list;
  const { mode = 'shift_subsequent', minDuration = MIN_SPLIT_GAP_SEC, rippleAll = true } = options;
  const safePause = Math.max(0, roundToMs(pauseSec));
  const cur = list[idx];
  const next = list[idx + 1];
  if (mode === 'adjust_end') {
    const nextEnd = Math.max(cur.start + minDuration, roundToMs(next.start - safePause));
    return list.map((seg, i) => (i === idx ? { ...seg, end: nextEnd } : seg));
  }
  const targetNextStart = roundToMs(cur.end + safePause);
  const delta = roundToMs(targetNextStart - next.start);
  if (delta === 0) return list;
  return shiftSubsequentCues(list, idx + 1, delta, rippleAll);
}

function resolveOverlapPair(a, b, options) {
  const { resolutionMode, minDuration, minGap } = options;
  if (resolutionMode === OVERLAP_RESOLVE_MODES.TRIM_NEXT) {
    const newBStart = roundToMs(a.end + minGap);
    const newBEnd = Math.max(newBStart + minDuration, b.end);
    return [{ ...a }, { ...b, start: newBStart, end: newBEnd }];
  }
  if (resolutionMode === OVERLAP_RESOLVE_MODES.SHIFT_FORWARD) {
    const duration = roundToMs(b.end - b.start);
    const newBStart = roundToMs(a.end + minGap);
    return [{ ...a }, { ...b, start: newBStart, end: roundToMs(newBStart + duration) }];
  }
  const trimmedEnd = Math.max(a.start + minDuration, roundToMs(b.start - minGap));
  const forcedStart = trimmedEnd > roundToMs(b.start - minGap) ? roundToMs(trimmedEnd + minGap) : b.start;
  const finalBEnd = Math.max(forcedStart + minDuration, b.end);
  return [{ ...a, end: trimmedEnd }, { ...b, start: forcedStart, end: finalBEnd }];
}

/**
 * Resolves overlapping intervals across adjacent subtitle segments.
 * Inputs: segments array, resolution options. Outputs: resolved segments array.
 * Side effects: none. Failure modes: returns input array when < 2 cues.
 * @param {Array<object>} segments - Timed subtitle segments.
 * @param {object} [options] - Resolution options.
 * @returns {Array<object>} Resolved segments array.
 */
export function resolveCueOverlaps(segments, options = {}) {
  const { resolutionMode = OVERLAP_RESOLVE_MODES.TRIM_PREVIOUS, minDuration = MIN_SPLIT_GAP_SEC, minGap = 0 } = options;
  if (!Array.isArray(segments) || segments.length < 2) return segments || [];
  const out = [segments[0]];
  for (let i = 1; i < segments.length; i++) {
    const prev = out[i - 1];
    const cur = segments[i];
    if (roundToMs(prev.end) > roundToMs(cur.start - minGap)) {
      const [fixedPrev, fixedCur] = resolveOverlapPair(prev, cur, { resolutionMode, minDuration, minGap });
      out[i - 1] = fixedPrev;
      out.push(fixedCur);
    } else {
      out.push(cur);
    }
  }
  return out;
}

/**
 * Parses `SS`, `MM:SS`, `MM:SS.d`, or `HH:MM:SS.d` timestamp strings into seconds.
 * @param {unknown} raw - Candidate timestamp text.
 * @returns {number|null} Parsed non-negative seconds or null when invalid.
 */
export function parseEditableTimestamp(raw) {
  const cleaned = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
  if (!cleaned) return null;
  const parts = cleaned.split(':');
  if (parts.length > 3) return null;
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    const part = parts[i];
    if (!part || (isLast ? !/^\d+(?:\.\d+)?$/.test(part) : !/^\d+$/.test(part))) return null;
    const num = Number(part);
    if (!Number.isFinite(num) || (!isLast && i > 0 && num >= 60) || (isLast && parts.length > 1 && num >= 60)) return null;
    total = total * 60 + num;
  }
  return Math.round(total * 1000) / 1000;
}

function resolveSegmentTimingBounds(list, idx, minGap) {
  const prev = idx > 0 ? list[idx - 1] : null;
  const next = idx < list.length - 1 ? list[idx + 1] : null;
  return {
    prevEnd: prev ? roundToMs(prev.end + minGap) : 0,
    nextStart: next ? roundToMs(next.start - minGap) : Infinity,
  };
}

function computeClampedCueTimes(rawStart, rawEnd, bounds, minDuration) {
  const boundedStart = Math.max(bounds.prevEnd, rawStart);
  const minEnd = roundToMs(boundedStart + minDuration);
  const boundedEnd = Math.min(bounds.nextStart, Math.max(minEnd, rawEnd));
  return { start: boundedStart, end: boundedEnd };
}

function applyTimingWithOverlapMode(list, idx, params) {
  const { rawStart, rawEnd, bounds, minDuration, overlapMode, minGap } = params;
  if (overlapMode === OVERLAP_BEHAVIOR_MODES.PREVENT) {
    const clamped = computeClampedCueTimes(rawStart, rawEnd, bounds, minDuration);
    return list.map((seg, i) => (i === idx ? { ...seg, ...clamped } : seg));
  }
  const nextEnd = Math.max(roundToMs(rawStart + minDuration), rawEnd);
  if (overlapMode === OVERLAP_BEHAVIOR_MODES.REJECT && (rawStart < bounds.prevEnd || nextEnd > bounds.nextStart)) {
    throw new ValidationError('Cue interval overlaps with an adjacent cue.', 'timing', 'CUE_OVERLAP');
  }
  if (overlapMode === OVERLAP_BEHAVIOR_MODES.SHIFT_NEXT && nextEnd > bounds.nextStart) {
    const delta = roundToMs(nextEnd - bounds.nextStart + minGap);
    const updated = list.map((seg, i) => (i === idx ? { ...seg, start: rawStart, end: nextEnd } : seg));
    return shiftSubsequentCues(updated, idx + 1, delta, true);
  }
  return list.map((seg, i) => (i === idx ? { ...seg, start: rawStart, end: nextEnd } : seg));
}

/**
 * Updates start/end timestamps on one subtitle segment with validation and overlap handling.
 * Inputs: segments array, cue ID, patch object, options. Outputs: updated segments array.
 * Side effects: throws ValidationError when overlapMode is 'reject' and overlap occurs.
 * Failure modes: returns input array when segId not found.
 * @param {Array<object>} segments - Subtitle segments.
 * @param {string} segId - Target segment ID.
 * @param {{ start?: number, end?: number, duration?: number }} [patch] - Timing patch.
 * @param {object} [options] - Timing and overlap options.
 * @returns {Array<object>} Updated segments array.
 */
export function adjustSubtitleSegmentTiming(segments, segId, patch = {}, options = {}) {
  const list = segments || [];
  const idx = list.findIndex(seg => seg.id === segId);
  if (idx < 0) return list;
  const { minDuration = MIN_SPLIT_GAP_SEC, overlapMode = OVERLAP_BEHAVIOR_MODES.ALLOW, minGap = 0 } = options;
  const cur = list[idx];
  const rawStart = Number.isFinite(patch?.start) ? Math.max(0, roundToMs(patch.start)) : cur.start;
  const candidateEnd = Number.isFinite(patch?.duration) ? roundToMs(rawStart + patch.duration) : patch?.end;
  const rawEnd = Number.isFinite(candidateEnd) ? roundToMs(candidateEnd) : cur.end;
  const bounds = resolveSegmentTimingBounds(list, idx, minGap);
  return applyTimingWithOverlapMode(list, idx, { rawStart, rawEnd, bounds, minDuration, overlapMode, minGap });
}

/**
 * Removes a single subtitle segment by ID.
 * @param {Array<object>} segments - Subtitle segments.
 * @param {string} segId - Target segment ID.
 * @returns {Array<object>} Filtered segments array.
 */
export function deleteSubtitleSegment(segments, segId) {
  return (segments || []).filter(seg => seg.id !== segId);
}

/**
 * Merges a segment with its immediate successor, joining original and translated lines cleanly.
 * @param {Array<object>} segments - Subtitle segments.
 * @param {string} segId - Target segment ID.
 * @returns {Array<object>} Updated segments array.
 */
export function mergeSubtitleSegmentWithNext(segments, segId) {
  const list = segments || [];
  const idx = list.findIndex(seg => seg.id === segId);
  if (idx < 0 || idx >= list.length - 1) return list;
  const cur = list[idx];
  const next = list[idx + 1];
  const join = (a, b) => [String(a || '').trim(), String(b || '').trim()].filter(Boolean).join(' ');
  const merged = {
    ...cur,
    start: Math.min(cur.start, next.start),
    end: Math.max(cur.end, next.end),
    text: join(cur.text, next.text),
    translatedText: join(cur.translatedText, next.translatedText),
  };
  return [...list.slice(0, idx), merged, ...list.slice(idx + 2)];
}

function splitTextGraphemeSafe(text, ratio) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return ['', ''];
  const graphemes = Array.from(GRAPHEME_SEGMENTER.segment(cleaned), item => item.segment);
  if (graphemes.length < 2) return [cleaned, ''];
  const target = Math.max(1, Math.min(graphemes.length - 1, Math.round(graphemes.length * ratio)));
  let bestCut = target;
  let bestDist = Infinity;
  const minBound = Math.max(1, Math.floor(graphemes.length * 0.15));
  const maxBound = Math.min(graphemes.length - 1, Math.ceil(graphemes.length * 0.85));
  for (let i = minBound; i <= maxBound; i++) {
    if (/^\s$/.test(graphemes[i]) && Math.abs(i - target) < bestDist) {
      bestDist = Math.abs(i - target);
      bestCut = i;
    }
  }
  const head = graphemes.slice(0, bestCut).join('').trim();
  const tail = graphemes.slice(bestCut).join('').trim();
  return head && tail ? [head, tail] : [cleaned, ''];
}

function buildUniqueSegmentId(segments, baseId) {
  const used = new Set((segments || []).map(seg => seg.id));
  let suffix = 2;
  while (used.has(`${baseId}-split-${suffix}`)) suffix += 1;
  return `${baseId}-split-${suffix}`;
}

function computeSplitTimestamp(start, end, ratio) {
  const safeStart = Math.max(0, Number(start) || 0);
  const safeEnd = Math.max(safeStart, Number(end) || 0);
  const duration = safeEnd - safeStart;
  if (duration < 0.002) return safeEnd;
  const rawSplit = Math.round((safeStart + duration * ratio) * 1000) / 1000;
  return Math.max(safeStart + 0.001, Math.min(safeEnd - 0.001, rawSplit));
}

/**
 * Splits a segment proportionally across time and grapheme-safe text boundaries.
 * @param {Array<object>} segments - Subtitle segments.
 * @param {string} segId - Target segment ID.
 * @param {{ ratio?: number, nextId?: string }} [options] - Split ratio in (0, 1) and optional ID.
 * @returns {Array<object>} Updated segments array.
 */
export function splitSubtitleSegment(segments, segId, { ratio = 0.5, nextId } = {}) {
  const list = segments || [];
  const idx = list.findIndex(seg => seg.id === segId);
  if (idx < 0) return list;
  const seg = list[idx];
  const safeRatio = Math.max(0.15, Math.min(0.85, Number.isFinite(ratio) ? ratio : 0.5));
  const splitTime = computeSplitTimestamp(seg.start, seg.end, safeRatio);
  const [textA, textB] = splitTextGraphemeSafe(seg.text, safeRatio);
  const [trA, trB] = splitTextGraphemeSafe(seg.translatedText, safeRatio);
  if (!textB && !trB) return list;
  const freshId = nextId || buildUniqueSegmentId(list, seg.id);
  const first = { ...seg, end: splitTime, text: textA || seg.text, translatedText: trA };
  const second = { ...seg, id: freshId, start: splitTime, text: textB, translatedText: trB };
  return [...list.slice(0, idx), first, second, ...list.slice(idx + 1)];
}

function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Counts literal occurrences across the currently active subtitle field (`text` or `translatedText`).
 * @param {{ segments?: Array<object>, findText?: string, useTranslation?: boolean, caseSensitive?: boolean }} [spec] - Search spec.
 * @returns {{ matchCount: number, segmentCount: number }} Match counts.
 */
export function countTextMatchesInSegments({ segments = [], findText = '', useTranslation = false, caseSensitive = false } = {}) {
  if (!findText) return { matchCount: 0, segmentCount: 0 };
  const matcher = new RegExp(escapeRegExp(findText), caseSensitive ? 'g' : 'gi');
  let matchCount = 0;
  let segmentCount = 0;
  for (const seg of segments) {
    const active = useTranslation ? (seg.translatedText ?? '') : (seg.text ?? '');
    const hits = active.match(matcher);
    if (!hits?.length) continue;
    matchCount += hits.length;
    segmentCount += 1;
  }
  return { matchCount, segmentCount };
}

/**
 * Replaces literal occurrences across the currently active subtitle field (`text` or `translatedText`).
 * @param {{ segments?: Array<object>, findText?: string, replaceText?: string, useTranslation?: boolean, caseSensitive?: boolean }} [spec] - Search/replace spec.
 * @returns {{ segments: Array<object>, matchCount: number, segmentCount: number }} Updated segments and summary counts.
 */
export function replaceTextInSegments({ segments = [], findText = '', replaceText = '', useTranslation = false, caseSensitive = false } = {}) {
  if (!findText) return { segments, matchCount: 0, segmentCount: 0 };
  const matcher = new RegExp(escapeRegExp(findText), caseSensitive ? 'g' : 'gi');
  let matchCount = 0;
  let segmentCount = 0;
  const next = segments.map(seg => {
    const active = useTranslation ? (seg.translatedText ?? '') : (seg.text ?? '');
    const hits = active.match(matcher);
    if (!hits?.length) return seg;
    matchCount += hits.length;
    segmentCount += 1;
    const replaced = active.replace(matcher, () => replaceText);
    return useTranslation ? { ...seg, translatedText: replaced } : { ...seg, text: replaced };
  });
  return { segments: next, matchCount, segmentCount };
}
