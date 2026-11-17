/**
 * @fileoverview Atomic persistent catalog and binary audio storage backed by a Docker volume directory.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ALLOWED_AUDIO_MIME_TYPES,
  MAX_REFERENCE_AUDIO_BYTES,
  hasValidAudioMagicBytes,
} from '../src/domain/audioValidation.js';
import { StorageError, ValidationError } from '../src/domain/errors.js';
import { normalizeSavedEntry } from '../src/domain/voiceLibrary.js';

const CATALOG_VERSION = 1;
const CATALOG_FILE_NAME = 'catalog.json';
const ANCHORS_DIR_NAME = 'anchors';
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 200;
const DEFAULT_AUDIO_MIME = 'audio/wav';
const OCTET_STREAM_MIME = 'application/octet-stream';

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
    await unlink(tempPath).catch(() => {});
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
 * Creates a disk-backed persistent store for Voice Studio characters and original WAV voice anchors.
 * Inputs: `{ dataDir }`.
 * Outputs: serialized async store API (`init`, character & anchor CRUD with soft deletes).
 * Side effects: creates `dataDir/anchors`, writes `catalog.json` and audio binaries atomically.
 * Failure modes: throws `ValidationError` on bad input or `StorageError` on IO failures.
 * @param {{ dataDir: string }} config - Storage configuration.
 * @returns {object} Persistent storage store.
 */
export function createStorageStore({ dataDir }) {
  const rootDir = path.resolve(dataDir);
  const anchorsDir = path.join(rootDir, ANCHORS_DIR_NAME);
  const catalogPath = path.join(rootDir, CATALOG_FILE_NAME);
  let writeChain = Promise.resolve();
  const enqueueWrite = task => {
    const run = writeChain.then(task, task);
    writeChain = run.catch(() => {});
    return run;
  };
  const init = async () => { await mkdir(anchorsDir, { recursive: true }); await stat(anchorsDir); };
  const ctx = { rootDir, anchorsDir, catalogPath, enqueueWrite, init };
  return {
    init,
    dataDir: rootDir,
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
  };
}
