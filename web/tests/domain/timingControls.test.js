/**
 * @fileoverview Unit tests for subtitle timing controls: precision rounding, validation, overlap detection/resolution, and pause editing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_CUE_DURATION_SEC,
  MIN_SPLIT_GAP_SEC,
  OVERLAP_BEHAVIOR_MODES,
  OVERLAP_RESOLVE_MODES,
  adjustCuePause,
  adjustSubtitleSegmentTiming,
  assertValidCueInterval,
  clampCueInterval,
  detectCueOverlaps,
  findCueOverlap,
  formatEditableTimestamp,
  getCuePause,
  parseEditableTimestamp,
  resolveCueOverlaps,
  roundToMs,
  snapCueTimestamp,
  validateCueInterval,
} from '../../src/domain/subtitles.js';
import { ValidationError } from '../../src/domain/errors.js';

test('roundToMs rounds to 3 decimal places and handles non-finite values', () => {
  assert.equal(roundToMs(1.23456), 1.235);
  assert.equal(roundToMs(0.1 + 0.2), 0.3);
  assert.equal(roundToMs(0), 0);
  assert.equal(roundToMs(Number.NaN), 0);
  assert.equal(roundToMs(Infinity), 0);
  assert.equal(roundToMs(null), 0);
});

test('formatEditableTimestamp formats tenth and millisecond precision', () => {
  // Tenths formatting
  assert.equal(formatEditableTimestamp(65.4), '01:05.4');
  assert.equal(formatEditableTimestamp(3661.2), '1:01:01.2');
  assert.equal(formatEditableTimestamp(0), '00:00.0');

  // Automatic sub-tenth millisecond detection
  assert.equal(formatEditableTimestamp(0.123), '00:00.123');
  assert.equal(formatEditableTimestamp(1.005), '00:01.005');
  assert.equal(formatEditableTimestamp(75.432), '01:15.432');

  // Explicit precision argument
  assert.equal(formatEditableTimestamp(65.4, 3), '01:05.400');
  assert.equal(formatEditableTimestamp(0.123, 1), '00:00.1');
  assert.equal(formatEditableTimestamp(10.5, { precision: 2 }), '00:10.50');
});

test('validateCueInterval detects valid and invalid intervals accurately', () => {
  // Valid
  assert.deepEqual(validateCueInterval({ start: 0, end: 1.5 }), {
    valid: true,
    error: null,
    code: null,
    field: null,
  });

  // Negative start
  const negStart = validateCueInterval({ start: -0.5, end: 2.0 });
  assert.equal(negStart.valid, false);
  assert.equal(negStart.code, 'INVALID_START_TIME');
  assert.equal(negStart.field, 'start');

  // Non-finite end
  const badEnd = validateCueInterval({ start: 1.0, end: Number.NaN });
  assert.equal(badEnd.valid, false);
  assert.equal(badEnd.code, 'INVALID_END_TIME');
  assert.equal(badEnd.field, 'end');

  // End before or equal to start
  const endBefore = validateCueInterval({ start: 2.0, end: 1.5 });
  assert.equal(endBefore.valid, false);
  assert.equal(endBefore.code, 'END_BEFORE_START');
  assert.equal(endBefore.field, 'end');

  const endEqual = validateCueInterval({ start: 2.0, end: 2.0 });
  assert.equal(endEqual.valid, false);
  assert.equal(endEqual.code, 'END_BEFORE_START');

  // Duration shorter than minDuration
  const shortDur = validateCueInterval({ start: 1.0, end: 1.02, minDuration: 0.05 });
  assert.equal(shortDur.valid, false);
  assert.equal(shortDur.code, 'DURATION_TOO_SHORT');
  assert.equal(shortDur.field, 'duration');

  // Exceeds maxDuration
  const tooLong = validateCueInterval({ start: 1.0, end: 15.0, maxDuration: 10.0 });
  assert.equal(tooLong.valid, false);
  assert.equal(tooLong.code, 'EXCEEDS_MEDIA_DURATION');
  assert.equal(tooLong.field, 'end');
});

test('assertValidCueInterval throws ValidationError on invalid intervals', () => {
  assert.doesNotThrow(() => {
    assertValidCueInterval({ start: 1.0, end: 3.0 });
  });

  assert.throws(
    () => assertValidCueInterval({ start: 5.0, end: 2.0 }),
    err => err instanceof ValidationError && err.code === 'END_BEFORE_START'
  );

  assert.throws(
    () => assertValidCueInterval({ start: -1.0, end: 2.0 }),
    err => err instanceof ValidationError && err.code === 'INVALID_START_TIME'
  );
});

test('detectCueOverlaps and findCueOverlap identify collision intervals', () => {
  const segments = [
    { id: 'cue-1', start: 0.0, end: 2.5 },
    { id: 'cue-2', start: 2.0, end: 4.0 }, // Overlaps cue-1 by 0.5s
    { id: 'cue-3', start: 4.5, end: 6.0 }, // Gap of 0.5s after cue-2
    { id: 'cue-4', start: 5.8, end: 7.0 }, // Overlaps cue-3 by 0.2s
  ];

  const overlaps = detectCueOverlaps(segments);
  assert.equal(overlaps.length, 2);

  assert.equal(overlaps[0].cueAId, 'cue-1');
  assert.equal(overlaps[0].cueBId, 'cue-2');
  assert.equal(overlaps[0].overlapStart, 2.0);
  assert.equal(overlaps[0].overlapEnd, 2.5);
  assert.equal(overlaps[0].overlapDuration, 0.5);

  assert.equal(overlaps[1].cueAId, 'cue-3');
  assert.equal(overlaps[1].cueBId, 'cue-4');
  assert.equal(overlaps[1].overlapDuration, 0.2);

  assert.ok(findCueOverlap(segments, 'cue-1'));
  assert.ok(findCueOverlap(segments, 'cue-2'));
  assert.equal(findCueOverlap(segments, 'cue-2').cueAId, 'cue-1');
  assert.ok(findCueOverlap(segments, 'cue-4'));
  assert.equal(findCueOverlap(segments, 'non-existent'), null);

  // Abutting cues (exact touching) do not count as overlap
  const touching = [
    { id: 't-1', start: 0.0, end: 2.0 },
    { id: 't-2', start: 2.0, end: 4.0 },
  ];
  assert.deepEqual(detectCueOverlaps(touching), []);

  // Nested cues: Cue B inside Cue A calculates true overlap duration
  const nested = [
    { id: 'n-1', start: 0.0, end: 10.0 },
    { id: 'n-2', start: 2.0, end: 5.0 },
  ];
  const nestedOverlaps = detectCueOverlaps(nested);
  assert.equal(nestedOverlaps.length, 1);
  assert.equal(nestedOverlaps[0].overlapStart, 2.0);
  assert.equal(nestedOverlaps[0].overlapEnd, 5.0);
  assert.equal(nestedOverlaps[0].overlapDuration, 3.0);

  // Spanning cue overlapping multiple subsequent cues across non-adjacent indices
  const spanning = [
    { id: 'sp-1', start: 0.0, end: 8.0 },
    { id: 'sp-2', start: 1.0, end: 3.0 },
    { id: 'sp-3', start: 4.0, end: 6.0 },
  ];
  const spanOverlaps = detectCueOverlaps(spanning);
  assert.equal(spanOverlaps.length, 2);
  assert.equal(spanOverlaps[0].cueAId, 'sp-1');
  assert.equal(spanOverlaps[0].cueBId, 'sp-2');
  assert.equal(spanOverlaps[1].cueAId, 'sp-1');
  assert.equal(spanOverlaps[1].cueBId, 'sp-3');

  // Out of order non-overlapping cues must not produce false overlap
  const outOfOrderClean = [
    { id: 'o-1', start: 5.0, end: 7.0 },
    { id: 'o-2', start: 1.0, end: 2.0 },
  ];
  assert.deepEqual(detectCueOverlaps(outOfOrderClean), []);
});

test('getCuePause measures pause gaps before and after cues accurately', () => {
  const segments = [
    { id: 's1', start: 1.0, end: 3.0 },
    { id: 's2', start: 3.5, end: 5.0 }, // Gap before: 0.5s
    { id: 's3', start: 4.8, end: 6.0 }, // Overlaps s2 by 0.2s (negative pause -0.2s)
  ];

  const p1 = getCuePause(segments, 's1');
  assert.equal(p1.pauseBefore, null);
  assert.equal(p1.pauseAfter, 0.5);
  assert.equal(p1.isOverlapping, false);

  const p2 = getCuePause(segments, 's2');
  assert.equal(p2.pauseBefore, 0.5);
  assert.equal(p2.pauseAfter, -0.2);
  assert.equal(p2.isOverlapping, true);

  const p3 = getCuePause(segments, 's3');
  assert.equal(p3.pauseBefore, -0.2);
  assert.equal(p3.pauseAfter, null);
  assert.equal(p3.isOverlapping, true);

  assert.deepEqual(getCuePause(segments, 'missing'), {
    pauseBefore: null,
    pauseAfter: null,
    isOverlapping: false,
  });
});

test('clampCueInterval and snapCueTimestamp enforce boundaries', () => {
  // Clamping
  const clamped = clampCueInterval({ start: 0.2, end: 0.22 }, { minDuration: 0.1 });
  assert.equal(clamped.start, 0.2);
  assert.equal(clamped.end, 0.3);

  const clampedBounds = clampCueInterval({ start: -1.0, end: 15.0 }, { minStart: 0.5, maxEnd: 10.0 });
  assert.equal(clampedBounds.start, 0.5);
  assert.equal(clampedBounds.end, 10.0);

  // Snapping within threshold
  assert.equal(snapCueTimestamp(1.95, 2.0, 0.1), 2.0);
  assert.equal(snapCueTimestamp(2.05, 2.0, 0.1), 2.0);
  assert.equal(snapCueTimestamp(1.8, 2.0, 0.1), 1.8); // outside threshold
});

test('adjustCuePause shifts subsequent cues or trims current cue', () => {
  const segments = [
    { id: 'c1', start: 1.0, end: 2.0 },
    { id: 'c2', start: 2.2, end: 3.2 },
    { id: 'c3', start: 3.5, end: 4.5 },
  ];

  // Shift subsequent cues: increase gap from 0.2s to 1.0s (delta = +0.8s)
  const shifted = adjustCuePause(segments, 'c1', 1.0, { mode: 'shift_subsequent', rippleAll: true });
  assert.equal(shifted[0].end, 2.0);
  assert.equal(shifted[1].start, 3.0); // 2.0 + 1.0
  assert.equal(shifted[1].end, 4.0);
  assert.equal(shifted[2].start, 4.3); // 3.5 + 0.8
  assert.equal(shifted[2].end, 5.3);

  // Adjust end mode: move c1 end so pause to c2 is 0.5s -> c1 end becomes 2.2 - 0.5 = 1.7
  const trimmed = adjustCuePause(segments, 'c1', 0.5, { mode: 'adjust_end' });
  assert.equal(trimmed[0].start, 1.0);
  assert.equal(trimmed[0].end, 1.7);
  assert.equal(trimmed[1].start, 2.2);

  // Last cue has no next cue
  const lastUnchanged = adjustCuePause(segments, 'c3', 0.5);
  assert.deepEqual(lastUnchanged, segments);
});

test('resolveCueOverlaps cleanly resolves overlapping cues using trim_previous, shift_forward, and trim_next', () => {
  const overlapping = [
    { id: 'o1', start: 1.0, end: 3.0 },
    { id: 'o2', start: 2.5, end: 4.0 }, // Overlaps o1 by 0.5s
  ];

  // Mode: trim_previous (default)
  const trimmedPrev = resolveCueOverlaps(overlapping, { resolutionMode: OVERLAP_RESOLVE_MODES.TRIM_PREVIOUS });
  assert.equal(trimmedPrev[0].end, 2.5);
  assert.equal(trimmedPrev[1].start, 2.5);
  assert.equal(trimmedPrev[1].end, 4.0);
  assert.deepEqual(detectCueOverlaps(trimmedPrev), []);

  // Mode: shift_forward
  const shiftedFwd = resolveCueOverlaps(overlapping, { resolutionMode: OVERLAP_RESOLVE_MODES.SHIFT_FORWARD });
  assert.equal(shiftedFwd[0].end, 3.0);
  assert.equal(shiftedFwd[1].start, 3.0);
  assert.equal(shiftedFwd[1].end, 4.5); // 3.0 + 1.5 duration
  assert.deepEqual(detectCueOverlaps(shiftedFwd), []);

  // Mode: trim_next
  const trimmedNext = resolveCueOverlaps(overlapping, { resolutionMode: OVERLAP_RESOLVE_MODES.TRIM_NEXT });
  assert.equal(trimmedNext[0].end, 3.0);
  assert.equal(trimmedNext[1].start, 3.0);
  assert.equal(trimmedNext[1].end, 4.0);
  assert.deepEqual(detectCueOverlaps(trimmedNext), []);
});

test('adjustSubtitleSegmentTiming handles duration patches and overlap modes', () => {
  const segments = [
    { id: 'a', start: 1.0, end: 2.0 },
    { id: 'b', start: 2.5, end: 4.0 },
    { id: 'c', start: 4.5, end: 6.0 },
  ];

  // Duration patch
  const durPatched = adjustSubtitleSegmentTiming(segments, 'a', { duration: 1.3 });
  assert.equal(durPatched[0].start, 1.0);
  assert.equal(durPatched[0].end, 2.3);

  // OverlapMode: prevent clamps interval within neighbors
  const prevented = adjustSubtitleSegmentTiming(segments, 'b', { start: 1.5, end: 5.0 }, {
    overlapMode: OVERLAP_BEHAVIOR_MODES.PREVENT,
  });
  assert.equal(prevented[1].start, 2.0); // clamped to a.end
  assert.equal(prevented[1].end, 4.5);   // clamped to c.start

  // OverlapMode: reject throws ValidationError on overlap
  assert.throws(
    () => adjustSubtitleSegmentTiming(segments, 'b', { start: 1.8 }, { overlapMode: OVERLAP_BEHAVIOR_MODES.REJECT }),
    err => err instanceof ValidationError && err.code === 'CUE_OVERLAP'
  );

  // OverlapMode: shift_next ripples subsequent cues forward
  const rippled = adjustSubtitleSegmentTiming(segments, 'b', { end: 5.0 }, {
    overlapMode: OVERLAP_BEHAVIOR_MODES.SHIFT_NEXT,
  });
  assert.equal(rippled[1].end, 5.0);
  assert.equal(rippled[2].start, 5.0); // c shifted forward
  assert.equal(rippled[2].end, 6.5);
});
