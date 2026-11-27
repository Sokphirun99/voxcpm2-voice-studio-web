/**
 * @fileoverview Atomic persistent storage for Voice Studio binary assets and metadata.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, statfs, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StorageError, ValidationError } from '../src/domain/errors.js';

export const ASSET_META_EXT = '.json';
export const ASSET_BIN_EXT = '.bin';
export const ASSET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;
export const MAX_ASSET_BYTES = 500 * 1024 * 1024;
export const DEFAULT_MIME_TYPE = 'application/octet-stream';
export const VALID_ASSET_KINDS = Object.freeze(new Set(['video', 'audio', 'subtitle', 'other']));
export const MAX_FILE_NAME_LENGTH = 255;

/**
 * Validates that an asset identifier is a non-empty UUID string.
 * Inputs: rawId (unknown), field (string).
 * Outputs: Normalized UUID string.
 * Side effects: none.
 * Failure modes: Throws ValidationError if not a valid UUID format.
 * @param {unknown} rawId - Candidate identifier.
 * @param {string} [field='assetId'] - Error field label.
 * @returns {string} Validated UUID string.
 */
export function assertSafeAssetId(rawId, field = 'assetId') {
  const id = typeof rawId === 'string' ? rawId.trim() : '';
  if (!id || !ASSET_ID_PATTERN.test(id)) {
    throw new ValidationError('Asset id must be a UUID.', field, 'INVALID_ASSET_ID');
  }
  return id;
}

function assertSafeProjectId(rawId, field = 'projectId') {
  const id = typeof rawId === 'string' ? rawId.trim() : '';
  if (!id || !ASSET_ID_PATTERN.test(id)) {
    throw new ValidationError('Project id must be a UUID.', field, 'INVALID_PROJECT_ID');
  }
  return id;
}

/**
 * Resolves a safe file path inside `assetsDir` and guards against directory traversal.
 * Inputs: assetsDir (string), fileName (string).
 * Outputs: Safe absolute file path.
 * Side effects: none.
 * Failure modes: Throws StorageError if resolved path escapes assetsDir.
 * @param {string} assetsDir - Target assets directory.
 * @param {string} fileName - File name to resolve.
 * @returns {string} Resolved absolute path.
 */
export function resolveSafeAssetPath(assetsDir, fileName) {
  const base = path.resolve(assetsDir);
  const resolved = path.resolve(base, path.basename(fileName));
  if (!resolved.startsWith(`${base}${path.sep}`)) {
    throw new StorageError('Resolved asset path escaped storage directory.');
  }
  return resolved;
}

async function cleanupTempFile(tempPath, originalError) {
  try {
    await unlink(tempPath);
  } catch (cleanupError) {
    if (cleanupError?.code !== 'ENOENT') {
      throw new AggregateError([originalError, cleanupError], 'Atomic asset write failed.');
    }
  }
}

/**
 * Atomically writes file contents via a unique temporary file and rename.
 * Inputs: targetPath (string), contents (Uint8Array|string).
 * Outputs: Promise<void>.
 * Side effects: Writes temp file, renames to destination, unlinks temp file on failure.
 * Failure modes: Throws on IO errors.
 * @param {string} targetPath - Destination path.
 * @param {Uint8Array|string} contents - Binary or text payload.
 * @returns {Promise<void>}
 */
export async function writeAtomicFile(targetPath, contents) {
  const tempPath = `${targetPath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, contents);
  try {
    await rename(tempPath, targetPath);
  } catch (error) {
    await cleanupTempFile(tempPath, error);
    throw error;
  }
}

function computeSha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function validateAssetBytes(bytes, maxBytes) {
  if (!(bytes instanceof Uint8Array) && !Buffer.isBuffer(bytes)) {
    throw new ValidationError('Asset payload must be binary bytes.', 'bytes', 'INVALID_ASSET_BYTES');
  }
  if (bytes.byteLength === 0) {
    throw new ValidationError('Asset payload cannot be empty.', 'bytes', 'EMPTY_ASSET_PAYLOAD');
  }
  if (bytes.byteLength > maxBytes) {
    throw new ValidationError('Asset payload exceeds maximum size limit.', 'bytes', 'ASSET_TOO_LARGE');
  }
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function validateAssetMeta(input) {
  const rawName = typeof input?.fileName === 'string' ? path.basename(input.fileName.trim()) : '';
  if (!rawName) throw new ValidationError('Asset fileName is required.', 'fileName', 'INVALID_ASSET_FILENAME');
  if (rawName.length > MAX_FILE_NAME_LENGTH) {
    throw new ValidationError('Asset fileName too long.', 'fileName', 'FILENAME_TOO_LONG');
  }
  const kind = typeof input?.kind === 'string' ? input.kind.trim().toLowerCase() : 'other';
  if (!VALID_ASSET_KINDS.has(kind)) {
    throw new ValidationError(`Asset kind must be one of: ${Array.from(VALID_ASSET_KINDS).join(', ')}.`, 'kind', 'INVALID_ASSET_KIND');
  }
  const mimeType = typeof input?.mimeType === 'string' && input.mimeType.trim() ? input.mimeType.trim() : DEFAULT_MIME_TYPE;
  const projectId = input?.projectId ? assertSafeProjectId(input.projectId, 'projectId') : null;
  return { fileName: rawName, kind, mimeType, projectId };
}

async function assertVolumeHeadroom(rootDir, requiredBytes) {
  if (typeof statfs !== 'function') return;
  try {
    const info = await statfs(rootDir);
    const freeBytes = Number(info.bsize || 0) * Number(info.bavail || 0);
    if (info.bavail !== undefined && Number.isFinite(freeBytes) && freeBytes < requiredBytes) {
      throw new StorageError('Insufficient storage space to save asset.');
    }
  } catch (error) {
    if (error instanceof StorageError) throw error;
    if (error?.code !== 'ENOENT') throw new StorageError('Could not inspect storage capacity.', error);
  }
}

async function writeAssetFiles(ctx, record, bytes) {
  const binPath = resolveSafeAssetPath(ctx.assetsDir, `${record.id}${ASSET_BIN_EXT}`);
  const metaPath = resolveSafeAssetPath(ctx.assetsDir, `${record.id}${ASSET_META_EXT}`);
  await writeAtomicFile(binPath, bytes);
  try {
    await writeAtomicFile(metaPath, JSON.stringify(record, null, 2));
  } catch (metaError) {
    await unlink(binPath).catch(() => {});
    throw metaError;
  }
}

function buildAssetRecord(id, meta, bytes) {
  const nowIso = new Date().toISOString();
  return {
    id,
    fileName: meta.fileName,
    mimeType: meta.mimeType,
    sizeBytes: bytes.byteLength,
    kind: meta.kind,
    sha256: computeSha256(bytes),
    projectId: meta.projectId,
    createdAt: nowIso,
    updatedAt: nowIso,
    deletedAt: null,
  };
}

async function saveAssetRecord(ctx, input) {
  const id = input?.id ? assertSafeAssetId(input.id) : randomUUID();
  const bytes = validateAssetBytes(input?.bytes, ctx.maxAssetBytes);
  const meta = validateAssetMeta(input);
  await assertVolumeHeadroom(ctx.rootDir, bytes.byteLength);
  return ctx.enqueueWrite(async () => {
    await ctx.init();
    const record = buildAssetRecord(id, meta, bytes);
    await writeAssetFiles(ctx, record, bytes);
    return record;
  });
}

async function readAssetMetaFile(assetsDir, id) {
  try {
    const raw = await readFile(resolveSafeAssetPath(assetsDir, `${id}${ASSET_META_EXT}`), 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new StorageError(`Stored asset metadata ${id} is unreadable.`, error);
  }
}

async function getAssetMetaRecord(ctx, rawId, options = {}) {
  const id = assertSafeAssetId(rawId);
  const meta = await readAssetMetaFile(ctx.assetsDir, id);
  if (!meta || (meta.deletedAt && !options.includeDeleted)) return null;
  return meta;
}

async function getAssetBinaryRecord(ctx, rawId, options = {}) {
  const meta = await getAssetMetaRecord(ctx, rawId, options);
  if (!meta) return null;
  const binPath = resolveSafeAssetPath(ctx.assetsDir, `${meta.id}${ASSET_BIN_EXT}`);
  try {
    const bytes = await readFile(binPath);
    return { meta, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
  } catch (error) {
    throw new StorageError(`Binary payload for asset ${meta.id} is missing or unreadable on disk.`, error);
  }
}

async function softDeleteAssetRecord(ctx, rawId) {
  const id = assertSafeAssetId(rawId);
  return ctx.enqueueWrite(async () => {
    await ctx.init();
    const existing = await readAssetMetaFile(ctx.assetsDir, id);
    if (!existing || existing.deletedAt) return false;
    const nowIso = new Date().toISOString();
    const updated = { ...existing, deletedAt: nowIso, updatedAt: nowIso };
    await writeAtomicFile(resolveSafeAssetPath(ctx.assetsDir, `${id}${ASSET_META_EXT}`), JSON.stringify(updated, null, 2));
    return true;
  });
}

async function hardDeleteAssetRecord(ctx, rawId) {
  const id = assertSafeAssetId(rawId);
  return ctx.enqueueWrite(async () => {
    await ctx.init();
    const binPath = resolveSafeAssetPath(ctx.assetsDir, `${id}${ASSET_BIN_EXT}`);
    const metaPath = resolveSafeAssetPath(ctx.assetsDir, `${id}${ASSET_META_EXT}`);
    const metaExists = await readAssetMetaFile(ctx.assetsDir, id);
    if (!metaExists) return false;
    await unlink(binPath).catch(() => {});
    await unlink(metaPath).catch(() => {});
    return true;
  });
}

function shouldIncludeAsset(meta, query) {
  if (!meta || (meta.deletedAt && !query.includeDeleted)) return false;
  if (query.projectId && meta.projectId !== query.projectId) return false;
  if (query.kind && meta.kind !== query.kind) return false;
  return true;
}

async function loadActiveAssets(assetsDir, files, query) {
  const records = [];
  for (const fileName of files) {
    if (!fileName.endsWith(ASSET_META_EXT)) continue;
    const id = fileName.slice(0, -ASSET_META_EXT.length);
    if (!ASSET_ID_PATTERN.test(id)) continue;
    const meta = await readAssetMetaFile(assetsDir, id);
    if (shouldIncludeAsset(meta, query)) records.push(meta);
  }
  return records;
}

function normalizePagination(query = {}) {
  const parsedLimit = Number.parseInt(String(query.limit ?? DEFAULT_PAGE_LIMIT), 10);
  const parsedOffset = Number.parseInt(String(query.offset ?? 0), 10);
  const limit = Number.isFinite(parsedLimit) ? Math.min(MAX_PAGE_LIMIT, Math.max(1, parsedLimit)) : DEFAULT_PAGE_LIMIT;
  const offset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
  return { limit, offset };
}

async function listAssetRecords(ctx, query = {}) {
  const { limit, offset } = normalizePagination(query);
  await ctx.init();
  const files = await readdir(ctx.assetsDir).catch(error => {
    if (error?.code === 'ENOENT') return [];
    throw new StorageError('Could not list assets from disk.', error);
  });
  const records = await loadActiveAssets(ctx.assetsDir, files, query);
  records.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const total = records.length;
  const items = records.slice(offset, offset + limit);
  return { items, total, limit, offset, hasMore: offset + items.length < total };
}

async function purgeAssetItem(assetsDir, id, meta, threshold) {
  if (!meta?.deletedAt) return false;
  const deletedTime = new Date(meta.deletedAt).getTime();
  if (Date.now() - deletedTime < threshold) return false;
  await unlink(resolveSafeAssetPath(assetsDir, `${id}${ASSET_BIN_EXT}`)).catch(() => {});
  await unlink(resolveSafeAssetPath(assetsDir, `${id}${ASSET_META_EXT}`)).catch(() => {});
  return true;
}

async function cleanupOrphanAsset(assetsDir, file) {
  if (file.endsWith('.tmp')) {
    await unlink(resolveSafeAssetPath(assetsDir, file)).catch(() => {});
    return true;
  }
  if (file.endsWith(ASSET_BIN_EXT)) {
    const id = file.slice(0, -ASSET_BIN_EXT.length);
    if (!ASSET_ID_PATTERN.test(id)) return false;
    const meta = await readAssetMetaFile(assetsDir, id);
    if (!meta) {
      await unlink(resolveSafeAssetPath(assetsDir, file)).catch(() => {});
      return true;
    }
  }
  return false;
}

async function processPurgeFile(ctx, file, olderThanMs) {
  if (file.endsWith(ASSET_META_EXT)) {
    const id = file.slice(0, -ASSET_META_EXT.length);
    if (!ASSET_ID_PATTERN.test(id)) return false;
    const meta = await readAssetMetaFile(ctx.assetsDir, id);
    return purgeAssetItem(ctx.assetsDir, id, meta, olderThanMs);
  }
  return cleanupOrphanAsset(ctx.assetsDir, file);
}

async function purgeDeletedAssetRecords(ctx, { olderThanMs = 0 } = {}) {
  return ctx.enqueueWrite(async () => {
    await ctx.init();
    const files = await readdir(ctx.assetsDir).catch(() => []);
    let purgedCount = 0;
    for (const file of files) {
      if (await processPurgeFile(ctx, file, olderThanMs)) purgedCount += 1;
    }
    return purgedCount;
  });
}

function createDefaultWriteQueue() {
  let writeChain = Promise.resolve();
  return task => {
    const run = writeChain.then(task, task);
    writeChain = run.catch(() => {});
    return run;
  };
}

function resolveAssetDirs(assetsDir, dataDir) {
  const root = dataDir ? path.resolve(dataDir) : path.dirname(path.resolve(assetsDir));
  return { rootDir: root, assetsDir: assetsDir ? path.resolve(assetsDir) : path.join(root, 'assets') };
}

/**
 * Creates an atomic persistent store for binary media assets and metadata.
 * Inputs: `{ assetsDir, dataDir, enqueueWrite, maxAssetBytes }`.
 * Outputs: AssetStore instance with save, get, delete, list, purge, and init methods.
 * Side effects: Creates assetsDir if missing, writes atomic files.
 * Failure modes: Throws ValidationError on bad input, StorageError on IO or capacity issues.
 * @param {object} config - Configuration options.
 * @returns {object} Initialized asset store.
 */
export function createAssetStore({ assetsDir, dataDir, enqueueWrite, maxAssetBytes = MAX_ASSET_BYTES }) {
  const dirs = resolveAssetDirs(assetsDir, dataDir);
  const effectiveEnqueue = enqueueWrite || createDefaultWriteQueue();
  const init = async () => { await mkdir(dirs.assetsDir, { recursive: true }); };
  const ctx = { assetsDir: dirs.assetsDir, rootDir: dirs.rootDir, enqueueWrite: effectiveEnqueue, init, maxAssetBytes };
  return {
    init,
    assetsDir: dirs.assetsDir,
    saveAsset: input => saveAssetRecord(ctx, input),
    getAsset: (rawId, options) => getAssetMetaRecord(ctx, rawId, options),
    getAssetBinary: (rawId, options) => getAssetBinaryRecord(ctx, rawId, options),
    deleteAsset: (rawId, options) => (options?.hard ? hardDeleteAssetRecord(ctx, rawId) : softDeleteAssetRecord(ctx, rawId)),
    listAssets: query => listAssetRecords(ctx, query),
    purgeDeletedAssets: options => purgeDeletedAssetRecords(ctx, options),
  };
}
