/**
 * @fileoverview Pure domain subtitle alignment helpers, WebVTT/SRT/Dialogue formatters, segment edits, and speaker utilities.
 */

import { MAX_SCRIPT_LENGTH, countGraphemes } from './presets.js';
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

const AUDIO_ONLY_EXT_PATTERN = /\.(mp3|wav|m4a|aac|ogg|flac)$/i;
const VIDEO_EXT_PATTERN = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const MIN_SPLIT_GAP_SEC = 0.1;

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
 * Formats seconds as `MM:SS.d` or `H:MM:SS.d` for inline timestamp editing.
 * @param {number} seconds - Non-negative timestamp in seconds.
 * @returns {string} Editable timestamp string.
 */
export function formatEditableTimestamp(seconds) {
  const clamped = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 10) / 10 : 0;
  const totalTenths = Math.round(clamped * 10);
  const hours = Math.floor(totalTenths / 36000);
  const mins = Math.floor((totalTenths % 36000) / 600);
  const secs = Math.floor((totalTenths % 600) / 10);
  const tenth = totalTenths % 10;
  const secLabel = `${String(secs).padStart(2, '0')}.${tenth}`;
  if (hours > 0) return `${hours}:${String(mins).padStart(2, '0')}:${secLabel}`;
  return `${String(mins).padStart(2, '0')}:${secLabel}`;
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

/**
 * Updates start/end timestamps on one subtitle segment while enforcing valid ordering.
 * @param {Array<object>} segments - Subtitle segments.
 * @param {string} segId - Target segment ID.
 * @param {{ start?: number, end?: number }} patch - Timing patch.
 * @returns {Array<object>} Updated segments array.
 */
export function adjustSubtitleSegmentTiming(segments, segId, { start, end } = {}) {
  return (segments || []).map(seg => {
    if (seg.id !== segId) return seg;
    const nextStart = Number.isFinite(start) ? Math.max(0, Math.round(start * 1000) / 1000) : seg.start;
    const rawEnd = Number.isFinite(end) ? Math.max(0, Math.round(end * 1000) / 1000) : seg.end;
    const nextEnd = Math.max(nextStart + MIN_SPLIT_GAP_SEC, rawEnd);
    return { ...seg, start: nextStart, end: nextEnd };
  });
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
