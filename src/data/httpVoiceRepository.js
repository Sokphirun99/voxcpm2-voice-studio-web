/**
 * @fileoverview HTTP repository client syncing custom Voice Studio characters with Docker backend storage.
 */

import { normalizeSavedEntry } from '../domain/voiceLibrary.js';
import { StorageUnavailableError, buildStorageApiUrl, requestStorageJson } from './httpStorageClient.js';

const CHARACTER_PAGE_LIMIT = 200;

/**
 * Merges remote backend characters with local entries, uploading any local-only custom entries once.
 * @param {{ remoteEntries: Array<object>, localEntries: Array<object>, upsertRemote: (entry: object) => Promise<object>, logger?: object }} params - Sync inputs.
 * @returns {Promise<Array<object>>} Merged active character entries.
 */
async function mergeAndMigrateCharacters({ remoteEntries, localEntries, upsertRemote, logger }) {
  const remoteIds = new Set(remoteEntries.map(entry => entry.id));
  const migrated = [];
  for (const localEntry of localEntries) {
    if (remoteIds.has(localEntry.id)) continue;
    try {
      const saved = await upsertRemote(localEntry);
      migrated.push(saved || localEntry);
    } catch (error) {
      logger?.error('httpVoiceRepository.migrateLocalCharacter', error, { id: localEntry.id });
    }
  }
  return [...migrated, ...remoteEntries];
}

/**
 * Creates a remote custom-character sync adapter backed by `/api/v1/characters`.
 * Inputs: optional `{ baseUrl, fetchImpl, logger }`.
 * Outputs: `{ loadRemoteEntries(), upsertRemoteEntry(entry), deleteRemoteEntry(id), syncWithLocal(localEntries) }`.
 * Side effects: performs HTTP calls against `/api/v1/characters`.
 * Failure modes: throws `StorageError` or `StorageUnavailableError` on transport/API failures.
 * @param {{ baseUrl?: string, fetchImpl?: typeof fetch, logger?: import('../domain/ports.js').LoggerPort }} [deps] - Adapter deps.
 * @returns {object} Remote character storage adapter.
 */
export function createHttpVoiceRepository({ baseUrl = '/api/v1', fetchImpl = globalThis.fetch, logger } = {}) {
  async function loadRemoteEntries() {
    const items = [];
    let offset = 0;
    while (true) {
      const url = buildStorageApiUrl(baseUrl, `/characters?limit=${CHARACTER_PAGE_LIMIT}&offset=${offset}`);
      const { data, meta } = await requestStorageJson({ fetchImpl, url, unavailableOn404: true });
      const batch = Array.isArray(data?.items) ? data.items.map(normalizeSavedEntry).filter(Boolean) : [];
      items.push(...batch);
      if (!meta?.hasMore || batch.length === 0) break;
      offset += batch.length;
    }
    return items;
  }

  async function upsertRemoteEntry(entry) {
    const url = buildStorageApiUrl(baseUrl, `/characters/${encodeURIComponent(entry.id)}`);
    const { data } = await requestStorageJson({
      fetchImpl,
      url,
      options: { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) },
    });
    return normalizeSavedEntry(data?.character) || entry;
  }

  async function deleteRemoteEntry(id) {
    const url = buildStorageApiUrl(baseUrl, `/characters/${encodeURIComponent(id)}`);
    await requestStorageJson({ fetchImpl, url, options: { method: 'DELETE' } });
  }

  async function fetchStats() {
    const url = buildStorageApiUrl(baseUrl, '/stats');
    try {
      const { data } = await requestStorageJson({ fetchImpl, url, unavailableOn404: true });
      return data || null;
    } catch (error) {
      if (!(error instanceof StorageUnavailableError)) logger?.debug?.('httpVoiceRepository.fetchStats', error?.message);
      return null;
    }
  }

  return {
    loadRemoteEntries,
    upsertRemoteEntry,
    deleteRemoteEntry,
    fetchStats,
    async syncWithLocal(localEntries) {
      try {
        const remoteEntries = await loadRemoteEntries();
        return await mergeAndMigrateCharacters({ remoteEntries, localEntries, upsertRemote: upsertRemoteEntry, logger });
      } catch (error) {
        if (error instanceof StorageUnavailableError) return null;
        throw error;
      }
    },
  };
}
