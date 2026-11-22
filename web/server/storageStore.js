/**
 * @fileoverview Atomic persistent catalog and binary audio storage backed by a Docker volume directory.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ALLOWED_AUDIO_MIME_TYPES,
  MAX_REFERENCE_AUDIO_BYTES,
  hasValidAudioMagicBytes,
} from '../src/domain/audioValidation.js';
import { StorageError, ValidationError } from '../src/domain/errors.js';
import { normalizeGlossaryRules } from '../src/domain/pronunciationRules.js';
import { normalizeSavedEntry } from '../src/domain/voiceLibrary.js';
import { createProjectStore, assertSafeProjectId, resolveSafeProjectPath } from './projectStore.js';
import { createAssetStore } from './assetStore.js';
import {
  runStorageMigrations,
  verifyStorageIntegrity,
  detectStorageMigrationsNeeded,
  createStorageBackup,
  rollbackStorageBackup,
} from './storageMigration.js';

export { assertSafeProjectId, resolveSafeProjectPath } from './projectStore.js';
export {
  runStorageMigrations,
  verifyStorageIntegrity,
  detectStorageMigrationsNeeded,
  createStorageBackup,
  rollbackStorageBackup,
} from './storageMigration.js';


const CATALOG_VERSION = 1;
const GLOSSARY_VERSION = 1;
const GLOSSARY_FILE_NAME = 'glossary.json';
const CATALOG_FILE_NAME = 'catalog.json';
const ANCHORS_DIR_NAME = 'anchors';
const CACHE_DIR_NAME = 'cache';
const CACHE_INDEX_FILE_NAME = 'cache-index.json';
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const CACHE_KEY_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 200;
const MAX_CACHE_ENTRIES = 100;
const DEFAULT_AUDIO_MIME = 'audio/wav';
const OCTET_STREAM_MIME = 'application/octet-stream';
const PROJECTS_DIR_NAME = 'projects';
const ASSETS_DIR_NAME = 'assets';


/**
 * Validates that a cache key is a 64-character lowercase SHA-256 hex digest.
 * @param {unknown} rawKey - Candidate cache key.
 * @returns {string} Normalized cache key.
 */
export function assertSafeCacheKey(rawKey) {
  const key = typeof rawKey === 'string' ? rawKey.trim().toLowerCase() : '';
  if (!CACHE_KEY_PATTERN.test(key)) {
    throw new ValidationError('Invalid synthesis cache key.', 'cacheKey', 'INVALID_CACHE_KEY');
  }
  return key;
}

/**
 * Validates that a character ID is non-empty and safe for filesystem and URL paths.
 * @param {unknown} rawId - Candidate identifier.
 * @param {string} [field='characterId'] - Error field label.
 * @returns {string} Validated identifier.
 */
export function assertSafeEntityId(rawId, field = 'characterId') {
  const id = typeof rawId === 'string' ? rawId.trim() : '';
  if (!id || !SAFE_ID_PATTERN.test(id)) {
    throw new ValidationError('Invalid character identifier format.', field, 'INVALID_ID');
  }
  return id;
}

/**
 * Normalizes pagination parameters (`limit`, `offset`) to safe bounded integers.
 * @param {{ limit?: unknown, offset?: unknown }} [query] - Query bounds.
 * @returns {{ limit: number, offset: number }} Clamped pagination bounds.
 */
function normalizePagination(query = {}) {
  const parsedLimit = Number.parseInt(String(query.limit ?? DEFAULT_PAGE_LIMIT), 10);
  const parsedOffset = Number.parseInt(String(query.offset ?? 0), 10);
  const limit = Number.isFinite(parsedLimit) ? Math.min(MAX_PAGE_LIMIT, Math.max(1, parsedLimit)) : DEFAULT_PAGE_LIMIT;
  const offset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
  return { limit, offset };
}

/**
 * Resolves a safe file path inside `anchorsDir` and guards against directory escape.
 * @param {string} anchorsDir - Base anchor directory.
 * @param {string} fileName - Candidate relative filename.
 * @returns {string} Resolved absolute path inside `anchorsDir`.
 */
function resolveSafeAnchorPath(anchorsDir, fileName) {
  const base = path.resolve(anchorsDir);
  const resolved = path.resolve(base, path.basename(fileName));
  if (!resolved.startsWith(`${base}${path.sep}`)) {
    throw new StorageError('Resolved audio path escaped storage directory.');
  }
  return resolved;
}

/**
 * Writes file contents atomically via a unique temporary sibling file and `rename`.
 * @param {string} targetPath - Destination file path.
 * @param {string|Uint8Array} contents - UTF-8 string or binary buffer.
 * @returns {Promise<void>} Resolves once atomically committed.
 */
async function writeAtomicFile(targetPath, contents) {
  const tempPath = `${targetPath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, contents);
  try {
    await rename(tempPath, targetPath);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') {
        throw new AggregateError([error, cleanupError], 'Atomic file write failed and its temporary file could not be removed.');
      }
    }
    throw error;
  }
}

/**
 * Validates audio buffer length, optional MIME type, and leading magic-byte signature.
 * @param {{ bytes: Uint8Array, mimeType?: string }} spec - Uploaded audio payload.
 * @returns {string} Normalized audio MIME type.
 */
function validateAudioBytes({ bytes, mimeType }) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new ValidationError('Select a non-empty audio file.', 'referenceAudio', 'EMPTY_AUDIO');
  }
  if (bytes.byteLength > MAX_REFERENCE_AUDIO_BYTES) {
    throw new ValidationError('Reference audio must be 20 MB or smaller.', 'referenceAudio', 'AUDIO_TOO_LARGE');
  }
  const normalizedMime = typeof mimeType === 'string' ? mimeType.split(';')[0].trim().toLowerCase() : '';
  // Legacy IndexedDB records store WAV blobs with application/octet-stream; rely on magic-byte check below.
  const effectiveMime = normalizedMime === OCTET_STREAM_MIME ? '' : normalizedMime;
  if (effectiveMime && !ALLOWED_AUDIO_MIME_TYPES.has(effectiveMime)) {
    throw new ValidationError('Unsupported audio format. Use WAV, MP3, M4A, FLAC, OGG, or WebM.', 'referenceAudio', 'UNSUPPORTED_AUDIO_TYPE');
  }
  if (!hasValidAudioMagicBytes(bytes)) {
    throw new ValidationError('The uploaded audio payload is not a valid audio format.', 'referenceAudio', 'INVALID_AUDIO_CONTENT');
  }
  return effectiveMime || DEFAULT_AUDIO_MIME;
}

/**
 * Loads `catalog.json` from disk or creates a fresh empty catalog when missing.
 * @param {string} catalogPath - Path to `catalog.json`.
 * @returns {Promise<{ version: number, characters: Record<string, object>, anchors: Record<string, object> }>} Parsed catalog.
 */
async function loadCatalog(catalogPath) {
  try {
    const raw = await readFile(catalogPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      version: parsed?.version || CATALOG_VERSION,
      characters: parsed?.characters && typeof parsed.characters === 'object' ? parsed.characters : {},
      anchors: parsed?.anchors && typeof parsed.anchors === 'object' ? parsed.anchors : {},
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: CATALOG_VERSION, characters: {}, anchors: {} };
    throw new StorageError('Could not read Voice Studio catalog from disk.', error);
  }
}

/**
 * Filters out soft-deleted rows, sorts newest first, and slices a bounded page.
 * @param {Record<string, object>} map - Entity map keyed by ID.
 * @param {{ limit?: unknown, offset?: unknown }} query - Pagination options.
 * @returns {{ items: Array<object>, total: number, limit: number, offset: number, hasMore: boolean }} Paginated slice.
 */
function paginateActiveRecords(map, query) {
  const { limit, offset } = normalizePagination(query);
  const active = Object.values(map)
    .filter(item => item && !item.deleted_at)
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  const items = active.slice(offset, offset + limit);
  return { items, total: active.length, limit, offset, hasMore: offset + items.length < active.length };
}

/**
 * Formats an anchor metadata record for JSON API responses without leaking disk file paths.
 * @param {object} record - Stored anchor metadata row.
 * @returns {object} Public anchor summary.
 */
function toPublicAnchor(record) {
  return {
    characterId: record.characterId,
    label: record.label,
    source: record.source,
    takeId: record.takeId ?? null,
    fileName: record.fileName,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    sha256: record.sha256,
    promptText: record.promptText || '',
    exactClone: Boolean(record.exactClone),
    created_at: record.created_at,
    updated_at: record.updated_at,
    audioUrl: `/api/v1/anchors/${encodeURIComponent(record.characterId)}/audio`,
  };
}

/**
 * Builds and validates a stored custom character row preserving `created_at` across updates.
 * @param {string} id - Safe character ID.
 * @param {object} input - Raw character fields.
 * @param {object|undefined} existing - Prior row if present.
 * @returns {{ entry: object, isCreated: boolean }} Normalized row and create flag.
 */
function buildCharacterRow(id, input, existing) {
  const normalized = normalizeSavedEntry({ ...input, id });
  if (!normalized) {
    throw new ValidationError('Provide valid character name, category, and description.', 'character', 'INVALID_CHARACTER');
  }
  const nowIso = new Date().toISOString();
  const isCreated = !existing || Boolean(existing.deleted_at);
  const entry = {
    ...normalized,
    created_at: isCreated ? nowIso : existing.created_at,
    updated_at: nowIso,
    deleted_at: null,
  };
  return { entry, isCreated };
}

/**
 * Builds validated anchor metadata row preserving `created_at` across updates.
 * @param {{ id: string, meta: object, mimeType: string, sizeBytes: number, sha256: string, audioFile: string, existing?: object }} spec - Inputs.
 * @returns {object} Persisted anchor row.
 */
function buildAnchorRow({ id, meta, mimeType, sizeBytes, sha256, audioFile, existing }) {
  const nowIso = new Date().toISOString();
  const isCreated = !existing || Boolean(existing.deleted_at);
  const fileName = typeof meta?.fileName === 'string' && meta.fileName.trim()
    ? path.basename(meta.fileName.trim()).slice(0, 120)
    : `character-${id}.wav`;
  return {
    characterId: id,
    label: typeof meta?.label === 'string' && meta.label.trim() ? meta.label.trim() : id,
    source: meta?.source === 'upload' ? 'upload' : 'generated',
    takeId: meta?.takeId ? String(meta.takeId) : null,
    fileName,
    mimeType,
    sizeBytes,
    sha256,
    promptText: typeof meta?.promptText === 'string' ? meta.promptText : '',
    exactClone: Boolean(meta?.exactClone),
    audioFile,
    created_at: isCreated ? nowIso : existing.created_at,
    updated_at: nowIso,
    deleted_at: null,
  };
}

/**
 * Upserts a custom character entry into the serialized catalog.
 * @param {object} ctx - Store internals.
 * @param {string} rawId - Character identifier.
 * @param {object} input - Character payload.
 * @returns {Promise<{ character: object, isCreated: boolean }>} Saved record and create flag.
 */
function saveCharacterRecord(ctx, rawId, input) {
  const id = assertSafeEntityId(rawId, 'characterId');
  return ctx.enqueueWrite(async () => {
    await ctx.init();
    const catalog = await loadCatalog(ctx.catalogPath);
    const { entry, isCreated } = buildCharacterRow(id, input, catalog.characters[id]);
    catalog.characters[id] = entry;
    await writeAtomicFile(ctx.catalogPath, JSON.stringify(catalog, null, 2));
    return { character: entry, isCreated };
  });
}

/**
 * Soft-deletes a custom character and any bound voice anchor inside the serialized write queue.
 * @param {object} ctx - Store internals.
 * @param {string} rawId - Character identifier.
 * @returns {Promise<boolean>} True if an active character was soft-deleted.
 */
function softDeleteCharacterRecord(ctx, rawId) {
  const id = assertSafeEntityId(rawId, 'characterId');
  return ctx.enqueueWrite(async () => {
    const catalog = await loadCatalog(ctx.catalogPath);
    const existing = catalog.characters[id];
    if (!existing || existing.deleted_at) return false;
    const nowIso = new Date().toISOString();
    catalog.characters[id] = { ...existing, deleted_at: nowIso, updated_at: nowIso };
    if (catalog.anchors[id] && !catalog.anchors[id].deleted_at) {
      catalog.anchors[id] = { ...catalog.anchors[id], deleted_at: nowIso, updated_at: nowIso };
    }
    await writeAtomicFile(ctx.catalogPath, JSON.stringify(catalog, null, 2));
    return true;
  });
}

/**
 * Reads an active anchor's stored binary audio bytes safely from disk.
 * @param {object} ctx - Store internals.
 * @param {string} rawId - Character identifier.
 * @returns {Promise<object|null>} Binary payload + metadata or null if absent/deleted.
 */
async function readAnchorAudioRecord(ctx, rawId) {
  const id = assertSafeEntityId(rawId, 'characterId');
  const catalog = await loadCatalog(ctx.catalogPath);
  const record = catalog.anchors[id];
  if (!record || record.deleted_at || !record.audioFile) return null;
  const audioPath = resolveSafeAnchorPath(ctx.anchorsDir, record.audioFile);
  const bytes = await readFile(audioPath);
  return { bytes, mimeType: record.mimeType || 'audio/wav', sha256: record.sha256, fileName: record.fileName };
}

/**
 * Atomically writes an anchor's audio file and updates catalog metadata inside the write queue.
 * @param {object} ctx - Store internals.
 * @param {{ characterId: string, metadata: object, bytes: Uint8Array, mimeType?: string }} input - Anchor data.
 * @returns {Promise<object>} Public anchor summary.
 */
function saveAnchorRecord(ctx, { characterId: rawId, metadata, bytes, mimeType }) {
  const id = assertSafeEntityId(rawId, 'characterId');
  const validMime = validateAudioBytes({ bytes, mimeType });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const audioFile = `${id}.audio`;
  return ctx.enqueueWrite(async () => {
    await ctx.init();
    const catalog = await loadCatalog(ctx.catalogPath);
    await writeAtomicFile(resolveSafeAnchorPath(ctx.anchorsDir, audioFile), bytes);
    const row = buildAnchorRow({ id, meta: metadata, mimeType: validMime, sizeBytes: bytes.byteLength, sha256, audioFile, existing: catalog.anchors[id] });
    catalog.anchors[id] = row;
    await writeAtomicFile(ctx.catalogPath, JSON.stringify(catalog, null, 2));
    return toPublicAnchor(row);
  });
}

/**
 * Partially updates anchor transcript or exact-clone flags without re-uploading audio.
 * @param {object} ctx - Store internals.
 * @param {string} rawId - Character identifier.
 * @param {object} patch - Patch fields.
 * @returns {Promise<object|null>} Updated public anchor or null when missing.
 */
function patchAnchorRecord(ctx, rawId, patch) {
  const id = assertSafeEntityId(rawId, 'characterId');
  return ctx.enqueueWrite(async () => {
    const catalog = await loadCatalog(ctx.catalogPath);
    const existing = catalog.anchors[id];
    if (!existing || existing.deleted_at) return null;
    const updated = {
      ...existing,
      ...(patch?.promptText !== undefined ? { promptText: String(patch.promptText) } : {}),
      ...(patch?.exactClone !== undefined ? { exactClone: Boolean(patch.exactClone) } : {}),
      updated_at: new Date().toISOString(),
    };
    catalog.anchors[id] = updated;
    await writeAtomicFile(ctx.catalogPath, JSON.stringify(catalog, null, 2));
    return toPublicAnchor(updated);
  });
}

/**
 * Soft-deletes a character voice anchor in `catalog.json`.
 * @param {object} ctx - Store internals.
 * @param {string} rawId - Character identifier.
 * @returns {Promise<boolean>} True if an active anchor was soft-deleted.
 */
function softDeleteAnchorRecord(ctx, rawId) {
  const id = assertSafeEntityId(rawId, 'characterId');
  return ctx.enqueueWrite(async () => {
    const catalog = await loadCatalog(ctx.catalogPath);
    const existing = catalog.anchors[id];
    if (!existing || existing.deleted_at) return false;
    const nowIso = new Date().toISOString();
    catalog.anchors[id] = { ...existing, deleted_at: nowIso, updated_at: nowIso };
    await writeAtomicFile(ctx.catalogPath, JSON.stringify(catalog, null, 2));
    return true;
  });
}

/**
 * Loads synthesis cache metadata index or returns an empty entry map when absent.
 * @param {string} indexPath - Path to `cache-index.json`.
 * @returns {Promise<{ entries: Record<string, object> }>} Parsed cache index.
 */
async function loadCacheIndex(indexPath) {
  try {
    const raw = await readFile(indexPath, 'utf8');
    const parsed = JSON.parse(raw);
    return { entries: parsed?.entries && typeof parsed.entries === 'object' ? parsed.entries : {} };
  } catch (error) {
    if (error?.code === 'ENOENT') return { entries: {} };
    throw new StorageError('Could not read synthesis cache index from disk.', error);
  }
}

/**
 * Evicts oldest LRU synthesis cache files when total cached takes exceed `maxEntries`.
 * @param {object} ctx - Store internals.
 * @param {Record<string, object>} entries - Mutable cache entry map.
 * @param {number} maxEntries - Maximum allowed entries.
 * @returns {Promise<void>} Resolves once overflow entries are removed.
 */
async function evictOverflowCacheEntries(ctx, entries, maxEntries) {
  const ordered = Object.values(entries).sort((a, b) => (a.lastAccessedAt || 0) - (b.lastAccessedAt || 0));
  while (ordered.length > maxEntries) {
    const victim = ordered.shift();
    if (!victim?.key) continue;
    delete entries[victim.key];
    await unlink(resolveSafeAnchorPath(ctx.cacheDir, `${victim.key}.wav`)).catch(err => {
      if (err?.code !== 'ENOENT') throw err;
    });
  }
}

/**
 * Formats a cached synthesis entry for public API metadata responses.
 * @param {object} record - Cache index entry.
 * @returns {object} Public cache summary.
 */
function toPublicCacheEntry(record) {
  return {
    key: record.key,
    seed: record.seed ?? null,
    characterId: record.characterId || null,
    mimeType: record.mimeType || DEFAULT_AUDIO_MIME,
    sizeBytes: record.sizeBytes,
    created_at: record.created_at,
    audioUrl: `/api/v1/cache/${record.key}/audio`,
  };
}

/**
 * Saves a mastered synthesis WAV clip into the bounded LRU cache on disk.
 * @param {object} ctx - Store internals.
 * @param {{ key: string, bytes: Uint8Array, mimeType?: string, metadata?: object }} input - Cache payload.
 * @returns {Promise<object>} Stored public cache metadata.
 */
function saveCacheRecord(ctx, { key: rawKey, bytes, mimeType, metadata }) {
  const key = assertSafeCacheKey(rawKey);
  const validMime = validateAudioBytes({ bytes, mimeType });
  return ctx.enqueueWrite(async () => {
    await ctx.init();
    await writeAtomicFile(resolveSafeAnchorPath(ctx.cacheDir, `${key}.wav`), bytes);
    const index = await loadCacheIndex(ctx.cacheIndexPath);
    const nowMs = Date.now();
    const row = {
      key,
      characterId: typeof metadata?.characterId === 'string' ? metadata.characterId : null,
      seed: Number.isFinite(Number(metadata?.seed)) ? Number(metadata.seed) : null,
      mimeType: validMime,
      sizeBytes: bytes.byteLength,
      created_at: new Date(nowMs).toISOString(),
      lastAccessedAt: nowMs,
    };
    index.entries[key] = row;
    await evictOverflowCacheEntries(ctx, index.entries, ctx.maxCacheEntries);
    await writeAtomicFile(ctx.cacheIndexPath, JSON.stringify(index, null, 2));
    return toPublicCacheEntry(row);
  });
}


/**
 * Reads `glossary.json`, returning an empty dictionary when it has never been saved.
 * @param {string} glossaryPath - Path to `glossary.json`.
 * @returns {Promise<{ rules: Array<object>, createdAt: string|null, updatedAt: string|null }>} Stored glossary.
 */
async function readGlossaryFile(glossaryPath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(glossaryPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { rules: [], createdAt: null, updatedAt: null };
    throw new StorageError('Could not read pronunciation glossary from disk.', error);
  }
  try {
    return { rules: normalizeGlossaryRules(parsed?.rules), createdAt: parsed?.createdAt ?? null, updatedAt: parsed?.updatedAt ?? null };
  } catch (error) {
    throw new StorageError('Stored pronunciation glossary is invalid.', error);
  }
}

/**
 * Validates and atomically replaces the whole pronunciation dictionary inside the write queue.
 * @param {object} ctx - Store internals.
 * @param {unknown} rawRules - Candidate rule list (validated before any disk write).
 * @returns {Promise<{ rules: Array<object>, createdAt: string, updatedAt: string }>} Persisted glossary.
 */
function replaceGlossaryRecord(ctx, rawRules) {
  const rules = normalizeGlossaryRules(rawRules);
  return ctx.enqueueWrite(async () => {
    await ctx.init();
    // PUT replaces the whole document, so an unreadable prior file must not block repairing it.
    const existing = await readGlossaryFile(ctx.glossaryPath).catch(error => {
      if (error instanceof StorageError) return { createdAt: null };
      throw error;
    });
    const nowIso = new Date().toISOString();
    const row = { version: GLOSSARY_VERSION, rules, createdAt: existing.createdAt || nowIso, updatedAt: nowIso };
    await writeAtomicFile(ctx.glossaryPath, JSON.stringify(row, null, 2));
    return { rules, createdAt: row.createdAt, updatedAt: row.updatedAt };
  });
}

/**
 * Reads cached synthesis audio bytes and returns null if missing or expired on disk.
 * @param {object} ctx - Store internals.
 * @param {string} rawKey - Cache SHA-256 key.
 * @returns {Promise<object|null>} Cached audio payload or null.
 */
async function readCacheAudioRecord(ctx, rawKey) {
  const key = assertSafeCacheKey(rawKey);
  const index = await loadCacheIndex(ctx.cacheIndexPath);
  const record = index.entries[key];
  if (!record) return null;
  try {
    const bytes = await readFile(resolveSafeAnchorPath(ctx.cacheDir, `${key}.wav`));
    return { bytes, meta: toPublicCacheEntry(record) };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new StorageError('Could not read cached audio from disk.', error);
  }
}

function sumActiveSizeBytes(records) {
  return records.reduce((total, row) => total + (Number.isFinite(row?.sizeBytes) ? row.sizeBytes : 0), 0);
}

/**
 * Reads filesystem capacity metrics for `rootDir`, returning nulls if uninitialized.
 * @param {string} rootDir - Storage data directory.
 * @returns {Promise<{ volumeFreeBytes: number|null, volumeTotalBytes: number|null }>} Filesystem byte metrics.
 */
async function readVolumeCapacity(rootDir) {
  if (typeof statfs !== 'function') return { volumeFreeBytes: null, volumeTotalBytes: null };
  try {
    const info = await statfs(rootDir);
    const bsize = Number(info.bsize) || 0;
    return {
      volumeFreeBytes: bsize * Number(info.bavail || 0),
      volumeTotalBytes: bsize * Number(info.blocks || 0),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { volumeFreeBytes: null, volumeTotalBytes: null };
    throw new StorageError('Could not inspect storage filesystem capacity.', error);
  }
}

/**
 * Computes active catalog, anchor/cache disk consumption, and filesystem headroom.
 * @param {object} ctx - Store internals.
 * @returns {Promise<object>} Storage usage statistics.
 */
async function readStoreStats(ctx) {
  const [catalog, cacheIndex, capacity] = await Promise.all([
    loadCatalog(ctx.catalogPath),
    loadCacheIndex(ctx.cacheIndexPath),
    readVolumeCapacity(ctx.rootDir),
  ]);
  const characters = Object.values(catalog.characters || {}).filter(item => item && !item.deleted_at);
  const anchors = Object.values(catalog.anchors || {}).filter(item => item && !item.deleted_at);
  const cacheItems = Object.values(cacheIndex.entries || {});
  const anchorBytes = sumActiveSizeBytes(anchors);
  const cacheBytes = sumActiveSizeBytes(cacheItems);
  return {
    charactersCount: characters.length,
    anchorsCount: anchors.length,
    anchorBytes,
    cacheEntriesCount: cacheItems.length,
    maxCacheEntries: ctx.maxCacheEntries,
    cacheBytes,
    usedBytes: anchorBytes + cacheBytes,
    ...capacity,
  };
}

/**
 * Creates a disk-backed persistent store for Voice Studio characters and original WAV voice anchors.
 * Inputs: `{ dataDir, maxCacheEntries }`.
 * Outputs: serialized async store API (`init`, character & anchor CRUD with soft deletes, LRU synthesis cache, glossary read/replace).
 * Side effects: creates `dataDir/anchors` and `dataDir/cache`, writes `catalog.json`, `cache-index.json`, `glossary.json`, and audio binaries atomically.
 * Failure modes: throws `ValidationError` on bad input or `StorageError` on IO failures.
 * @param {{ dataDir: string, maxCacheEntries?: number }} config - Storage configuration.
 * @returns {object} Persistent storage store.
 */
export function createStorageStore({ dataDir, maxCacheEntries = MAX_CACHE_ENTRIES, autoMigrate = true }) {
  const rootDir = path.resolve(dataDir);
  const anchorsDir = path.join(rootDir, ANCHORS_DIR_NAME);
  const cacheDir = path.join(rootDir, CACHE_DIR_NAME);
  const catalogPath = path.join(rootDir, CATALOG_FILE_NAME);
  const cacheIndexPath = path.join(rootDir, CACHE_INDEX_FILE_NAME);
  const projectsDir = path.join(rootDir, PROJECTS_DIR_NAME);
  const assetsDir = path.join(rootDir, ASSETS_DIR_NAME);
  const glossaryPath = path.join(rootDir, GLOSSARY_FILE_NAME);
  let writeChain = Promise.resolve();
  const enqueueWrite = task => {
    const run = writeChain.then(task, task);
    writeChain = run.catch(() => {});
    return run;
  };
  const projectStore = createProjectStore({ projectsDir, enqueueWrite });
  const assetStore = createAssetStore({ assetsDir, dataDir: rootDir, enqueueWrite });
  let initPromise = null;
  const init = () => {
    if (!initPromise) {
      initPromise = (async () => {
        await mkdir(anchorsDir, { recursive: true });
        await mkdir(cacheDir, { recursive: true });
        await projectStore.init();
        await assetStore.init();
        if (autoMigrate) {
          await runStorageMigrations({ dataDir: rootDir });
        }
        await stat(anchorsDir);
      })().catch(error => {
        initPromise = null;
        throw error;
      });
    }
    return initPromise;
  };
  const ctx = { rootDir, anchorsDir, cacheDir, catalogPath, cacheIndexPath, projectsDir, glossaryPath, maxCacheEntries, enqueueWrite, init };
  return {
    init,
    dataDir: rootDir,
    projectStore,
    assetStore,
    migrate: options => enqueueWrite(() => runStorageMigrations({ dataDir: rootDir, ...options })),
    verifyIntegrity: () => verifyStorageIntegrity({ dataDir: rootDir }),
    detectMigrations: () => detectStorageMigrationsNeeded({ dataDir: rootDir }),
    listCharacters: async query => paginateActiveRecords((await loadCatalog(catalogPath)).characters, query),
    upsertCharacter: (rawId, input) => saveCharacterRecord(ctx, rawId, input),
    deleteCharacter: rawId => softDeleteCharacterRecord(ctx, rawId),
    listAnchors: async query => {
      const page = paginateActiveRecords((await loadCatalog(catalogPath)).anchors, query);
      return { ...page, items: page.items.map(toPublicAnchor) };
    },
    getAnchorAudio: rawId => readAnchorAudioRecord(ctx, rawId),
    upsertAnchor: input => saveAnchorRecord(ctx, input),
    patchAnchor: (rawId, patch) => patchAnchorRecord(ctx, rawId, patch),
    deleteAnchor: rawId => softDeleteAnchorRecord(ctx, rawId),
    listProjects: query => projectStore.listProjects(query),
    createProject: input => projectStore.createProject(input),
    upsertProject: (rawId, input, options) => projectStore.saveProject(rawId, input, options),
    getProject: (rawId, options) => projectStore.getProject(rawId, options),
    deleteProject: (rawId, options) => projectStore.deleteProject(rawId, options),
    duplicateProject: (rawId, options) => projectStore.duplicateProject(rawId, options),
    restoreProject: (rawId, options) => projectStore.restoreProject(rawId, options),
    saveAsset: input => assetStore.saveAsset(input),
    getAsset: (rawId, options) => assetStore.getAsset(rawId, options),
    getAssetBinary: (rawId, options) => assetStore.getAssetBinary(rawId, options),
    deleteAsset: (rawId, options) => assetStore.deleteAsset(rawId, options),
    listAssets: query => assetStore.listAssets(query),
    purgeDeletedAssets: options => assetStore.purgeDeletedAssets(options),
    getGlossary: () => readGlossaryFile(glossaryPath),
    replaceGlossary: rawRules => replaceGlossaryRecord(ctx, rawRules),
    getCacheEntry: async rawKey => (await readCacheAudioRecord(ctx, rawKey))?.meta || null,
    getCacheAudio: rawKey => readCacheAudioRecord(ctx, rawKey),
    putCacheEntry: input => saveCacheRecord(ctx, input),
    getStats: () => readStoreStats(ctx),
  };
}
