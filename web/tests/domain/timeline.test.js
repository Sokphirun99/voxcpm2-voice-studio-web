/**
 * @fileoverview Unit tests for timeline duration, clock formatting, intervals geometry, and clip resolution.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MIN_TIMELINE_DURATION_SEC,
  MIN_TIMELINE_INTERVAL_PERCENT,
  clampTimelineTime,
  computeTimelineDuration,
  computeTimelineIntervals,
  findCueAtPosition,
  formatTimelineClock,
  resolveActiveSpeechClip,
} from '../../src/domain/timeline.js';

test('computeTimelineDuration returns mediaDuration when valid and positive', () => {
  const segments = [{ start: 0, end: 10 }];
  assert.equal(computeTimelineDuration(segments, 45.5), 45.5);
});

test('computeTimelineDuration derives duration from max segment end when mediaDuration missing', () => {
  const segments = [
    { start: 0, end: 5.2 },
    { start: 5.5, end: 14.8 },
    { start: 15.0, end: 12.0 },
  ];
  assert.equal(computeTimelineDuration(segments, 0), 14.8);
  assert.equal(computeTimelineDuration(segments, null), 14.8);
});

test('computeTimelineDuration falls back to minimum duration on empty segments', () => {
  assert.equal(computeTimelineDuration([], 0), DEFAULT_MIN_TIMELINE_DURATION_SEC);
  assert.equal(computeTimelineDuration(null, -5), DEFAULT_MIN_TIMELINE_DURATION_SEC);
});

test('formatTimelineClock formats MM:SS.s and HH:MM:SS.s correctly', () => {
  assert.equal(formatTimelineClock(0), '00:00.0');
  assert.equal(formatTimelineClock(5.42), '00:05.4');
  assert.equal(formatTimelineClock(65.78), '01:05.8');
  assert.equal(formatTimelineClock(3665.2), '01:01:05.2');
  assert.equal(formatTimelineClock(65.78, false), '01:05');
  assert.equal(formatTimelineClock(-10), '00:00.0');
  assert.equal(formatTimelineClock(NaN), '00:00.0');
});

test('clampTimelineTime bounds timestamps to [0, maxDuration]', () => {
  assert.equal(clampTimelineTime(-5, 60), 0);
  assert.equal(clampTimelineTime(15.5, 60), 15.5);
  assert.equal(clampTimelineTime(80, 60), 60);
  assert.equal(clampTimelineTime(10, 0), 0);
  assert.equal(clampTimelineTime(NaN, 60), 0);
});

test('findCueAtPosition locates matching cue spanning target timestamp', () => {
  const segments = [
    { id: 'cue-1', start: 0, end: 4 },
    { id: 'cue-2', start: 5, end: 10 },
  ];
  assert.equal(findCueAtPosition(segments, 2)?.id, 'cue-1');
  assert.equal(findCueAtPosition(segments, 4)?.id, 'cue-1');
  assert.equal(findCueAtPosition(segments, 4.5), null);
  assert.equal(findCueAtPosition(segments, 8)?.id, 'cue-2');
  assert.equal(findCueAtPosition(segments, 15), null);
  assert.equal(findCueAtPosition(null, 2), null);
});

test('resolveActiveSpeechClip returns clip only when url or blob exists', () => {
  const clips = {
    'cue-1': { url: 'blob:audio/1', durationSeconds: 3.5 },
    'cue-2': { durationSeconds: 2.0 },
  };
  assert.deepEqual(resolveActiveSpeechClip('cue-1', clips), clips['cue-1']);
  assert.equal(resolveActiveSpeechClip('cue-2', clips), null);
  assert.equal(resolveActiveSpeechClip('cue-missing', clips), null);
  assert.equal(resolveActiveSpeechClip('', clips), null);
});

test('computeTimelineIntervals calculates exact percentages, speaker color, active state, and voice info', () => {
  const segments = [
    { id: 'seg-1', start: 0, end: 10, speakerId: 'speaker-1', text: 'ជំរាបសួរ' },
    { id: 'seg-2', start: 20, end: 50, speakerId: 'speaker-2', text: 'Hello' },
  ];
  const segmentClips = {
    'seg-1': { url: 'blob:audio/1', characterName: 'Dara', durationSeconds: 4.2 },
  };
  const intervals = computeTimelineIntervals({
    segments,
    totalDuration: 100,
    activeSegmentId: 'seg-1',
    segmentClips,
  });

  assert.equal(intervals.length, 2);
  assert.equal(intervals[0].id, 'seg-1');
  assert.equal(intervals[0].leftPercent, 0);
  assert.equal(intervals[0].widthPercent, 10);
  assert.equal(intervals[0].isActive, true);
  assert.equal(intervals[0].hasVoiceClip, true);
  assert.ok(intervals[0].speakerColor);
  assert.equal(intervals[0].text, 'ជំរាបសួរ');

  assert.equal(intervals[0].duration, 10);
  assert.equal(intervals[0].pauseBefore, null);
  assert.equal(intervals[0].pauseAfter, 10);
  assert.equal(intervals[0].hasOverlap, false);

  assert.equal(intervals[1].id, 'seg-2');
  assert.equal(intervals[1].leftPercent, 20);
  assert.equal(intervals[1].widthPercent, 30);
  assert.equal(intervals[1].isActive, false);
  assert.equal(intervals[1].hasVoiceClip, false);
  assert.equal(intervals[1].duration, 30);
  assert.equal(intervals[1].pauseBefore, 10);
  assert.equal(intervals[1].pauseAfter, null);
  assert.equal(intervals[1].hasOverlap, false);
});

test('computeTimelineIntervals flags overlapping cues', () => {
  const overlappingSegments = [
    { id: 'c1', start: 1.0, end: 3.5, speakerId: 'speaker-1' },
    { id: 'c2', start: 3.0, end: 5.0, speakerId: 'speaker-2' },
  ];
  const intervals = computeTimelineIntervals({
    segments: overlappingSegments,
    totalDuration: 10,
  });
  assert.equal(intervals[0].hasOverlap, true);
  assert.equal(intervals[0].pauseAfter, -0.5);
  assert.equal(intervals[1].hasOverlap, true);
  assert.equal(intervals[1].pauseBefore, -0.5);
});

test('computeTimelineIntervals enforces minimum width for instantaneous or zero-duration cues', () => {
  const segments = [{ id: 'zero', start: 5, end: 5, speakerId: 'speaker-1' }];
  const intervals = computeTimelineIntervals({ segments, totalDuration: 100 });
  assert.equal(intervals[0].leftPercent, 5);
  assert.equal(intervals[0].widthPercent, MIN_TIMELINE_INTERVAL_PERCENT);
});
