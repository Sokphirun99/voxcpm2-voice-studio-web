/**
 * @fileoverview Browser IndexedDB adapter implementing VoiceAnchorRepositoryPort for persistent character audio anchors.
 */

import { StorageError } from '../domain/errors.js';

const DB_NAME = 'voxcpm-voice-studio';
const DB_VERSION = 1;
const STORE_NAME = 'voiceAnchors';

/**
 * Opens or upgrades the IndexedDB database storing persistent character reference clips.
 * @param {IDBFactory} idb - Browser IndexedDB factory.
 * @returns {Promise<IDBDatabase>} Open IDBDatabase handle.
 */
function openAnchorDatabase(idb) {
  return new Promise((resolve, reject) => {
    const request = idb.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'characterId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open IndexedDB.'));
  });
}

/**
 * Wraps an IDBRequest inside a Promise.
 * @param {IDBRequest} request - IndexedDB request.
 * @returns {Promise<unknown>} Request result.
 */
function awaitIdbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
  });
}

/**
 * Awaits transaction commit so QuotaExceededError or aborts at commit time surface reliably.
 * @param {IDBTransaction} tx - Active IndexedDB transaction.
 * @returns {Promise<void>} Resolves on commit.
 */
function awaitTransaction(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed.'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted.'));
  });
}

/**
 * Executes a callback with an opened IDBDatabase and ensures the connection always closes.
 * @param {IDBFactory} idb - Browser IndexedDB factory.
 * @param {(db: IDBDatabase) => Promise<unknown>} task - Async DB operation.
 * @returns {Promise<unknown>} Task return value.
 */
async function withAnchorDb(idb, task) {
  const db = await openAnchorDatabase(idb);
  try {
    return await task(db);
  } finally {
    db.close();
  }
}

/**
 * Indexes an array of stored anchor records into a `{ [characterId]: record }` lookup map.
 * @param {Array<object>} records - Stored anchor rows.
 * @returns {Record<string, object>} Character anchor dictionary.
 */
function indexAnchors(records) {
  const map = {};
  for (const item of records) {
    if (item?.characterId && item?.blob) map[item.characterId] = item;
  }
  return map;
}

/**
 * Creates a memory fallback store when IndexedDB is unavailable (e.g. private browsing or SSR tests).
 * @returns {import('../domain/ports.js').VoiceAnchorRepositoryPort} In-memory fallback repository.
 */
function createMemoryAnchorFallback() {
  const memory = new Map();
  return {
    loadAllAnchors: async () => Object.fromEntries(memory.entries()),
    saveAnchor: async (characterId, anchor) => { memory.set(characterId, anchor); },
    deleteAnchor: async characterId => { memory.delete(characterId); },
  };
}

/**
 * Creates an IndexedDB VoiceAnchorRepositoryPort storing binary reference clips per character.
 * Inputs: optional `{ indexedDB, logger }`.
 * Outputs: `{ loadAllAnchors(), saveAnchor(id, anchor), deleteAnchor(id) }`.
 * Side effects: reads and writes binary WAV Blobs in browser IndexedDB.
 * Failure modes: `loadAllAnchors` logs and falls back cleanly; `saveAnchor`/`deleteAnchor` throw `StorageError`.
 * @param {{ indexedDB?: IDBFactory, logger?: import('../domain/ports.js').LoggerPort }} [deps] - Injected IndexedDB & logger.
 * @returns {import('../domain/ports.js').VoiceAnchorRepositoryPort} Persistent anchor repository.
 */
export function createIndexedDbVoiceAnchorRepository({ indexedDB = globalThis.indexedDB, logger } = {}) {
  if (!indexedDB) return createMemoryAnchorFallback();

  return {
    async loadAllAnchors() {
      try {
        const rows = await withAnchorDb(indexedDB, db => awaitIdbRequest(db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll()));
        return Array.isArray(rows) ? indexAnchors(rows) : {};
      } catch (error) {
        logger?.error('indexedDbAudioRepository.loadAllAnchors', error);
        return {};
      }
    },
    async saveAnchor(characterId, anchor) {
      try {
        await withAnchorDb(indexedDB, async db => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).put({ ...anchor, characterId });
          await awaitTransaction(tx);
        });
      } catch (error) {
        logger?.error('indexedDbAudioRepository.saveAnchor', error, { characterId });
        throw new StorageError('Could not pin the voice clip to browser storage.', error);
      }
    },
    async deleteAnchor(characterId) {
      try {
        await withAnchorDb(indexedDB, async db => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).delete(characterId);
          await awaitTransaction(tx);
        });
      } catch (error) {
        logger?.error('indexedDbAudioRepository.deleteAnchor', error, { characterId });
        throw new StorageError('Could not remove the pinned voice clip from storage.', error);
      }
    },
  };
}
