/**
 * @fileoverview Docker backend HTTP repository implementing VoiceAnchorRepositoryPort with IndexedDB migration/cache.
 */

import { StorageError } from '../domain/errors.js';
import { ensureAudioWavBlob } from '../domain/wavCodec.js';
import { StorageUnavailableError, buildStorageApiUrl, requestStorageJson } from './httpStorageClient.js';

const ANCHOR_PAGE_LIMIT = 200;
const MIGRATED_STORAGE_KEY = 'voxcpm.dockerAnchorsMigrated.v2';
const DEFAULT_AUDIO_MIME = 'audio/wav';
const OCTET_STREAM_MIME = 'application/octet-stream';

/**
 * Strips MIME parameters and treats generic binary octet-stream as unspecified so audio defaults apply.
 * @param {unknown} rawMime - Candidate MIME type string.
 * @returns {string} Specific lowercase MIME type or empty string.
 */
function normalizeAudioMime(rawMime) {
  const cleaned = typeof rawMime === 'string' ? rawMime.split(';')[0].trim().toLowerCase() : '';
  if (!cleaned || cleaned === OCTET_STREAM_MIME) return '';
  return cleaned;
}

/**
 * Checks whether one-time migration from browser IndexedDB to Docker storage already completed.
 * @param {Storage|null|undefined} storage - Web Storage instance.
 * @param {object} [logger] - Application logger.
 * @returns {boolean} True if already migrated.
 */
function hasCompletedAnchorMigration(storage, logger) {
  try {
    return storage?.getItem(MIGRATED_STORAGE_KEY) === '1';
  } catch (error) {
    logger?.debug?.('httpAudioRepository.readMigrationFlag', error?.message || 'Storage read skipped');
    return false;
  }
}

/**
 * Records that pre-existing IndexedDB anchors have been checked/migrated to Docker storage.
 * @param {Storage|null|undefined} storage - Web Storage instance.
 * @param {object} [logger] - Application logger.
 */
function markAnchorMigrationDone(storage, logger) {
  try {
    storage?.setItem(MIGRATED_STORAGE_KEY, '1');
  } catch (error) {
    logger?.debug?.('httpAudioRepository.writeMigrationFlag', error?.message || 'Storage write skipped');
  }
}

/**
 * Fetches all active anchor metadata rows across paginated `/api/v1/anchors` responses.
 * @param {{ fetchImpl: typeof fetch, baseUrl: string }} deps - HTTP deps.
 * @returns {Promise<Array<object>>} Active remote anchor metadata records.
 */
async function fetchAllRemoteAnchorMetadata({ fetchImpl, baseUrl }) {
  const items = [];
  let offset = 0;
  while (true) {
    const url = buildStorageApiUrl(baseUrl, `/anchors?limit=${ANCHOR_PAGE_LIMIT}&offset=${offset}`);
    const { data, meta } = await requestStorageJson({ fetchImpl, url, unavailableOn404: true });
    const batch = Array.isArray(data?.items) ? data.items : [];
    items.push(...batch);
    if (!meta?.hasMore || batch.length === 0) break;
    offset += batch.length;
  }
  return items;
}

/**
 * Downloads one anchor's binary audio clip and attaches it as a normalized Blob.
 * @param {{ fetchImpl: typeof fetch, baseUrl: string, item: object }} params - Download params.
 * @returns {Promise<object>} Hydrated anchor record with `blob`.
 */
async function downloadRemoteAnchorRecord({ fetchImpl, baseUrl, item }) {
  const audioPath = item.audioUrl || buildStorageApiUrl(baseUrl, `/anchors/${encodeURIComponent(item.characterId)}/audio`);
  const response = await fetchImpl(audioPath);
  if (!response.ok) throw new StorageError(`Could not download voice sample for ${item.characterId} (${response.status}).`);
  const rawBlob = await response.blob();
  const normalizedMime = normalizeAudioMime(item.mimeType) || DEFAULT_AUDIO_MIME;
  const blob = normalizedMime === DEFAULT_AUDIO_MIME ? ensureAudioWavBlob(rawBlob) : new Blob([rawBlob], { type: normalizedMime });
  return { ...item, mimeType: normalizedMime, blob, updatedAt: Date.parse(item.updated_at || '') || Date.now() };
}

/**
 * Uploads one anchor's binary audio and metadata to `PUT /api/v1/anchors/:characterId`.
 * @param {{ fetchImpl: typeof fetch, baseUrl: string, characterId: string, anchor: object }} params - Upload params.
 * @returns {Promise<object>} Persisted remote metadata.
 */
async function uploadRemoteAnchor({ fetchImpl, baseUrl, characterId, anchor }) {
  const formData = new FormData();
  const fileName = anchor.fileName || `character-${characterId}.wav`;
  const mimeType = normalizeAudioMime(anchor.mimeType) || normalizeAudioMime(anchor.blob?.type) || DEFAULT_AUDIO_MIME;
  const audioFile = new File([anchor.blob], fileName, { type: mimeType });
  formData.set('metadata', JSON.stringify({
    label: anchor.label || characterId,
    source: anchor.source || 'generated',
    takeId: anchor.takeId ?? null,
    fileName,
    promptText: anchor.promptText || '',
    exactClone: Boolean(anchor.exactClone),
  }));
  formData.set('audio', audioFile);
  const url = buildStorageApiUrl(baseUrl, `/anchors/${encodeURIComponent(characterId)}`);
  const { data } = await requestStorageJson({ fetchImpl, url, options: { method: 'PUT', body: formData } });
  return data?.anchor;
}

/**
 * Attempts to upload one local IndexedDB anchor and updates `remoteMap` on success.
 * @param {{ characterId: string, localAnchor: object, remoteMap: Record<string, object>, uploadFn: (id: string, rec: object) => Promise<object>, logger?: object }} params - Migration inputs.
 * @returns {Promise<boolean>} True if uploaded or skipped cleanly, false if upload failed.
 */
async function tryMigrateLocalAnchor({ characterId, localAnchor, remoteMap, uploadFn, logger }) {
  try {
    const uploaded = await uploadFn(characterId, localAnchor);
    const mimeType = normalizeAudioMime(localAnchor.mimeType) || normalizeAudioMime(localAnchor.blob?.type) || DEFAULT_AUDIO_MIME;
    const blob = mimeType === DEFAULT_AUDIO_MIME ? ensureAudioWavBlob(localAnchor.blob) : localAnchor.blob;
    remoteMap[characterId] = { ...localAnchor, ...(uploaded || {}), mimeType: uploaded?.mimeType || mimeType, blob };
    return true;
  } catch (error) {
    logger?.error('httpAudioRepository.migrateLocalAnchor', error, { characterId });
    return false;
  }
}

/**
 * Migrates legacy IndexedDB anchors on first run and prunes stale local cache entries reset remotely.
 * @param {{ remoteMap: Record<string, object>, localMap: Record<string, object>, uploadFn: (id: string, rec: object) => Promise<object>, localRepository?: object, storage?: Storage, logger?: object }} params - Sync inputs.
 * @returns {Promise<void>} Resolves once reconciliation completes.
 */
async function reconcileLocalAndRemoteAnchors({ remoteMap, localMap, uploadFn, localRepository, storage, logger }) {
  const alreadyMigrated = hasCompletedAnchorMigration(storage, logger);
  let hasFailures = false;
  for (const [characterId, localAnchor] of Object.entries(localMap || {})) {
    if (remoteMap[characterId]) continue;
    if (!alreadyMigrated && localAnchor?.blob instanceof Blob) {
      const migrated = await tryMigrateLocalAnchor({ characterId, localAnchor, remoteMap, uploadFn, logger });
      if (!migrated) hasFailures = true;
      continue;
    }
    if (alreadyMigrated && localRepository) {
      await localRepository.deleteAnchor(characterId).catch(err => logger?.error('httpAudioRepository.pruneStaleLocal', err, { characterId }));
    }
  }
  if (!hasFailures) markAnchorMigrationDone(storage, logger);
}

/**
 * Hydrates remote anchors, migrates legacy IndexedDB locks once if missing remotely, and reconciles local cache.
 * @param {{ baseUrl: string, fetchImpl: typeof fetch, localRepository?: object, storage?: Storage, logger?: object }} deps - Repo dependencies.
 * @returns {Promise<Record<string, object>>} Map of characterId -> anchor record with `blob`.
 */
async function loadAndSyncAnchors({ baseUrl, fetchImpl, localRepository, storage, logger }) {
  const localMap = localRepository ? await localRepository.loadAllAnchors() : {};
  let remoteMeta;
  try {
    remoteMeta = await fetchAllRemoteAnchorMetadata({ fetchImpl, baseUrl });
  } catch (error) {
    if (error instanceof StorageUnavailableError) {
      logger?.warn?.('httpAudioRepository.loadAllAnchors', error.message);
      return localMap;
    }
    throw error;
  }
  const hydrated = await Promise.all(remoteMeta.map(item => downloadRemoteAnchorRecord({ fetchImpl, baseUrl, item })));
  const remoteMap = Object.fromEntries(hydrated.map(rec => [rec.characterId, rec]));
  await reconcileLocalAndRemoteAnchors({
    remoteMap, localMap, localRepository, storage, logger,
    uploadFn: (id, rec) => uploadRemoteAnchor({ fetchImpl, baseUrl, characterId: id, anchor: rec }),
  });
  return remoteMap;
}

/**
 * Creates a Docker backend VoiceAnchorRepositoryPort with automatic one-time IndexedDB migration.
 * Inputs: `{ baseUrl, localRepository, fetchImpl, storage, logger }`.
 * Outputs: VoiceAnchorRepositoryPort `{ loadAllAnchors, saveAnchor, deleteAnchor }`.
 * Side effects: persists WAV clips in Docker storage via `/api/v1/anchors` and reconciles `localRepository`.
 * Failure modes: throws `StorageError` on backend persistence errors; falls back on read if backend is unreachable.
 * @param {{ baseUrl?: string, localRepository?: import('../domain/ports.js').VoiceAnchorRepositoryPort, fetchImpl?: typeof fetch, storage?: Storage, logger?: import('../domain/ports.js').LoggerPort }} [deps] - Adapter deps.
 * @returns {import('../domain/ports.js').VoiceAnchorRepositoryPort} Persistent anchor repository.
 */
export function createDockerVoiceAnchorRepository({ baseUrl = '/api/v1', localRepository, fetchImpl = globalThis.fetch, storage = globalThis.localStorage, logger } = {}) {
  return {
    loadAllAnchors: () => loadAndSyncAnchors({ baseUrl, fetchImpl, localRepository, storage, logger }),
    async saveAnchor(characterId, anchor) {
      await uploadRemoteAnchor({ fetchImpl, baseUrl, characterId, anchor });
      if (localRepository) await localRepository.saveAnchor(characterId, anchor).catch(err => logger?.error('httpAudioRepository.localCacheSave', err, { characterId }));
    },
    async deleteAnchor(characterId) {
      const url = buildStorageApiUrl(baseUrl, `/anchors/${encodeURIComponent(characterId)}`);
      await requestStorageJson({ fetchImpl, url, options: { method: 'DELETE' } });
      if (localRepository) await localRepository.deleteAnchor(characterId).catch(err => logger?.error('httpAudioRepository.localCacheDelete', err, { characterId }));
    },
  };
}
