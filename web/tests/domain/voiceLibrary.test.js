import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILT_IN_VOICES,
  DEFAULT_CHARACTER_ID,
  DEFAULT_CLONED_DESCRIPTION,
  MAX_VOICE_NAME_LENGTH,
  createSavedVoiceEntry,
  filterLibraryVoices,
  findCharacterById,
  formatCharacterOptionLabel,
  groupCharactersByCategory,
  normalizeSavedEntry,
} from '../../src/domain/voiceLibrary.js';
import { ValidationError } from '../../src/domain/errors.js';

test('BUILT_IN_VOICES defines distinct single-person characters with unique IDs', () => {
  const ids = new Set(BUILT_IN_VOICES.map(item => item.id));
  assert.equal(ids.size, BUILT_IN_VOICES.length);
  assert.ok(BUILT_IN_VOICES.every(item => item.voiceScope === 'single' && item.id.startsWith('char-') && item.description));
  assert.equal(DEFAULT_CHARACTER_ID, BUILT_IN_VOICES[0].id);
});

test('normalizeSavedEntry validates shape, strips parentheses, and migrates legacy delivery entries cleanly', () => {
  assert.equal(normalizeSavedEntry(null), null);
  assert.equal(normalizeSavedEntry({ id: 'x', name: 'No desc', description: '()' }), null);

  const normalized = normalizeSavedEntry({
    id: 'char-custom-1',
    name: '  Khmer Host  ',
    category: 'invalid-category',
    delivery: 'newscast',
    description: '  (warm) gentle voice  ',
  });
  assert.deepEqual(normalized, {
    id: 'char-custom-1',
    name: 'Khmer Host',
    role: 'Custom character',
    category: 'female',
    voiceScope: 'single',
    traits: '1 person · Saved character',
    description: 'warm gentle voice',
    isBuiltIn: false,
  });

  const legacyPrompt = normalizeSavedEntry({ id: 'legacy-1', name: 'Old Voice', prompt: '(calm) steady speaker' });
  assert.equal(legacyPrompt?.description, 'calm steady speaker');
});

test('createSavedVoiceEntry validates names/descriptions and defaults description when a voice sample is attached', () => {
  assert.throws(() => createSavedVoiceEntry({ name: '   ', description: 'Warm voice' }, 'id-1'), ValidationError);
  assert.throws(() => createSavedVoiceEntry({ name: 'Test', description: '()' }, 'id-2'), ValidationError);
  assert.throws(
    () => createSavedVoiceEntry({ name: 'x'.repeat(MAX_VOICE_NAME_LENGTH + 1), description: 'Warm voice' }, 'id-3'),
    err => err instanceof ValidationError && err.field === 'voiceName' && err.code === 'VOICE_NAME_TOO_LONG'
  );

  const cloned = createSavedVoiceEntry({ name: 'Pisey', category: 'female', description: '', hasVoiceClip: true }, 'char-pisey');
  assert.equal(cloned.id, 'char-pisey');
  assert.equal(cloned.description, DEFAULT_CLONED_DESCRIPTION);
  assert.equal(cloned.voiceScope, 'single');
});

test('grouping, option formatting, lookup fallback, and library search work cleanly', () => {
  const custom = createSavedVoiceEntry({ name: 'Pisey', category: 'female', description: 'Soft Khmer narrator' }, 'char-pisey');
  const combined = [custom, ...BUILT_IN_VOICES];

  const groups = groupCharactersByCategory(combined);
  assert.equal(groups[0][0], 'Saved characters');
  assert.equal(groups[0][1][0].id, 'char-pisey');
  assert.equal(formatCharacterOptionLabel(BUILT_IN_VOICES[0]), 'Nisa — Warm & natural');
  assert.equal(formatCharacterOptionLabel(BUILT_IN_VOICES[0], { isLocked: true }), 'Nisa — Warm & natural (Locked)');
  assert.equal(findCharacterById(combined, 'missing-id').id, DEFAULT_CHARACTER_ID);

  assert.equal(filterLibraryVoices(combined, { source: 'saved' }).length, 1);
  assert.equal(filterLibraryVoices(combined, { source: 'builtin' }).length, BUILT_IN_VOICES.length);
  const byId = filterLibraryVoices(combined, { search: 'char-sovath' });
  assert.equal(byId.length, 1);
  assert.equal(byId[0].name, 'Sovath');
});
