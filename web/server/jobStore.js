/**
 * @fileoverview Atomic persistent storage for Voice Studio bounded production batch jobs and restart recovery.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConflictError, StorageError, ValidationError } from '../src/domain/errors.js';
import {
  ACTIVE_JOB_STATUSES,
  IN_FLIGHT_JOB_STATUSES,
  JOB_STATUS,
  MAX_ACTIVE_QUEUED_JOBS,
  MAX_STORED_JOBS,
  PRUNABLE_HISTORY_STATUSES,
  applyJobLifecycleAction,
  assertActiveQueueCapacity,
  assertJobId,
  createQueuedProductionJob,
  evaluateQueueAdmission,
  markJobInterrupted,
  normalizeProductionJob,
  summarizeJobs,
  toJobSummary,
} from '../src/domain/productionJobs.js';

export const JOB_FILE_EXT = '.json';
export const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DEFAULT_JOB_PAGE_LIMIT = 50;
export const MAX_JOB_PAGE_LIMIT = 200;
export const MAX_JOB_DOC_BYTES = 512 * 1024;

/**
 * Validates that a job identifier is a UUID v4 format string.
 * Inputs: rawId (unknown), optional field label.
 * Outputs: normalized UUID string.
 * Side effects: none.
 * Failure modes: throws ValidationError when id is malformed.
 * @param {unknown} rawId - Candidate job id.
 * @param {string} [field='jobId'] - Error field label.
 * @returns {string} Validated UUID string.
 */
export function assertSafeJobId(rawId, field = 'jobId') {
  return assertJobId(rawId, field);
}

/**
 * Resolves a safe file path inside `jobsDir` and blocks directory traversal.
 * Inputs: jobsDir (string), id (string).
 * Outputs: resolved absolute file path.
 * Side effects: none.
 * Failure modes: throws StorageError if resolved path escapes jobsDir.
 * @param {string} jobsDir - Base jobs directory.
 * @param {string} id - Safe job UUID.
 * @returns {string} Resolved absolute path.
 */
export function resolveSafeJobPath(jobsDir, id) {
  const base = path.resolve(jobsDir);
  const resolved = path.resolve(base, `${id}${JOB_FILE_EXT}`);
  if (!resolved.startsWith(`${base}${path.sep}`)) {
    throw new StorageError('Resolved job path escaped storage directory.');
  }
  return resolved;
}

async function cleanupTempFile(tempPath, originalError) {
  try {
    await unlink(tempPath);
  } catch (cleanupError) {
    if (cleanupError?.code !== 'ENOENT') {
      throw new AggregateError([originalError, cleanupError], 'Atomic job write failed.');
    }
  }
}

/**
 * Atomically writes job JSON contents via a unique sibling `.tmp` file and `rename`.
 * Inputs: targetPath (string), contents (string).
 * Outputs: Promise<void>.
 * Side effects: writes temp file, atomically replaces destination, cleans temp file on failure.
 * Failure modes: throws on filesystem IO errors.
 * @param {string} targetPath - Destination JSON file path.
 * @param {string} contents - Serialized JSON payload.
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

function assertJobDocSize(job, maxDocBytes) {
  const docBytes = Buffer.byteLength(JSON.stringify(job), 'utf8');
  if (docBytes > maxDocBytes) {
    throw new ValidationError('Job payload exceeds maximum size limit.', 'job', 'JOB_TOO_LARGE');
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
    throw new ConflictError(`Job revision mismatch. Expected ${expected} but job does not exist.`, {
      currentRevision: 0,
      expectedRevision: expected,
      code: 'REVISION_CONFLICT',
    });
  }
  const current = Number(existing.revision || 1);
  if (current !== expected) {
    throw new ConflictError(`Job revision mismatch. Expected ${expected} but found ${current}.`, {
      currentRevision: current,
      expectedRevision: expected,
      code: 'REVISION_CONFLICT',
    });
  }
}

async function readJobFile(jobsDir, id) {
  try {
    const raw = await readFile(resolveSafeJobPath(jobsDir, id), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return normalizeProductionJob(parsed);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new StorageError(`Stored job snapshot ${id} is unreadable.`, error);
  }
}

async function readAllJobRecords(ctx) {
  const files = await readdir(ctx.jobsDir).catch(error => {
    if (error?.code === 'ENOENT') return [];
    throw new StorageError('Could not list jobs from disk.', error);
  });
  const records = [];
  for (const fileName of files) {
    if (!fileName.endsWith(JOB_FILE_EXT)) continue;
    const id = fileName.slice(0, -JOB_FILE_EXT.length);
    if (!JOB_ID_PATTERN.test(id)) continue;
    const record = await readJobFileSafe(ctx, id);
    if (record && !record.deletedAt) records.push(record);
  }
  return records;
}

async function cleanupLeftoverTempFiles(jobsDir, logger) {
  let files = [];
  try {
    files = await readdir(jobsDir);
  } catch (error) {
    if (error?.code !== 'ENOENT') logger?.warn?.('jobStore.cleanupLeftoverTempFiles', error?.message || 'Could not scan jobs directory');
    return;
  }
  for (const fileName of files) {
    if (!fileName.endsWith('.tmp')) continue;
    const tempPath = path.resolve(jobsDir, path.basename(fileName));
    if (tempPath.startsWith(`${path.resolve(jobsDir)}${path.sep}`)) {
      await unlink(tempPath).catch(error => {
        if (error?.code !== 'ENOENT') logger?.warn?.('jobStore.cleanupLeftoverTempFiles', error?.message || 'Could not remove temp file', { fileName });
      });
    }
  }
}

async function recoverInFlightJobs(ctx) {
  await mkdir(ctx.jobsDir, { recursive: true });
  await cleanupLeftoverTempFiles(ctx.jobsDir, ctx.logger);
  let files = [];
  try {
    files = await readdir(ctx.jobsDir);
  } catch (error) {
    if (error?.code !== 'ENOENT') ctx.logger?.warn?.('jobStore.recoverInFlightJobs', error?.message || 'Could not read jobs directory');
    return { recoveredCount: 0, jobs: [] };
  }
  const recovered = [];
  for (const fileName of files) {
    if (!fileName.endsWith(JOB_FILE_EXT)) continue;
    const id = fileName.slice(0, -JOB_FILE_EXT.length);
    if (!JOB_ID_PATTERN.test(id)) continue;
    const job = await readJobFileSafe(ctx, id);
    if (!job || job.deletedAt || !IN_FLIGHT_JOB_STATUSES.has(job.status)) continue;
    const interrupted = markJobInterrupted(job);
    await writeAtomicFile(resolveSafeJobPath(ctx.jobsDir, id), JSON.stringify(interrupted, null, 2));
    recovered.push(toJobSummary(interrupted));
  }
  return { recoveredCount: recovered.length, jobs: recovered };
}

async function readJobFileSafe(ctx, id) {
  try {
    return await readJobFile(ctx.jobsDir, id);
  } catch (error) {
    ctx.logger?.error?.('jobStore.readJobFileSafe', error, { jobId: id });
    return null;
  }
}

function assertQueueCapacity(allJobs, ctx) {
  return evaluateQueueAdmission(allJobs, {
    maxJobs: ctx.maxJobs,
    maxActiveJobs: ctx.maxActiveJobs,
  });
}

async function unlinkJobFiles(jobsDir, ids) {
  for (const id of ids) {
    await unlink(resolveSafeJobPath(jobsDir, id)).catch(err => {
      if (err?.code !== 'ENOENT') throw err;
    });
  }
}

async function enqueueJobRecord(ctx, input) {
  const id = input?.id ? assertSafeJobId(input.id, 'id') : undefined;
  const candidate = createQueuedProductionJob({ ...(input || {}), ...(id ? { id } : {}) });
  assertJobDocSize(candidate, ctx.maxDocBytes);
  return ctx.enqueueWrite(async () => {
    await ctx.init();
    const existing = await readJobFile(ctx.jobsDir, candidate.id);
    if (existing && !existing.deletedAt) {
      throw new ConflictError(`Job ${candidate.id} already exists.`, { code: 'JOB_ALREADY_EXISTS' });
    }
    const allJobs = await readAllJobRecords(ctx);
    const evictIds = assertQueueCapacity(allJobs, ctx);
    await writeAtomicFile(resolveSafeJobPath(ctx.jobsDir, candidate.id), JSON.stringify(candidate, null, 2));
    await unlinkJobFiles(ctx.jobsDir, evictIds);
    return { job: toJobSummary(candidate), isCreated: true, evictedIds: evictIds };
  });
}

function applyJobMutationAction(existing, patch) {
  return applyJobLifecycleAction(existing, patch);
}

async function updateJobRecord(ctx, rawId, patch, options = {}) {
  const id = assertSafeJobId(rawId);
  const expectedRevision = options.expectedRevision ?? patch?.expectedRevision;
  return ctx.enqueueWrite(async () => {
    await ctx.init();
    const existing = await readJobFile(ctx.jobsDir, id);
    if (!existing || existing.deletedAt) return null;
    checkRevisionConflict(existing, expectedRevision);
    const updated = applyJobMutationAction(existing, patch);
    if (!ACTIVE_JOB_STATUSES.has(existing.status) && ACTIVE_JOB_STATUSES.has(updated.status)) {
      const allJobs = await readAllJobRecords(ctx);
      assertActiveQueueCapacity(allJobs, ctx.maxActiveJobs);
    }
    assertJobDocSize(updated, ctx.maxDocBytes);
    await writeAtomicFile(resolveSafeJobPath(ctx.jobsDir, id), JSON.stringify(updated, null, 2));
    return { job: toJobSummary(updated) };
  });
}

async function getJobRecord(ctx, rawId) {
  const id = assertSafeJobId(rawId);
  await ctx.init();
  const record = await readJobFile(ctx.jobsDir, id);
  if (!record || record.deletedAt) return null;
  return toJobSummary(record);
}

function matchesStatusFilter(jobStatus, rawFilter) {
  if (!rawFilter || rawFilter === 'all') return true;
  if (rawFilter === 'active') return ACTIVE_JOB_STATUSES.has(jobStatus);
  const set = new Set(String(rawFilter).split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  return set.size === 0 || set.has(jobStatus);
}

function shouldIncludeJob(record, query) {
  if (!record || record.deletedAt) return false;
  if (query.status && !matchesStatusFilter(record.status, query.status)) return false;
  if (query.type && record.type !== query.type) return false;
  if (query.projectId && record.projectId !== query.projectId) return false;
  const term = typeof query.search === 'string' ? query.search.trim().toLowerCase() : '';
  if (term) {
    const hay = `${record.title || ''} ${record.projectTitle || ''}`.toLowerCase();
    if (!hay.includes(term)) return false;
  }
  return true;
}

function normalizePagination(query = {}) {
  const parsedLimit = Number.parseInt(String(query.limit ?? DEFAULT_JOB_PAGE_LIMIT), 10);
  const parsedOffset = Number.parseInt(String(query.offset ?? 0), 10);
  return {
    limit: Number.isFinite(parsedLimit) ? Math.min(MAX_JOB_PAGE_LIMIT, Math.max(1, parsedLimit)) : DEFAULT_JOB_PAGE_LIMIT,
    offset: Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0,
  };
}

async function listJobRecords(ctx, query = {}) {
  await ctx.init();
  const { limit, offset } = normalizePagination(query);
  const all = await readAllJobRecords(ctx);
  const summary = summarizeJobs(all);
  const filtered = all.filter(record => shouldIncludeJob(record, query));
  filtered.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const items = filtered.slice(offset, offset + limit).map(toJobSummary);
  return { items, total: filtered.length, limit, offset, hasMore: offset + items.length < filtered.length, summary };
}

async function deleteJobRecord(ctx, rawId, options = {}) {
  const id = assertSafeJobId(rawId);
  return ctx.enqueueWrite(async () => {
    await ctx.init();
    const existing = await readJobFile(ctx.jobsDir, id);
    if (!existing || existing.deletedAt) return false;
    checkRevisionConflict(existing, options?.expectedRevision);
    if (ACTIVE_JOB_STATUSES.has(existing.status) && !options?.force) {
      throw new ConflictError('Cancel or interrupt an active job before removing it.', { code: 'JOB_ACTIVE_DELETE_BLOCKED' });
    }
    await unlink(resolveSafeJobPath(ctx.jobsDir, id)).catch(err => {
      if (err?.code !== 'ENOENT') throw err;
    });
    return true;
  });
}

async function clearHistoryRecords(ctx) {
  return ctx.enqueueWrite(async () => {
    await ctx.init();
    const all = await readAllJobRecords(ctx);
    const prunableIds = all.filter(job => PRUNABLE_HISTORY_STATUSES.has(job.status)).map(job => job.id);
    await unlinkJobFiles(ctx.jobsDir, prunableIds);
    return { clearedCount: prunableIds.length };
  });
}

function createDefaultWriteQueue() {
  let chain = Promise.resolve();
  return task => {
    const run = chain.then(task, task);
    chain = run.catch(() => {});
    return run;
  };
}

function resolveJobsDir(jobsDir, dataDir) {
  return jobsDir ? path.resolve(jobsDir) : path.join(path.resolve(dataDir), 'jobs');
}

function createBootInitializer(ctx) {
  let initPromise = null;
  let booted = false;
  return async () => {
    if (booted) return;
    if (!initPromise) {
      initPromise = recoverInFlightJobs(ctx).then(() => { booted = true; }).catch(err => {
        initPromise = null;
        throw err;
      });
    }
    await initPromise;
  };
}

/**
 * Creates a bounded durable persistent store for Voice Studio batch jobs with automatic restart recovery.
 * Inputs: `{ jobsDir, dataDir, enqueueWrite, maxJobs, maxActiveJobs, maxDocBytes, logger }`.
 * Outputs: JobStore instance exposing init, enqueueJob, getJob, listJobs, updateJob, cancelJob, retryJob, interruptJob, recoverInterruptedJobs, deleteJob, clearHistory.
 * Side effects: creates `jobsDir`, writes atomic JSON snapshots, transitions interrupted in-flight jobs on startup.
 * Failure modes: throws ValidationError on capacity/schema violation, ConflictError on invalid transitions/revisions, StorageError on IO failures.
 * @param {object} config - Job store configuration.
 * @returns {object} Initialized job store.
 */
export function createJobStore({
  jobsDir,
  dataDir,
  enqueueWrite,
  maxJobs = MAX_STORED_JOBS,
  maxActiveJobs = MAX_ACTIVE_QUEUED_JOBS,
  maxDocBytes = MAX_JOB_DOC_BYTES,
  logger = null,
}) {
  const resolvedDir = resolveJobsDir(jobsDir, dataDir);
  const effectiveEnqueue = enqueueWrite || createDefaultWriteQueue();
  const ctx = { jobsDir: resolvedDir, enqueueWrite: effectiveEnqueue, maxJobs, maxActiveJobs, maxDocBytes, logger, init: null };
  ctx.init = createBootInitializer(ctx);
  return {
    init: () => ctx.init(),
    jobsDir: resolvedDir,
    enqueueJob: input => enqueueJobRecord(ctx, input),
    getJob: rawId => getJobRecord(ctx, rawId),
    listJobs: query => listJobRecords(ctx, query),
    updateJob: (rawId, patch, options) => updateJobRecord(ctx, rawId, patch, options),
    cancelJob: (rawId, options = {}) => updateJobRecord(ctx, rawId, { action: 'cancel', finalize: Boolean(options.finalize) }, options),
    retryJob: (rawId, options = {}) => updateJobRecord(ctx, rawId, { action: 'retry' }, options),
    interruptJob: (rawId, options = {}) => updateJobRecord(ctx, rawId, { action: 'interrupt', ...(options.reason ? { reason: options.reason } : {}) }, options),
    recoverInterruptedJobs: () => ctx.enqueueWrite(async () => {
      await ctx.init();
      return recoverInFlightJobs(ctx);
    }),
    deleteJob: (rawId, options) => deleteJobRecord(ctx, rawId, options),
    clearHistory: () => clearHistoryRecords(ctx),
  };
}
