/**
 * @fileoverview Browser Storage repository adapter implementing the domain VoiceRepositoryPort.
 */

import { StorageError } from '../domain/errors.js';
import { normalizeSavedEntry } from '../domain/voiceLibrary.js';

export const SAVED_VOICES_STORAGE_KEY = 'voxcpm.savedVoices.v1';

/**
 * Creates a VoiceRepositoryPort backed by Web Storage (`localStorage`).
 * Inputs: `{ storage, logger }`.
 * Outputs: `{ loadSavedEntries(), saveEntries(entries) }`.
 * Side effects: reads and writes `SAVED_VOICES_STORAGE_KEY` in `storage`.
 * Failure modes: `loadSavedEntries` recovers gracefully with a warning on corrupt data; `saveEntries` throws `StorageError`.
 * @param {{ storage?: Storage, logger?: import('../domain/ports.js').LoggerPort }} [deps] - Injected dependencies.
 * @returns {import('../domain/ports.js').VoiceRepositoryPort} Repository adapter.
 */
export function createLocalVoiceRepository({ storage = globalThis.localStorage, logger } = {}) {
  return {
    loadSavedEntries() {
      if (!storage) {
        return { entries: [], warning: 'Browser storage is unavailable in this context.' };
      }
      try {
        const raw = storage.getItem(SAVED_VOICES_STORAGE_KEY);
        if (!raw) return { entries: [], warning: null };
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new StorageError('Saved voice catalog is not an array.');
        return { entries: parsed.map(normalizeSavedEntry).filter(Boolean), warning: null };
      } catch (error) {
        logger?.error('localVoiceRepository.loadSavedEntries', error, { key: SAVED_VOICES_STORAGE_KEY });
        return { entries: [], warning: 'Saved voices could not be read from browser storage.' };
      }
    },

    saveEntries(entries) {
      if (!storage) throw new StorageError('Browser storage is unavailable.');
      try {
        storage.setItem(SAVED_VOICES_STORAGE_KEY, JSON.stringify(entries));
      } catch (error) {
        logger?.error('localVoiceRepository.saveEntries', error, { count: entries.length });
        throw new StorageError('Could not save voices to browser storage.', error);
      }
    },
  };
}
