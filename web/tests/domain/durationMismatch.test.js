/**
 * @fileoverview Unit tests for pure domain speech duration mismatch detection and explicit resolution remedies.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MISMATCH_REMEDY_TYPES,
  assertNoUnresolvedDurationMismatches,
  ceilToMs,
  createSpillApproval,
  detectDurationMismatches,
  extendAllSafeMismatches,
  extendCueAndShiftLater,
  extendCueToSpeech,
  isSpillApprovalValid,
  resolveClipDurationSeconds,
  shiftCueStartEarlier,
  trimClipWavToInterval,
} from '../../src/domain/durationMismatch.js';
import { inspectWavBuffer, readWavDurationSeconds } from '../../src/domain/wavCodec.js';

function createPcmWavBlob(durationMs = 1000, sampleRate = 16000, amplitude = 8000) {
  const numSamples = Math.round((sampleRate * durationMs) / 1000);
  const dataSize = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeTag = (off, tag) => { for (let i = 0; i < 4; i++) view.setUint8(off + i, tag.charCodeAt(i)); };
  writeTag(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeTag(8, 'WAVE');
  writeTag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeTag(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < numSamples; i++) {
    view.setInt16(44 + i * 2, i % 2 === 0 ? amplitude : -amplitude, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

test('ceilToMs and resolveClipDurationSeconds handle boundary and invalid inputs cleanly', () => {
  assert.equal(ceilToMs(0), 0);
  assert.equal(ceilToMs(-1.5), 0);
  assert.equal(ceilToMs(NaN), 0);
  assert.equal(ceilToMs(1.2341), 1.235);
  assert.equal(ceilToMs(1.5), 1.5);

  assert.equal(resolveClipDurationSeconds(null), 0);
  assert.equal(resolveClipDurationSeconds({ durationSeconds: 0 }), 0);
  assert.equal(resolveClipDurationSeconds({ durationSeconds: 2.3456 }), 2.346);
  assert.equal(resolveClipDurationSeconds({ measuredDurationSeconds: 1.75 }), 1.75);
});

test('detectDurationMismatches handles empty inputs, exact fits, tolerance, and interval overflow', () => {
  assert.equal(detectDurationMismatches().hasUnresolved, false);
  assert.equal(detectDurationMismatches({ segments: null, segmentClips: null }).totalCount, 0);

  const segments = [
    { id: 'c1', start: 0.0, end: 2.0, text: 'First' },
    { id: 'c2', start: 2.5, end: 4.5, text: 'Second' },
    { id: 'c3', start: 5.0, end: 6.5, text: 'Third' },
  ];
  const segmentClips = {
    c1: { durationSeconds: 2.004, blob: new Blob(['a']) }, // within 5ms rounding tolerance
    c2: { durationSeconds: 2.6, blob: new Blob(['b']) },   // exceeds 2.0s by +0.60s -> collides with c3 (starts 5.0, speech ends 5.1)
    c3: { durationSeconds: 1.9, blob: new Blob(['c']) },   // exceeds 1.5s by +0.40s into free tail
  };

  const report = detectDurationMismatches({ segments, segmentClips, mediaDuration: 10.0 });
  assert.equal(report.hasUnresolved, true);
  assert.equal(report.totalCount, 2);
  assert.equal(report.unresolvedCount, 2);
  assert.equal(report.bySegmentId.c1, undefined);

  const m2 = report.bySegmentId.c2;
  assert.equal(m2.cueNumber, 2);
  assert.equal(m2.allocatedDuration, 2.0);
  assert.equal(m2.clipDuration, 2.6);
  assert.equal(m2.intervalExcess, 0.6);
  assert.equal(m2.collidesWithNextCue, true);
  assert.equal(m2.nextCueCollisionSeconds, 0.1);
  assert.equal(m2.remedies.canExtendCue, false);
  assert.equal(m2.remedies.canExtendAndShift, true);
  assert.equal(m2.remedies.canTrimClip, true);
  assert.equal(m2.remedies.canAllowSpill, false);

  const m3 = report.bySegmentId.c3;
  assert.equal(m3.cueNumber, 3);
  assert.equal(m3.excessDuration, 0.4);
  assert.equal(m3.collidesWithNextCue, false);
  assert.equal(m3.remedies.canExtendCue, true);
  assert.equal(m3.remedies.extendEnd, 6.9);
  assert.equal(m3.remedies.canAllowSpill, true);
});

test('detectDurationMismatches flags media overflow, pre-cue shift feasibility, and overlapping cue collisions', () => {
  const segments = [
    { id: 'c1', start: 0.0, end: 3.0, text: 'Overlap cue' },
    { id: 'c2', start: 2.5, end: 4.0, text: 'Neighbor' },
    { id: 'c3', start: 7.0, end: 8.5, text: 'Near end' },
  ];
  const segmentClips = {
    c1: { durationSeconds: 2.8, blob: new Blob(['1']) }, // <= 3.0s interval, but collides with c2 at 2.5s!
    c3: { durationSeconds: 2.4, blob: new Blob(['3']) }, // 7.0 + 2.4 = 9.4 > 9.0 mediaDuration, but 8.5 - 2.4 = 6.1 >= 4.0!
  };

  const report = detectDurationMismatches({
    segments,
    segmentClips,
    mediaDuration: 9.0,
    isClipStale: seg => seg.id === 'c3',
  });

  const m1 = report.bySegmentId.c1;
  assert.ok(m1, 'Overlapping cue collision must be flagged even when clip <= cue duration');
  assert.equal(m1.collidesWithNextCue, true);
  assert.equal(m1.nextCueCollisionSeconds, 0.3);
  assert.equal(m1.remedies.trimTargetDuration, 2.5);
  assert.match(m1.message, /collides with Cue #2 by 0\.30s/);

  const m3 = report.bySegmentId.c3;
  assert.equal(m3.exceedsMediaDuration, true);
  assert.equal(m3.mediaOverflowSeconds, 0.4);
  assert.equal(m3.remedies.canExtendCue, false);
  assert.equal(m3.remedies.canShiftStartEarlier, true);
  assert.equal(m3.remedies.earlierStart, 6.1);
  assert.equal(m3.remedies.canRegenerate, true);
  assert.ok(m3.availableRemedies.some(r => r.action === MISMATCH_REMEDY_TYPES.SHIFT_START_EARLIER));
  assert.ok(m3.availableRemedies.some(r => r.action === MISMATCH_REMEDY_TYPES.REGENERATE_CLIP));
});

test('detectDurationMismatches scopes targetOnly to selected segments when selection has clips', () => {
  const segments = [
    { id: 'c1', start: 0, end: 1.0 },
    { id: 'c2', start: 2, end: 5.0 },
  ];
  const segmentClips = {
    c1: { durationSeconds: 2.0, blob: new Blob(['1']) }, // mismatch
    c2: { durationSeconds: 1.5, blob: new Blob(['2']) }, // clean
  };

  const onlyClean = detectDurationMismatches({
    segments,
    segmentClips,
    selectedIds: ['c2'],
    targetOnly: true,
  });
  assert.equal(onlyClean.hasUnresolved, false);

  const allScope = detectDurationMismatches({
    segments,
    segmentClips,
    selectedIds: [],
    targetOnly: true,
  });
  assert.equal(allScope.hasUnresolved, true);
  assert.equal(allScope.unresolvedCount, 1);
});

test('extendCueToSpeech, extendCueAndShiftLater, shiftCueStartEarlier, and extendAllSafeMismatches update segments immutably and enforce bounds', () => {
  const base = [
    { id: 'c1', start: 0.0, end: 1.5, text: 'One' },
    { id: 'c2', start: 1.7, end: 3.0, text: 'Two' },
    { id: 'c3', start: 5.0, end: 6.0, text: 'Three' },
  ];

  // Extend cue 3 safely into trailing gap
  const extended3 = extendCueToSpeech(base, 'c3', 1.8, { mediaDuration: 8.0 });
  assert.equal(extended3[2].end, 6.8);
  assert.equal(base[2].end, 6.0, 'Input segments must remain immutable');

  // Extend cue 1 collides with c2 -> throws
  assert.throws(() => extendCueToSpeech(base, 'c1', 2.2, { mediaDuration: 8.0 }), err => err.code === 'CUE_COLLISION');
  // Extend cue 3 past mediaDuration -> throws
  assert.throws(() => extendCueToSpeech(base, 'c3', 4.0, { mediaDuration: 8.0 }), err => err.code === 'EXCEEDS_MEDIA_DURATION');

  // Extend and shift cue 1 (0.0 -> 2.2) shifts c2 and c3 cleanly preserving gap
  const shifted = extendCueAndShiftLater(base, 'c1', 2.2, { mediaDuration: 8.0 });
  assert.equal(shifted[0].end, 2.2);
  assert.ok(shifted[1].start >= 2.2);
  assert.equal(Math.round((shifted[1].end - shifted[1].start) * 1000) / 1000, 1.3);
  assert.equal(Math.round((shifted[2].end - shifted[2].start) * 1000) / 1000, 1.0);

  // Tight mediaDuration blocks shift that would push last cue past end
  assert.throws(() => extendCueAndShiftLater(base, 'c1', 2.2, { mediaDuration: 6.2 }), err => err.code === 'EXCEEDS_MEDIA_DURATION');

  // Shift start earlier on c3 (has 2.0s preceding gap from 3.0 to 5.0)
  const earlier = shiftCueStartEarlier(base, 'c3', 1.6);
  assert.equal(earlier[2].start, 4.4);
  assert.equal(earlier[2].end, 6.0);
  assert.throws(() => shiftCueStartEarlier(base, 'c2', 2.0), err => err.code === 'INSUFFICIENT_PRE_CUE_SPACE');

  // Bulk auto-extend only extends safe non-colliding cues
  const report = detectDurationMismatches({
    segments: base,
    segmentClips: {
      c1: { durationSeconds: 2.2, blob: new Blob(['1']) }, // collides with c2
      c3: { durationSeconds: 1.8, blob: new Blob(['3']) }, // safe
    },
    mediaDuration: 8.0,
  });
  const bulk = extendAllSafeMismatches(base, report.unresolved, { mediaDuration: 8.0 });
  assert.equal(bulk.fixedCount, 1);
  assert.equal(bulk.segments[2].end, 6.8);
  assert.equal(bulk.segments[0].end, 1.5);
});

test('isSpillApprovalValid enforces exact clip, cue, neighbor, and media bounds before allowing spill', () => {
  const seg = { id: 'c1', start: 0.0, end: 1.5 };
  const nextSeg = { id: 'c2', start: 2.5, end: 4.0 };
  const clip = { signature: 'char-1\0\0Hi', durationSeconds: 2.1, blob: new Blob(['1']) };
  const approval = {
    segmentId: 'c1',
    clipSignature: 'char-1\0\0Hi',
    clipDuration: 2.1,
    cueStart: 0.0,
    cueEnd: 1.5,
  };

  assert.equal(isSpillApprovalValid(approval, { segment: seg, clip, nextSegment: nextSeg, mediaDuration: 5.0 }), true);
  // Moving next cue earlier so it collides invalidates spill approval
  assert.equal(isSpillApprovalValid(approval, { segment: seg, clip, nextSegment: { id: 'c2', start: 1.9, end: 4.0 }, mediaDuration: 5.0 }), false);
  // Editing text/signature invalidates spill approval
  assert.equal(isSpillApprovalValid(approval, { segment: seg, clip: { ...clip, signature: 'changed' }, nextSegment: nextSeg, mediaDuration: 5.0 }), false);
  // Changing cue end invalidates spill approval
  assert.equal(isSpillApprovalValid(approval, { segment: { ...seg, end: 1.4 }, clip, nextSegment: nextSeg, mediaDuration: 5.0 }), false);
  // Shrinking mediaDuration below speechEnd invalidates spill approval
  assert.equal(isSpillApprovalValid(approval, { segment: seg, clip, nextSegment: nextSeg, mediaDuration: 2.0 }), false);

  const report = detectDurationMismatches({
    segments: [seg, nextSeg],
    segmentClips: { c1: clip },
    mediaDuration: 5.0,
    spillApprovals: { c1: approval },
  });
  assert.equal(report.totalCount, 1);
  assert.equal(report.unresolvedCount, 0);
  assert.equal(report.hasUnresolved, false);
  assert.doesNotThrow(() => assertNoUnresolvedDurationMismatches(report));
});

test('trimClipWavToInterval trims real WAV bytes cleanly with micro-fade and assertNoUnresolvedDurationMismatches throws cleanly', async () => {
  const wav2s = createPcmWavBlob(2000, 16000);
  const trimmed = await trimClipWavToInterval(wav2s, 1.25);
  assert.equal(trimmed.trimmed, true);
  assert.equal(trimmed.durationSeconds, 1.25);
  const buf = await trimmed.blob.arrayBuffer();
  const info = inspectWavBuffer(buf);
  assert.equal(readWavDurationSeconds(buf), 1.25);
  const view = new DataView(buf, info.dataOffset, info.dataSize);
  assert.equal(view.getInt16((info.dataSize / 2 - 1) * 2, true), 0);

  // Cue < 0.2s must NOT offer trim remedy
  const tinyReport = detectDurationMismatches({
    segments: [{ id: 'c1', start: 0, end: 0.1 }],
    segmentClips: { c1: { durationSeconds: 0.8, blob: wav2s } },
  });
  assert.equal(tinyReport.bySegmentId.c1.remedies.canTrimClip, false);

  const report = detectDurationMismatches({
    segments: [{ id: 'c1', start: 0, end: 1.0 }],
    segmentClips: { c1: { durationSeconds: 1.8, blob: wav2s } },
  });
  assert.throws(
    () => assertNoUnresolvedDurationMismatches(report),
    err => err.code === 'DURATION_MISMATCH' && /Cue #1 \(\+0\.80s\)/.test(err.message)
  );
});

test('extendCueAndShiftLater preserves cue end on pre-existing overlaps and shiftCueStartEarlier honors neighbor speech and media bounds', () => {
  // Overlapping cues: c1 [0.0, 3.0] overlaps c2 [2.5, 4.0] with 2.8s clip -> Extend & shift keeps c1.end = 3.0 and shifts c2 to 3.0
  const overlapping = [
    { id: 'c1', start: 0.0, end: 3.0 },
    { id: 'c2', start: 2.5, end: 4.0 },
  ];
  const resolvedOverlap = extendCueAndShiftLater(overlapping, 'c1', 2.8, { mediaDuration: 6.0 });
  assert.equal(resolvedOverlap[0].end, 3.0);
  assert.equal(resolvedOverlap[1].start, 3.0);
  assert.equal(resolvedOverlap[1].end, 4.5);

  // shiftCueStartEarlier respects mediaDuration < cue.end AND previous cue's generated speech tail
  const nearEnd = [
    { id: 'c1', start: 0.0, end: 1.0 },
    { id: 'c2', start: 3.0, end: 4.2 }, // end (4.2) exceeds mediaDuration (4.0)
  ];
  const shiftedToMedia = shiftCueStartEarlier(nearEnd, 'c2', 1.5, { mediaDuration: 4.0 });
  assert.equal(shiftedToMedia[1].start, 2.5); // 4.0 - 1.5 = 2.5 so speech finishes at 4.0 <= mediaDuration

  // When c1 has a 2.6s speech clip (0.0 + 2.6 = 2.6s > 2.5s), pulling c2 to 2.5s is blocked to prevent colliding with c1's speech
  assert.throws(
    () => shiftCueStartEarlier(nearEnd, 'c2', 1.5, {
      mediaDuration: 4.0,
      segmentClips: { c1: { durationSeconds: 2.6 } },
    }),
    err => err.code === 'INSUFFICIENT_PRE_CUE_SPACE'
  );
});

test('zero-duration and inverted cues block Allow spill while offering Extend cue, ripple shifts preserve valid downstream spills, and wedged tail cues offer Remove voice', () => {
  // 1. Inverted (2.0 -> 1.5) and zero-duration (2.0 -> 2.0) cues must NOT offer Allow spill, but CAN Extend cue
  for (const badEnd of [1.5, 2.0, 2.1]) {
    const seg = { id: 'c1', start: 2.0, end: badEnd };
    const clip = { durationSeconds: 1.2, signature: 'sig-1', blob: new Blob(['1']) };
    const report = detectDurationMismatches({
      segments: [seg, { id: 'c2', start: 4.0, end: 5.0 }],
      segmentClips: { c1: clip },
      mediaDuration: 6.0,
    });
    assert.equal(report.bySegmentId.c1.remedies.canExtendCue, true);
    assert.equal(report.bySegmentId.c1.remedies.canAllowSpill, false, `End=${badEnd} must not offer Allow spill`);
    assert.equal(isSpillApprovalValid(createSpillApproval(seg, clip), { segment: seg, clip, mediaDuration: 6.0 }), false);
  }

  // 2. Ripple-shifting Cue #1 preserves Cue #2's valid spill approval when safe, and revokes if pushed past mediaDuration
  const rippleSegments = [
    { id: 'c1', start: 0.0, end: 1.0 },
    { id: 'c2', start: 1.2, end: 2.0 },
    { id: 'c3', start: 5.0, end: 6.0 },
  ];
  const rippleClips = {
    c1: { durationSeconds: 1.5, signature: 's1', blob: new Blob(['1']) },
    c2: { durationSeconds: 1.4, signature: 's2', blob: new Blob(['2']) },
  };
  const spillApprovals = { c2: createSpillApproval(rippleSegments[1], rippleClips.c2) };
  const shifted = extendCueAndShiftLater(rippleSegments, 'c1', 1.5, { mediaDuration: 8.0 });
  const afterSafeShift = detectDurationMismatches({
    segments: shifted,
    segmentClips: rippleClips,
    spillApprovals,
    mediaDuration: 8.0,
  });
  assert.equal(afterSafeShift.hasUnresolved, false, 'Downstream spill approval must survive safe ripple shift');

  // If mediaDuration is 2.6s (shifted c2 starts at 1.6s + 1.4s = 3.0s > 2.6s), spill approval is automatically revoked
  const afterOverflowShift = detectDurationMismatches({
    segments: [{ id: 'c1', start: 0.0, end: 1.5 }, { id: 'c2', start: 1.6, end: 2.4 }],
    segmentClips: rippleClips,
    spillApprovals,
    mediaDuration: 2.6,
  });
  assert.equal(afterOverflowShift.hasUnresolved, true);
  assert.equal(afterOverflowShift.bySegmentId.c2.isSpillApproved, false);

  // 3. Wedged 0.15s tail cue bounded by previous speech and mediaDuration always offers explicit remove_clip remedy
  const wedged = detectDurationMismatches({
    segments: [{ id: 'c1', start: 0.0, end: 9.35 }, { id: 'c2', start: 9.35, end: 9.5 }],
    segmentClips: {
      c1: { durationSeconds: 9.35, signature: 's1', blob: new Blob(['1']) },
      c2: { durationSeconds: 0.5, signature: 's2', blob: new Blob(['2']) },
    },
    mediaDuration: 9.5,
  });
  const m2 = wedged.bySegmentId.c2;
  assert.equal(m2.remedies.canExtendCue, false);
  assert.equal(m2.remedies.canShiftStartEarlier, false);
  assert.equal(m2.remedies.canTrimClip, false);
  assert.equal(m2.remedies.canRemoveClip, true);
  assert.ok(m2.availableRemedies.some(r => r.action === MISMATCH_REMEDY_TYPES.REMOVE_CLIP));
});
