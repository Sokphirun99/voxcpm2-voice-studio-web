/**
 * @fileoverview Pure domain logic for timeline duration, interval layout calculation, clock formatting, and voice clip association.
 */

import { getSpeakerColor, roundToMs } from './subtitles.js';

export const DEFAULT_MIN_TIMELINE_DURATION_SEC = 1.0;
export const MIN_TIMELINE_INTERVAL_PERCENT = 0.5;
export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_HOUR = 3600;

/**
 * Computes the effective timeline duration from media duration or max segment end.
 * @param {Array<{ start: number, end: number }>} segments - Timed segments.
 * @param {number} [mediaDuration=0] - Media duration in seconds.
 * @returns {number} Effective duration in seconds (at least 1.0s).
 */
export function computeTimelineDuration(segments, mediaDuration = 0) {
  if (Number.isFinite(mediaDuration) && mediaDuration > 0) {
    return mediaDuration;
  }
  let maxEnd = 0;
  for (const seg of segments || []) {
    if (Number.isFinite(seg?.end) && seg.end > maxEnd) {
      maxEnd = seg.end;
    }
  }
  return Math.max(DEFAULT_MIN_TIMELINE_DURATION_SEC, maxEnd);
}

/**
 * Pads a positive number with leading zeroes up to specified width.
 * @param {number} num - Integer to pad.
 * @param {number} [width=2] - Target string width.
 * @returns {string} Zero-padded string.
 */
function padZero(num, width = 2) {
  return String(Math.floor(Math.max(0, num))).padStart(width, '0');
}

/**
 * Formats seconds into a human-readable clock string: MM:SS.s or HH:MM:SS.s.
 * @param {number} seconds - Elapsed time in seconds.
 * @param {boolean} [includeDecimals=true] - Whether to include tenth-second decimal.
 * @returns {string} Formatted clock string.
 */
export function formatTimelineClock(seconds, includeDecimals = true) {
  const safeSec = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const roundedTenths = Math.round(safeSec * 10);
  const totalSeconds = Math.floor(roundedTenths / 10);
  const tenths = roundedTenths % 10;
  const hours = Math.floor(totalSeconds / SECONDS_PER_HOUR);
  const minutes = Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const secs = totalSeconds % SECONDS_PER_MINUTE;
  const secPart = includeDecimals ? `${padZero(secs)}.${tenths}` : padZero(secs);
  if (hours > 0) {
    return `${padZero(hours)}:${padZero(minutes)}:${secPart}`;
  }
  return `${padZero(minutes)}:${secPart}`;
}

/**
 * Clamps a timestamp to the valid timeline boundary [0, maxDuration].
 * @param {number} seconds - Target timestamp in seconds.
 * @param {number} maxDuration - Maximum allowable duration.
 * @returns {number} Clamped timestamp.
 */
export function clampTimelineTime(seconds, maxDuration) {
  const safeMax = Number.isFinite(maxDuration) ? Math.max(0, maxDuration) : 0;
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(seconds, safeMax);
}

/**
 * Finds the subtitle segment active at the specified timestamp.
 * @param {Array<{ id: string, start: number, end: number }>} segments - Segment list.
 * @param {number} timeSeconds - Current time in seconds.
 * @returns {object|null} Active segment or null.
 */
export function findCueAtPosition(segments, timeSeconds) {
  if (!Array.isArray(segments) || !Number.isFinite(timeSeconds)) return null;
  return segments.find(seg => seg.start <= timeSeconds && timeSeconds <= seg.end) || null;
}

/**
 * Resolves the speech clip record associated with the active segment ID.
 * @param {string} activeSegmentId - Currently active segment ID.
 * @param {Record<string, object>} segmentClips - Map of segment ID to voice clip.
 * @returns {object|null} Voice clip record or null.
 */
export function resolveActiveSpeechClip(activeSegmentId, segmentClips) {
  if (!activeSegmentId || !segmentClips || typeof segmentClips !== 'object') return null;
  const clip = segmentClips[activeSegmentId];
  return clip?.url || clip?.blob ? clip : null;
}

function resolveTimelineGapStatus(start, end, index, segments) {
  const prevSeg = index > 0 ? segments[index - 1] : null;
  const nextSeg = index < segments.length - 1 ? segments[index + 1] : null;
  const pauseBefore = prevSeg ? roundToMs(start - prevSeg.end) : null;
  const pauseAfter = nextSeg ? roundToMs(nextSeg.start - end) : null;
  const hasOverlap = Boolean((pauseBefore !== null && pauseBefore < 0) || (pauseAfter !== null && pauseAfter < 0));
  return { pauseBefore, pauseAfter, hasOverlap };
}

function resolveTimelineValidationStatus(segId, validationBySegmentId) {
  const issues = validationBySegmentId?.[segId] || [];
  const hasError = issues.some(iss => iss.severity === 'error');
  const hasWarning = !hasError && issues.some(iss => iss.severity === 'warning');
  return { issues, hasError, hasWarning, issueCount: issues.length };
}

function computeIntervalGeometry(start, end, safeTotal) {
  const leftPercent = Math.min(100, Math.max(0, (start / safeTotal) * 100));
  const rawWidth = Math.max(0, ((end - start) / safeTotal) * 100);
  const widthPercent = Math.min(100 - leftPercent, Math.max(MIN_TIMELINE_INTERVAL_PERCENT, rawWidth));
  return { leftPercent, widthPercent };
}

function calculateSpeechRatioPercent(clipDuration, safeCueDur) {
  if (safeCueDur <= 0 || clipDuration <= 0) return 0;
  return Math.min(100, Math.round((clipDuration / safeCueDur) * 1000) / 10);
}

function resolveClipTimingDetails(clip, cueDuration) {
  const clipDuration = Number.isFinite(clip?.durationSeconds) && clip.durationSeconds > 0
    ? roundToMs(clip.durationSeconds) : 0;
  const hasVoiceClip = Boolean(clip?.url || clip?.blob);
  const safeCueDur = Math.max(0, cueDuration);
  const speechPercent = calculateSpeechRatioPercent(clipDuration, safeCueDur);
  const isClipOverflowing = clipDuration > safeCueDur && safeCueDur > 0;
  const trailingSilenceDuration = safeCueDur > clipDuration && clipDuration > 0
    ? roundToMs(safeCueDur - clipDuration) : 0;
  const overflowDuration = isClipOverflowing ? roundToMs(clipDuration - safeCueDur) : 0;
  return { clipDuration, hasVoiceClip, speechPercent, trailingSilenceDuration, isClipOverflowing, overflowDuration };
}

function buildTimelineIntervalItem(seg, index, context) {
  const { segments, safeTotal, activeSegmentId, segmentClips, validationBySegmentId } = context;
  const start = Number.isFinite(seg.start) ? Math.max(0, seg.start) : 0;
  const end = Number.isFinite(seg.end) ? Math.max(start, seg.end) : start;
  const { leftPercent, widthPercent } = computeIntervalGeometry(start, end, safeTotal);
  const { pauseBefore, pauseAfter, hasOverlap } = resolveTimelineGapStatus(start, end, index, segments);
  const { issues, hasError, hasWarning, issueCount } = resolveTimelineValidationStatus(seg.id, validationBySegmentId);
  const clip = segmentClips[seg.id];
  const timing = resolveClipTimingDetails(clip, end - start);
  return {
    id: seg.id, index, start, end, duration: roundToMs(end - start),
    leftPercent, widthPercent, speakerId: seg.speakerId || 'speaker-1',
    speakerColor: getSpeakerColor(seg.speakerId), isActive: seg.id === activeSegmentId,
    voiceClip: timing.hasVoiceClip ? clip : null,
    pauseBefore, pauseAfter, hasOverlap,
    hasError, hasWarning, issueCount, validationIssues: issues,
    text: (seg.text || seg.translatedText || '').trim(),
    ...timing,
  };
}

/**
 * Calculates display geometry and states for subtitle intervals across the timeline.
 * @param {object} params - Calculation parameters.
 * @param {Array<object>} params.segments - Timed subtitle segments.
 * @param {number} params.totalDuration - Total timeline duration in seconds.
 * @param {string} [params.activeSegmentId=''] - Currently selected or active segment ID.
 * @param {Record<string, object>} [params.segmentClips={}] - Voice clips keyed by segment ID.
 * @param {Record<string, Array<object>>} [params.validationBySegmentId={}] - Validation issues by cue ID.
 * @returns {Array<object>} Interval render descriptors.
 */
export function computeTimelineIntervals({
  segments,
  totalDuration,
  activeSegmentId = '',
  segmentClips = {},
  validationBySegmentId = {},
}) {
  const safeTotal = Math.max(DEFAULT_MIN_TIMELINE_DURATION_SEC, totalDuration || 0);
  if (!Array.isArray(segments)) return [];
  const context = { segments, safeTotal, activeSegmentId, segmentClips, validationBySegmentId };
  return segments.map((seg, index) => buildTimelineIntervalItem(seg, index, context));
}
