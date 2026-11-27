/**
 * @fileoverview HTTP repository adapter for persistent batch jobs with bounded offline localStorage fallback.
 */

import { ConflictError, ValidationError } from '../domain/errors.js';
import {
  ACTIVE_JOB_STATUSES,
  IN_FLIGHT_JOB_STATUSES,
  MAX_ACTIVE_QUEUED_JOBS,
  MAX_STORED_JOBS,
  PRUNABLE_HISTORY_STATUSES,
  applyJobLifecycleAction,
  assertActiveQueueCapacity,
  createQueuedProductionJob,
  evaluateQueueAdmission,
  markJobInterrupted,
  normalizeProductionJob,
  summarizeJobs,
  toJobSummary,
} from '../domain/productionJobs.js';
import { StorageUnavailableError, buildStorageApiUrl, requestStorageJson } from './httpStorageClient.js';

const JOBS_STORAGE_KEY = 'voxcpm.jobs.v1';
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

function resolveStorage(storageOpt, logger) {
  if (storageOpt !== undefined) return storageOpt;
  try {
    return globalThis.localStorage ?? null;
  } catch (error) {
    logger?.error?.('httpJobRepository.resolveStorage', error, { fallback: 'memory' });
    return null;
  }
}

function parseLocalJobMap(raw, logger) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch (error) {
    logger?.error?.('httpJobRepository.parseLocalJobMap', error, { fallback: 'memory' });
    return {};
  }
}

function readLocalJobMap(ctx) {
  const fromMemory = Object.fromEntries(ctx.localCache);
  if (!ctx.storage) return fromMemory;
  try {
    const raw = ctx.storage.getItem(JOBS_STORAGE_KEY);
    if (!raw) {
      ctx.localCache.clear();
      return {};
    }
    const parsed = parseLocalJobMap(raw, ctx.logger);
    ctx.localCache.clear();
    for (const [id, value] of Object.entries(parsed)) ctx.localCache.set(id, value);
    return parsed;
  } catch (error) {
    ctx.logger?.error?.('httpJobRepository.readLocalJobMap', error, { fallback: 'memory' });
    return fromMemory;
  }
}

function writeLocalJobMap(ctx, map) {
  ctx.localCache.clear();
  for (const [id, value] of Object.entries(map)) ctx.localCache.set(id, value);
  if (!ctx.storage) return;
  try {
    ctx.storage.setItem(JOBS_STORAGE_KEY, JSON.stringify(map));
  } catch (error) {
    ctx.logger?.error?.('httpJobRepository.writeLocalJobMap', error);
  }
}

function buildRevisionHeaders(options, baseHeaders = {}) {
  const headers = { ...baseHeaders };
  if (options?.expectedRevision !== undefined && options?.expectedRevision !== null) {
    headers['if-match'] = String(options.expectedRevision);
  }
  return headers;
}

function rethrowMappedApiError(error) {
  if (error?.status === 409 || error?.code === 'REVISION_CONFLICT' || error?.code === 'INVALID_JOB_TRANSITION' || error?.code === 'JOB_ACTIVE_DELETE_BLOCKED' || error?.code === 'JOB_ALREADY_EXISTS') {
    throw new ConflictError(error.message, { code: error.code || 'REVISION_CONFLICT' });
  }
  if (error?.status === 400 || error?.status === 422 || error?.code === 'JOB_QUEUE_FULL' || error?.code === 'MAX_RETRIES_EXCEEDED') {
    throw new ValidationError(error.message, error.field || 'queue', error.code || 'VALIDATION_ERROR');
  }
}

function normalizePagination(query = {}) {
  const limit = Number.parseInt(String(query.limit ?? DEFAULT_PAGE_LIMIT), 10);
  const offset = Number.parseInt(String(query.offset ?? 0), 10);
  return {
    limit: Number.isFinite(limit) ? Math.min(MAX_PAGE_LIMIT, Math.max(1, limit)) : DEFAULT_PAGE_LIMIT,
    offset: Number.isFinite(offset) && offset >= 0 ? offset : 0,
  };
}

function buildJobListQuery(query = {}) {
  const bounds = normalizePagination(query);
  const params = new URLSearchParams({ limit: String(bounds.limit), offset: String(bounds.offset) });
  if (query.status && query.status !== 'all') params.set('status', String(query.status));
  if (query.type) params.set('type', String(query.type));
  if (query.projectId) params.set('projectId', String(query.projectId));
  if (query.search) params.set('search', String(query.search));
  return { queryString: params.toString(), bounds };
}

function matchesLocalStatusFilter(jobStatus, rawFilter) {
  if (!rawFilter || rawFilter === 'all') return true;
  if (rawFilter === 'active') return ACTIVE_JOB_STATUSES.has(jobStatus);
  const set = new Set(String(rawFilter).split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  return set.size === 0 || set.has(jobStatus);
}

function matchesLocalQuery(job, query = {}) {
  if (!job || job.deletedAt) return false;
  if (query.type && job.type !== query.type) return false;
  if (query.projectId && job.projectId !== query.projectId) return false;
  if (query.status && !matchesLocalStatusFilter(job.status, query.status)) return false;
  const term = typeof query.search === 'string' ? query.search.trim().toLowerCase() : '';
  if (term && !`${job.title || ''} ${job.projectTitle || ''}`.toLowerCase().includes(term)) return false;
  return true;
}

function safeNormalizeLocalJob(raw, logger) {
  try {
    return normalizeProductionJob(raw);
  } catch (error) {
    logger?.warn?.('httpJobRepository.safeNormalizeLocalJob', error?.message || 'Skipped malformed offline job record');
    return null;
  }
}

function listOfflineJobs(ctx, query = {}) {
  const bounds = normalizePagination(query);
  const all = Object.values(readLocalJobMap(ctx)).map(item => safeNormalizeLocalJob(item, ctx.logger)).filter(Boolean);
  const summary = summarizeJobs(all);
  const filtered = all.filter(job => matchesLocalQuery(job, query))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const items = filtered.slice(bounds.offset, bounds.offset + bounds.limit).map(toJobSummary);
  return { items, total: filtered.length, limit: bounds.limit, offset: bounds.offset, hasMore: bounds.offset + items.length < filtered.length, summary };
}

function syncOnlineListMirror(ctx, items, query, hasMore, offset) {
  const isUnfilteredFullSnapshot = offset === 0 && !hasMore && !query.type && !query.projectId && !query.search && (!query.status || query.status === 'all');
  const map = isUnfilteredFullSnapshot ? {} : readLocalJobMap(ctx);
  for (const job of items) {
    if (job?.id) map[job.id] = { ...job, localOnly: false };
  }
  writeLocalJobMap(ctx, map);
}

async function listJobsFromRepo(ctx, query = {}) {
  const { queryString, bounds } = buildJobListQuery(query);
  const url = buildStorageApiUrl(ctx.baseUrl, `/jobs?${queryString}`);
  try {
    const { data, meta } = await requestStorageJson({ fetchImpl: ctx.fetchImpl, url });
    const items = Array.isArray(data?.items) ? data.items : [];
    const total = Number.isFinite(Number(meta?.total)) ? Number(meta.total) : items.length;
    const limit = Number.isFinite(Number(meta?.limit)) && Number(meta.limit) > 0 ? Number(meta.limit) : bounds.limit;
    const offset = Number.isFinite(Number(meta?.offset)) && Number(meta.offset) >= 0 ? Number(meta.offset) : bounds.offset;
    const hasMore = Boolean(meta?.hasMore);
    syncOnlineListMirror(ctx, items, query, hasMore, offset);
    return {
      items,
      total,
      limit,
      offset,
      hasMore,
      summary: meta?.summary || summarizeJobs(items),
    };
  } catch (error) {
    if (!(error instanceof StorageUnavailableError)) throw error;
    ctx.logger?.warn?.('httpJobRepository.listJobs', error.message, { fallback: 'localStorage' });
    return listOfflineJobs(ctx, query);
  }
}

async function getJobFromRepo(ctx, id) {
  const url = buildStorageApiUrl(ctx.baseUrl, `/jobs/${encodeURIComponent(id)}`);
  try {
    const { data } = await requestStorageJson({ fetchImpl: ctx.fetchImpl, url });
    if (data?.job) {
      const map = readLocalJobMap(ctx);
      map[id] = { ...data.job, localOnly: false };
      writeLocalJobMap(ctx, map);
    }
    return data?.job ?? null;
  } catch (error) {
    if (error?.status === 404 || error?.code === 'JOB_NOT_FOUND') return null;
    if (!(error instanceof StorageUnavailableError)) throw error;
    const local = readLocalJobMap(ctx)[id];
    const normalized = local && !local.deletedAt ? safeNormalizeLocalJob(local, ctx.logger) : null;
    return normalized ? toJobSummary(normalized) : null;
  }
}

function enqueueJobOffline(ctx, spec) {
  const job = createQueuedProductionJob(spec);
  const map = readLocalJobMap(ctx);
  if (map[job.id] && !map[job.id].deletedAt) {
    throw new ConflictError(`Job ${job.id} already exists.`, { code: 'JOB_ALREADY_EXISTS' });
  }
  const all = Object.values(map).map(item => safeNormalizeLocalJob(item, ctx.logger)).filter(Boolean);
  const evictedIds = evaluateQueueAdmission(all, { maxJobs: ctx.maxJobs, maxActiveJobs: ctx.maxActiveJobs });
  for (const victimId of evictedIds) delete map[victimId];
  const stored = { ...toJobSummary(job), localOnly: true };
  map[job.id] = stored;
  writeLocalJobMap(ctx, map);
  return { job: stored, evictedIds };
}

async function enqueueJobInRepo(ctx, spec) {
  const candidate = createQueuedProductionJob(spec);
  const url = buildStorageApiUrl(ctx.baseUrl, '/jobs');
  try {
    const { data, meta } = await requestStorageJson({
      fetchImpl: ctx.fetchImpl,
      url,
      options: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(candidate) },
    });
    const saved = { ...data.job, localOnly: false };
    const evictedIds = Array.isArray(meta?.evictedIds) ? meta.evictedIds : [];
    const map = readLocalJobMap(ctx);
    for (const victimId of evictedIds) delete map[victimId];
    map[saved.id] = saved;
    writeLocalJobMap(ctx, map);
    return { job: saved, evictedIds };
  } catch (error) {
    rethrowMappedApiError(error);
    if (!(error instanceof StorageUnavailableError)) throw error;
    return enqueueJobOffline(ctx, candidate);
  }
}

function assertOfflineRevisionMatch(existing, expectedRevision) {
  if (expectedRevision === undefined || expectedRevision === null || expectedRevision === '') return;
  const expected = Number(expectedRevision);
  if (!Number.isInteger(expected) || expected < 1) {
    throw new ValidationError('Expected revision must be a positive integer.', 'expectedRevision', 'INVALID_REVISION');
  }
  if (Number(existing.revision) !== expected) {
    throw new ConflictError(`Job revision mismatch. Expected ${expected} but found ${existing.revision}.`, {
      code: 'REVISION_CONFLICT',
    });
  }
}

function mutateJobOffline(ctx, id, patch, options = {}) {
  const map = readLocalJobMap(ctx);
  const raw = map[id];
  if (!raw || raw.deletedAt) throw new ValidationError('Batch job was not found.', 'jobId', 'JOB_NOT_FOUND');
  const existing = normalizeProductionJob(raw);
  assertOfflineRevisionMatch(existing, options.expectedRevision);
  const nextEntity = applyJobLifecycleAction(existing, patch);
  if (!ACTIVE_JOB_STATUSES.has(existing.status) && ACTIVE_JOB_STATUSES.has(nextEntity.status)) {
    const all = Object.values(map).map(item => safeNormalizeLocalJob(item, ctx.logger)).filter(Boolean);
    assertActiveQueueCapacity(all, ctx.maxActiveJobs);
  }
  const updated = { ...toJobSummary(nextEntity), localOnly: true };
  map[id] = updated;
  writeLocalJobMap(ctx, map);
  return { job: updated };
}

async function postJobAction(ctx, id, actionPath, body = {}, options = {}) {
  const url = buildStorageApiUrl(ctx.baseUrl, `/jobs/${encodeURIComponent(id)}/${actionPath}`);
  const headers = buildRevisionHeaders(options, { 'content-type': 'application/json' });
  try {
    const { data } = await requestStorageJson({
      fetchImpl: ctx.fetchImpl,
      url,
      options: { method: 'POST', headers, body: JSON.stringify(body) },
    });
    if (data?.job) {
      const map = readLocalJobMap(ctx);
      map[id] = { ...data.job, localOnly: false };
      writeLocalJobMap(ctx, map);
    }
    return { job: data.job };
  } catch (error) {
    rethrowMappedApiError(error);
    if (!(error instanceof StorageUnavailableError)) throw error;
    return mutateJobOffline(ctx, id, { action: actionPath, ...body }, options);
  }
}

async function updateJobInRepo(ctx, id, patch, options = {}) {
  const url = buildStorageApiUrl(ctx.baseUrl, `/jobs/${encodeURIComponent(id)}`);
  const headers = buildRevisionHeaders(options, { 'content-type': 'application/json' });
  try {
    const { data } = await requestStorageJson({
      fetchImpl: ctx.fetchImpl,
      url,
      options: { method: 'PATCH', headers, body: JSON.stringify(patch) },
    });
    if (data?.job) {
      const map = readLocalJobMap(ctx);
      map[id] = { ...data.job, localOnly: false };
      writeLocalJobMap(ctx, map);
    }
    return { job: data.job };
  } catch (error) {
    rethrowMappedApiError(error);
    if (!(error instanceof StorageUnavailableError)) throw error;
    return mutateJobOffline(ctx, id, patch, options);
  }
}

async function recoverOfflineJobs(ctx) {
  const map = readLocalJobMap(ctx);
  const recovered = [];
  for (const [id, raw] of Object.entries(map)) {
    const job = safeNormalizeLocalJob(raw, ctx.logger);
    if (!job || !IN_FLIGHT_JOB_STATUSES.has(job.status)) continue;
    const interrupted = { ...toJobSummary(markJobInterrupted(job)), localOnly: true };
    map[id] = interrupted;
    recovered.push(interrupted);
  }
  if (recovered.length > 0) writeLocalJobMap(ctx, map);
  return { recoveredCount: recovered.length, jobs: recovered };
}

async function recoverJobsInRepo(ctx) {
  const url = buildStorageApiUrl(ctx.baseUrl, '/jobs/recover');
  try {
    const { data } = await requestStorageJson({ fetchImpl: ctx.fetchImpl, url, options: { method: 'POST' } });
    const recoveredJobs = Array.isArray(data?.jobs) ? data.jobs : [];
    if (recoveredJobs.length > 0) {
      const map = readLocalJobMap(ctx);
      for (const job of recoveredJobs) {
        if (job?.id) map[job.id] = { ...job, localOnly: false };
      }
      writeLocalJobMap(ctx, map);
    }
    return { recoveredCount: data?.recoveredCount || 0, jobs: recoveredJobs };
  } catch (error) {
    if (!(error instanceof StorageUnavailableError)) throw error;
    return recoverOfflineJobs(ctx);
  }
}

async function deleteJobFromRepo(ctx, id, options = {}) {
  const hasRev = options.expectedRevision !== undefined && options.expectedRevision !== null && options.expectedRevision !== '';
  const revQuery = hasRev ? `?expectedRevision=${encodeURIComponent(String(options.expectedRevision))}` : '';
  const url = buildStorageApiUrl(ctx.baseUrl, `/jobs/${encodeURIComponent(id)}${revQuery}`);
  try {
    const { data } = await requestStorageJson({ fetchImpl: ctx.fetchImpl, url, options: { method: 'DELETE', headers: buildRevisionHeaders(options) } });
    const map = readLocalJobMap(ctx);
    delete map[id];
    writeLocalJobMap(ctx, map);
    return data;
  } catch (error) {
    rethrowMappedApiError(error);
    if (!(error instanceof StorageUnavailableError)) throw error;
    const map = readLocalJobMap(ctx);
    const existing = map[id] ? safeNormalizeLocalJob(map[id], ctx.logger) : null;
    if (!existing) throw new ValidationError('Batch job was not found.', 'jobId', 'JOB_NOT_FOUND');
    assertOfflineRevisionMatch(existing, options.expectedRevision);
    if (ACTIVE_JOB_STATUSES.has(existing.status)) {
      throw new ConflictError('Cancel or interrupt an active job before removing it.', { code: 'JOB_ACTIVE_DELETE_BLOCKED' });
    }
    delete map[id];
    writeLocalJobMap(ctx, map);
    return { deleted: true, id };
  }
}

async function clearHistoryInRepo(ctx) {
  const url = buildStorageApiUrl(ctx.baseUrl, '/jobs/clear-history');
  try {
    const { data } = await requestStorageJson({ fetchImpl: ctx.fetchImpl, url, options: { method: 'POST' } });
    const map = readLocalJobMap(ctx);
    let mutated = false;
    for (const [id, raw] of Object.entries(map)) {
      if (PRUNABLE_HISTORY_STATUSES.has(raw?.status)) {
        delete map[id];
        mutated = true;
      }
    }
    if (mutated) writeLocalJobMap(ctx, map);
    return { clearedCount: data?.clearedCount || 0 };
  } catch (error) {
    if (!(error instanceof StorageUnavailableError)) throw error;
    const map = readLocalJobMap(ctx);
    let clearedCount = 0;
    for (const [id, raw] of Object.entries(map)) {
      if (PRUNABLE_HISTORY_STATUSES.has(raw?.status)) {
        delete map[id];
        clearedCount += 1;
      }
    }
    writeLocalJobMap(ctx, map);
    return { clearedCount };
  }
}

/**
 * Creates a bounded durable job repository backed by `/api/v1/jobs` with localStorage fallback.
 * Inputs: `{ baseUrl, fetchImpl, storage, maxJobs, maxActiveJobs, logger }`.
 * Outputs: JobRepositoryPort adapter exposing listJobs, getJob, enqueueJob, updateJob, cancelJob, retryJob, interruptJob, recoverInterruptedJobs, deleteJob, clearHistory.
 * Side effects: performs HTTP requests and falls back to Web Storage when offline.
 * Failure modes: maps 409 conflicts and 422/429 queue validation errors into typed domain errors.
 * @param {object} [deps={}] - Repository configuration.
 * @returns {object} Job repository instance.
 */
export function createHttpJobRepository({
  baseUrl = '/api/v1',
  fetchImpl = globalThis.fetch,
  storage: storageOption,
  maxJobs = MAX_STORED_JOBS,
  maxActiveJobs = MAX_ACTIVE_QUEUED_JOBS,
  logger,
} = {}) {
  const storage = resolveStorage(storageOption, logger);
  const ctx = { baseUrl, fetchImpl, storage, localCache: new Map(), maxJobs, maxActiveJobs, logger };
  return {
    listJobs: query => listJobsFromRepo(ctx, query),
    getJob: id => getJobFromRepo(ctx, id),
    enqueueJob: spec => enqueueJobInRepo(ctx, spec),
    updateJob: (id, patch, options) => updateJobInRepo(ctx, id, patch, options),
    cancelJob: (id, options = {}) => postJobAction(ctx, id, 'cancel', { finalize: Boolean(options.finalize) }, options),
    retryJob: (id, options = {}) => postJobAction(ctx, id, 'retry', {}, options),
    interruptJob: (id, options = {}) => postJobAction(ctx, id, 'interrupt', options.reason ? { reason: options.reason } : {}, options),
    recoverInterruptedJobs: () => recoverJobsInRepo(ctx),
    deleteJob: (id, options) => deleteJobFromRepo(ctx, id, options),
    clearHistory: () => clearHistoryInRepo(ctx),
  };
}
