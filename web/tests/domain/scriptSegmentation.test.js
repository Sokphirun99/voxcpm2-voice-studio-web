import test from 'node:test';
import assert from 'node:assert/strict';
import { ValidationError } from '../../src/domain/errors.js';
import { expandKhmerNumbers } from '../../src/domain/khmerText.js';
import { MAX_SCRIPT_LENGTH, validateGenerationInput } from '../../src/domain/presets.js';
import {
  MAX_PAUSE_MS,
  MIN_PAUSE_MS,
  clampPauseMs,
  segmentScriptWithPauses,
  segmentSingleSpeakerScript,
  stripPauseMarkers,
} from '../../src/domain/scriptSegmentation.js';

test('segmentSingleSpeakerScript rejects empty and oversized scripts', () => {
  assert.throws(
    () => segmentSingleSpeakerScript('   \n  '),
    err => err instanceof ValidationError && err.code === 'EMPTY_SCRIPT'
  );
  assert.throws(
    () => segmentSingleSpeakerScript('ក'.repeat(MAX_SCRIPT_LENGTH + 1)),
    err => err instanceof ValidationError && err.code === 'SCRIPT_TOO_LONG'
  );
});

test('segmentSingleSpeakerScript merges tiny fragments and splits long Khmer/Latin sentences cleanly', () => {
  const shortScript = 'សួស្តី! តើអ្នកសុខសប្បាយជាទេ?';
  assert.deepEqual(segmentSingleSpeakerScript(shortScript, 220), ['សួស្តី! តើអ្នកសុខសប្បាយជាទេ?']);

  const multiParagraph = [
    'សួស្តីបងប្អូនទាំងអស់គ្នា ថ្ងៃនេះយើងនឹងសាកល្បងបម្លែងអត្ថបទជាភាសាខ្មែរទៅជាសំឡេងដែលមានភាពច្បាស់លាស់។',
    'ប្រយោគទីពីរនេះនិយាយអំពីការរក្សាសំឡេងតែមួយដដែលចាប់ពីដើមរហូតដល់ចប់។',
  ].join(' ');
  const chunks = segmentSingleSpeakerScript(multiParagraph, 75);
  assert.equal(chunks.length, 2);
  assert.match(chunks[0], /សួស្តីបងប្អូន/);
  assert.match(chunks[1], /ប្រយោគទីពីរ/);
});

test('segmentSingleSpeakerScript splits overlong sentences without delimiters at whitespace or grapheme bounds', () => {
  const longWords = Array.from({ length: 12 }, (_, idx) => `word${idx}`).join(' ');
  const chunks = segmentSingleSpeakerScript(longWords, 25);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every(chunk => chunk.length <= 25));

  const unbroken = 'ក'.repeat(25);
  const sliced = segmentSingleSpeakerScript(unbroken, 10);
  assert.deepEqual(sliced, ['ក'.repeat(10), 'ក'.repeat(10), 'ក'.repeat(5)]);
});

test('segmentScriptWithPauses parses [pause 0.5s] and [pause 800ms] boundaries without leaking literal tags', () => {
  const script = 'Welcome to Voice Studio. [pause 0.5s] Now listen closely. [pause 800ms] Thank you!';
  const segments = segmentScriptWithPauses(script);
  assert.deepEqual(segments, [
    { text: 'Welcome to Voice Studio.', pauseAfterMs: 500 },
    { text: 'Now listen closely.', pauseAfterMs: 800 },
    { text: 'Thank you!', pauseAfterMs: null },
  ]);
  assert.ok(segments.every(seg => !/\[pause/i.test(seg.text)));

  // segmentSingleSpeakerScript stays string[] and strips pause boundaries cleanly.
  assert.deepEqual(segmentSingleSpeakerScript(script), [
    'Welcome to Voice Studio.',
    'Now listen closely.',
    'Thank you!',
  ]);
});

test('segmentScriptWithPauses clamps inline pauses strictly to 100ms..5000ms and handles spacing, case, and adjacent markers', () => {
  assert.equal(clampPauseMs(0), MIN_PAUSE_MS);
  assert.equal(clampPauseMs(50), MIN_PAUSE_MS);
  assert.equal(clampPauseMs(99.4), MIN_PAUSE_MS);
  assert.equal(clampPauseMs(500), 500);
  assert.equal(clampPauseMs(9999), MAX_PAUSE_MS);
  assert.equal(clampPauseMs(Number.NaN), MIN_PAUSE_MS);

  const clamped = segmentScriptWithPauses(
    '[pause 2s] First [pause 0s] Second [pause 50 ms] Third [PAUSE 1.5 S] Fourth [pause 12s] Fifth [pause 3s] [pause 4s] Sixth [pause 1s]'
  );
  assert.deepEqual(clamped, [
    { text: 'First', pauseAfterMs: 100 },
    { text: 'Second', pauseAfterMs: 100 },
    { text: 'Third', pauseAfterMs: 1500 },
    { text: 'Fourth', pauseAfterMs: 5000 },
    { text: 'Fifth', pauseAfterMs: 5000 },
    { text: 'Sixth', pauseAfterMs: null },
  ]);

  const summed = segmentScriptWithPauses('សួស្តី [pause .25s] [pause 400ms] កម្ពុជា');
  assert.deepEqual(summed, [
    { text: 'សួស្តី', pauseAfterMs: 650 },
    { text: 'កម្ពុជា', pauseAfterMs: null },
  ]);
});

test('segmentScriptWithPauses rejects pause-only or oversized scripts and shields markers from Khmer expansion and glossary rules', () => {
  assert.throws(
    () => segmentScriptWithPauses('[pause 0.5s] [pause 800ms]'),
    err => err instanceof ValidationError && err.code === 'EMPTY_SCRIPT'
  );
  assert.throws(
    () => segmentScriptWithPauses(`${'ក'.repeat(1100)} [pause 0.5s] ${'ក'.repeat(1000)}`),
    err => err instanceof ValidationError && err.code === 'SCRIPT_TOO_LONG'
  );
  assert.equal(stripPauseMarkers('Hello [pause 0.5s] world [keep me]'), 'Hello world [keep me]');

  // Khmer numeral expansion must never rewrite digits inside [pause 500 ms], while still expanding numerals around it.
  const khmerExpanded = expandKhmerNumbers('សួស្តី [pause 500 ms] ឆ្នាំ 2026');
  assert.equal(khmerExpanded, 'សួស្តី [pause 500 ms] ឆ្នាំ ពីរពាន់ម្ភៃប្រាំមួយ');

  // validateGenerationInput protects pause markers from both pronunciation rules and Khmer expansion, and rejects pause-only scripts.
  const validated = validateGenerationInput({
    script: 'សួស្តី NASA [pause 500 ms] ឆ្នាំ 2026',
    character: { id: 'char-nisa', description: 'Warm Khmer narrator' },
    guidance: 2,
    steps: 10,
    seed: 7,
    autoFormatKhmer: true,
    pronunciationRules: [
      { source: 'pause', replacement: 'paws', enabled: true },
      { source: 'NASA', replacement: 'ណាសា', enabled: true },
    ],
  });
  assert.equal(validated.text, 'សួស្តី ណាសា [pause 500 ms] ឆ្នាំ ពីរពាន់ម្ភៃប្រាំមួយ');
  assert.deepEqual(segmentScriptWithPauses(validated.text), [
    { text: 'សួស្តី ណាសា', pauseAfterMs: 500 },
    { text: 'ឆ្នាំ ពីរពាន់ម្ភៃប្រាំមួយ', pauseAfterMs: null },
  ]);

  assert.throws(
    () => validateGenerationInput({
      script: '  [pause 1s]  ',
      character: { id: 'char-nisa', description: 'Warm Khmer narrator' },
      guidance: 2,
      steps: 10,
      seed: 7,
    }),
    err => err instanceof ValidationError && err.code === 'EMPTY_SCRIPT'
  );
});
