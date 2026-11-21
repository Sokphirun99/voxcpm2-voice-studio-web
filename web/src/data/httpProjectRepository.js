/**
 * @fileoverview HTTP repository for saved subtitle/TTS projects with localStorage fallback.
 */

import { ConflictError, ValidationError } from '../domain/errors.js';
import { normalizeProjectRecord, toProjectSummary } from '../domain/projects.js';
import {
  StorageUnavailableError,
  buildStorageApiUrl,
  requestStorageJson,
} from './httpStorageClient.js';

const PROJECTS_STORAGE_KEY = 'voxcpm.projects.v1';
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

function generateFallbackId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizePagination(query = {}) {
  const limit = Number.parseInt(String(query.limit ?? DEFAULT_PAGE_LIMIT), 10);
  const offset = Number.parseInt(String(query.offset ?? 0), 10);
  return {
    limit: Number.isFinite(limit) ? Math.min(MAX_PAGE_LIMIT, Math.max(1, limit)) : DEFAULT_PAGE_LIMIT,
    offset: Number.isFinite(offset) && offset >= 0 ? offset : 0,
  };
}

function buildProjectListQueryString(query = {}) {
  const bounds = normalizePagination(query);
  const listOffset = bounds.offset < MAX_PAGE_LIMIT ? 0 : bounds.offset;
  const listLimit = listOffset === 0 ? MAX_PAGE_LIMIT : bounds.limit;
  const params = new URLSearchParams({ limit: String(listLimit), offset: String(listOffset) });
  if (query.type) params.set('type', String(query.type));
  if (query.kind) params.set('kind', String(query.kind));
  if (query.status) params.set('status', String(query.status));
  if (query.search || query.q) params.set('search', String(query.search || query.q));
  return { queryString: params.toString(), bounds, listOffset };
}

function matchesLocalProjectQuery(project, query = {}) {
  if (project.deletedAt && !query?.includeDeleted) return false;
  if (query.type && project.type !== query.type) return false;
  if (query.kind && project.kind !== query.kind) return false;
  if (query.status && project.status !== query.status) return false;
  const term = (query.search || query.q || '').trim().toLowerCase();
  if (term) {
    const title = (project.title || project.name || '').toLowerCase();
    if (!title.includes(term)) return false;
  }
  return true;
}

function parseLocalProjectMap(raw, logger) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch (error) {
    logger?.error?.('httpProjectRepository.parseLocalProjectMap', error, { fallback: 'memory' });
    return {};
  }
}

function readLocalProjectMap(storage, localCache, logger) {
  const map = Object.fromEntries(localCache);
  if (!storage) return map;
  try {
    const raw = storage.getItem(PROJECTS_STORAGE_KEY);
    return raw ? { ...parseLocalProjectMap(raw, logger), ...map } : map;
  } catch (error) {
    logger?.error?.('httpProjectRepository.readLocalProjectMap', error, { fallback: 'memory' });
    return map;
  }
}

function writeLocalProjectMap(storage, map, logger) {
  try {
    if (!storage) return false;
    storage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(map));
    return true;
  } catch (error) {
    logger?.error?.('httpProjectRepository.writeLocalProjectMap', error);
    return false;
  }
}

function softDeleteLocalProject(storage, id, options, localCache, logger) {
  const map = readLocalProjectMap(storage, localCache, logger);
  const existing = map[id];
  if (!existing || existing.deletedAt) return false;
  assertOfflineRevisionMatch(existing, options?.expectedRevision);
  const updated = { ...existing, deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  map[id] = updated;
  writeLocalProjectMap(storage, map, logger);
  localCache.set(id, updated);
  return true;
}

function resolveStorage(storage, logger) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch (error) {
    logger?.error?.('httpProjectRepository.resolveStorage', error, { fallback: 'memory' });
    return null;
  }
}

function createLocalProjectCopy(existing, options) {
  const newId = generateFallbackId();
  const title = options?.title || options?.name || `Copy of ${existing.title || existing.name}`;
  return {
    ...existing,
    id: newId,
    title,
    name: title,
    revision: 1,
    localOnly: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
  };
}

function duplicateLocalProject(storage, id, options, localCache, logger) {
  const map = readLocalProjectMap(storage, localCache, logger);
  const existing = map[id];
  if (!existing || existing.deletedAt) return null;
  const duplicated = createLocalProjectCopy(existing, options);
  map[duplicated.id] = duplicated;
  writeLocalProjectMap(storage, map, logger);
  localCache.set(duplicated.id, duplicated);
  return { project: duplicated };
}

function restoreLocalProject(storage, id, options, localCache, logger) {
  const map = readLocalProjectMap(storage, localCache, logger);
  const existing = map[id];
  if (!existing) return null;
  assertOfflineRevisionMatch(existing, options?.expectedRevision);
  const updated = { ...existing, deletedAt: null, updatedAt: new Date().toISOString(), revision: (existing.revision || 1) + 1 };
  map[id] = updated;
  writeLocalProjectMap(storage, map, logger);
  localCache.set(id, updated);
  return { project: updated, restored: true };
}

function mergeLocalList(items, storage, localCache, logger, query) {
  const localOnly = Object.values(readLocalProjectMap(storage, localCache, logger))
    .filter(project => project?.localOnly && !items.some(item => item.id === project.id) && matchesLocalProjectQuery(project, query))
    .map(toProjectSummary);
  return [...items, ...localOnly].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

async function listProjectsFromRepo(ctx, query = {}) {
  const { queryString, bounds, listOffset } = buildProjectListQueryString(query);
  const url = buildStorageApiUrl(ctx.baseUrl, `/projects?${queryString}`);
  try {
    const { data, meta } = await requestStorageJson({ fetchImpl: ctx.fetchImpl, url });
    const items = Array.isArray(data?.items) ? data.items : [];
    const merged = mergeLocalList(items, ctx.storage, ctx.localCache, ctx.logger, query);
    const page = listOffset === 0 ? merged.slice(bounds.offset, bounds.offset + bounds.limit) : items;
    const total = (Number(meta.total) || items.length) + (merged.length - items.length);
    return { items: page, total, limit: bounds.limit, offset: bounds.offset, hasMore: bounds.offset + page.length < total };
  } catch (error) {
    if (!(error instanceof StorageUnavailableError)) throw error;
    ctx.logger?.warn?.('httpProjectRepository.listProjects', error.message, { fallback: 'localStorage' });
    const map = readLocalProjectMap(ctx.storage, ctx.localCache, ctx.logger);
    const items = Object.values(map).filter(p => matchesLocalProjectQuery(p, query)).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    const page = items.slice(bounds.offset, bounds.offset + bounds.limit);
    return { items: page, total: items.length, limit: bounds.limit, offset: bounds.offset, hasMore: bounds.offset + page.length < items.length };
  }
}

function cacheProjectLocally(ctx, project) {
  ctx.localCache.set(project.id, project);
  const map = readLocalProjectMap(ctx.storage, ctx.localCache, ctx.logger);
  map[project.id] = project;
  writeLocalProjectMap(ctx.storage, map, ctx.logger);
}

function handleGetProjectFallback(ctx, id, error) {
  if (error instanceof StorageUnavailableError) {
    const item = readLocalProjectMap(ctx.storage, ctx.localCache, ctx.logger)[id];
    return item && !item.deletedAt ? item : null;
  }
  if (error?.code === 'PROJECT_NOT_FOUND' || error?.status === 404) {
    const cached = readLocalProjectMap(ctx.storage, ctx.localCache, ctx.logger)[id];
    return cached?.localOnly && !cached.deletedAt ? cached : null;
  }
  throw error;
}

async function getProjectFromRepo(ctx, id) {
  const url = buildStorageApiUrl(ctx.baseUrl, `/projects/${encodeURIComponent(id)}`);
  try {
    const { data } = await requestStorageJson({ fetchImpl: ctx.fetchImpl, url });
    if (data?.project) cacheProjectLocally(ctx, data.project);
    return data?.project ?? null;
  } catch (error) {
    return handleGetProjectFallback(ctx, id, error);
  }
}

function buildNormalizedProject(project, localMap, id) {
  const now = new Date().toISOString();
  const kind = project.kind || (project.type === 'tts' ? 'tts' : 'subtitle');
  const payload = project.payload && typeof project.payload === 'object' && !Array.isArray(project.payload)
    ? project.payload
    : (project.settings || {});
  return normalizeProjectRecord({
    ...project,
    kind,
    payload,
    id,
    createdAt: localMap[id]?.createdAt || project.createdAt || now,
    updatedAt: now,
    deletedAt: null,
  });
}

function saveProjectOfflineFallback(ctx, normalized, isCreated) {
  const map = readLocalProjectMap(ctx.storage, ctx.localCache, ctx.logger);
  const prevRev = map[normalized.id]?.revision;
  const revision = normalized.revision || (isCreated ? 1 : (Number(prevRev || 1) + 1));
  const saved = { ...normalized, id: normalized.id, revision, localOnly: true };
  map[normalized.id] = saved;
  writeLocalProjectMap(ctx.storage, map, ctx.logger);
  ctx.localCache.set(normalized.id, saved);
  return { project: saved, isCreated };
}

function buildRevisionHeaders(options, baseHeaders = {}) {
  const headers = { ...baseHeaders };
  if (options?.expectedRevision !== undefined && options?.expectedRevision !== null) {
    headers['if-match'] = String(options.expectedRevision);
  }
  return headers;
}

function assertOfflineRevisionMatch(cached, expectedRevision) {
  if (!expectedRevision || !cached) return;
  const current = Number(cached.revision || 1);
  if (current !== Number(expectedRevision)) {
    throw new ConflictError(`Project revision mismatch. Expected ${expectedRevision} but found ${current}.`);
  }
}

function handleProjectConflictError(error) {
  if (error?.status === 409 || error?.code === 'PROJECT_ALREADY_EXISTS' || error?.code === 'REVISION_CONFLICT') {
    throw new ConflictError(error.message, { code: error.code || 'REVISION_CONFLICT' });
  }
}

function createProjectOffline(ctx, normalized, localMap) {
  if (localMap[normalized.id] && !localMap[normalized.id].deletedAt) {
    throw new ConflictError(`Project ${normalized.id} already exists.`, { code: 'PROJECT_ALREADY_EXISTS' });
  }
  return saveProjectOfflineFallback(ctx, normalized, true);
}

async function createProjectInRepo(ctx, project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    throw new ValidationError('Project snapshot is required.', 'project', 'INVALID_PROJECT_RECORD');
  }
  const id = project.id || generateFallbackId();
  const localMap = readLocalProjectMap(ctx.storage, ctx.localCache, ctx.logger);
  const normalized = buildNormalizedProject(project, localMap, id);
  const url = buildStorageApiUrl(ctx.baseUrl, '/projects');
  try {
    const res = await requestStorageJson({ fetchImpl: ctx.fetchImpl, url, options: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(normalized) } });
    const saved = { ...(res?.data?.project || normalized), localOnly: false };
    cacheProjectLocally(ctx, saved);
    return { project: saved, isCreated: true };
  } catch (error) {
    handleProjectConflictError(error);
    if (!(error instanceof StorageUnavailableError)) throw error;
    return createProjectOffline(ctx, normalized, localMap);
  }
}

function assertProjectSnapshot(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    throw new ValidationError('Project snapshot is required.', 'project', 'INVALID_PROJECT_RECORD');
  }
}

function buildSaveProjectUrl(baseUrl, id, options) {
  const revQuery = options.expectedRevision ? `?expectedRevision=${options.expectedRevision}` : '';
  return buildStorageApiUrl(baseUrl, `/projects/${encodeURIComponent(id)}${revQuery}`);
}

function normalizeSaveProjectArgs(projectOrId, snapshotOrOptions, maybeOptions) {
  if (typeof projectOrId === 'string' && projectOrId.trim()) {
    const id = projectOrId.trim();
    const snapshot = typeof snapshotOrOptions === 'object' && snapshotOrOptions !== null ? snapshotOrOptions : {};
    const options = typeof maybeOptions === 'object' && maybeOptions !== null ? maybeOptions : {};
    return { id, snapshot: { ...snapshot, id }, options };
  }
  const isDirectSnapshot = typeof projectOrId === 'object' && projectOrId !== null;
  const snapshot = isDirectSnapshot
    ? projectOrId
    : (typeof snapshotOrOptions === 'object' && snapshotOrOptions !== null ? snapshotOrOptions : {});
  const options = isDirectSnapshot
    ? (typeof snapshotOrOptions === 'object' && snapshotOrOptions !== null ? snapshotOrOptions : {})
    : (typeof maybeOptions === 'object' && maybeOptions !== null ? maybeOptions : {});
  const id = snapshot.id || generateFallbackId();
  return { id, snapshot: { ...snapshot, id }, options };
}

async function saveProjectToRepo(ctx, projectOrId, snapshotOrOptions = {}, maybeOptions = {}) {
  const { id, snapshot, options } = normalizeSaveProjectArgs(projectOrId, snapshotOrOptions, maybeOptions);
  assertProjectSnapshot(snapshot);
  const localMap = readLocalProjectMap(ctx.storage, ctx.localCache, ctx.logger);
  const normalized = buildNormalizedProject(snapshot, localMap, id);
  const url = buildSaveProjectUrl(ctx.baseUrl, normalized.id, options);
  const headers = buildRevisionHeaders(options, { 'content-type': 'application/json' });
  try {
    const res = await requestStorageJson({ fetchImpl: ctx.fetchImpl, url, options: { method: 'PUT', headers, body: JSON.stringify(normalized) } });
    const saved = { ...(res?.data?.project || normalized), localOnly: false };
    cacheProjectLocally(ctx, saved);
    return { project: saved, isCreated: res.status === 201 };
  } catch (error) {
    handleProjectConflictError(error);
    if (!(error instanceof StorageUnavailableError)) throw error;
    assertOfflineRevisionMatch(localMap[normalized.id], options.expectedRevision);
    return saveProjectOfflineFallback(ctx, normalized, !localMap[normalized.id]);
  }
}

async function duplicateProjectInRepo(ctx, id, options = {}) {
  const url = buildStorageApiUrl(ctx.baseUrl, `/projects/${encodeURIComponent(id)}/duplicate`);
  const body = JSON.stringify({ title: options.title || options.name });
  try {
    const { data } = await requestStorageJson({ fetchImpl: ctx.fetchImpl, url, options: { method: 'POST', headers: { 'content-type': 'application/json' }, body } });
    if (data?.project) cacheProjectLocally(ctx, data.project);
    return data?.project ? { project: data.project } : null;
  } catch (error) {
    handleProjectConflictError(error);
    if (error instanceof StorageUnavailableError) return duplicateLocalProject(ctx.storage, id, options, ctx.localCache, ctx.logger);
    throw error;
  }
}

async function restoreProjectInRepo(ctx, id, options = {}) {
  const revQuery = options.expectedRevision ? `?expectedRevision=${options.expectedRevision}` : '';
  const url = buildStorageApiUrl(ctx.baseUrl, `/projects/${encodeURIComponent(id)}/restore${revQuery}`);
  const headers = buildRevisionHeaders(options);
  try {
    const { data } = await requestStorageJson({ fetchImpl: ctx.fetchImpl, url, options: { method: 'POST', headers } });
    if (data?.project) cacheProjectLocally(ctx, data.project);
    return data?.project ? { project: data.project, restored: data.restored ?? true } : null;
  } catch (error) {
    handleProjectConflictError(error);
    if (error instanceof StorageUnavailableError) return restoreLocalProject(ctx.storage, id, options, ctx.localCache, ctx.logger);
    throw error;
  }
}

function handleDeleteProjectFallback(ctx, id, error, options = {}) {
  if (error instanceof StorageUnavailableError) {
    const deleted = softDeleteLocalProject(ctx.storage, id, options, ctx.localCache, ctx.logger);
    if (!deleted) throw new ValidationError('Project was not found.', 'id', 'PROJECT_NOT_FOUND');
    return { deleted: true, id };
  }
  if (error?.code === 'PROJECT_NOT_FOUND' || error?.status === 404) {
    const cached = readLocalProjectMap(ctx.storage, ctx.localCache, ctx.logger)[id];
    if (cached?.localOnly) {
      softDeleteLocalProject(ctx.storage, id, options, ctx.localCache, ctx.logger);
      return { deleted: true, id };
    }
    throw new ValidationError('Project was not found.', 'id', 'PROJECT_NOT_FOUND');
  }
  throw error;
}

async function deleteProjectFromRepo(ctx, id, options = {}) {
  const revQuery = options.expectedRevision ? `?expectedRevision=${options.expectedRevision}` : '';
  const url = buildStorageApiUrl(ctx.baseUrl, `/projects/${encodeURIComponent(id)}${revQuery}`);
  const headers = buildRevisionHeaders(options);
  try {
    await requestStorageJson({ fetchImpl: ctx.fetchImpl, url, options: { method: 'DELETE', headers } });
  } catch (error) {
    handleProjectConflictError(error);
    return handleDeleteProjectFallback(ctx, id, error, options);
  }
  softDeleteLocalProject(ctx.storage, id, options, ctx.localCache, ctx.logger);
  return { deleted: true, id };
}

/**
 * Creates a project repository backed by `/api/v1/projects` with a localStorage fallback
 * when the Docker storage container is temporarily offline.
 * Inputs: `{ baseUrl, fetchImpl, storage, logger }`.
 * Outputs: `{ listProjects, getProject, saveProject, createProject, duplicateProject, restoreProject, deleteProject }`.
 * Side effects: persists projects to localStorage on offline fallback; logs structured details.
 * Failure modes: logs errors without swallowing silently; surfaces storage failures to callers.
 * @param {{ baseUrl?: string, fetchImpl?: typeof fetch, storage?: Storage, logger?: object }} [deps] - Repository deps.
 * @returns {object} Project repository.
 */
export function createHttpProjectRepository({
  baseUrl = '/api/v1',
  fetchImpl = globalThis.fetch,
  storage: storageOption,
  logger,
} = {}) {
  const storage = resolveStorage(storageOption, logger);
  const localCache = new Map();
  const ctx = { baseUrl, fetchImpl, storage, localCache, logger };
  return {
    listProjects: query => listProjectsFromRepo(ctx, query),
    getProject: id => getProjectFromRepo(ctx, id),
    saveProject: (projectOrId, snapshotOrOptions, maybeOptions) =>
      saveProjectToRepo(ctx, projectOrId, snapshotOrOptions, maybeOptions),
    createProject: project => createProjectInRepo(ctx, project),
    duplicateProject: (id, options) => duplicateProjectInRepo(ctx, id, options),
    restoreProject: (id, options) => restoreProjectInRepo(ctx, id, options),
    deleteProject: (id, options) => deleteProjectFromRepo(ctx, id, options),
  };
}
