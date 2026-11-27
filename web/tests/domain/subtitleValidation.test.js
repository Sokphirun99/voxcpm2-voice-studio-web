/**
 * @fileoverview Pure domain unit tests for subtitle validation rules, error/warning thresholds, overlaps, and issue navigation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CHARS_PER_LINE,
  MAX_LINE_BREAKS,
  MAX_READING_SPEED_CPS,
  REMEDY_ACTIONS,
  SUBTITLE_ISSUE_SEVERITIES,
  SUBTITLE_ISSUE_TYPES,
  VALIDATION_MAX_DURATION_SEC,
  VALIDATION_MIN_DURATION_SEC,
  autoBreakLongLine,
  detectValidationOverlaps,
  filterSegmentsWithIssues,
  findNextSegmentWithIssue,
  findPreviousSegmentWithIssue,
  validateSegmentDuration,
  validateSegmentLineLengths,
  validateSegmentText,
  validateSegmentVoice,
  validateSingleSegment,
  validateSubtitleSegments,
} from '../../src/domain/subtitleValidation.js';

test('validateSegmentText flags empty or whitespace-only text as error', () => {
  const emptySeg = { id: 'c1', text: '' };
  const whitespaceSeg = { id: 'c2', text: '   \n  \t  ' };
  const validSeg = { id: 'c3', text: 'សួស្តី' };

  const emptyIssues = validateSegmentText(emptySeg);
  assert.equal(emptyIssues.length, 1);
  assert.equal(emptyIssues[0].type, SUBTITLE_ISSUE_TYPES.MISSING_TEXT);
  assert.equal(emptyIssues[0].severity, SUBTITLE_ISSUE_SEVERITIES.ERROR);
  assert.equal(emptyIssues[0].remedyAction, REMEDY_ACTIONS.FOCUS_TEXT);

  const whiteIssues = validateSegmentText(whitespaceSeg);
  assert.equal(whiteIssues.length, 1);
  assert.equal(whiteIssues[0].type, SUBTITLE_ISSUE_TYPES.MISSING_TEXT);

  const validIssues = validateSegmentText(validSeg);
  assert.equal(validIssues.length, 0);
});

test('validateSegmentText flags untranslated cues when translation mode is enabled', () => {
  const segNoTrans = { id: 'c1', text: 'Hello', translatedText: '' };
  const segWithTrans = { id: 'c2', text: 'Hello', translatedText: 'ជំរាបសួរ' };

  const withoutMode = validateSegmentText(segNoTrans, { useTranslation: false });
  assert.equal(withoutMode.length, 0);

  const withMode = validateSegmentText(segNoTrans, { useTranslation: true });
  assert.equal(withMode.length, 1);
  assert.equal(withMode[0].type, SUBTITLE_ISSUE_TYPES.UNTRANSLATED);
  assert.equal(withMode[0].severity, SUBTITLE_ISSUE_SEVERITIES.WARNING);
  assert.equal(withMode[0].remedyAction, REMEDY_ACTIONS.FOCUS_TRANSLATION);

  const translatedResult = validateSegmentText(segWithTrans, { useTranslation: true });
  assert.equal(translatedResult.length, 0);
});

test('validateSegmentDuration flags negative start or end before start as errors', () => {
  const negStart = { id: 'c1', start: -1.0, end: 2.0 };
  const endBeforeStart = { id: 'c2', start: 3.5, end: 2.0 };
  const equalTimes = { id: 'c3', start: 4.0, end: 4.0 };

  const negIssues = validateSegmentDuration(negStart);
  assert.equal(negIssues.length, 1);
  assert.equal(negIssues[0].type, SUBTITLE_ISSUE_TYPES.INVALID_DURATION);
  assert.equal(negIssues[0].severity, SUBTITLE_ISSUE_SEVERITIES.ERROR);

  const endBeforeIssues = validateSegmentDuration(endBeforeStart);
  assert.equal(endBeforeIssues.length, 1);
  assert.equal(endBeforeIssues[0].type, SUBTITLE_ISSUE_TYPES.INVALID_DURATION);

  const equalIssues = validateSegmentDuration(equalTimes);
  assert.equal(equalIssues.length, 1);
  assert.equal(equalIssues[0].type, SUBTITLE_ISSUE_TYPES.INVALID_DURATION);
});

test('validateSegmentDuration flags duration below 0.2s as error and above 10.0s as warning', () => {
  const shortCue = { id: 'c1', start: 1.0, end: 1.15 }; // 0.15s < 0.2s
  const longCue = { id: 'c2', start: 1.0, end: 12.5 }; // 11.5s > 10.0s
  const normalCue = { id: 'c3', start: 1.0, end: 4.0 }; // 3.0s

  const shortIssues = validateSegmentDuration(shortCue);
  assert.equal(shortIssues.length, 1);
  assert.equal(shortIssues[0].type, SUBTITLE_ISSUE_TYPES.INVALID_DURATION);
  assert.equal(shortIssues[0].severity, SUBTITLE_ISSUE_SEVERITIES.ERROR);

  const longIssues = validateSegmentDuration(longCue);
  assert.equal(longIssues.length, 1);
  assert.equal(longIssues[0].type, SUBTITLE_ISSUE_TYPES.LONG_DURATION);
  assert.equal(longIssues[0].severity, SUBTITLE_ISSUE_SEVERITIES.WARNING);
  assert.equal(longIssues[0].remedyAction, REMEDY_ACTIONS.SPLIT_SEGMENT);

  const normalIssues = validateSegmentDuration(normalCue);
  assert.equal(normalIssues.length, 0);
});

test('validateSegmentDuration flags cue exceeding media duration as error', () => {
  const cue = { id: 'c1', start: 55.0, end: 62.0 }; // duration 7.0s < 10.0s, but 62.0s > 60.0s
  const issues = validateSegmentDuration(cue, { mediaDuration: 60.0 });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, SUBTITLE_ISSUE_TYPES.EXCEEDS_MEDIA);
  assert.equal(issues[0].severity, SUBTITLE_ISSUE_SEVERITIES.ERROR);
});

test('detectValidationOverlaps creates bidirectional overlap errors with conflicting cue IDs', () => {
  const segments = [
    { id: 'c1', start: 1.0, end: 3.5, text: 'First' },
    { id: 'c2', start: 3.0, end: 5.0, text: 'Second' },
    { id: 'c3', start: 6.0, end: 8.0, text: 'Third' },
  ];

  const overlapIssues = detectValidationOverlaps(segments);
  assert.equal(overlapIssues.length, 2);
  const issueA = overlapIssues.find(iss => iss.segmentId === 'c1');
  const issueB = overlapIssues.find(iss => iss.segmentId === 'c2');

  assert.ok(issueA);
  assert.equal(issueA.type, SUBTITLE_ISSUE_TYPES.OVERLAP);
  assert.equal(issueA.severity, SUBTITLE_ISSUE_SEVERITIES.ERROR);
  assert.equal(issueA.metadata.conflictingSegmentId, 'c2');
  assert.equal(issueA.metadata.overlapDuration, 0.5);
  assert.equal(issueA.remedyAction, REMEDY_ACTIONS.RESOLVE_OVERLAP);

  assert.ok(issueB);
  assert.equal(issueB.metadata.conflictingSegmentId, 'c1');
});

test('validateSegmentLineLengths flags lines exceeding 80 characters, >2 line breaks, and excessive reading speed', () => {
  const longLineText = 'a'.repeat(85);
  const tooManyLinesText = 'Line 1\nLine 2\nLine 3\nLine 4'; // 3 breaks > 2
  const fastReadingText = 'This is quite a long sentence for a half second interval'; // ~56 chars in 0.5s = 112 cps > 25

  const longLineIssues = validateSegmentLineLengths({ id: 'c1', start: 1.0, end: 5.0, text: longLineText });
  assert.equal(longLineIssues.length, 1);
  assert.equal(longLineIssues[0].type, SUBTITLE_ISSUE_TYPES.LINE_TOO_LONG);
  assert.equal(longLineIssues[0].remedyAction, REMEDY_ACTIONS.SPLIT_LINE);

  const manyLinesIssues = validateSegmentLineLengths({ id: 'c2', start: 1.0, end: 5.0, text: tooManyLinesText });
  assert.equal(manyLinesIssues.length, 1);
  assert.equal(manyLinesIssues[0].type, SUBTITLE_ISSUE_TYPES.TOO_MANY_LINES);
  assert.equal(manyLinesIssues[0].remedyAction, REMEDY_ACTIONS.SPLIT_SEGMENT);

  const fastReadingIssues = validateSegmentLineLengths({ id: 'c3', start: 1.0, end: 1.5, text: fastReadingText });
  assert.equal(fastReadingIssues.length, 1);
  assert.equal(fastReadingIssues[0].type, SUBTITLE_ISSUE_TYPES.READING_SPEED_FAST);
  assert.equal(fastReadingIssues[0].remedyAction, REMEDY_ACTIONS.EXTEND_DURATION);
});

test('validateSegmentVoice flags unassigned or nonexistent voices when voice assignment is required', () => {
  const characters = [{ id: 'char-1', name: 'Dara' }, { id: 'char-2', name: 'Sophea' }];

  const unassignedSeg = { id: 'c1', speakerId: 'spk-1', voiceId: null };
  const mappedSeg = { id: 'c2', speakerId: 'spk-1', voiceId: null };
  const invalidVoiceSeg = { id: 'c3', speakerId: 'spk-1', voiceId: 'nonexistent-voice' };

  // When not required:
  assert.equal(validateSegmentVoice(unassignedSeg, { requireVoiceAssignment: false }).length, 0);

  // When required and missing:
  const missingIssues = validateSegmentVoice(unassignedSeg, { requireVoiceAssignment: true });
  assert.equal(missingIssues.length, 1);
  assert.equal(missingIssues[0].type, SUBTITLE_ISSUE_TYPES.UNASSIGNED_VOICE);
  assert.equal(missingIssues[0].remedyAction, REMEDY_ACTIONS.ASSIGN_VOICE);

  // When mapped via speakerVoiceMap:
  const mappedIssues = validateSegmentVoice(mappedSeg, {
    requireVoiceAssignment: true,
    speakerVoiceMap: { 'spk-1': 'char-1' },
    characters,
  });
  assert.equal(mappedIssues.length, 0);

  // When voiceId is nonexistent in catalog:
  const invalidIssues = validateSegmentVoice(invalidVoiceSeg, {
    requireVoiceAssignment: true,
    characters,
  });
  assert.equal(invalidIssues.length, 1);
  assert.equal(invalidIssues[0].type, SUBTITLE_ISSUE_TYPES.UNASSIGNED_VOICE);
});

test('validateSubtitleSegments aggregates counts, error flags, and lookup by segment ID', () => {
  const segments = [
    { id: 'c1', start: 0, end: 2.0, text: '' }, // Error: missing text
    { id: 'c2', start: 1.5, end: 3.0, text: 'Overlapping cue' }, // Error: overlap with c1
    { id: 'c3', start: 4.0, end: 16.0, text: 'A'.repeat(85) }, // Warnings: long duration & line too long
    { id: 'c4', start: 17.0, end: 20.0, text: 'Perfect cue' }, // Clean
  ];

  const summary = validateSubtitleSegments({ segments });

  assert.equal(summary.isValid, false);
  assert.equal(summary.hasErrors, true);
  assert.equal(summary.hasWarnings, true);
  assert.ok(summary.errorCount >= 2);
  assert.ok(summary.warningCount >= 2);
  assert.equal(summary.issuesBySegmentId['c4'], undefined);
  assert.ok(summary.issuesBySegmentId['c1'].length >= 2); // missing text + overlap
  assert.ok(summary.issuesBySegmentId['c2'].length >= 1); // overlap
  assert.ok(summary.issuesBySegmentId['c3'].length >= 2); // long duration + line too long
});

test('findNextSegmentWithIssue and findPreviousSegmentWithIssue cycle through problem segments', () => {
  const segments = [
    { id: 'c1', start: 0, end: 1 },
    { id: 'c2', start: 2, end: 3 },
    { id: 'c3', start: 4, end: 5 },
    { id: 'c4', start: 6, end: 7 },
  ];
  const issuesBySegmentId = {
    c1: [{ severity: 'error' }],
    c3: [{ severity: 'warning' }],
  };

  assert.equal(findNextSegmentWithIssue(segments, issuesBySegmentId, 'c1'), 'c3');
  assert.equal(findNextSegmentWithIssue(segments, issuesBySegmentId, 'c3'), 'c1');
  assert.equal(findPreviousSegmentWithIssue(segments, issuesBySegmentId, 'c1'), 'c3');
  assert.equal(findPreviousSegmentWithIssue(segments, issuesBySegmentId, 'c3'), 'c1');

  // Severity filtering
  assert.equal(findNextSegmentWithIssue(segments, issuesBySegmentId, 'c1', 'error'), 'c1');
  assert.equal(findNextSegmentWithIssue(segments, issuesBySegmentId, 'c1', 'warning'), 'c3');
});

test('filterSegmentsWithIssues returns only segments matching issue criteria', () => {
  const segments = [
    { id: 'c1', start: 0, end: 1 },
    { id: 'c2', start: 2, end: 3 },
    { id: 'c3', start: 4, end: 5 },
  ];
  const issuesBySegmentId = {
    c1: [{ severity: 'error' }],
    c2: [{ severity: 'warning' }],
  };

  const allProblems = filterSegmentsWithIssues(segments, issuesBySegmentId);
  assert.equal(allProblems.length, 2);
  assert.deepEqual(allProblems.map(s => s.id), ['c1', 'c2']);

  const errorProblems = filterSegmentsWithIssues(segments, issuesBySegmentId, 'error');
  assert.equal(errorProblems.length, 1);
  assert.equal(errorProblems[0].id, 'c1');
});

test('autoBreakLongLine wraps long sentences cleanly at word boundaries', () => {
  const sentence = 'This is an excessively long subtitle line that definitely needs wrapping before it exceeds standard limits';
  const wrapped = autoBreakLongLine(sentence, 40);

  const lines = wrapped.split('\n');
  assert.ok(lines.length >= 2);
  for (const line of lines) {
    assert.ok(line.length <= 40, `Line "${line}" must not exceed 40 characters`);
  }
});

test('null and undefined inputs return empty issue arrays without throwing', () => {
  assert.deepEqual(validateSegmentText(null), []);
  assert.deepEqual(validateSegmentDuration(undefined), []);
  assert.deepEqual(validateSegmentLineLengths(null), []);
  assert.deepEqual(validateSegmentVoice(null), []);
  assert.deepEqual(validateSingleSegment(null), []);
  assert.deepEqual(validateSubtitleSegments({ segments: null }).issues, []);
});

test('validateSegmentLineLengths ignores reading speed when duration is NaN or missing', () => {
  const cueWithMissingTimes = { id: 'c1', text: 'This text should not produce NaN reading speed', start: undefined, end: undefined };
  const issues = validateSegmentLineLengths(cueWithMissingTimes);
  assert.equal(issues.filter(i => i.type === SUBTITLE_ISSUE_TYPES.READING_SPEED_FAST).length, 0);

  const cueWithNanTimes = { id: 'c2', text: 'Another text line', start: NaN, end: NaN };
  const nanIssues = validateSegmentLineLengths(cueWithNanTimes);
  assert.equal(nanIssues.filter(i => i.type === SUBTITLE_ISSUE_TYPES.READING_SPEED_FAST).length, 0);
});

test('empty cue does not flag redundant untranslated warning when translation is active', () => {
  const emptyCue = { id: 'c1', start: 1.0, end: 3.0, text: '', translatedText: '' };
  const issues = validateSegmentText(emptyCue, { useTranslation: true });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, SUBTITLE_ISSUE_TYPES.MISSING_TEXT);
});

test('validateSubtitleSegments with hasVoiceover flags unassigned voices', () => {
  const segments = [{ id: 'c1', start: 1.0, end: 3.0, text: 'Hello', speakerId: 'spk-1', voiceId: null }];
  const summary = validateSubtitleSegments({ segments, hasVoiceover: true });
  assert.equal(summary.isValid, false);
  const voiceIssue = summary.issues.find(i => i.type === SUBTITLE_ISSUE_TYPES.UNASSIGNED_VOICE);
  assert.ok(voiceIssue, 'Must flag unassigned voice when hasVoiceover is true');
});

test('autoBreakLongLine preserves Khmer Unicode grapheme clusters and avoids infinite loops', () => {
  // Khmer text with subscripts and vowels (25 graphemes)
  const khmerText = 'ខ្ញុំចង់រៀនភាសាខ្មែរជាមួយអ្នកទាំងអស់គ្នាជារៀងរាល់ថ្ងៃ';
  const wrapped = autoBreakLongLine(khmerText, 15);
  const lines = wrapped.split('\n');
  assert.ok(lines.length >= 2, 'Should break into multiple lines');
  for (const line of lines) {
    // Confirm text roundtrips without broken codepoints
    assert.doesNotThrow(() => line.normalize('NFC'));
  }

  // Non-positive maxChars safeguard
  assert.equal(autoBreakLongLine('No break', 0), 'No break');
  assert.equal(autoBreakLongLine('No break', -5), 'No break');
});

test('validateSubtitleSegments reports speech_exceeds_interval errors, rejects colliding spill, and clears on valid spill approval', () => {
  const collidingSegments = [
    { id: 'c1', start: 0.0, end: 1.5, text: 'Short cue' },
    { id: 'c2', start: 2.0, end: 4.0, text: 'Neighbor at 2.0s' },
  ];
  const collidingClips = {
    c1: { durationSeconds: 2.2, signature: 'sig-1', blob: new Blob(['x']) },
    c2: { durationSeconds: 1.5, signature: 'sig-2', blob: new Blob(['y']) },
  };

  const summary = validateSubtitleSegments({ segments: collidingSegments, segmentClips: collidingClips, mediaDuration: 6.0 });
  assert.equal(summary.isValid, false);
  assert.equal(summary.hasErrors, true);
  const issue = summary.issuesBySegmentId.c1.find(i => i.type === SUBTITLE_ISSUE_TYPES.SPEECH_EXCEEDS_INTERVAL);
  assert.ok(issue, 'Must attach SPEECH_EXCEEDS_INTERVAL issue to c1');
  assert.equal(issue.severity, SUBTITLE_ISSUE_SEVERITIES.ERROR);
  assert.equal(issue.remedyAction, REMEDY_ACTIONS.EXTEND_AND_SHIFT_NEXT);
  assert.ok(issue.metadata.availableRemedies.length >= 3, 'Must surface multiple explicit remedies');
  assert.equal(summary.issuesBySegmentId.c2, undefined);

  // Colliding spill approval (2.2s > 2.0s start of c2) must NOT clear the validation error
  const invalidSpill = validateSubtitleSegments({
    segments: collidingSegments,
    segmentClips: collidingClips,
    mediaDuration: 6.0,
    spillApprovals: { c1: { segmentId: 'c1', clipSignature: 'sig-1', clipDuration: 2.2, cueStart: 0.0, cueEnd: 1.5 } },
  });
  assert.equal(invalidSpill.isValid, false);

  // Valid spill into empty pause [1.5s, 3.0s] clears validation error cleanly
  const safeSegments = [
    { id: 'c1', start: 0.0, end: 1.5, text: 'Hello world' },
    { id: 'c2', start: 3.0, end: 4.5, text: 'Next line' },
  ];
  const safeClips = {
    c1: { durationSeconds: 2.1, signature: 'char-1\0\0Hello world', blob: new Blob(['a']) },
    c2: { durationSeconds: 1.2, signature: 'char-1\0\0Next line', blob: new Blob(['b']) },
  };
  const flagged = validateSubtitleSegments({ segments: safeSegments, segmentClips: safeClips, mediaDuration: 5.0 });
  assert.equal(flagged.isValid, false);
  assert.equal(flagged.issuesBySegmentId.c1[0].remedyAction, REMEDY_ACTIONS.EXTEND_CUE_TO_SPEECH);

  const approved = validateSubtitleSegments({
    segments: safeSegments,
    segmentClips: safeClips,
    mediaDuration: 5.0,
    spillApprovals: {
      c1: { segmentId: 'c1', clipSignature: 'char-1\0\0Hello world', clipDuration: 2.1, cueStart: 0.0, cueEnd: 1.5 },
    },
  });
  assert.equal(approved.isValid, true);
  assert.equal(approved.totalIssues, 0);
});

test('validateSubtitleSegments flags terminology spelling and translation gaps without flagging TTS pronunciation', () => {
  const terminology = [
    { id: 't-spell', category: 'spelling', status: 'approved', enabled: true, term: 'Phnom Penh', variants: ['Pnom Penh'] },
    { id: 't-tr', category: 'translation', status: 'approved', enabled: true, term: 'AI', translation: 'បញ្ញាសិប្បនិម្មិត', sourceLanguage: 'en', targetLanguage: 'khm_Khmr' },
    { id: 't-draft', category: 'spelling', status: 'draft', enabled: true, term: 'DraftWord', variants: ['draftword'] },
    { id: 't-pron', category: 'pronunciation', status: 'approved', enabled: true, term: 'Phnom Penh', pronunciation: 'ភ្នំ-ពេញ' },
  ];

  const report = validateSubtitleSegments({
    segments: [
      { id: 'c1', start: 0.0, end: 2.0, text: 'Visit Pnom Penh for AI draftword.', translatedText: 'ទៅទស្សនាទីក្រុង' },
      { id: 'c2', start: 2.1, end: 4.0, text: 'Phnom Penh AI hub.', translatedText: 'ភ្នំពេញ បញ្ញាសិប្បនិម្មិត' },
    ],
    useTranslation: true,
    sourceLanguage: 'en',
    targetLanguage: 'khm_Khmr',
    terminology,
  });

  const c1Issues = report.issuesBySegmentId.c1;
  assert.equal(c1Issues.length, 2);
  assert.equal(c1Issues[0].type, SUBTITLE_ISSUE_TYPES.TERMINOLOGY_SPELLING);
  assert.equal(c1Issues[0].remedyAction, REMEDY_ACTIONS.APPLY_TERMINOLOGY_SPELLING);
  assert.equal(c1Issues[1].type, SUBTITLE_ISSUE_TYPES.TERMINOLOGY_TRANSLATION);
  assert.equal(c1Issues[1].remedyAction, REMEDY_ACTIONS.APPLY_TERMINOLOGY_TRANSLATION);
  assert.equal(report.issuesBySegmentId.c2, undefined);
});
