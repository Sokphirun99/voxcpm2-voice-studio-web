import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_STEPS,
  MAX_DESCRIPTION_LENGTH,
  MAX_SCRIPT_LENGTH,
  MAX_STEPS,
  MIN_STEPS,
  STYLE_MODES,
  buildCharacterInstruction,
  countGraphemes,
  inferScriptStyleInstruction,
  resolveStyleInstruction,
  stripParentheses,
  validateGenerationInput,
} from '../../src/domain/presets.js';
import { BUILT_IN_VOICES } from '../../src/domain/voiceLibrary.js';
import { ValidationError } from '../../src/domain/errors.js';

const SAMPLE_CHARACTER = BUILT_IN_VOICES[0];

test('stripParentheses removes half-width and full-width parentheses and normalizes spacing', () => {
  assert.equal(stripParentheses('  (warm) voice （gentle） tone  '), 'warm voice gentle tone');
  assert.equal(stripParentheses('((()))（）'), '');
  assert.equal(stripParentheses(null), '');
});

test('countGraphemes counts Khmer combining clusters as single visual characters', () => {
  const word = 'សួស្តី';
  assert.equal(countGraphemes(word), 2);
  assert.ok(word.length > 2);
  assert.equal(countGraphemes(''), 0);
});

test('buildCharacterInstruction uses character description when unpinned and omits it when cloning locked audio', () => {
  const initial = buildCharacterInstruction({ character: SAMPLE_CHARACTER, hasLockedAudio: false });
  assert.equal(initial, SAMPLE_CHARACTER.description);

  assert.equal(buildCharacterInstruction({ character: SAMPLE_CHARACTER, hasLockedAudio: true }), '');
  assert.equal(buildCharacterInstruction({ character: SAMPLE_CHARACTER, hasLockedAudio: true, usePromptText: true }), '');

  assert.throws(
    () => buildCharacterInstruction({ character: { id: 'c1', description: ' ( ) ' }, hasLockedAudio: false }),
    err => err instanceof ValidationError && err.field === 'character' && err.code === 'MISSING_CHARACTER_VOICE'
  );
  assert.throws(
    () => buildCharacterInstruction({ character: { id: 'c1', description: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1) }, hasLockedAudio: false }),
    err => err instanceof ValidationError && err.field === 'description'
  );
});

test('validateGenerationInput enforces script, character, guidance, steps, and seed bounds', () => {
  assert.throws(
    () => validateGenerationInput({ script: '   ', character: SAMPLE_CHARACTER, guidance: 2, steps: 10, seed: '' }),
    err => err instanceof ValidationError && err.field === 'script' && err.code === 'EMPTY_SCRIPT'
  );
  assert.throws(
    () => validateGenerationInput({ script: 'a'.repeat(MAX_SCRIPT_LENGTH + 1), character: SAMPLE_CHARACTER, guidance: 2, steps: 10, seed: '' }),
    err => err instanceof ValidationError && err.field === 'script' && err.code === 'SCRIPT_TOO_LONG'
  );
  assert.throws(
    () => validateGenerationInput({ script: 'សួស្តី', character: null, guidance: 2, steps: 10, seed: '' }),
    err => err instanceof ValidationError && err.field === 'character' && err.code === 'MISSING_CHARACTER'
  );
  assert.throws(
    () => validateGenerationInput({ script: 'សួស្តី', character: SAMPLE_CHARACTER, guidance: 2, steps: MIN_STEPS - 1, seed: '' }),
    err => err instanceof ValidationError && err.field === 'steps'
  );
  assert.throws(
    () => validateGenerationInput({ script: 'សួស្តី', character: SAMPLE_CHARACTER, guidance: 2, steps: MAX_STEPS + 1, seed: '' }),
    err => err instanceof ValidationError && err.field === 'steps'
  );

  const valid = validateGenerationInput({
    script: '  សួស្តីអ្នកទាំងអស់គ្នា  ',
    character: SAMPLE_CHARACTER,
    guidance: '2.5',
    steps: 6,
    seed: '1234',
  });
  assert.deepEqual(valid, {
    text: 'សួស្តីអ្នកទាំងអស់គ្នា',
    instruction: SAMPLE_CHARACTER.description,
    usePromptText: false,
    promptText: '',
    guidance: 2.5,
    steps: 6,
    seed: 1234,
  });

  const defaulted = validateGenerationInput({ script: 'សួស្តី', character: SAMPLE_CHARACTER, guidance: 2, seed: '' }, () => 777);
  assert.equal(defaulted.steps, DEFAULT_STEPS);
  assert.equal(defaulted.seed, 777);

  const blankSeed = validateGenerationInput({ script: 'សួស្តី', character: SAMPLE_CHARACTER, guidance: 2, seed: '   ' }, () => 888);
  assert.equal(blankSeed.seed, 888);
});

test('validateGenerationInput supports Exact transcript match for uploaded samples and requires promptText', () => {
  assert.throws(
    () => validateGenerationInput({
      script: 'ខ្ញុំអាយុ ២៥ ឆ្នាំ',
      character: SAMPLE_CHARACTER,
      guidance: 2,
      steps: 10,
      seed: '',
      hasLockedAudio: true,
      exactClone: true,
      promptText: '   ',
    }),
    err => err instanceof ValidationError && err.field === 'promptText' && err.code === 'EMPTY_PROMPT_TEXT'
  );

  const exact = validateGenerationInput({
    script: 'ខ្ញុំអាយុ ២៥ ឆ្នាំ',
    character: SAMPLE_CHARACTER,
    guidance: 2,
    steps: 8,
    seed: '99',
    hasLockedAudio: true,
    exactClone: true,
    promptText: '  សួស្តីអ្នកទាំងអស់គ្នា  ',
  });
  assert.equal(exact.usePromptText, true);
  assert.equal(exact.promptText, 'សួស្តីអ្នកទាំងអស់គ្នា');
  assert.equal(exact.instruction, '');
});

test('inferScriptStyleInstruction, resolveStyleInstruction, and autoFormatKhmer guide locked voices from writing format', () => {
  assert.equal(inferScriptStyleInstruction('សួស្តីអ្នកទាំងអស់គ្នា'), '');
  assert.match(inferScriptStyleInstruction('តើអ្នកសុខសប្បាយជាទេ?'), /inquisitive tone/i);
  assert.match(inferScriptStyleInstruction('អបអរសាទរខ្លាំងណាស់!'), /energetic upbeat/i);
  assert.match(inferScriptStyleInstruction('ចំណុចសំខាន់៖\n1. គុណភាព'), /structured presenter cadence/i);

  assert.equal(resolveStyleInstruction({ styleMode: STYLE_MODES.NATURAL, script: 'សួស្តី!' }), '');
  assert.match(resolveStyleInstruction({ styleMode: STYLE_MODES.FORMAL, script: 'សួស្តី' }), /news broadcast/i);
  assert.equal(resolveStyleInstruction({ styleMode: STYLE_MODES.CUSTOM, customStyle: ' (Calm) radio host ' }), 'Calm radio host');

  const lockedStyled = validateGenerationInput({
    script: 'តម្លៃ $25 សម្រាប់ថ្ងៃនេះ!',
    character: SAMPLE_CHARACTER,
    guidance: 2,
    steps: 10,
    seed: '10',
    hasLockedAudio: true,
    exactClone: false,
    autoFormatKhmer: true,
    styleMode: STYLE_MODES.AUTO,
  });
  assert.equal(lockedStyled.text, 'តម្លៃ ម្ភៃប្រាំដុល្លារ សម្រាប់ថ្ងៃនេះ!');
  assert.match(lockedStyled.instruction, /energetic upbeat/i);

  const exactOverridesStyle = validateGenerationInput({
    script: 'អបអរសាទរ!',
    character: SAMPLE_CHARACTER,
    guidance: 2,
    steps: 10,
    seed: '10',
    hasLockedAudio: true,
    exactClone: true,
    promptText: 'សួស្តី',
    styleMode: STYLE_MODES.FORMAL,
  });
  assert.equal(exactOverridesStyle.instruction, '');
});
