import test from 'node:test';
import assert from 'node:assert/strict';
import {
  expandKhmerNumbers,
  hasConvertibleKhmerNumbers,
  integerToKhmerWords,
  normalizeKhmerUnicode,
} from '../../src/domain/khmerText.js';

test('normalizeKhmerUnicode repairs broken digraphs, strips invisible artifacts, and preserves lines', () => {
  assert.equal(normalizeKhmerUnicode(null), '');
  assert.equal(normalizeKhmerUnicode('\uFEFF  សួស្តី\u200C  ពិភពលោក\u00AD  ។\n\nបន្ទាត់ទីពីរ  '), 'សួស្តី ពិភពលោក។\n\nបន្ទាត់ទីពីរ');
  assert.equal(normalizeKhmerUnicode('ស\u17C1\u17B6ម និង ក\u17C1\u17B8ត'), 'សោម និង កើត');
});

test('integerToKhmerWords formats Khmer and Arabic integers cleanly', () => {
  assert.equal(integerToKhmerWords(0), 'សូន្យ');
  assert.equal(integerToKhmerWords(15), 'ដប់ប្រាំ');
  assert.equal(integerToKhmerWords(25), 'ម្ភៃប្រាំ');
  assert.equal(integerToKhmerWords('១៥០០'), 'មួយពាន់ប្រាំរយ');
  assert.equal(integerToKhmerWords('2,026'), 'ពីរពាន់ម្ភៃប្រាំមួយ');
  assert.equal(integerToKhmerWords('1000000'), 'មួយលាន');
  assert.equal(integerToKhmerWords('1000000000'), '1000000000');
});

test('expandKhmerNumbers expands Khmer-context currencies, percentages, and digits without corrupting Latin text', () => {
  assert.equal(expandKhmerNumbers('Save $25 and 50% today on VoxCPM2.'), 'Save $25 and 50% today on VoxCPM2.');
  assert.equal(expandKhmerNumbers('តម្លៃ $25 ឬ 1,500៛ បញ្ចុះ 50%'), 'តម្លៃ ម្ភៃប្រាំដុល្លារ ឬ មួយពាន់ប្រាំរយរៀល បញ្ចុះ ហាសិបភាគរយ');
  assert.equal(expandKhmerNumbers('ខ្ញុំអាយុ ២៥ ឆ្នាំ ប្រើ VoxCPM2'), 'ខ្ញុំអាយុ ម្ភៃប្រាំ ឆ្នាំ ប្រើ VoxCPM2');
  assert.equal(hasConvertibleKhmerNumbers('តម្លៃ ៥០០៛'), true);
  assert.equal(hasConvertibleKhmerNumbers('សួស្តីអ្នកទាំងអស់គ្នា'), false);
});
