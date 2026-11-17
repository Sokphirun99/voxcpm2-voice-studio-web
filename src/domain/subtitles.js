/**
 * @fileoverview Pure domain subtitle alignment helpers, WebVTT/SRT/Dialogue formatters, and speaker utilities.
 */

export const SUBTITLE_SPEAKER_COLORS = Object.freeze([
  '#eeeeec',
  '#ffe678',
  '#a7bdd5',
  '#a0f2b5',
  '#ffa69e',
  '#ebbaf2',
]);

export const SOURCE_LANGUAGE_OPTIONS = Object.freeze([
  { id: 'auto', label: 'Auto-detect language' },
  { id: 'en', label: 'English' },
  { id: 'zh', label: 'Chinese (Mandarin)' },
  { id: 'km', label: 'Khmer' },
  { id: 'th', label: 'Thai' },
  { id: 'vi', label: 'Vietnamese' },
  { id: 'ja', label: 'Japanese' },
  { id: 'ko', label: 'Korean' },
  { id: 'fr', label: 'French' },
  { id: 'es', label: 'Spanish' },
  { id: 'de', label: 'German' },
  { id: 'ru', label: 'Russian' },
  { id: 'ar', label: 'Arabic' },
  { id: 'hi', label: 'Hindi' },
]);

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
 * Picks translated text when requested and non-empty, falling back to original text.
 * @param {object} seg - Subtitle segment object.
 * @param {boolean} useTranslation - Whether translation view/export is active.
 * @returns {string} Display text.
 */
export function pickSegmentText(seg, useTranslation = false) {
  const translated = typeof seg?.translatedText === 'string' ? seg.translatedText.trim() : '';
  if (useTranslation && translated) return translated;
  return typeof seg?.text === 'string' ? seg.text.trim() : '';
}

/**
 * Formats subtitle segments into SubRip (`.srt`) text.
 * Inputs: `{ segments, speakerNames, includeSpeaker, useTranslation }`.
 * Outputs: `.srt` subtitle file content.
 * Side effects: none.
 * Failure modes: returns empty string when no non-empty segments exist.
 * @param {object} spec - SRT formatting specification.
 * @returns {string} SubRip content.
 */
export function buildSrt({ segments = [], speakerNames = {}, includeSpeaker = true, useTranslation = false } = {}) {
  const blocks = [];
  for (const seg of segments) {
    const body = pickSegmentText(seg, useTranslation);
    if (!body) continue;
    const prefix = includeSpeaker ? `[${resolveSpeakerLabel(seg.speakerId, speakerNames)}] ` : '';
    const timing = `${formatSubtitleTime(seg.start, ',')} --> ${formatSubtitleTime(seg.end, ',')}`;
    blocks.push(`${blocks.length + 1}\n${timing}\n${prefix}${body}`);
  }
  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}

/**
 * Formats subtitle segments into WebVTT (`.vtt`) text for `<video><track>` preview.
 * Inputs: `{ segments, speakerNames, includeSpeaker, useTranslation }`.
 * Outputs: WebVTT file content.
 * Side effects: none.
 * Failure modes: returns minimal `WEBVTT` header when empty.
 * @param {object} spec - WebVTT formatting specification.
 * @returns {string} WebVTT content.
 */
export function buildVtt({ segments = [], speakerNames = {}, includeSpeaker = true, useTranslation = false } = {}) {
  const blocks = ['WEBVTT'];
  for (const seg of segments) {
    const body = pickSegmentText(seg, useTranslation);
    if (!body) continue;
    const prefix = includeSpeaker ? `${resolveSpeakerLabel(seg.speakerId, speakerNames)}: ` : '';
    const timing = `${formatSubtitleTime(seg.start, '.')} --> ${formatSubtitleTime(seg.end, '.')}`;
    blocks.push(`${timing}\n${prefix}${body}`);
  }
  return `${blocks.join('\n\n')}\n`;
}

/**
 * Groups consecutive utterances by the same speaker into a readable conversation script.
 * Inputs: `{ segments, speakerNames, includeTimestamps, useTranslation }`.
 * Outputs: newline-delimited speaker dialogue transcript.
 * Side effects: none.
 * Failure modes: returns empty string when no non-empty segments exist.
 * @param {object} spec - Dialogue script formatting options.
 * @returns {string} Multi-speaker transcript text.
 */
export function buildDialogueText({ segments = [], speakerNames = {}, includeTimestamps = true, useTranslation = false } = {}) {
  const turns = [];
  for (const seg of segments) {
    const body = pickSegmentText(seg, useTranslation);
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
    .map(t => `${includeTimestamps ? `[${formatShortClock(t.start)} - ${formatShortClock(t.end)}] ` : ''}${resolveSpeakerLabel(t.speakerId, speakerNames)}: ${t.parts.join(' ')}`)
    .join('\n');
}

/**
 * Extracts clean plain spoken lines from segments for direct TTS synthesis without timestamps/labels.
 * @param {{ segments?: Array<object>, useTranslation?: boolean, speakerId?: string }} [spec] - Extraction spec.
 * @returns {string} Plain joined speech script bounded cleanly.
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
