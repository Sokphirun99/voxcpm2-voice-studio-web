import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageError } from '../../src/domain/errors.js';
import {
  SAVED_VOICES_STORAGE_KEY,
  createLocalVoiceRepository,
} from '../../src/data/localVoiceRepository.js';

function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

function createSpyLogger() {
  const errors = [];
  return {
    errors,
    debug() {},
    error: (location, error, context) => errors.push({ location, error, context }),
  };
}

test('loadSavedEntries recovers cleanly and logs when storage contains malformed JSON', () => {
  const logger = createSpyLogger();
  const storage = createMemoryStorage({ [SAVED_VOICES_STORAGE_KEY]: '{not-json' });
  const repository = createLocalVoiceRepository({ storage, logger });

  const result = repository.loadSavedEntries();
  assert.deepEqual(result.entries, []);
  assert.match(result.warning, /could not be read/i);
  assert.equal(logger.errors.length, 1);
});

test('saveEntries persists normalized custom characters and throws StorageError if storage quota fails', () => {
  const storage = createMemoryStorage();
  const repository = createLocalVoiceRepository({ storage });

  const entry = {
    id: 'char-saved-1',
    name: 'Pisey',
    role: 'Custom character',
    category: 'female',
    voiceScope: 'single',
    traits: '1 person · Saved character',
    description: 'bright clear speaker',
    isBuiltIn: false,
  };

  repository.saveEntries([entry]);
  assert.deepEqual(repository.loadSavedEntries().entries, [entry]);

  const throwingRepository = createLocalVoiceRepository({
    storage: {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    },
  });
  assert.throws(() => throwingRepository.saveEntries([entry]), StorageError);
});
