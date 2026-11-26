/**
 * @fileoverview Unit tests for `httpJobRepository` online CRUD, typed error mapping, offline localStorage fallback, and Vite proxy allowlist.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttpJobRepository } from '../../src/data/httpJobRepository.js';
import { ConflictError, ValidationError } from '../../src/domain/errors.js';
import { JOB_STATUS, createProductionJob } from '../../src/domain/productionJobs.js';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const JOB_ID_1 = '11111111-1111-4111-8111-111111111111';
const JOB_ID_2 = '22222222-2222-4222-8222-222222222222';

function createMemoryStorage() {
  const store = new Map();
  return {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, val) => { store.set(key, String(val)); },
    removeItem: key => { store.delete(key); },
  };
}

function makeJsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

test('httpJobRepository handles online CRUD, zero meta.total without NaN, and maps 409/422/429 errors cleanly', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', headers: options.headers || {}, body: options.body });
    if (url.includes('/jobs?') && options.method === undefined) {
      return makeJsonResponse(200, { data: { items: [] }, meta: { total: 0, limit: 50, offset: 0, hasMore: false } });
    }
    if (url.endsWith('/jobs') && options.method === 'POST') {
      return makeJsonResponse(201, { data: { job: { id: JOB_ID_1, type: 'tts_batch', title: 'Job A', status: 'queued', revision: 1 } }, meta: { evictedIds: [] } });
    }
    if (url.endsWith(`/jobs/${JOB_ID_1}/retry`)) {
      return makeJsonResponse(422, { data: null, error: { code: 'MAX_RETRIES_EXCEEDED', message: 'Max retries reached.' } });
    }
    if (url.endsWith(`/jobs/${JOB_ID_1}/cancel`)) {
      return makeJsonResponse(409, { data: null, error: { code: 'INVALID_JOB_TRANSITION', message: 'Cannot cancel completed job.' } });
    }
    return makeJsonResponse(404, { data: null, error: { code: 'JOB_NOT_FOUND', message: 'Not found' } });
  };

  const repo = createHttpJobRepository({ fetchImpl, storage: createMemoryStorage(), logger: { warn() {}, error() {} } });
  const emptyList = await repo.listJobs();
  assert.equal(emptyList.total, 0);
  assert.equal(Number.isNaN(emptyList.total), false);

  const created = await repo.enqueueJob({ id: JOB_ID_1, type: 'tts_batch', title: 'Job A' });
  assert.equal(created.job.id, JOB_ID_1);
  assert.equal(await repo.getJob(JOB_ID_2), null);

  await assert.rejects(() => repo.retryJob(JOB_ID_1), err => err instanceof ValidationError && err.code === 'MAX_RETRIES_EXCEEDED');
  await assert.rejects(() => repo.cancelJob(JOB_ID_1), err => err instanceof ConflictError && err.code === 'INVALID_JOB_TRANSITION');
});

test('httpJobRepository falls back offline via localStorage, supports comma filters, corrupt entry recovery, and bounded eviction', async () => {
  const storage = createMemoryStorage();
  storage.setItem('voxcpm.jobs.v1', JSON.stringify({ bad: { not: 'a-job' } }));
  const offlineFetch = async () => { throw new TypeError('Failed to fetch'); };
  const repo = createHttpJobRepository({
    fetchImpl: offlineFetch,
    storage,
    maxJobs: 2,
    maxActiveJobs: 2,
    logger: { warn() {}, error() {} },
  });

  const j1 = (await repo.enqueueJob({ id: JOB_ID_1, type: 'tts_batch', title: 'Offline One', items: [{ itemId: 'a', label: 'A' }] })).job;
  await repo.updateJob(j1.id, { action: 'prepare', workerSessionId: 'tab-x' });
  await repo.updateJob(j1.id, { action: 'start', workerSessionId: 'tab-x' });
  await repo.updateJob(j1.id, { action: 'item_complete', itemId: 'a' });

  const j2 = (await repo.enqueueJob({ id: JOB_ID_2, type: 'video_burn', title: 'Offline Two' })).job;
  await repo.updateJob(j2.id, { action: 'prepare', workerSessionId: 'tab-x' });
  await repo.updateJob(j2.id, { action: 'complete' });

  // Recover marks in-flight j1 interrupted while j2 remains completed
  const recovered = await repo.recoverInterruptedJobs();
  assert.equal(recovered.recoveredCount, 1);
  assert.equal((await repo.getJob(j1.id)).status, JOB_STATUS.INTERRUPTED);

  // Comma-separated status filter works offline too
  const both = await repo.listJobs({ status: 'interrupted,completed' });
  assert.equal(both.total, 2);

  // Admitting j3 when maxJobs=2 evicts completed j2 while preserving interrupted j1
  const j3 = await repo.enqueueJob({ type: 'tts_batch', title: 'Offline Three' });
  assert.deepEqual(j3.evictedIds, [j2.id]);
  assert.equal(await repo.getJob(j2.id), null);
  assert.ok(await repo.getJob(j1.id));

  // clearHistory offline preserves active & interrupted jobs
  await repo.cancelJob(j3.job.id);
  const cleared = await repo.clearHistory();
  assert.equal(cleared.clearedCount, 1);
  assert.ok(await repo.getJob(j1.id));

  // Offline getJob handles corrupt entry cleanly without throwing
  const corruptId = '99999999-9999-4999-8999-999999999999';
  const currentMap = JSON.parse(storage.getItem('voxcpm.jobs.v1'));
  currentMap[corruptId] = { broken: true };
  storage.setItem('voxcpm.jobs.v1', JSON.stringify(currentMap));
  assert.equal(await repo.getJob(corruptId), null);

  // Offline deleteJob enforces expectedRevision conflict
  const curJ1 = await repo.getJob(j1.id);
  await assert.rejects(
    () => repo.deleteJob(j1.id, { expectedRevision: curJ1.revision + 9 }),
    err => err instanceof ConflictError && err.code === 'REVISION_CONFLICT'
  );

  // Offline retryJob enforces maxActiveJobs capacity
  const strictRepo = createHttpJobRepository({
    fetchImpl: offlineFetch,
    storage,
    maxJobs: 4,
    maxActiveJobs: 1,
    logger: { warn() {}, error() {} },
  });
  await strictRepo.enqueueJob({ type: 'tts_batch', title: 'Saturating Active' });
  await assert.rejects(
    () => strictRepo.retryJob(j1.id),
    err => err instanceof ValidationError && err.code === 'JOB_QUEUE_FULL'
  );
});

test('httpJobRepository syncs online evictions and clearHistory to localStorage mirror so stale jobs never resurrect offline', async () => {
  const storage = createMemoryStorage();
  let online = true;
  const fetchImpl = async (url, options = {}) => {
    if (!online) throw new TypeError('Offline');
    if (url.endsWith('/jobs') && options.method === 'POST') {
      const body = JSON.parse(options.body);
      const evictedIds = body.id === JOB_ID_2 ? [JOB_ID_1] : [];
      return makeJsonResponse(201, { data: { job: { ...body, status: 'completed', revision: 1 } }, meta: { evictedIds } });
    }
    if (url.endsWith('/jobs/clear-history') && options.method === 'POST') {
      return makeJsonResponse(200, { data: { clearedCount: 1 } });
    }
    return makeJsonResponse(404, { data: null, error: { code: 'JOB_NOT_FOUND', message: 'Not found' } });
  };

  const repo = createHttpJobRepository({ fetchImpl, storage, logger: { warn() {}, error() {} } });
  await repo.enqueueJob({ id: JOB_ID_1, type: 'tts_batch', title: 'Old Job' });
  await repo.enqueueJob({ id: JOB_ID_2, type: 'tts_batch', title: 'New Job' });

  // Evicted JOB_ID_1 must already be removed from localStorage mirror
  online = false;
  assert.equal(await repo.getJob(JOB_ID_1), null);
  assert.ok(await repo.getJob(JOB_ID_2));

  // Online clearHistory must remove completed JOB_ID_2 from localStorage mirror too
  online = true;
  await repo.clearHistory();
  online = false;
  assert.equal(await repo.getJob(JOB_ID_2), null);
});

test('httpJobRepository online listJobs refreshes local mirror and offline validates expectedRevision strictly', async () => {
  const storage = createMemoryStorage();
  let online = true;
  let serverJobs = [
    createProductionJob({ id: JOB_ID_1, type: 'tts_batch', title: 'Server Job', status: JOB_STATUS.RUNNING, revision: 2 }),
  ];
  const fetchImpl = async (url, options = {}) => {
    if (!online) throw new TypeError('offline');
    if (url.includes('/jobs?')) {
      return makeJsonResponse(200, { data: { items: serverJobs }, meta: { total: serverJobs.length, limit: 50, offset: 0, hasMore: false } });
    }
    if (url.endsWith('/jobs') && options.method === 'POST') {
      const body = JSON.parse(options.body);
      return makeJsonResponse(201, { data: { job: { ...body, revision: 1 } }, meta: { evictedIds: [] } });
    }
    return makeJsonResponse(404, { data: null, error: { code: 'JOB_NOT_FOUND', message: 'Not found' } });
  };

  const repo = createHttpJobRepository({ fetchImpl, storage, logger: { warn() {}, error() {} } });
  await repo.listJobs({ limit: 50, offset: 0 });
  // Simulate server restart recovering JOB_ID_1 -> interrupted (rev 3)
  serverJobs = [
    createProductionJob({ id: JOB_ID_1, type: 'tts_batch', title: 'Server Job', status: JOB_STATUS.INTERRUPTED, revision: 3 }),
  ];
  await repo.listJobs({ limit: 50, offset: 0 });

  // Go offline: localStorage mirror must reflect recovered interrupted rev 3 (not stale running rev 2)
  online = false;
  const offlineJob = await repo.getJob(JOB_ID_1);
  assert.equal(offlineJob.status, JOB_STATUS.INTERRUPTED);
  assert.equal(offlineJob.revision, 3);

  // Offline invalid expectedRevision (0 or non-integer) throws ValidationError INVALID_REVISION
  await assert.rejects(
    () => repo.retryJob(JOB_ID_1, { expectedRevision: 0 }),
    err => err instanceof ValidationError && err.code === 'INVALID_REVISION'
  );
  await assert.rejects(
    () => repo.deleteJob(JOB_ID_1, { expectedRevision: 'abc' }),
    err => err instanceof ValidationError && err.code === 'INVALID_REVISION'
  );

  // External deletion in localStorage must NOT be resurrected by stale in-memory localCache
  storage.setItem('voxcpm.jobs.v1', JSON.stringify({}));
  assert.equal(await repo.getJob(JOB_ID_1), null);
});

test('Vite dev proxy allowlist exposes all /api/v1/jobs endpoints while blocking unknown paths', async () => {
  const viteConfig = await readFile(path.join(WEB_ROOT, 'vite.config.js'), 'utf8');
  const match = viteConfig.match(/const ALLOWED_STORAGE_PATH = (\/.*\/);/);
  assert.ok(match);
  const regex = new RegExp(match[1].slice(1, -1));
  for (const allowed of [
    '/api/v1/jobs',
    '/api/v1/jobs/recover',
    '/api/v1/jobs/clear-history',
    `/api/v1/jobs/${JOB_ID_1}`,
    `/api/v1/jobs/${JOB_ID_1}/cancel`,
    `/api/v1/jobs/${JOB_ID_1}/retry`,
    `/api/v1/jobs/${JOB_ID_1}/interrupt`,
  ]) {
    assert.equal(regex.test(allowed), true, allowed);
  }
  assert.equal(regex.test(`/api/v1/jobs/${JOB_ID_1}/evil`), false);
});
