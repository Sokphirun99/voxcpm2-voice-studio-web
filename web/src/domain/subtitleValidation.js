/**
 * @fileoverview Pure domain subtitle validation engine flagging missing text, invalid durations, overlaps, abnormal line lengths, reading speed, untranslated segments, and voice assignments.
 */

import { countGraphemes } from './presets.js';
import { MIN_SPLIT_GAP_SEC, detectCueOverlaps, roundToMs } from './subtitles.js';

export const VALIDATION_MIN_DURATION_SEC = 0.2;
export const VALIDATION_MAX_DURATION_SEC = 10.0;
export const MAX_CHARS_PER_LINE = 80;
export const MAX_LINE_BREAKS = 2;
export const MAX_READING_SPEED_CPS = 25.0;

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export const SUBTITLE_ISSUE_SEVERITIES = Object.freeze({
  ERROR: 'error',
  WARNING: 'warning',
});

export const SUBTITLE_ISSUE_TYPES = Object.freeze({
  MISSING_TEXT: 'missing_text',
  INVALID_DURATION: 'invalid_duration',
  LONG_DURATION: 'long_duration',
  EXCEEDS_MEDIA: 'exceeds_media',
  OVERLAP: 'overlap',
  LINE_TOO_LONG: 'line_too_long',
  TOO_MANY_LINES: 'too_many_lines',
  READING_SPEED_FAST: 'reading_speed_fast',
  UNTRANSLATED: 'untranslated',
  UNASSIGNED_VOICE: 'unassigned_voice',
});

export const REMEDY_ACTIONS = Object.freeze({
  FOCUS_TEXT: 'focus_text',
  ADJUST_TIMING: 'adjust_timing',
  RESOLVE_OVERLAP: 'resolve_overlap',
  SPLIT_LINE: 'split_line',
  SPLIT_SEGMENT: 'split_segment',
  EXTEND_DURATION: 'extend_duration',
  FOCUS_TRANSLATION: 'focus_translation',
  ASSIGN_VOICE: 'assign_voice',
});

/**
 * Creates a normalized validation issue entity.
 * Inputs: issue parameters. Outputs: immutable issue object.
 * Side effects: none. Failure modes: none.
 * @param {object} spec - Issue parameters.
 * @returns {object} Normalized issue object.
 */
function createIssue({ segmentId, type, severity, message, remedyAction, remedyHint, metadata = null }) {
  return Object.freeze({
    id: `${segmentId}-${type}`,
    segmentId,
    type,
    severity,
    message,
    remedyAction,
    remedyHint,
    metadata: metadata ? Object.freeze({ ...metadata }) : null,
  });
}

function shouldValidateTranslation(options) {
  if (options.useTranslation || options.requireTranslation) return true;
  if (options.useTranslation === false) return false;
  return Boolean(options.targetLanguage && options.targetLanguage !== options.sourceLanguage);
}

/**
 * Validates presence of primary subtitle text and active translated text.
 * Inputs: segment, options. Outputs: array of text issues.
 * Side effects: none. Failure modes: empty array on valid text or null input.
 * @param {object} seg - Subtitle segment.
 * @param {object} [options] - Validation options.
 * @returns {Array<object>} Text issue list.
 */
export function validateSegmentText(seg, options = {}) {
  if (!seg || typeof seg !== 'object') return [];
  const issues = [];
  const primaryText = typeof seg.text === 'string' ? seg.text.trim() : '';
  if (!primaryText) {
    issues.push(createIssue({
      segmentId: seg.id, type: SUBTITLE_ISSUE_TYPES.MISSING_TEXT, severity: SUBTITLE_ISSUE_SEVERITIES.ERROR,
      message: 'Subtitle text is empty.', remedyAction: REMEDY_ACTIONS.FOCUS_TEXT,
      remedyHint: 'Enter text for this subtitle cue or delete the empty cue.',
    }));
  }
  const shouldCheckTranslation = shouldValidateTranslation(options);
  const transText = typeof seg.translatedText === 'string' ? seg.translatedText.trim() : '';
  if (shouldCheckTranslation && primaryText && !transText) {
    issues.push(createIssue({
      segmentId: seg.id, type: SUBTITLE_ISSUE_TYPES.UNTRANSLATED, severity: SUBTITLE_ISSUE_SEVERITIES.WARNING,
      message: 'Translation text is missing for this cue.', remedyAction: REMEDY_ACTIONS.FOCUS_TRANSLATION,
      remedyHint: 'Provide translated text or run translation on this segment.',
    }));
  }
  return issues;
}

function createMinDurationIssue(seg, duration, minDuration) {
  return createIssue({
    segmentId: seg.id, type: SUBTITLE_ISSUE_TYPES.INVALID_DURATION, severity: SUBTITLE_ISSUE_SEVERITIES.ERROR,
    message: `Duration (${duration.toFixed(2)}s) is shorter than minimum ${minDuration}s.`,
    remedyAction: REMEDY_ACTIONS.ADJUST_TIMING, remedyHint: 'Extend the cue end time or merge with an adjacent cue.',
    metadata: { duration, minDuration },
  });
}

function createMaxDurationIssue(seg, duration, maxDuration) {
  return createIssue({
    segmentId: seg.id, type: SUBTITLE_ISSUE_TYPES.LONG_DURATION, severity: SUBTITLE_ISSUE_SEVERITIES.WARNING,
    message: `Duration (${duration.toFixed(1)}s) exceeds recommended maximum ${maxDuration}s.`,
    remedyAction: REMEDY_ACTIONS.SPLIT_SEGMENT, remedyHint: 'Split this cue into two shorter cues for better readability.',
    metadata: { duration, maxDuration },
  });
}

function checkDurationBounds(seg, duration, minDuration, maxDuration) {
  if (duration < minDuration) return createMinDurationIssue(seg, duration, minDuration);
  if (duration > maxDuration) return createMaxDurationIssue(seg, duration, maxDuration);
  return null;
}

function checkExceedsMedia(seg, end, mediaDuration) {
  if (!Number.isFinite(mediaDuration) || mediaDuration <= 0 || end <= mediaDuration) return null;
  return createIssue({
    segmentId: seg.id, type: SUBTITLE_ISSUE_TYPES.EXCEEDS_MEDIA, severity: SUBTITLE_ISSUE_SEVERITIES.ERROR,
    message: `End time (${end.toFixed(2)}s) exceeds media duration (${mediaDuration.toFixed(2)}s).`,
    remedyAction: REMEDY_ACTIONS.ADJUST_TIMING, remedyHint: 'Clamp cue end time within the media duration.',
    metadata: { end, mediaDuration },
  });
}

/**
 * Validates start, end, and duration bounds of a single subtitle segment.
 * Inputs: segment, timing constraint options. Outputs: array of timing issues.
 * Side effects: none. Failure modes: empty array on valid timing or null input.
 * @param {object} seg - Subtitle segment.
 * @param {object} [options] - Constraint options.
 * @returns {Array<object>} Timing issue list.
 */
export function validateSegmentDuration(seg, options = {}) {
  if (!seg || typeof seg !== 'object') return [];
  const { minDuration = VALIDATION_MIN_DURATION_SEC, maxDuration = VALIDATION_MAX_DURATION_SEC, mediaDuration = null } = options;
  const start = Number(seg.start);
  const end = Number(seg.end);
  if (!Number.isFinite(start) || start < 0) {
    return [createIssue({
      segmentId: seg.id, type: SUBTITLE_ISSUE_TYPES.INVALID_DURATION, severity: SUBTITLE_ISSUE_SEVERITIES.ERROR,
      message: 'Start time must be a non-negative number.', remedyAction: REMEDY_ACTIONS.ADJUST_TIMING,
      remedyHint: 'Set start time to 0.0 or a positive timestamp.',
    })];
  }
  if (!Number.isFinite(end) || end <= start) {
    return [createIssue({
      segmentId: seg.id, type: SUBTITLE_ISSUE_TYPES.INVALID_DURATION, severity: SUBTITLE_ISSUE_SEVERITIES.ERROR,
      message: `End time (${end}s) must be greater than start time (${start}s).`,
      remedyAction: REMEDY_ACTIONS.ADJUST_TIMING, remedyHint: 'Extend end time past the start timestamp.',
    })];
  }
  const issues = [];
  const boundIssue = checkDurationBounds(seg, roundToMs(end - start), minDuration, maxDuration);
  if (boundIssue) issues.push(boundIssue);
  const mediaIssue = checkExceedsMedia(seg, end, mediaDuration);
  if (mediaIssue) issues.push(mediaIssue);
  return issues;
}

function resolveActiveValidationText(seg, useTranslation) {
  if (useTranslation && typeof seg?.translatedText === 'string' && seg.translatedText.trim()) {
    return seg.translatedText.trim();
  }
  return typeof seg?.text === 'string' ? seg.text.trim() : '';
}

function checkReadingSpeed(seg, text, duration, maxCps) {
  if (!Number.isFinite(duration) || duration <= 0 || !text) return null;
  const graphemes = countGraphemes(text);
  const cps = graphemes / duration;
  if (!Number.isFinite(cps) || cps <= maxCps) return null;
  return createIssue({
    segmentId: seg.id,
    type: SUBTITLE_ISSUE_TYPES.READING_SPEED_FAST,
    severity: SUBTITLE_ISSUE_SEVERITIES.WARNING,
    message: `Reading speed is ${cps.toFixed(1)} chars/sec (recommended limit is ${maxCps} chars/sec).`,
    remedyAction: REMEDY_ACTIONS.EXTEND_DURATION,
    remedyHint: 'Extend cue duration or shorten text to ensure viewers can read the subtitle.',
    metadata: { cps: roundToMs(cps), maxCps, graphemes, duration },
  });
}

function findLongestLine(text) {
  const lines = text.split('\n');
  let maxLine = '';
  let maxLength = 0;
  for (const line of lines) {
    const len = countGraphemes(line.trim());
    if (len > maxLength) {
      maxLength = len;
      maxLine = line.trim();
    }
  }
  return { maxLength, maxLine, lineCount: lines.length };
}

/**
 * Validates text line lengths, newline count, and character-per-second reading speed.
 * Inputs: segment, typography options. Outputs: array of typography issues.
 * Side effects: none. Failure modes: empty array on valid text typography or null input.
 * @param {object} seg - Subtitle segment.
 * @param {object} [options] - Threshold options.
 * @returns {Array<object>} Typography issue list.
 */
export function validateSegmentLineLengths(seg, options = {}) {
  if (!seg || typeof seg !== 'object') return [];
  const { maxCharsPerLine = MAX_CHARS_PER_LINE, maxLineBreaks = MAX_LINE_BREAKS, maxCps = MAX_READING_SPEED_CPS, useTranslation = false } = options;
  const text = resolveActiveValidationText(seg, useTranslation);
  if (!text) return [];
  const issues = [];
  const { maxLength, lineCount } = findLongestLine(text);
  if (maxLength > maxCharsPerLine) {
    issues.push(createIssue({
      segmentId: seg.id, type: SUBTITLE_ISSUE_TYPES.LINE_TOO_LONG, severity: SUBTITLE_ISSUE_SEVERITIES.WARNING,
      message: `Line length (${maxLength} chars) exceeds ${maxCharsPerLine} character limit.`,
      remedyAction: REMEDY_ACTIONS.SPLIT_LINE, remedyHint: 'Break line into two lines or split this cue into multiple segments.',
      metadata: { maxLength, maxCharsPerLine },
    }));
  }
  const lineBreakCount = lineCount - 1;
  if (lineBreakCount > maxLineBreaks) {
    issues.push(createIssue({
      segmentId: seg.id, type: SUBTITLE_ISSUE_TYPES.TOO_MANY_LINES, severity: SUBTITLE_ISSUE_SEVERITIES.WARNING,
      message: `Cue contains ${lineCount} lines (exceeds ${maxLineBreaks + 1} lines limit).`,
      remedyAction: REMEDY_ACTIONS.SPLIT_SEGMENT, remedyHint: 'Split into separate cues so no more than 2-3 lines appear at once.',
      metadata: { lineCount, lineBreakCount, maxLineBreaks },
    }));
  }
  const duration = roundToMs(Number(seg.end) - Number(seg.start));
  const speedIssue = checkReadingSpeed(seg, text, duration, maxCps);
  if (speedIssue) issues.push(speedIssue);
  return issues;
}

function resolveAssignedVoice(seg, options) {
  const explicitVoice = typeof seg?.voiceId === 'string' ? seg.voiceId.trim() : '';
  const mappedVoice = typeof options.speakerVoiceMap?.[seg?.speakerId] === 'string' ? options.speakerVoiceMap[seg.speakerId].trim() : '';
  const fallbackVoice = typeof options.selectedVoiceId === 'string' ? options.selectedVoiceId.trim() : '';
  return explicitVoice || mappedVoice || (options.multiSpeaker ? '' : fallbackVoice);
}

/**
 * Validates voice assignment on a segment when voiceover generation is required.
 * Inputs: segment, voice assignment options. Outputs: array of voice issues.
 * Side effects: none. Failure modes: empty array when voice assigned or not required.
 * @param {object} seg - Subtitle segment.
 * @param {object} [options] - Voice assignment options.
 * @returns {Array<object>} Voice assignment issue list.
 */
export function validateSegmentVoice(seg, options = {}) {
  if (!seg || typeof seg !== 'object') return [];
  const shouldCheckVoice = Boolean(options.hasVoiceover || options.requireVoiceAssignment || options.multiSpeaker);
  if (!shouldCheckVoice) return [];
  const resolvedVoice = resolveAssignedVoice(seg, options);
  if (!resolvedVoice) {
    return [createIssue({
      segmentId: seg.id, type: SUBTITLE_ISSUE_TYPES.UNASSIGNED_VOICE, severity: SUBTITLE_ISSUE_SEVERITIES.WARNING,
      message: `Speaker "${seg.speakerName || seg.speakerId || 'Speaker'}" has no voice character assigned.`,
      remedyAction: REMEDY_ACTIONS.ASSIGN_VOICE, remedyHint: 'Assign a voice to this speaker in the voice roster.',
      metadata: { speakerId: seg.speakerId },
    })];
  }
  if (Array.isArray(options.characters) && options.characters.length > 0 && !options.characters.some(c => c.id === resolvedVoice)) {
    return [createIssue({
      segmentId: seg.id, type: SUBTITLE_ISSUE_TYPES.UNASSIGNED_VOICE, severity: SUBTITLE_ISSUE_SEVERITIES.WARNING,
      message: `Assigned voice "${resolvedVoice}" does not exist in the character catalog.`,
      remedyAction: REMEDY_ACTIONS.ASSIGN_VOICE, remedyHint: 'Select a valid voice character from the library.',
      metadata: { speakerId: seg.speakerId, voiceId: resolvedVoice },
    })];
  }
  return [];
}

/**
 * Runs single-segment validation rules (text, duration, line length, voice).
 * Inputs: segment, options. Outputs: combined array of issues for this segment.
 * Side effects: none. Failure modes: empty array on completely valid segment.
 * @param {object} seg - Subtitle segment.
 * @param {object} [options] - Validation options.
 * @returns {Array<object>} Combined issue list.
 */
export function validateSingleSegment(seg, options = {}) {
  if (!seg || typeof seg !== 'object') return [];
  return [
    ...validateSegmentText(seg, options),
    ...validateSegmentDuration(seg, options),
    ...validateSegmentLineLengths(seg, options),
    ...validateSegmentVoice(seg, options),
  ];
}

function buildOverlapIssuesForPair(overlap, indexMap) {
  const durLabel = overlap.overlapDuration.toFixed(2);
  const idxA = indexMap.get(overlap.cueAId) ?? -1;
  const idxB = indexMap.get(overlap.cueBId) ?? -1;
  const labelA = idxA >= 0 ? `Cue #${idxA + 1}` : overlap.cueAId;
  const labelB = idxB >= 0 ? `Cue #${idxB + 1}` : overlap.cueBId;
  const issueA = createIssue({
    segmentId: overlap.cueAId, type: SUBTITLE_ISSUE_TYPES.OVERLAP, severity: SUBTITLE_ISSUE_SEVERITIES.ERROR,
    message: `Overlaps ${labelB} by ${durLabel}s.`, remedyAction: REMEDY_ACTIONS.RESOLVE_OVERLAP,
    remedyHint: `Trim end of ${labelA} or shift start of ${labelB}.`,
    metadata: { conflictingSegmentId: overlap.cueBId, overlapDuration: overlap.overlapDuration },
  });
  const issueB = createIssue({
    segmentId: overlap.cueBId, type: SUBTITLE_ISSUE_TYPES.OVERLAP, severity: SUBTITLE_ISSUE_SEVERITIES.ERROR,
    message: `Overlaps ${labelA} by ${durLabel}s.`, remedyAction: REMEDY_ACTIONS.RESOLVE_OVERLAP,
    remedyHint: `Shift start of ${labelB} or trim end of ${labelA}.`,
    metadata: { conflictingSegmentId: overlap.cueAId, overlapDuration: overlap.overlapDuration },
  });
  return [issueA, issueB];
}

/**
 * Detects time interval overlaps across all segments and formats typed overlap issues.
 * Inputs: subtitle segments array. Outputs: array of overlap validation issues.
 * Side effects: none. Failure modes: empty array on non-overlapping segments.
 * @param {Array<object>} segments - Timed subtitle segments.
 * @returns {Array<object>} Overlap issue list.
 */
export function detectValidationOverlaps(segments) {
  if (!Array.isArray(segments) || segments.length < 2) return [];
  const rawOverlaps = detectCueOverlaps(segments);
  if (!rawOverlaps.length) return [];
  const indexMap = new Map(segments.map((seg, i) => [seg.id, i]));
  const issues = [];
  for (const overlap of rawOverlaps) {
    issues.push(...buildOverlapIssuesForPair(overlap, indexMap));
  }
  return issues;
}

function groupIssuesBySegment(allIssues) {
  const issuesBySegmentId = {};
  let errorCount = 0;
  let warningCount = 0;
  for (const issue of allIssues) {
    if (!issuesBySegmentId[issue.segmentId]) issuesBySegmentId[issue.segmentId] = [];
    issuesBySegmentId[issue.segmentId].push(issue);
    if (issue.severity === SUBTITLE_ISSUE_SEVERITIES.ERROR) errorCount += 1;
    else warningCount += 1;
  }
  return { issuesBySegmentId, errorCount, warningCount };
}

function aggregateIssuesSummary(allIssues) {
  const { issuesBySegmentId, errorCount, warningCount } = groupIssuesBySegment(allIssues);
  return {
    isValid: allIssues.length === 0,
    hasErrors: errorCount > 0,
    hasWarnings: warningCount > 0,
    errorCount,
    warningCount,
    totalIssues: allIssues.length,
    issues: Object.freeze(allIssues),
    issuesBySegmentId: Object.freeze(issuesBySegmentId),
  };
}

/**
 * Validates a list of subtitle segments against all subtitle standards and returns a structured summary.
 * Inputs: validation options `{ segments, useTranslation, targetLanguage, hasVoiceover, requireVoiceAssignment, speakerVoiceMap, characters, mediaDuration, minDuration, maxDuration }`.
 * Outputs: comprehensive validation summary object.
 * Side effects: none. Failure modes: returns empty valid summary on null/empty inputs.
 * @param {object} params - Validation options.
 * @returns {object} Validation summary with issue lookups and metrics.
 */
export function validateSubtitleSegments(params = {}) {
  const { segments = [] } = params;
  if (!Array.isArray(segments) || segments.length === 0) {
    return aggregateIssuesSummary([]);
  }
  const allIssues = [];
  for (const seg of segments) {
    allIssues.push(...validateSingleSegment(seg, params));
  }
  allIssues.push(...detectValidationOverlaps(segments));
  return aggregateIssuesSummary(allIssues);
}

function getProblemSegments(segments, issuesBySegmentId, severityFilter) {
  if (!Array.isArray(segments) || !issuesBySegmentId) return [];
  return segments.filter(seg => {
    const list = issuesBySegmentId[seg.id];
    if (!list || !list.length) return false;
    if (severityFilter === 'all') return true;
    return list.some(iss => iss.severity === severityFilter);
  });
}

/**
 * Finds the next segment ID that has validation issues, cycling back to the start if needed.
 * Inputs: segments, issuesBySegmentId, currentSegmentId, optional severity filter.
 * Outputs: next segment ID or null.
 * Side effects: none. Failure modes: returns null if no issues exist.
 * @param {Array<object>} segments - Timed segments.
 * @param {Record<string, Array<object>>} issuesBySegmentId - Issues lookup map.
 * @param {string} currentSegmentId - Currently focused segment ID.
 * @param {'all'|'error'|'warning'} [severityFilter='all'] - Filter by severity.
 * @returns {string|null} Next segment ID or null.
 */
export function findNextSegmentWithIssue(segments, issuesBySegmentId, currentSegmentId, severityFilter = 'all') {
  const problemSegments = getProblemSegments(segments, issuesBySegmentId, severityFilter);
  if (!problemSegments.length) return null;
  const currentIdx = problemSegments.findIndex(seg => seg.id === currentSegmentId);
  const nextIdx = (currentIdx + 1) % problemSegments.length;
  return problemSegments[nextIdx]?.id || null;
}

/**
 * Finds the previous segment ID that has validation issues, cycling to the end if needed.
 * Inputs: segments, issuesBySegmentId, currentSegmentId, optional severity filter.
 * Outputs: previous segment ID or null.
 * Side effects: none. Failure modes: returns null if no issues exist.
 * @param {Array<object>} segments - Timed segments.
 * @param {Record<string, Array<object>>} issuesBySegmentId - Issues lookup map.
 * @param {string} currentSegmentId - Currently focused segment ID.
 * @param {'all'|'error'|'warning'} [severityFilter='all'] - Filter by severity.
 * @returns {string|null} Previous segment ID or null.
 */
export function findPreviousSegmentWithIssue(segments, issuesBySegmentId, currentSegmentId, severityFilter = 'all') {
  const problemSegments = getProblemSegments(segments, issuesBySegmentId, severityFilter);
  if (!problemSegments.length) return null;
  const currentIdx = problemSegments.findIndex(seg => seg.id === currentSegmentId);
  const prevIdx = currentIdx <= 0 ? problemSegments.length - 1 : currentIdx - 1;
  return problemSegments[prevIdx]?.id || null;
}

/**
 * Filters a segment list down to only segments that have validation issues.
 * Inputs: segments, issuesBySegmentId, optional severity filter.
 * Outputs: filtered segment list.
 * Side effects: none. Failure modes: empty array when no issues.
 * @param {Array<object>} segments - Timed segments.
 * @param {Record<string, Array<object>>} issuesBySegmentId - Issues map.
 * @param {'all'|'error'|'warning'} [severityFilter='all'] - Severity filter.
 * @returns {Array<object>} Filtered segments.
 */
export function filterSegmentsWithIssues(segments, issuesBySegmentId, severityFilter = 'all') {
  return getProblemSegments(segments, issuesBySegmentId, severityFilter);
}

function findBestGraphemeBreak(graphemes, maxChars) {
  const target = Math.min(graphemes.length, maxChars);
  let bestPos = -1;
  for (let i = target; i >= Math.floor(target * 0.4); i--) {
    if (/\s/.test(graphemes[i])) {
      bestPos = i;
      break;
    }
  }
  return bestPos > 0 ? bestPos : Math.max(1, target);
}

function wrapSingleLine(line, maxChars) {
  const trimmed = line.trim();
  const graphemes = Array.from(GRAPHEME_SEGMENTER.segment(trimmed), s => s.segment);
  if (graphemes.length <= maxChars) return [trimmed];
  const result = [];
  let remaining = graphemes;
  while (remaining.length > maxChars) {
    const cut = findBestGraphemeBreak(remaining, maxChars);
    result.push(remaining.slice(0, cut).join('').trim());
    const nextText = remaining.slice(cut).join('').trim();
    remaining = Array.from(GRAPHEME_SEGMENTER.segment(nextText), s => s.segment);
  }
  if (remaining.length > 0) result.push(remaining.join(''));
  return result;
}

/**
 * Automatically wraps long text at word boundaries using Unicode grapheme clusters.
 * Inputs: line text, maximum character threshold.
 * Outputs: formatted text with newline insertions.
 * Side effects: none. Failure modes: returns input text if short, empty, or threshold non-positive.
 * @param {string} text - Raw text string.
 * @param {number} [maxChars=MAX_CHARS_PER_LINE] - Maximum characters per line.
 * @returns {string} Formatted multi-line text.
 */
export function autoBreakLongLine(text, maxChars = MAX_CHARS_PER_LINE) {
  if (typeof text !== 'string' || maxChars <= 0) return text || '';
  if (countGraphemes(text.trim()) <= maxChars) return text;
  return text.split('\n').flatMap(line => wrapSingleLine(line, maxChars)).join('\n');
}
