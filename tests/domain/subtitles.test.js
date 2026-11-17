import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDialogueText,
  buildSrt,
  buildTtsScriptFromSegments,
  buildVtt,
  collectUniqueSpeakers,
  formatShortClock,
  formatSubtitleTime,
  getSpeakerColor,
  resolveSpeakerLabel,
} from '../../src/domain/subtitles.js';

const SAMPLE_SEGMENTS = [
  { start: 0.5, end: 3.2, text: 'Welcome to the evening news.', translatedText: 'សូមស្វាគមន៍មកកាន់ព័ត៌មានពេលល្ងាច។', speakerId: 'speaker-1' },
  { start: 3.4, end: 6.1, text: 'Our top story starts in Phnom Penh.', translatedText: 'ព័ត៌មានសំខាន់ចាប់ផ្តើមពីភ្នំពេញ។', speakerId: 'speaker-1' },
  { start: 6.5, end: 9.8, text: 'Thank you for having me tonight.', translatedText: 'អរគុណដែលបានអញ្ជើញខ្ញុំ។', speakerId: 'speaker-2' },
];

test('timestamp and speaker helpers format cleanly and resolve custom names', () => {
  assert.equal(formatSubtitleTime(65.432, ','), '00:01:05,432');
  assert.equal(formatSubtitleTime(3.2, '.'), '00:00:03.200');
  assert.equal(formatShortClock(65), '01:05');
  assert.equal(formatShortClock(3661), '01:01:01');
  assert.deepEqual(collectUniqueSpeakers(SAMPLE_SEGMENTS), ['speaker-1', 'speaker-2']);
  assert.equal(resolveSpeakerLabel('speaker-2', { 'speaker-2': 'ភ្ញៀវ' }), 'ភ្ញៀវ');
  assert.equal(resolveSpeakerLabel('speaker-3', {}), 'Speaker 3');
  assert.notEqual(getSpeakerColor('speaker-1'), getSpeakerColor('speaker-2'));
});

test('buildSrt, buildVtt, buildDialogueText, and buildTtsScriptFromSegments support custom speakers and translation', () => {
  const names = { 'speaker-1': 'ពិធីករ', 'speaker-2': 'ភ្ញៀវ' };
  const srt = buildSrt({ segments: SAMPLE_SEGMENTS, speakerNames: names, includeSpeaker: true, useTranslation: true });
  assert.ok(srt.includes('1\n00:00:00,500 --> 00:00:03,200\n[ពិធីករ] សូមស្វាគមន៍មកកាន់ព័ត៌មានពេលល្ងាច។'));

  const vtt = buildVtt({ segments: SAMPLE_SEGMENTS, speakerNames: names, includeSpeaker: true, useTranslation: false });
  assert.ok(vtt.startsWith('WEBVTT\n\n'));
  assert.ok(vtt.includes('00:00:06.500 --> 00:00:09.800\nភ្ញៀវ: Thank you for having me tonight.'));

  const script = buildDialogueText({ segments: SAMPLE_SEGMENTS, speakerNames: names, includeTimestamps: true, useTranslation: true });
  assert.equal(
    script,
    '[00:01 - 00:06] ពិធីករ: សូមស្វាគមន៍មកកាន់ព័ត៌មានពេលល្ងាច។ ព័ត៌មានសំខាន់ចាប់ផ្តើមពីភ្នំពេញ។\n[00:07 - 00:10] ភ្ញៀវ: អរគុណដែលបានអញ្ជើញខ្ញុំ។'
  );

  const ttsOnlySpeaker2 = buildTtsScriptFromSegments({ segments: SAMPLE_SEGMENTS, useTranslation: true, speakerId: 'speaker-2' });
  assert.equal(ttsOnlySpeaker2, 'អរគុណដែលបានអញ្ជើញខ្ញុំ។');
});
