import test from 'node:test';
import assert from 'node:assert/strict';
import { ValidationError } from '../../src/domain/errors.js';
import { MAX_SCRIPT_LENGTH } from '../../src/domain/presets.js';
import { segmentSingleSpeakerScript } from '../../src/domain/scriptSegmentation.js';

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
