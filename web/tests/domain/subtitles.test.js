import test from 'node:test';
import assert from 'node:assert/strict';
import { countGraphemes } from '../../src/domain/presets.js';
import {
  DEFAULT_ENGLISH_TARGET,
  DEFAULT_KHMER_TARGET,
  POPULAR_SOURCE_LANGUAGE_IDS,
  POPULAR_TARGET_LANGUAGE_IDS,
  SOURCE_LANGUAGE_OPTIONS,
  TARGET_LANGUAGE_OPTIONS,
  adjustSubtitleSegmentTiming,
  buildBoundedTtsHandoff,
  buildDialogueText,
  buildSrt,
  buildTtsScriptFromSegments,
  buildVtt,
  collectUniqueSpeakers,
  countTextMatchesInSegments,
  deleteSubtitleSegment,
  findActiveSegmentId,
  formatEditableTimestamp,
  formatShortClock,
  formatSubtitleTime,
  getSpeakerColor,
  groupLanguageOptions,
  isAudioOnlyFile,
  isSameSubtitleLanguage,
  mergeSubtitleSegmentWithNext,
  normalizeTargetLanguageCode,
  parseEditableTimestamp,
  pickDefaultTargetLanguage,
  replaceTextInSegments,
  resolveSpeakerLabel,
  resolveTargetLanguageMeta,
  splitSubtitleSegment,
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

test('isAudioOnlyFile, bilingual exports, and includeSpeaker=false dialogue formatting', () => {
  assert.equal(isAudioOnlyFile({ name: 'podcast.mp3', type: 'audio/mpeg' }), true);
  assert.equal(isAudioOnlyFile({ name: 'voice.WAV', type: '' }), true);
  assert.equal(isAudioOnlyFile({ name: 'clip.mp4', type: 'video/mp4' }), false);
  assert.equal(isAudioOnlyFile(null), false);

  const vttBilingual = buildVtt({ segments: SAMPLE_SEGMENTS.slice(0, 1), includeSpeaker: false, useTranslation: true, bilingual: true });
  assert.equal(vttBilingual.includes('Speaker 1:'), false);
  assert.ok(vttBilingual.includes('Welcome to the evening news.\nសូមស្វាគមន៍មកកាន់ព័ត៌មានពេលល្ងាច។'));

  const dialogueNoSpeaker = buildDialogueText({ segments: SAMPLE_SEGMENTS, includeTimestamps: false, useTranslation: true, includeSpeaker: false });
  assert.equal(dialogueNoSpeaker.includes('Speaker'), false);
  assert.ok(dialogueNoSpeaker.startsWith('សូមស្វាគមន៍មកកាន់ព័ត៌មានពេលល្ងាច។ ព័ត៌មានសំខាន់ចាប់ផ្តើមពីភ្នំពេញ។\n'));

  const dialogueBilingual = buildDialogueText({
    segments: SAMPLE_SEGMENTS.slice(0, 1),
    includeTimestamps: false,
    useTranslation: true,
    includeSpeaker: false,
    bilingual: true,
  });
  assert.equal(dialogueBilingual, 'Welcome to the evening news.\nសូមស្វាគមន៍មកកាន់ព័ត៌មានពេលល្ងាច។');
});

test('buildBoundedTtsHandoff caps length safely at segment or grapheme boundaries', () => {
  const short = buildBoundedTtsHandoff({ segments: SAMPLE_SEGMENTS, useTranslation: true, speakerId: 'speaker-2', maxGraphemes: 200 });
  assert.equal(short.truncated, false);
  assert.equal(short.includedSegments, 1);

  const manySegments = Array.from({ length: 30 }, (_, i) => ({
    id: `seg-${i}`,
    start: i,
    end: i + 1,
    speakerId: 'speaker-1',
    text: `Sentence number ${i + 1} with plenty of words to push well past a tiny limit.`,
    translatedText: 'សួស្តីកម្ពុជាប្រជាធិបតេយ្យរុងរឿងជានិច្ច។',
  }));
  const bounded = buildBoundedTtsHandoff({ segments: manySegments, useTranslation: true, maxGraphemes: 120 });
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.includedSegments > 0 && bounded.includedSegments < 30);
  assert.ok(countGraphemes(bounded.text) <= 120);

  const giantKhmer = [{ id: 'g-1', start: 0, end: 5, speakerId: 'speaker-1', text: 'ស្ត្រីខ្ញុំ'.repeat(40), translatedText: '' }];
  const sliced = buildBoundedTtsHandoff({ segments: giantKhmer, useTranslation: false, maxGraphemes: 15 });
  assert.equal(sliced.truncated, true);
  assert.equal(countGraphemes(sliced.text), 15);
  assert.equal(sliced.text.endsWith('\u17d2'), false);
});

test('active cue lookup, timestamp editing, split/merge/delete, and find-and-replace work cleanly', () => {
  const segments = SAMPLE_SEGMENTS.map((seg, i) => ({ ...seg, id: `seg-${i + 1}` }));
  assert.equal(findActiveSegmentId(segments, 4.0), 'seg-2');
  assert.equal(findActiveSegmentId(segments, 99.0), '');
  assert.equal(findActiveSegmentId(segments, Number.NaN), '');

  assert.equal(formatEditableTimestamp(65.4), '01:05.4');
  assert.equal(formatEditableTimestamp(3661.2), '1:01:01.2');
  assert.equal(parseEditableTimestamp('01:05.4'), 65.4);
  assert.equal(parseEditableTimestamp('1:01:01.2'), 3661.2);
  assert.equal(parseEditableTimestamp('42.5'), 42.5);
  assert.equal(parseEditableTimestamp('01:75'), null);
  assert.equal(parseEditableTimestamp('abc'), null);

  const retimed = adjustSubtitleSegmentTiming(segments, 'seg-1', { start: 2.0, end: 1.0 });
  assert.equal(retimed[0].start, 2.0);
  assert.equal(retimed[0].end, 2.1);

  const split = splitSubtitleSegment(segments, 'seg-1', { ratio: 0.5 });
  assert.equal(split.length, 4);
  assert.equal(split[0].end, split[1].start);
  assert.ok(split[0].text.length > 0 && split[1].text.length > 0);

  const merged = mergeSubtitleSegmentWithNext(split, 'seg-1');
  assert.equal(merged.length, 3);
  assert.equal(merged[0].start, 0.5);
  assert.equal(merged[0].end, 3.2);

  const deleted = deleteSubtitleSegment(merged, 'seg-2');
  assert.equal(deleted.length, 2);

  const replaced = replaceTextInSegments({
    segments: [{ id: 'r1', text: 'Price is $25 ($25)', translatedText: '' }],
    findText: '$25',
    replaceText: '$30',
    useTranslation: false,
  });
  assert.equal(replaced.matchCount, 2);
  assert.equal(replaced.segmentCount, 1);
  assert.equal(replaced.segments[0].text, 'Price is $30 ($30)');

  // Literal $-sequences ($&, $$, $1) must not be expanded as regex replacement patterns
  const dollarSafe = replaceTextInSegments({
    segments: [{ id: 'r2', text: 'Total USD and USD', translatedText: '' }],
    findText: 'USD',
    replaceText: '$& $$50',
    useTranslation: false,
  });
  assert.equal(dollarSafe.segments[0].text, 'Total $& $$50 and $& $$50');
  assert.deepEqual(
    countTextMatchesInSegments({ segments: [{ id: 'r2', text: 'Total USD and usd', translatedText: '' }], findText: 'USD', caseSensitive: true }),
    { matchCount: 1, segmentCount: 1 }
  );

  // Splitting a sub-0.2s cue still produces two strictly positive-duration cues
  const shortSplit = splitSubtitleSegment([{ id: 's1', start: 1.0, end: 1.15, text: 'Hello world', translatedText: '' }], 's1');
  assert.equal(shortSplit.length, 2);
  assert.ok(shortSplit[0].end > shortSplit[0].start);
  assert.ok(shortSplit[1].end > shortSplit[1].start);
  assert.equal(shortSplit[0].end, shortSplit[1].start);

  // Translated-mode find/replace never leaks or replaces original `text` when `translatedText` is empty
  const emptyTrSegs = [{ id: 'tr-1', text: 'English only', translatedText: '' }];
  assert.deepEqual(countTextMatchesInSegments({ segments: emptyTrSegs, findText: 'English', useTranslation: true }), { matchCount: 0, segmentCount: 0 });
  const untouchedTr = replaceTextInSegments({ segments: emptyTrSegs, findText: 'English', replaceText: 'Khmer', useTranslation: true });
  assert.equal(untouchedTr.matchCount, 0);
  assert.equal(untouchedTr.segments[0].translatedText, '');

  // CRLF and multiple consecutive whitespace-only blank lines collapse cleanly so SRT/VTT cue parsing never breaks
  const multiBlankSegments = [
    {
      start: 0.0,
      end: 2.0,
      speakerId: 'speaker-1',
      text: 'Line one\r\n\r\nLine two\n  \n\t\n  \nLine three',
      translatedText: 'បន្ទាត់ទី១\r\n\r\n\t\n\nបន្ទាត់ទី២',
    },
  ];
  const cleanSrt = buildSrt({ segments: multiBlankSegments, includeSpeaker: false, useTranslation: false });
  assert.equal(cleanSrt, '1\n00:00:00,000 --> 00:00:02,000\nLine one\nLine two\nLine three\n');
  const cleanVtt = buildVtt({ segments: multiBlankSegments, includeSpeaker: false, useTranslation: true, bilingual: true });
  assert.equal(
    cleanVtt,
    'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nLine one\nLine two\nLine three\nបន្ទាត់ទី១\nបន្ទាត់ទី២\n'
  );
});

test('multilingual subtitle language catalog exposes all 100 Whisper sources, all 202 NLLB targets, and safe helpers', () => {
  assert.equal(SOURCE_LANGUAGE_OPTIONS.length, 101);
  assert.equal(new Set(SOURCE_LANGUAGE_OPTIONS.map(o => o.id)).size, 101);
  assert.equal(SOURCE_LANGUAGE_OPTIONS[0].id, 'auto');
  assert.ok(SOURCE_LANGUAGE_OPTIONS.some(o => o.id === 'km'));
  assert.ok(SOURCE_LANGUAGE_OPTIONS.some(o => o.id === 'yue'));
  assert.ok(SOURCE_LANGUAGE_OPTIONS.some(o => o.id === 'yo'));

  assert.equal(TARGET_LANGUAGE_OPTIONS.length, 202);
  assert.equal(new Set(TARGET_LANGUAGE_OPTIONS.map(o => o.id)).size, 202);
  assert.ok(TARGET_LANGUAGE_OPTIONS.some(o => o.id === 'zul_Latn'));

  assert.equal(normalizeTargetLanguageCode('km'), DEFAULT_KHMER_TARGET);
  assert.equal(normalizeTargetLanguageCode('en'), DEFAULT_ENGLISH_TARGET);
  assert.equal(normalizeTargetLanguageCode('ja'), 'jpn_Jpan');
  assert.equal(normalizeTargetLanguageCode('zh-TW'), 'zho_Hant');
  assert.equal(normalizeTargetLanguageCode('arb_Arab'), 'arb_Arab');
  assert.equal(normalizeTargetLanguageCode('unknown_code'), DEFAULT_KHMER_TARGET);

  const kmMeta = resolveTargetLanguageMeta('km');
  assert.equal(kmMeta.id, 'khm_Khmr');
  assert.equal(kmMeta.shortLabel, 'Khmer');
  assert.equal(kmMeta.bcp47, 'km');
  assert.equal(kmMeta.isKhmer, true);
  assert.equal(kmMeta.isRtl, false);

  const arMeta = resolveTargetLanguageMeta('arb_Arab');
  assert.equal(arMeta.shortLabel, 'Arabic');
  assert.equal(arMeta.bcp47, 'ar');
  assert.equal(arMeta.isKhmer, false);
  assert.equal(arMeta.isRtl, true);

  const heMeta = resolveTargetLanguageMeta('heb_Hebr');
  assert.equal(heMeta.isRtl, true);

  assert.equal(isSameSubtitleLanguage('km', 'khm_Khmr'), true);
  assert.equal(isSameSubtitleLanguage('en', 'eng_Latn'), true);
  assert.equal(isSameSubtitleLanguage('km', 'eng_Latn'), false);
  assert.equal(isSameSubtitleLanguage('auto', 'khm_Khmr'), false);

  assert.equal(pickDefaultTargetLanguage('km', 'khm_Khmr'), DEFAULT_ENGLISH_TARGET);
  assert.equal(pickDefaultTargetLanguage('km', 'jpn_Jpan'), 'jpn_Jpan');
  assert.equal(pickDefaultTargetLanguage('en', 'eng_Latn'), DEFAULT_KHMER_TARGET);
  assert.equal(pickDefaultTargetLanguage('ja', 'jpn_Jpan'), DEFAULT_KHMER_TARGET);

  const groupedSrc = groupLanguageOptions(SOURCE_LANGUAGE_OPTIONS, POPULAR_SOURCE_LANGUAGE_IDS);
  assert.equal(groupedSrc.popular.length, POPULAR_SOURCE_LANGUAGE_IDS.length);
  assert.equal(groupedSrc.popular.length + groupedSrc.others.length, SOURCE_LANGUAGE_OPTIONS.length);

  const groupedTgt = groupLanguageOptions(TARGET_LANGUAGE_OPTIONS, POPULAR_TARGET_LANGUAGE_IDS);
  assert.equal(groupedTgt.popular.length, POPULAR_TARGET_LANGUAGE_IDS.length);
  assert.equal(groupedTgt.popular.length + groupedTgt.others.length, TARGET_LANGUAGE_OPTIONS.length);
});
