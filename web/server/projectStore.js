/**
 * @fileoverview Atomic persistent storage for Voice Studio projects with revision conflict detection.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConflictError, StorageError, ValidationError } from '../src/domain/errors.js';
import { normalizeExportHistory } from '../src/domain/exportHistory.js';
import { upgradeProjectSchema } from '../src/domain/projects.js';
import { normalizeProjectTerminology } from '../src/domain/terminology.js';

export const PROJECT_FILE_EXT = '.json';
export const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;
export const MAX_PROJECT_DOC_BYTES = 1024 * 1024;
export const DEFAULT_SCHEMA_VERSION = 1;
export const DEFAULT_INITIAL_REVISION = 1;
export const DEFAULT_STATUS = 'draft';
export const MAX_PROJECT_TITLE_LENGTH = 200;

export const VALID_LEGACY_KINDS = Object.freeze(new Set(['subtitle', 'tts', 'dubbing']));
export const VALID_PROJECT_TYPES = Object.freeze(new Set(['tts', 'subtitles', 'dubbing']));
export const TYPE_TO_KIND_MAP = Object.freeze({
  tts: 'tts',
  subtitles: 'subtitle',
  dubbing: 'dubbing',
});
export const KIND_TO_TYPE_MAP = Object.freeze({
  tts: 'tts',
  subtitle: 'subtitles',
  dubbing: 'dubbing',
});

/**
 * Validates that a project identifier is a non-empty UUID string.
 * Inputs: rawId (unknown), field (string).
 * Outputs: Normalized project id string.
 * Side effects: none.
 * Failure modes: Throws ValidationError if not a valid UUID format.
 * @param {unknown} rawId - Candidate identifier.
 * @param {string} [field='projectId'] - Error field label.
 * @returns {string} Validated UUID string.
 */
export function assertSafeProjectId(rawId, field = 'projectId') {
  const id = typeof rawId === 'string' ? rawId.trim() : '';
  if (!id || !PROJECT_ID_PATTERN.test(id)) {
    throw new ValidationError('Project id must be a UUID.', field, 'INVALID_PROJECT_ID');
  }
  return id;
}

/**
 * Resolves a safe file path inside `projectsDir` and guards against directory traversal.
 * Inputs: projectsDir (string), id (string).
 * Outputs: Safe absolute file path.
 * Side effects: none.
 * Failure modes: Throws StorageError if resolved path escapes projectsDir.
 * @param {string} projectsDir - Target projects directory.
 * @param {string} id - Safe project UUID.
 * @returns {string} Resolved absolute path.
 */
export function resolveSafeProjectPath(projectsDir, id) {
  const base = path.resolve(projectsDir);
  const resolved = path.resolve(base, `${id}${PROJECT_FILE_EXT}`);
  if (!resolved.startsWith(`${base}${path.sep}`)) {
    throw new StorageError('Resolved project path escaped storage directory.');
  }
  return resolved;
}

async function cleanupTempFile(tempPath, originalError) {
  try {
    await unlink(tempPath);
  } catch (cleanupError) {
    if (cleanupError?.code !== 'ENOENT') {
      throw new AggregateError([originalError, cleanupError], 'Atomic project write failed.');
    }
  }
}

/**
 * Atomically writes file contents via a unique temporary file and rename.
 * Inputs: targetPath (string), contents (string).
 * Outputs: Promise<void>.
 * Side effects: Writes temp file, renames to destination, removes temp file on failure.
 * Failure modes: Throws on IO errors.
 * @param {string} targetPath - Destination path.
 * @param {string} contents - Serialized JSON string.
 * @returns {Promise<void>}
 */
export async function writeAtomicFile(targetPath, contents) {
  const tempPath = `${targetPath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, contents, 'utf8');
  try {
    await rename(tempPath, targetPath);
  } catch (error) {
    await cleanupTempFile(tempPath, error);
    throw error;
  }
}

function parseExpectedRevision(expectedRevision) {
  if (expectedRevision === undefined || expectedRevision === null || expectedRevision === '') return null;
  const expected = Number(expectedRevision);
  if (!Number.isInteger(expected) || expected < 1) {
    throw new ValidationError('Expected revision must be a positive integer.', 'expectedRevision', 'INVALID_REVISION');
  }
  return expected;
}

function checkRevisionConflict(existing, expectedRevision) {
  const expected = parseExpectedRevision(expectedRevision);
  if (expected === null) return;
  if (!existing || existing.deletedAt) {
    throw new ConflictError(`Project revision mismatch. Expected ${expected} but project does not exist.`, {
      currentRevision: 0,
      expectedRevision: expected,
      code: 'REVISION_CONFLICT',
    });
  }
  const current = Number(existing.revision || DEFAULT_INITIAL_REVISION);
  if (current !== expected) {
    throw new ConflictError(`Project revision mismatch. Expected ${expected} but found ${current}.`, {
      currentRevision: current,
      expectedRevision: expected,
      code: 'REVISION_CONFLICT',
    });
  }
}

function resolveTypeAndKind(input) {
  if (input?.type !== undefined) {
    const rawType = typeof input.type === 'string' ? input.type.trim().toLowerCase() : '';
    const normalized = rawType === 'subtitle' ? 'subtitles' : rawType;
    if (!VALID_PROJECT_TYPES.has(normalized)) {
      throw new ValidationError(`Project type must be one of: ${Array.from(VALID_PROJECT_TYPES).join(', ')}.`, 'type', 'INVALID_PROJECT_TYPE');
    }
    return { type: normalized, kind: TYPE_TO_KIND_MAP[normalized] || normalized };
  }
  const rawKind = typeof input?.kind === 'string' ? input.kind.trim().toLowerCase() : '';
  if (!VALID_LEGACY_KINDS.has(rawKind)) {
    throw new ValidationError("Project kind must be 'subtitle' or 'tts'.", 'kind', 'INVALID_PROJECT_KIND');
  }
  return { kind: rawKind, type: KIND_TO_TYPE_MAP[rawKind] || rawKind };
}

function assertProjectTitle(title) {
  const normalized = typeof title === 'string' ? title.trim() : '';
  if (!normalized) {
    throw new ValidationError('Project title is required.', 'title', 'INVALID_PROJECT_TITLE');
  }
  if (normalized.length > MAX_PROJECT_TITLE_LENGTH) {
    throw new ValidationError('Project title must not exceed 200 characters.', 'title', 'TITLE_TOO_LONG');
  }
  return normalized;
}

function assertProjectPayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ValidationError('Project payload must be a JSON object.', 'payload', 'INVALID_PROJECT_PAYLOAD');
  }
  return payload;
}

function resolveTimestamps(existing) {
  const nowIso = new Date().toISOString();
  const isCreated = !existing || Boolean(existing.deletedAt);
  return {
    createdAt: isCreated ? nowIso : existing.createdAt,
    updatedAt: nowIso,
  };
}

function resolveRevision(existing, fallbackRevision) {
  if (existing && !existing.deletedAt) {
    return (existing.revision || DEFAULT_INITIAL_REVISION) + 1;
  }
  return Number.isInteger(fallbackRevision) && fallbackRevision >= 1 ? fallbackRevision : DEFAULT_INITIAL_REVISION;
}

function resolveProjectPayload(input, type) {
  const terminology = normalizeProjectTerminology(input.terminology ?? input.payload?.terminology ?? input.settings?.terminology);
  const exportHistory = normalizeExportHistory(input.exportHistory ?? input.payload?.exportHistory ?? input.settings?.exportHistory);
  if (input.payload !== undefined) {
    return { ...assertProjectPayload(input.payload), terminology, exportHistory };
  }
  return {
    videoFileName: input.settings?.videoFileName ?? null,
    segments: Array.isArray(input.segments) ? input.segments : [],
    speakerNames: input.settings?.speakerNames || {},
    subtitleOptions: input.settings?.subtitleOptions || {},
    detectedLanguage: input.sourceLanguage || '',
    translatedLanguage: input.targetLanguage || '',
    hasTranslation: Boolean(input.settings?.hasTranslation),
    terminology,
    exportHistory,
    ...(type === 'tts' ? { script: input.settings?.script || '', voiceId: input.settings?.voiceId || '' } : {}),
  };
}

function assertPayloadDocSize(row, maxDocBytes) {
  const docBytes = Buffer.byteLength(JSON.stringify(row), 'utf8');
  if (docBytes > maxDocBytes) {
    throw new ValidationError('Project payload exceeds the size limit.', 'payload', 'PROJECT_TOO_LARGE');
  }
}

function assembleProjectMeta(spec) {
  const { id, type, kind, title, status, revision } = spec;
  return {
    schemaVersion: DEFAULT_SCHEMA_VERSION,
    id,
    type,
    kind,
    name: title,
    title,
    status: status || DEFAULT_STATUS,
    revision,
  };
}

function resolveProjectSettings(input, payload, type) {
  const settings = { ...(input.settings || {}) };
  if (payload && typeof payload === 'object') {
    if (settings.videoFileName === undefined && payload.videoFileName) settings.videoFileName = payload.videoFileName;
    if (settings.speakerNames === undefined && payload.speakerNames) settings.speakerNames = payload.speakerNames;
    if (settings.subtitleOptions === undefined && payload.subtitleOptions) settings.subtitleOptions = payload.subtitleOptions;
    if (type === 'tts') {
      if (settings.script === undefined && payload.script) settings.script = payload.script;
      if (settings.voiceId === undefined && payload.voiceId) settings.voiceId = payload.voiceId;
    }
  }
  return settings;
}

function assembleProjectDetails(spec, meta, timestamps) {
  const { input, payload, settings } = spec;
  const terminology = normalizeProjectTerminology(input.terminology ?? payload.terminology ?? settings.terminology);
  const exportHistory = normalizeExportHistory(input.exportHistory ?? payload.exportHistory ?? settings.exportHistory);
  return {
    ...meta,
    sourceLanguage: input.sourceLanguage || payload.detectedLanguage || '',
    targetLanguage: input.targetLanguage || payload.translatedLanguage || '',
    sourceAssetId: input.sourceAssetId || null,
    segments: Array.isArray(input.segments) ? input.segments : (payload.segments || []),
    settings,
    terminology,
    exportHistory,
    payload,
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
    deletedAt: null,
  };
}

function buildProjectRow(id, input, existing, maxDocBytes) {
  const { type, kind } = resolveTypeAndKind(input);
  const title = assertProjectTitle(input.title ?? input.name);
  const payload = resolveProjectPayload(input, type);
  const timestamps = resolveTimestamps(existing);
  const revision = resolveRevision(existing, input.revision);
  const meta = assembleProjectMeta({ id, type, kind, title, status: input.status, revision });
  const settings = resolveProjectSettings(input, payload, type);
  const row = assembleProjectDetails({ input, payload, settings }, meta, timestamps);
  assertPayloadDocSize(row, maxDocBytes);
  return row;
}

async function readProjectFile(projectsDir, id) {
  try {
    const raw = await readFile(resolveSafeProjectPath(projectsDir, id), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return upgradeProjectSchema(parsed);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new StorageError(`Stored project snapshot ${id} is unreadable.`, error);
  }
}

function normalizePagination(query = {}) {
  const parsedLimit = Number.parseInt(String(query.limit ?? DEFAULT_PAGE_LIMIT), 10);
  const parsedOffset = Number.parseInt(String(query.offset ?? 0), 10);
  const limit = Number.isFinite(parsedLimit) ? Math.min(MAX_PAGE_LIMIT, Math.max(1, parsedLimit)) : DEFAULT_PAGE_LIMIT;
  const offset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
  return { limit, offset };
}

function toPublicProjectSummary(record) {
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    type: record.type,
    name: record.name,
    revision: record.revision,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function saveProjectRecord(ctx, rawId, input, options = {}) {
  const id = assertSafeProjectId(rawId);
  const expectedRevision = options.expectedRevision ?? input?.expectedRevision;
  return ctx.enqueueWrite(async () => {
    await ctx.init();
    const existing = await readProjectFile(ctx.projectsDir, id);
    checkRevisionConflict(existing, expectedRevision);
    const row = buildProjectRow(id, input, existing, ctx.maxDocBytes);
    const projectPath = resolveSafeProjectPath(ctx.projectsDir, id);
    await writeAtomicFile(projectPath, JSON.stringify(row, null, 2));
    const isCreated = !existing || Boolean(existing.deletedAt);
    return { project: row, isCreated };
  });
}

async function getProjectRecord(ctx, rawId, options = {}) {
  const id = assertSafeProjectId(rawId);
  const record = await readProjectFile(ctx.projectsDir, id);
  if (!record || (record.deletedAt && !options.includeDeleted)) return null;
  return record;
}

async function softDeleteProjectRecord(ctx, rawId, options = {}) {
  const id = assertSafeProjectId(rawId);
  return ctx.enqueueWrite(async () => {
    await ctx.init();
    const existing = await readProjectFile(ctx.projectsDir, id);
    if (!existing || existing.deletedAt) return false;
    checkRevisionConflict(existing, options?.expectedRevision);
    const nowIso = new Date().toISOString();
    const updated = {
      ...existing,
      deletedAt: nowIso,
      updatedAt: nowIso,
      revision: (existing.revision || DEFAULT_INITIAL_REVISION) + 1,
    };
    await writeAtomicFile(resolveSafeProjectPath(ctx.projectsDir, id), JSON.stringify(updated, null, 2));
    return true;
  });
}

function buildDuplicatedRow(newId, existing, options, maxDocBytes) {
  const defaultTitle = `Copy of ${existing.title || existing.name}`;
  const title = assertProjectTitle(options?.title || options?.name || defaultTitle);
  const duplicatedInput = {
    ...existing,
    id: newId,
    title,
    name: title,
    revision: DEFAULT_INITIAL_REVISION,
    status: options?.status || DEFAULT_STATUS,
  };
  return buildProjectRow(newId, duplicatedInput, null, maxDocBytes);
}

async function duplicateProjectRecord(ctx, rawId, options = {}) {
  const sourceId = assertSafeProjectId(rawId);
  return ctx.enqueueWrite(async () => {
    await ctx.init();
    const existing = await readProjectFile(ctx.projectsDir, sourceId);
    if (!existing || existing.deletedAt) return null;
    const newId = options?.newId ? assertSafeProjectId(options.newId, 'newId') : randomUUID();
    const targetFile = await readProjectFile(ctx.projectsDir, newId);
    if (targetFile && !targetFile.deletedAt) {
      throw new ConflictError(`Project ${newId} already exists.`);
    }
    const row = buildDuplicatedRow(newId, existing, options, ctx.maxDocBytes);
    await writeAtomicFile(resolveSafeProjectPath(ctx.projectsDir, newId), JSON.stringify(row, null, 2));
    return { project: row };
  });
}

async function createProjectRecord(ctx, input) {
  const id = input?.id ? assertSafeProjectId(input.id) : randomUUID();
  return ctx.enqueueWrite(async () => {
    await ctx.init();
    const existing = await readProjectFile(ctx.projectsDir, id);
    if (existing && !existing.deletedAt) {
      throw new ConflictError(`Project ${id} already exists.`, { code: 'PROJECT_ALREADY_EXISTS' });
    }
    const row = buildProjectRow(id, input, existing, ctx.maxDocBytes);
    const projectPath = resolveSafeProjectPath(ctx.projectsDir, id);
    await writeAtomicFile(projectPath, JSON.stringify(row, null, 2));
    return { project: row, isCreated: true };
  });
}

async function restoreProjectRecord(ctx, rawId, options = {}) {
  const id = assertSafeProjectId(rawId);
  return ctx.enqueueWrite(async () => {
    await ctx.init();
    const existing = await readProjectFile(ctx.projectsDir, id);
    if (!existing) return null;
    checkRevisionConflict(existing, options?.expectedRevision);
    if (!existing.deletedAt) return { project: existing, restored: false };
    const nowIso = new Date().toISOString();
    const restored = {
      ...existing,
      deletedAt: null,
      updatedAt: nowIso,
      revision: (existing.revision || DEFAULT_INITIAL_REVISION) + 1,
    };
    await writeAtomicFile(resolveSafeProjectPath(ctx.projectsDir, id), JSON.stringify(restored, null, 2));
    return { project: restored, restored: true };
  });
}

function matchesSearchQuery(record, search) {
  if (!search || typeof search !== 'string') return true;
  const term = search.trim().toLowerCase();
  if (!term) return true;
  const title = String(record.title || record.name || '').toLowerCase();
  return title.includes(term);
}

function shouldIncludeProject(record, query) {
  if (!record) return false;
  if (record.deletedAt && !query?.includeDeleted) return false;
  if (query?.type && record.type !== query.type) return false;
  if (query?.kind && record.kind !== query.kind) return false;
  if (query?.status && record.status !== query.status) return false;
  const search = query?.search ?? query?.q;
  if (!matchesSearchQuery(record, search)) return false;
  return true;
}

async function loadActiveProjects(projectsDir, files, query = {}) {
  const records = [];
  for (const fileName of files) {
    if (!fileName.endsWith(PROJECT_FILE_EXT)) continue;
    const id = fileName.slice(0, -PROJECT_FILE_EXT.length);
    if (!PROJECT_ID_PATTERN.test(id)) continue;
    const record = await readProjectFile(projectsDir, id);
    if (record && record.id === id && shouldIncludeProject(record, query)) {
      records.push(record);
    }
  }
  return records;
}

async function listProjectRecords(ctx, query = {}) {
  const { limit, offset } = normalizePagination(query);
  await ctx.init();
  const files = await readdir(ctx.projectsDir).catch(error => {
    if (error?.code === 'ENOENT') return [];
    throw new StorageError('Could not list projects from disk.', error);
  });
  const records = await loadActiveProjects(ctx.projectsDir, files, query);
  records.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const total = records.length;
  const items = records.slice(offset, offset + limit).map(toPublicProjectSummary);
  return { items, total, limit, offset, hasMore: offset + items.length < total };
}

function createDefaultWriteQueue() {
  let writeChain = Promise.resolve();
  return task => {
    const run = writeChain.then(task, task);
    writeChain = run.catch(() => {});
    return run;
  };
}

function resolveProjectsDir(projectsDir, dataDir) {
  return projectsDir ? path.resolve(projectsDir) : path.join(path.resolve(dataDir), 'projects');
}

/**
 * Creates an atomic persistent store for Voice Studio projects.
 * Inputs: `{ projectsDir, dataDir, enqueueWrite, maxDocBytes }`.
 * Outputs: ProjectStore instance with save, get, delete, list, and init methods.
 * Side effects: Creates projectsDir if missing, writes atomic JSON files.
 * Failure modes: Throws ValidationError on bad input, ConflictError on revision mismatch, StorageError on IO.
 * @param {object} config - Configuration options.
 * @returns {object} Initialized project store.
 */
export function createProjectStore({ projectsDir, dataDir, enqueueWrite, maxDocBytes = MAX_PROJECT_DOC_BYTES }) {
  const resolvedDir = resolveProjectsDir(projectsDir, dataDir);
  const effectiveEnqueue = enqueueWrite || createDefaultWriteQueue();
  const init = async () => { await mkdir(resolvedDir, { recursive: true }); };
  const ctx = { projectsDir: resolvedDir, enqueueWrite: effectiveEnqueue, init, maxDocBytes };
  return {
    init,
    projectsDir: resolvedDir,
    createProject: input => createProjectRecord(ctx, input),
    saveProject: (rawId, input, options) => saveProjectRecord(ctx, rawId, input, options),
    getProject: (rawId, options) => getProjectRecord(ctx, rawId, options),
    deleteProject: (rawId, options) => softDeleteProjectRecord(ctx, rawId, options),
    duplicateProject: (rawId, options) => duplicateProjectRecord(ctx, rawId, options),
    restoreProject: (rawId, options) => restoreProjectRecord(ctx, rawId, options),
    listProjects: query => listProjectRecords(ctx, query),
  };
}
