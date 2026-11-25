/**
 * @fileoverview Pure domain detection and explicit resolution remedies for speech clips exceeding allocated subtitle cue intervals.
 */

import { ValidationError } from './errors.js';
import { trimWavBlobToDuration } from './wavCodec.js';

export const DURATION_MISMATCH_TOLERANCE_SEC = 0.005;
export const MIN_SHIFT_GAP_SEC = 0.1;
export const MIN_TRIM_INTERVAL_SEC = 0.2;
export const MIN_SPILL_CUE_DURATION_SEC = 0.2;
export const TAIL_TRIM_FADE_MS = 15;

function roundToMs(seconds) {
  if (!Number.isFinite(seconds)) return 0;
  return Math.round(seconds * 1000) / 1000;
}

export const MISMATCH_REMEDY_TYPES = Object.freeze({
  EXTEND_CUE: 'extend_cue',
  EXTEND_AND_SHIFT: 'extend_and_shift',
  SHIFT_START_EARLIER: 'shift_start_earlier',
  ALLOW_SPILL: 'allow_spill',
  TRIM_CLIP: 'trim_clip',
  REGENERATE_CLIP: 'regenerate_clip',
  REMOVE_CLIP: 'remove_clip',
  EDIT_TEXT: 'edit_text',
  ADJUST_TIMING: 'adjust_timing',
});

/**
 * Rounds non-negative seconds upward to millisecond precision.
 * Inputs: duration in seconds. Outputs: ceiling seconds rounded to 3 decimal places.
 * Side effects: none. Failure modes: returns 0 for non-finite or negative values.
 * @param {number} seconds - Duration in seconds.
 * @returns {number} Ceiling duration in seconds.
 */
export function ceilToMs(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.ceil(seconds * 1000 - 1e-9) / 1000;
}

/**
 * Extracts positive clip duration in seconds from a clip record rounded to milliseconds.
 * Inputs: clip object. Outputs: duration in seconds (`>= 0`).
 * Side effects: none. Failure modes: returns 0 when duration is missing or invalid.
 * @param {{ durationSeconds?: number, measuredDurationSeconds?: number }|null|undefined} clip - Clip record.
 * @returns {number} Clip duration in seconds.
 */
export function resolveClipDurationSeconds(clip) {
  const raw = Number.isFinite(clip?.durationSeconds) && clip.durationSeconds > 0
    ? clip.durationSeconds
    : clip?.measuredDurationSeconds;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return roundToMs(raw);
}

function resolveSegmentTimes(segment) {
  const numStart = Number(segment?.start);
  const numEnd = Number(segment?.end);
  const start = Number.isFinite(numStart) ? Math.max(0, roundToMs(numStart)) : 0;
  const rawEnd = Number.isFinite(numEnd) ? roundToMs(numEnd) : start;
  const end = Math.max(start, rawEnd);
  const allocatedDuration = roundToMs(end - start);
  const hasValidInterval = Number.isFinite(numStart) && numStart >= 0 && Number.isFinite(numEnd) && roundToMs(numEnd - start) >= MIN_SPILL_CUE_DURATION_SEC;
  return { start, end, allocatedDuration, hasValidInterval };
}

function computeNextCollisionState(start, clipDuration, nextSegment) {
  if (!nextSegment) return { collidesWithNextCue: false, nextCueCollisionSeconds: 0 };
  const nextStart = Math.max(0, roundToMs(Number(nextSegment.start) || 0));
  const speechEnd = roundToMs(start + clipDuration);
  if (speechEnd <= nextStart) return { collidesWithNextCue: false, nextCueCollisionSeconds: 0 };
  return { collidesWithNextCue: true, nextCueCollisionSeconds: roundToMs(speechEnd - nextStart) };
}

function computeMediaBoundState(start, clipDuration, mediaDuration) {
  if (!Number.isFinite(mediaDuration) || mediaDuration <= 0) {
    return { exceedsMediaDuration: false, mediaOverflowSeconds: 0 };
  }
  const speechEnd = roundToMs(start + clipDuration);
  const safeMedia = roundToMs(mediaDuration);
  if (speechEnd <= safeMedia) return { exceedsMediaDuration: false, mediaOverflowSeconds: 0 };
  return { exceedsMediaDuration: true, mediaOverflowSeconds: roundToMs(speechEnd - safeMedia) };
}

function resolveTargetSegments(segments, selectedIds, segmentClips, targetOnly) {
  if (!Array.isArray(segments) || !segments.length) return [];
  const hasClip = seg => Boolean(seg?.id && (segmentClips?.[seg.id]?.blob || resolveClipDurationSeconds(segmentClips?.[seg.id]) > 0));
  if (!targetOnly) return segments.filter(seg => Boolean(seg?.id && segmentClips?.[seg.id]));
  const lookup = selectedIds instanceof Set ? selectedIds : (selectedIds ? new Set(selectedIds) : null);
  const selected = lookup?.size ? segments.filter(seg => Boolean(seg?.id && lookup.has(seg.id)) && hasClip(seg)) : [];
  return selected.length > 0 ? selected : segments.filter(hasClip);
}

function computeProposedExtendedEnd(start, end, clipDuration) {
  return Math.max(roundToMs(start + MIN_TRIM_INTERVAL_SEC), end, ceilToMs(start + clipDuration));
}

function computeShiftFeasibility(spec) {
  const { index, segments, start, end, clipDuration, mediaDuration, collidesWithNextCue } = spec;
  const nextSeg = index < segments.length - 1 ? segments[index + 1] : null;
  if (!nextSeg || !collidesWithNextCue) return { canExtendAndShift: false, shiftDelta: 0, shiftGap: 0, shiftedEnd: end };
  const proposedEnd = computeProposedExtendedEnd(start, end, clipDuration);
  const safeMedia = Number.isFinite(mediaDuration) && mediaDuration > 0 ? roundToMs(mediaDuration) : Infinity;
  if (proposedEnd > safeMedia) return { canExtendAndShift: false, shiftDelta: 0, shiftGap: 0, shiftedEnd: end };
  const maxEnd = segments.slice(index + 1).reduce((max, s) => Math.max(max, Number(s?.end) || 0), 0);
  const origGap = Math.max(0, roundToMs((Number(nextSeg.start) || 0) - end));
  const preferred = origGap > 0 ? Math.min(origGap, MIN_SHIFT_GAP_SEC) : 0;
  for (const gap of preferred > 0 ? [preferred, 0] : [0]) {
    const delta = roundToMs(proposedEnd + gap - (Number(nextSeg.start) || 0));
    if (delta > 0 && roundToMs(maxEnd + delta) <= safeMedia) {
      return { canExtendAndShift: true, shiftDelta: delta, shiftGap: gap, shiftedEnd: proposedEnd };
    }
  }
  return { canExtendAndShift: false, shiftDelta: 0, shiftGap: 0, shiftedEnd: end };
}

function resolvePreviousBoundarySeconds(prevSeg, segmentClips) {
  if (!prevSeg) return 0;
  const prevTimes = resolveSegmentTimes(prevSeg);
  const prevClipDur = resolveClipDurationSeconds(segmentClips?.[prevSeg.id]);
  const prevSpeechEnd = prevClipDur > 0 ? roundToMs(prevTimes.start + prevClipDur) : 0;
  return Math.max(prevTimes.end, prevSpeechEnd);
}

function computeEarlierStartFeasibility(spec) {
  const { index, segments, segmentClips, start, end, clipDuration, nextSeg, mediaDuration } = spec;
  const prevSeg = index > 0 ? segments[index - 1] : null;
  const minStart = resolvePreviousBoundarySeconds(prevSeg, segmentClips);
  const nextBound = nextSeg ? Math.max(0, roundToMs(Number(nextSeg.start) || 0)) : Infinity;
  const mediaBound = Number.isFinite(mediaDuration) && mediaDuration > 0 ? roundToMs(mediaDuration) : Infinity;
  const effectiveEnd = Math.min(end, nextBound, mediaBound);
  const proposedStart = roundToMs(effectiveEnd - ceilToMs(clipDuration));
  if (proposedStart < minStart || proposedStart >= start) {
    return { canShiftStartEarlier: false, earlierStart: start };
  }
  return { canShiftStartEarlier: true, earlierStart: proposedStart };
}

function computeExtendCueEnd(start, end, clipDuration, bounds = {}) {
  const rawEnd = computeProposedExtendedEnd(start, end, clipDuration);
  const nextBound = bounds.nextSegment ? Math.max(0, roundToMs(Number(bounds.nextSegment.start) || 0)) : Infinity;
  const mediaBound = Number.isFinite(bounds.mediaDuration) && bounds.mediaDuration > 0 ? roundToMs(bounds.mediaDuration) : Infinity;
  return roundToMs(Math.min(rawEnd, nextBound, mediaBound));
}

function computeTrimTargetDuration(start, allocatedDuration, nextSegment, mediaDuration) {
  const nextBound = nextSegment ? Math.max(0, roundToMs((Number(nextSegment.start) || 0) - start)) : Infinity;
  const mediaBound = Number.isFinite(mediaDuration) && mediaDuration > 0 ? Math.max(0, roundToMs(roundToMs(mediaDuration) - start)) : Infinity;
  return roundToMs(Math.min(allocatedDuration, nextBound, mediaBound));
}

function buildAvailableRemedies(spec) {
  const { remedies, excessDuration, clipDuration } = spec;
  const list = [];
  if (remedies.canExtendCue) list.push({ action: MISMATCH_REMEDY_TYPES.EXTEND_CUE, label: `Extend cue (${clipDuration.toFixed(2)}s)`, title: 'Extend subtitle end time to match speech duration' });
  if (remedies.canExtendAndShift) list.push({ action: MISMATCH_REMEDY_TYPES.EXTEND_AND_SHIFT, label: `Extend & shift (+${remedies.shiftDelta.toFixed(2)}s)`, title: 'Extend cue and shift later subtitles forward' });
  if (remedies.canShiftStartEarlier) list.push({ action: MISMATCH_REMEDY_TYPES.SHIFT_START_EARLIER, label: 'Start earlier', title: 'Move cue start earlier into preceding pause' });
  if (remedies.canAllowSpill) list.push({ action: MISMATCH_REMEDY_TYPES.ALLOW_SPILL, label: `Allow spill (+${excessDuration.toFixed(2)}s)`, title: 'Allow speech to finish into empty pause without moving subtitle end' });
  if (remedies.canTrimClip) list.push({ action: MISMATCH_REMEDY_TYPES.TRIM_CLIP, label: `Trim to ${remedies.trimTargetDuration.toFixed(2)}s`, title: 'Explicitly trim end of audio clip (with fade) to fit interval' });
  if (remedies.canRegenerate) list.push({ action: MISMATCH_REMEDY_TYPES.REGENERATE_CLIP, label: 'Regenerate', title: 'Regenerate voice for updated subtitle text' });
  if (remedies.canRemoveClip) list.push({ action: MISMATCH_REMEDY_TYPES.REMOVE_CLIP, label: 'Remove voice', title: 'Remove generated voice clip from this cue while keeping subtitle text' });
  list.push({ action: MISMATCH_REMEDY_TYPES.EDIT_TEXT, label: 'Edit text', title: 'Shorten cue text then regenerate voice' });
  list.push({ action: MISMATCH_REMEDY_TYPES.ADJUST_TIMING, label: 'Adjust timing', title: 'Open inline timing editor' });
  return Object.freeze(list);
}

function formatMismatchMessage(spec) {
  const { clipDuration, allocatedDuration, intervalExcess, collidesWithNextCue, nextCueNumber, nextCueCollisionSeconds, exceedsMediaDuration, mediaOverflowSeconds } = spec;
  if (intervalExcess <= 0 && collidesWithNextCue) {
    return `Speech (${clipDuration.toFixed(2)}s) collides with Cue #${nextCueNumber} by ${nextCueCollisionSeconds.toFixed(2)}s due to overlapping cues.`;
  }
  const base = `Speech (${clipDuration.toFixed(2)}s) exceeds cue interval (${allocatedDuration.toFixed(2)}s) by +${intervalExcess.toFixed(2)}s`;
  if (collidesWithNextCue) return `${base} and collides with Cue #${nextCueNumber} by ${nextCueCollisionSeconds.toFixed(2)}s.`;
  if (exceedsMediaDuration) return `${base} and exceeds media end by ${mediaOverflowSeconds.toFixed(2)}s.`;
  return `${base}.`;
}

function buildMismatchHint(remedies) {
  if (remedies.canExtendCue) return 'Extend cue end time, allow spill into pause, trim audio, or shorten text.';
  if (remedies.canExtendAndShift) return 'Extend & shift later cues, trim audio, or shorten text and regenerate.';
  if (remedies.canShiftStartEarlier) return 'Pull cue start earlier, trim audio, or shorten text and regenerate.';
  return 'Shorten subtitle text and regenerate, adjust timing, or explicitly trim audio.';
}

/**
 * Creates a normalized spill approval record for a cue and its generated voice clip.
 * Inputs: `segment` and `clip`. Outputs: frozen spill approval record.
 * Side effects: none. Failure modes: returns null when segment or clip is missing.
 * @param {object} segment - Subtitle cue segment.
 * @param {object} clip - Generated voice clip record.
 * @returns {object|null} Frozen spill approval object or null.
 */
export function createSpillApproval(segment, clip) {
  if (!segment?.id || !clip) return null;
  const { start, end, allocatedDuration } = resolveSegmentTimes(segment);
  return Object.freeze({
    segmentId: segment.id,
    clipSignature: String(clip.signature || ''),
    clipDuration: resolveClipDurationSeconds(clip),
    cueStart: start,
    cueEnd: end,
    allocatedDuration,
  });
}

function resolveApprovedAllocatedDuration(approval) {
  if (Number.isFinite(approval?.allocatedDuration)) return roundToMs(approval.allocatedDuration);
  return roundToMs((Number(approval?.cueEnd) || 0) - (Number(approval?.cueStart) || 0));
}

/**
 * Validates whether a stored spill approval remains valid for the current cue, clip, neighbor, and media bounds.
 * Inputs: stored `approval` record and `{ segment, clip, nextSegment, mediaDuration }`.
 * Outputs: boolean indicating whether spill approval still safely covers the clip.
 * Side effects: none. Failure modes: returns false on missing or mismatched state.
 * @param {object|null|undefined} approval - Stored spill approval descriptor.
 * @param {{ segment: object, clip: object, nextSegment?: object|null, mediaDuration?: number }} context - Current state.
 * @returns {boolean} True if approval is still valid.
 */
export function isSpillApprovalValid(approval, context) {
  if (!approval || !context?.segment || !context?.clip) return false;
  const { segment, clip, nextSegment = null, mediaDuration = 0 } = context;
  const { start, allocatedDuration, hasValidInterval } = resolveSegmentTimes(segment);
  const clipDuration = resolveClipDurationSeconds(clip);
  if (!hasValidInterval || approval.segmentId !== segment.id || approval.clipSignature !== String(clip.signature || '')) return false;
  if (!Number.isFinite(approval.clipDuration) || Math.abs(approval.clipDuration - clipDuration) > DURATION_MISMATCH_TOLERANCE_SEC) return false;
  const approvedAllocated = resolveApprovedAllocatedDuration(approval);
  if (approvedAllocated < MIN_SPILL_CUE_DURATION_SEC || allocatedDuration + 0.001 < approvedAllocated) return false;
  const { collidesWithNextCue } = computeNextCollisionState(start, clipDuration, nextSegment);
  const { exceedsMediaDuration } = computeMediaBoundState(start, clipDuration, mediaDuration);
  return !collidesWithNextCue && !exceedsMediaDuration;
}

function buildRemedyOptions(spec) {
  const { index, segments, segmentClips, start, end, allocatedDuration, hasValidInterval, clipDuration, nextSeg, mediaDuration, collision, mediaBound, clip, isStale, intervalExcess } = spec;
  const shiftPlan = computeShiftFeasibility({ index, segments, start, end, clipDuration, mediaDuration, ...collision });
  const earlierPlan = computeEarlierStartFeasibility({ index, segments, segmentClips, start, end, clipDuration, nextSeg, mediaDuration });
  const trimTargetDuration = computeTrimTargetDuration(start, allocatedDuration, nextSeg, mediaDuration);
  const canExtendCue = intervalExcess > 0 && !collision.collidesWithNextCue && !mediaBound.exceedsMediaDuration;
  const canTrimClip = trimTargetDuration >= MIN_TRIM_INTERVAL_SEC && Boolean(clip?.blob);
  const extendEnd = canExtendCue ? computeExtendCueEnd(start, end, clipDuration, { nextSegment: nextSeg, mediaDuration }) : end;
  return Object.freeze({
    canExtendCue, extendEnd, ...shiftPlan, ...earlierPlan,
    canAllowSpill: canExtendCue && Boolean(hasValidInterval), canTrimClip, trimTargetDuration,
    canRegenerate: Boolean(isStale), canRemoveClip: clipDuration > 0 || Boolean(clip?.blob || clip?.url),
  });
}

function buildMismatchDescriptor(ctx) {
  const { segment, index, start, end, allocatedDuration, clipDuration, excessDuration, intervalExcess, collision, mediaBound, nextSeg, remedies, isSpillApproved, isStale, clip } = ctx;
  return Object.freeze({
    segmentId: segment.id, cueIndex: index, cueNumber: index + 1, start, end, allocatedDuration, clipDuration, excessDuration,
    intervalExcess, ...collision, nextCueId: nextSeg?.id || null, ...mediaBound, isSpillApproved, isResolved: isSpillApproved,
    isStale: Boolean(isStale), isTrimmed: Boolean(clip?.preTrimClip), remedies,
    availableRemedies: buildAvailableRemedies({ remedies, excessDuration, clipDuration }),
    message: formatMismatchMessage({ clipDuration, allocatedDuration, intervalExcess, ...collision, ...mediaBound, nextCueNumber: index + 2 }),
    remedyHint: buildMismatchHint(remedies),
  });
}

function analyzeMismatchEntry(spec) {
  const { segment, index, segments, segmentClips, clip, mediaDuration, spillApproval, isStale, toleranceSec } = spec;
  const clipDuration = resolveClipDurationSeconds(clip);
  if (clipDuration <= 0) return null;
  const { start, end, allocatedDuration, hasValidInterval } = resolveSegmentTimes(segment);
  const intervalExcess = Math.max(0, roundToMs(clipDuration - allocatedDuration));
  const nextSeg = index < segments.length - 1 ? segments[index + 1] : null;
  const collision = computeNextCollisionState(start, clipDuration, nextSeg);
  const mediaBound = computeMediaBoundState(start, clipDuration, mediaDuration);
  const excessDuration = Math.max(intervalExcess, collision.nextCueCollisionSeconds, mediaBound.mediaOverflowSeconds);
  if (excessDuration <= toleranceSec) return null;
  const remedies = buildRemedyOptions({ index, segments, segmentClips, start, end, allocatedDuration, hasValidInterval, clipDuration, nextSeg, mediaDuration, collision, mediaBound, clip, isStale, intervalExcess });
  const isSpillApproved = intervalExcess > 0 && isSpillApprovalValid(spillApproval, { segment, clip, nextSegment: nextSeg, mediaDuration });
  return buildMismatchDescriptor({ segment, index, start, end, allocatedDuration, clipDuration, excessDuration, intervalExcess, collision, mediaBound, nextSeg, remedies, isSpillApproved, isStale, clip });
}

function summarizeDurationMismatches(items) {
  const unresolved = [];
  const resolved = [];
  const bySegmentId = {};
  for (const item of items) {
    bySegmentId[item.segmentId] = item;
    if (item.isResolved) resolved.push(item);
    else unresolved.push(item);
  }
  return Object.freeze({
    items: Object.freeze(items), unresolved: Object.freeze(unresolved), resolved: Object.freeze(resolved),
    bySegmentId: Object.freeze(bySegmentId), totalCount: items.length, unresolvedCount: unresolved.length, hasUnresolved: unresolved.length > 0,
  });
}

/**
 * Detects speech clips exceeding their allocated subtitle cue intervals and computes feasible remedies.
 * Inputs: `{ segments, segmentClips, mediaDuration, spillApprovals, isClipStale, selectedIds, targetOnly, toleranceSec }`.
 * Outputs: mismatch summary `{ items, unresolved, resolved, bySegmentId, totalCount, unresolvedCount, hasUnresolved }`.
 * Side effects: none. Failure modes: returns empty summary when inputs are empty or no clips overflow.
 * @param {object} [params] - Detection configuration.
 * @returns {object} Duration mismatch summary.
 */
export function detectDurationMismatches(params = {}) {
  const { segments = [], segmentClips = {}, mediaDuration = 0, spillApprovals = {}, isClipStale = null, selectedIds = null, targetOnly = false, toleranceSec = DURATION_MISMATCH_TOLERANCE_SEC } = params;
  if (!Array.isArray(segments) || !segments.length || !segmentClips || typeof segmentClips !== 'object') return summarizeDurationMismatches([]);
  const indexById = new Map(segments.map((seg, i) => [seg?.id, i]));
  const items = [];
  for (const segment of resolveTargetSegments(segments, selectedIds, segmentClips, targetOnly)) {
    const index = indexById.get(segment.id) ?? -1;
    if (index < 0) continue;
    const item = analyzeMismatchEntry({ segment, index, segments, segmentClips, clip: segmentClips[segment.id], mediaDuration, spillApproval: spillApprovals?.[segment.id], isStale: typeof isClipStale === 'function' ? isClipStale(segment) : false, toleranceSec });
    if (item) items.push(item);
  }
  return summarizeDurationMismatches(items);
}

/**
 * Extends one cue's end timestamp to fit its generated speech without overlapping the next cue or media duration.
 * Inputs: `segments`, `segId`, `clipDuration`, optional `{ mediaDuration }`.
 * Outputs: new segments array with updated end timestamp.
 * Side effects: none. Failure modes: throws ValidationError when cue missing, duration invalid, or extension collides.
 * @param {Array<object>} segments - Subtitle segments.
 * @param {string} segId - Target segment ID.
 * @param {number} clipDuration - Speech clip duration in seconds.
 * @param {{ mediaDuration?: number|null }} [options] - Media boundary options.
 * @returns {Array<object>} Updated segments array.
 */
export function extendCueToSpeech(segments, segId, clipDuration, options = {}) {
  if (!Array.isArray(segments)) throw new ValidationError('Subtitle segments are required.', 'segments', 'INVALID_SEGMENTS');
  const idx = segments.findIndex(seg => seg?.id === segId);
  if (idx < 0) throw new ValidationError('Subtitle cue not found.', 'segmentId', 'SEGMENT_NOT_FOUND');
  if (!Number.isFinite(clipDuration) || clipDuration <= 0) throw new ValidationError('Clip duration must be positive.', 'clipDuration', 'INVALID_DURATION');
  const nextSeg = idx < segments.length - 1 ? segments[idx + 1] : null;
  const { start, end } = resolveSegmentTimes(segments[idx]);
  if (computeNextCollisionState(start, roundToMs(clipDuration), nextSeg).collidesWithNextCue) {
    throw new ValidationError('Extending cue collides with the next cue. Use Extend & shift instead.', 'end', 'CUE_COLLISION');
  }
  if (computeMediaBoundState(start, roundToMs(clipDuration), options.mediaDuration).exceedsMediaDuration) {
    throw new ValidationError('Extending cue exceeds the media duration.', 'end', 'EXCEEDS_MEDIA_DURATION');
  }
  const newEnd = computeExtendCueEnd(start, end, roundToMs(clipDuration), { nextSegment: nextSeg, mediaDuration: options.mediaDuration });
  return segments.map((item, i) => (i === idx ? { ...item, end: newEnd } : item));
}

/**
 * Extends a cue's end timestamp to fit speech and ripple-shifts all subsequent cues forward cleanly.
 * Inputs: `segments`, `segId`, `clipDuration`, optional `{ mediaDuration }`.
 * Outputs: new segments array with extended cue and shifted downstream cues.
 * Side effects: none. Failure modes: throws ValidationError if cue missing, has no successor, or shifting exceeds media duration.
 * @param {Array<object>} segments - Subtitle segments.
 * @param {string} segId - Target segment ID.
 * @param {number} clipDuration - Speech clip duration in seconds.
 * @param {{ mediaDuration?: number|null }} [options] - Media boundary options.
 * @returns {Array<object>} Updated segments array.
 */
export function extendCueAndShiftLater(segments, segId, clipDuration, options = {}) {
  if (!Array.isArray(segments)) throw new ValidationError('Subtitle segments are required.', 'segments', 'INVALID_SEGMENTS');
  const idx = segments.findIndex(seg => seg?.id === segId);
  if (idx < 0 || idx >= segments.length - 1) throw new ValidationError('No subsequent cues available to shift.', 'segmentId', 'NO_NEXT_SEGMENT');
  if (!Number.isFinite(clipDuration) || clipDuration <= 0) throw new ValidationError('Clip duration must be positive.', 'clipDuration', 'INVALID_DURATION');
  const { start, end } = resolveSegmentTimes(segments[idx]);
  if (!computeNextCollisionState(start, roundToMs(clipDuration), segments[idx + 1]).collidesWithNextCue) {
    return extendCueToSpeech(segments, segId, clipDuration, options);
  }
  const plan = computeShiftFeasibility({ index: idx, segments, start, end, clipDuration: roundToMs(clipDuration), mediaDuration: options.mediaDuration, collidesWithNextCue: true });
  if (!plan.canExtendAndShift) throw new ValidationError('Not enough remaining media duration to shift subsequent cues.', 'end', 'EXCEEDS_MEDIA_DURATION');
  return segments.map((item, i) => {
    if (i === idx) return { ...item, end: plan.shiftedEnd };
    if (i > idx) return { ...item, start: roundToMs((Number(item.start) || 0) + plan.shiftDelta), end: roundToMs((Number(item.end) || 0) + plan.shiftDelta) };
    return item;
  });
}

/**
 * Pulls a cue's start timestamp earlier into preceding silence to fit its speech without moving its end time.
 * Inputs: `segments`, `segId`, `clipDuration`, optional `{ mediaDuration, segmentClips }`.
 * Outputs: new segments array with updated start timestamp.
 * Side effects: none. Failure modes: throws ValidationError when cue missing or preceding space is insufficient.
 * @param {Array<object>} segments - Subtitle segments.
 * @param {string} segId - Target segment ID.
 * @param {number} clipDuration - Speech clip duration in seconds.
 * @param {{ mediaDuration?: number|null, segmentClips?: Record<string, object>|null }} [options] - Boundary options.
 * @returns {Array<object>} Updated segments array.
 */
export function shiftCueStartEarlier(segments, segId, clipDuration, options = {}) {
  if (!Array.isArray(segments)) throw new ValidationError('Subtitle segments are required.', 'segments', 'INVALID_SEGMENTS');
  const idx = segments.findIndex(seg => seg?.id === segId);
  if (idx < 0) throw new ValidationError('Subtitle cue not found.', 'segmentId', 'SEGMENT_NOT_FOUND');
  if (!Number.isFinite(clipDuration) || clipDuration <= 0) throw new ValidationError('Clip duration must be positive.', 'clipDuration', 'INVALID_DURATION');
  const { start, end } = resolveSegmentTimes(segments[idx]);
  const nextSeg = idx < segments.length - 1 ? segments[idx + 1] : null;
  const plan = computeEarlierStartFeasibility({
    index: idx, segments, segmentClips: options.segmentClips, start, end, clipDuration: roundToMs(clipDuration), nextSeg, mediaDuration: options.mediaDuration,
  });
  if (!plan.canShiftStartEarlier) throw new ValidationError('Not enough room before this cue to pull start time earlier.', 'start', 'INSUFFICIENT_PRE_CUE_SPACE');
  return segments.map((item, i) => (i === idx ? { ...item, start: plan.earlierStart } : item));
}

function canExtendItemSafely(segments, item, mediaDuration) {
  const idx = segments.findIndex(seg => seg?.id === item?.segmentId);
  if (idx < 0 || !Number.isFinite(item?.clipDuration) || item.clipDuration <= 0) return false;
  const { start } = resolveSegmentTimes(segments[idx]);
  const nextSeg = idx < segments.length - 1 ? segments[idx + 1] : null;
  const clipped = roundToMs(item.clipDuration);
  return !computeNextCollisionState(start, clipped, nextSeg).collidesWithNextCue
    && !computeMediaBoundState(start, clipped, mediaDuration).exceedsMediaDuration;
}

/**
 * Safely extends all mismatched cues that do not collide with neighbors or exceed media duration.
 * Inputs: `segments`, `mismatches` array, optional `{ mediaDuration }`.
 * Outputs: `{ segments, fixedCount }` with updated non-colliding segments.
 * Side effects: none. Failure modes: skips cues that cannot be extended safely without shifting.
 * @param {Array<object>} segments - Subtitle segments.
 * @param {Array<object>} mismatches - Unresolved mismatch items.
 * @param {{ mediaDuration?: number|null }} [options] - Media boundary options.
 * @returns {{ segments: Array<object>, fixedCount: number }} Updated segments and fixed count.
 */
export function extendAllSafeMismatches(segments, mismatches, options = {}) {
  if (!Array.isArray(segments) || !Array.isArray(mismatches) || !mismatches.length) {
    return { segments: segments || [], fixedCount: 0 };
  }
  let next = segments;
  let fixedCount = 0;
  for (const item of mismatches) {
    if (!item?.remedies?.canExtendCue || !canExtendItemSafely(next, item, options.mediaDuration)) continue;
    next = extendCueToSpeech(next, item.segmentId, item.clipDuration, options);
    fixedCount += 1;
  }
  return { segments: next, fixedCount };
}

/**
 * Explicitly trims a subtitle voice clip WAV to `targetDurationSec`, preferring edge-silence trimming first before cutting speech.
 * Inputs: WAV `blob`, positive `targetDurationSec`, optional `{ fadeMs }`.
 * Outputs: Promise resolving to `{ blob, durationSeconds, trimmed }`.
 * Side effects: reads binary bytes from `blob`.
 * Failure modes: throws ValidationError on non-positive duration or SynthesisError on invalid WAV headers.
 * @param {Blob} blob - Source WAV Blob.
 * @param {number} targetDurationSec - Target cue interval duration in seconds.
 * @param {{ fadeMs?: number }} [options] - Fade configuration.
 * @returns {Promise<{ blob: Blob, durationSeconds: number, trimmed: boolean }>} Trimmed WAV result.
 */
export async function trimClipWavToInterval(blob, targetDurationSec, options = {}) {
  if (!Number.isFinite(targetDurationSec) || targetDurationSec <= 0) {
    throw new ValidationError('Target duration must be a positive number of seconds.', 'duration', 'INVALID_DURATION');
  }
  const res = await trimWavBlobToDuration(blob, targetDurationSec, {
    fadeMs: options.fadeMs ?? TAIL_TRIM_FADE_MS,
    trimSilenceFirst: true,
  });
  return { blob: res.blob, durationSeconds: res.durationSeconds, trimmed: res.wasTrimmed };
}

/**
 * Throws a structured ValidationError if any unresolved duration mismatches remain before final export.
 * Inputs: array of mismatch items (or mismatch summary object).
 * Outputs: void when clean.
 * Side effects: throws ValidationError when unresolved mismatches exist.
 * Failure modes: throws ValidationError (`DURATION_MISMATCH`).
 * @param {Array<object>|{ unresolved?: Array<object> }} mismatches - Mismatch items or report.
 */
export function assertNoUnresolvedDurationMismatches(mismatches) {
  const list = Array.isArray(mismatches) ? mismatches : (mismatches?.unresolved || []);
  const unresolved = list.filter(item => item && !item.isResolved);
  if (!unresolved.length) return;
  const labels = unresolved.slice(0, 3).map(item => `Cue #${item.cueNumber || item.cueIndex + 1 || item.segmentId} (+${item.excessDuration.toFixed(2)}s)`).join(', ');
  const suffix = unresolved.length > 3 ? ` and ${unresolved.length - 3} more` : '';
  const word = unresolved.length === 1 ? 'mismatch' : 'mismatches';
  throw new ValidationError(
    `Resolve ${unresolved.length} speech duration ${word} before export: ${labels}${suffix}.`,
    'durationMismatch',
    'DURATION_MISMATCH'
  );
}
