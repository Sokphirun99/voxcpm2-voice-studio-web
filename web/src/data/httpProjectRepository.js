/**
 * @fileoverview HTTP repository for saved subtitle/TTS projects with localStorage fallback.
 */

import { ValidationError } from '../domain/errors.js';
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

/**
 * Normalizes bounded pagination parameters.
 * @param {{ limit?: unknown, offset?: unknown }} [query] - Query bounds.
 * @returns {{ limit: number, offset: number }} Clamped pagination bounds.
 */
function normalizePagination(query = {}) {
  const limit = Number.parseInt(String(query.limit ?? DEFAULT_PAGE_LIMIT), 10);
  const offset = Number.parseInt(String(query.offset ?? 0), 10);
  return {
    limit: Number.isFinite(limit) ? Math.min(MAX_PAGE_LIMIT, Math.max(1, limit)) : DEFAULT_PAGE_LIMIT,
    offset: Number.isFinite(offset) && offset >= 0 ? offset : 0,
  };
}

/**
 * Reads the fallback in-memory/localStorage project map.
 * @param {Storage|null|undefined} storage - Web Storage instance.
 * @returns {Record<string, object>} Project id -> snapshot map.
 */
function readLocalProjectMap(storage, localCache, logger) {
  const map = Object.fromEntries(localCache);
  if (!storage) return map;
  let raw;
  try {
    raw = storage.getItem(PROJECTS_STORAGE_KEY);
  } catch (error) {
    logger?.error?.('httpProjectRepository.readLocalProjectMap', error, { fallback: 'memory' });
    return map;
  }
  if (!raw) return map;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logger?.error?.('httpProjectRepository.parseLocalProjectMap', error, { fallback: 'memory' });
    return map;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger?.error?.('httpProjectRepository.validateLocalProjectMap', new Error('Stored project map must be an object.'), { fallback: 'memory' });
    return map;
  }
  return { ...parsed, ...map };
}

/**
 * Persists the fallback project map to localStorage.
 * @param {Storage|null|undefined} storage - Web Storage instance.
 * @param {Record<string, object>} map - Project id -> snapshot map.
 * @param {object} [logger] - Application logger.
 */
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

/**
 * Removes one project from the fallback map.
 * @param {Storage|null|undefined} storage - Web Storage instance.
 * @param {string} id - Project id.
 * @param {object} [logger] - Application logger.
 */
function removeLocalProject(storage, id, localCache, logger) {
  const map = readLocalProjectMap(storage, localCache, logger);
  delete map[id];
  localCache.delete(id);
  if (!storage) return;
  try {
    writeLocalProjectMap(storage, map, logger);
  } catch (error) {
    logger?.error?.('httpProjectRepository.removeLocalProject', error, { id });
  }
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

/**
 * Creates a project repository backed by `/api/v1/projects` with a localStorage fallback
 * when the Docker storage container is temporarily offline.
 * Inputs: `{ baseUrl, fetchImpl, storage, logger }`.
 * Outputs: `{ listProjects, getProject, saveProject, deleteProject }`.
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

  async function listProjects({ limit, offset } = {}) {
    const bounds = normalizePagination({ limit, offset });
    const listOffset = bounds.offset < MAX_PAGE_LIMIT ? 0 : bounds.offset;
    const listLimit = listOffset === 0 ? MAX_PAGE_LIMIT : bounds.limit;
    const url = buildStorageApiUrl(baseUrl, `/projects?limit=${listLimit}&offset=${listOffset}`);
    try {
      const { data, meta } = await requestStorageJson({ fetchImpl, url });
      const items = Array.isArray(data?.items) ? data.items : [];
      const localOnly = Object.values(readLocalProjectMap(storage, localCache, logger))
        .filter(project => project?.localOnly && !items.some(item => item.id === project.id))
        .map(toProjectSummary);
      const merged = [...items, ...localOnly].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      const page = listOffset === 0
        ? merged.slice(bounds.offset, bounds.offset + bounds.limit)
        : items;
      const total = (Number(meta.total) || items.length) + localOnly.length;
      return { items: page, total, limit: bounds.limit, offset: bounds.offset, hasMore: bounds.offset + page.length < total };
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        logger?.warn?.('httpProjectRepository.listProjects', error.message, { fallback: 'localStorage' });
        const map = readLocalProjectMap(storage, localCache, logger);
        const items = Object.values(map).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
        const page = items.slice(bounds.offset, bounds.offset + bounds.limit);
        return { items: page, total: items.length, limit: bounds.limit, offset: bounds.offset, hasMore: bounds.offset + page.length < items.length };
      }
      logger?.error?.('httpProjectRepository.listProjects', error);
      throw error;
    }
  }

  async function getProject(id) {
    const url = buildStorageApiUrl(baseUrl, `/projects/${encodeURIComponent(id)}`);
    try {
      const { data } = await requestStorageJson({ fetchImpl, url });
      if (data?.project) {
        localCache.set(data.project.id, data.project);
        const map = readLocalProjectMap(storage, localCache, logger);
        map[data.project.id] = data.project;
        writeLocalProjectMap(storage, map, logger);
      }
      return data?.project ?? null;
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        logger?.warn?.('httpProjectRepository.getProject', error.message, { id, fallback: 'localStorage' });
        const map = readLocalProjectMap(storage, localCache, logger);
        return map[id] ?? null;
      }
      if (error?.code === 'PROJECT_NOT_FOUND' || error?.status === 404) {
        const cached = readLocalProjectMap(storage, localCache, logger)[id];
        return cached?.localOnly ? cached : null;
      }
      logger?.error?.('httpProjectRepository.getProject', error, { id });
      throw error;
    }
  }

  async function saveProject(project) {
    if (!project || typeof project !== 'object' || Array.isArray(project)) {
      throw new ValidationError('Project snapshot is required.', 'project', 'INVALID_PROJECT_RECORD');
    }
    const now = new Date().toISOString();
    const id = project.id || generateFallbackId();
    const localMap = readLocalProjectMap(storage, localCache, logger);
    let normalized;
    try {
      normalized = normalizeProjectRecord({
        ...project,
        id,
        createdAt: localMap[id]?.createdAt || project.createdAt || now,
        updatedAt: now,
        deletedAt: null,
      });
    } catch (error) {
      logger?.error?.('httpProjectRepository.validateProject', error, { id });
      throw error;
    }
    const url = buildStorageApiUrl(baseUrl, `/projects/${encodeURIComponent(normalized.id)}`);
    let remoteResult;
    try {
      remoteResult = await requestStorageJson({ fetchImpl, url, options: { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(normalized) } });
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        logger?.warn?.('httpProjectRepository.saveProject', error.message, { id: normalized.id, fallback: 'localStorage' });
        const map = readLocalProjectMap(storage, localCache, logger);
        const fallbackId = normalized.id;
        const saved = { ...normalized, id: fallbackId, localOnly: true };
        map[fallbackId] = saved;
        writeLocalProjectMap(storage, map, logger);
        localCache.set(fallbackId, saved);
        return { project: saved, isCreated: !localMap[fallbackId] };
      }
      logger?.error?.('httpProjectRepository.saveProject', error, { id: normalized.id });
      throw error;
    }
    const saved = { ...(remoteResult?.data?.project || normalized), localOnly: false };
    try {
      const map = readLocalProjectMap(storage, localCache, logger);
      map[saved.id] = saved;
      writeLocalProjectMap(storage, map, logger);
      localCache.set(saved.id, saved);
    } catch (error) {
      logger?.error?.('httpProjectRepository.saveProject.localCache', error, { id: saved.id });
    }
    return { project: saved, isCreated: remoteResult.status === 201 };
  }

  async function deleteProject(id) {
    const url = buildStorageApiUrl(baseUrl, `/projects/${encodeURIComponent(id)}`);
    try {
      await requestStorageJson({ fetchImpl, url, options: { method: 'DELETE' } });
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        logger?.warn?.('httpProjectRepository.deleteProject', error.message, { id, fallback: 'localStorage' });
        removeLocalProject(storage, id, localCache, logger);
        return { deleted: true, id };
      }
      if (error?.code === 'PROJECT_NOT_FOUND' || error?.status === 404) {
        const cached = readLocalProjectMap(storage, localCache, logger)[id];
        if (cached?.localOnly) {
          removeLocalProject(storage, id, localCache, logger);
          return { deleted: true, id };
        }
        throw new ValidationError('Project was not found.', 'id', 'PROJECT_NOT_FOUND');
      }
      logger?.error?.('httpProjectRepository.deleteProject', error, { id });
      throw error;
    }
    removeLocalProject(storage, id, localCache, logger);
    return { deleted: true, id };
  }

  return { listProjects, getProject, saveProject, deleteProject };
}
