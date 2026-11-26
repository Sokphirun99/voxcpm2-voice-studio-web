/**
 * @fileoverview Integration tests for versioned `/api/v1/jobs/*` HTTP endpoints, restart recovery, and stats integration.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStorageHttpApp } from '../../server/httpApp.js';
import { createStorageStore } from '../../server/storageStore.js';

const JSON_TYPE = 'application/json';
const JOB_ID_A = '11111111-1111-4111-8111-111111111111';
const JOB_ID_B = '22222222-2222-4222-8222-222222222222';
const PROJ_ID = '33333333-3333-4333-8333-333333333333';
const ASSET_ID = '44444444-4444-4444-8444-444444444444';

async function invokeApp(handler, { method = 'GET', urlPath, headers = {}, body = null }) {
  let reqHeaders = { ...headers };
  let rawBytes = Buffer.alloc(0);
  if (typeof body === 'string') rawBytes = Buffer.from(body, 'utf8');
  else if (body instanceof Uint8Array) rawBytes = Buffer.from(body);

  const req = Readable.from(rawBytes.length ? [rawBytes] : []);
  req.method = method;
  req.url = urlPath;
  req.headers = Object.fromEntries(Object.entries(reqHeaders).map(([k, v]) => [k.toLowerCase(), v]));
  req.socket = { remoteAddress: '127.0.0.1' };

  const chunks = [];
  let statusCode = 200;
  let responseHeaders = {};
  const res = {
    headersSent: false,
    get statusCode() { return statusCode; },
    writeHead(code, hdrs = {}) {
      statusCode = code;
      responseHeaders = Object.fromEntries(Object.entries(hdrs).map(([k, v]) => [k.toLowerCase(), v]));
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
  };

  await handler(req, res);
  const buffer = Buffer.concat(chunks);
  return {
    status: statusCode,
    headers: responseHeaders,
    buffer,
    json: () => JSON.parse(buffer.toString('utf8')),
  };
}

async function withJobApiServer(run) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'voxcpm-job-api-'));
  const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
  const store = createStorageStore({ dataDir });
  await store.init();
  const handler = createStorageHttpApp({ store, rateLimitOptions: { maxRequests: 500 }, logger: silentLogger });
  try {
    return await run({ handler, store, dataDir, silentLogger });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('Jobs API CRUD, lifecycle transitions, filtering, stats, and restart recovery work end-to-end', async () => {
  await withJobApiServer(async ({ handler, dataDir, silentLogger }) => {
    const createRes = await invokeApp(handler, {
      method: 'POST',
      urlPath: '/api/v1/jobs',
      headers: { 'content-type': JSON_TYPE },
      body: JSON.stringify({
        id: JOB_ID_A,
        type: 'tts_batch',
        title: 'Khmer Lesson 1',
        projectId: PROJ_ID,
        projectTitle: 'Lesson 1',
        items: [
          { itemId: 'seg-1', segmentId: 'seg-1', label: 'Seg 1' },
          { itemId: 'seg-2', segmentId: 'seg-2', label: 'Seg 2' },
        ],
      }),
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.json().data.job.status, 'queued');

    // Prepare, start, complete item 1, start item 2
    await invokeApp(handler, { method: 'PATCH', urlPath: `/api/v1/jobs/${JOB_ID_A}`, headers: { 'content-type': JSON_TYPE }, body: JSON.stringify({ action: 'prepare', workerSessionId: 'tab-1' }) });
    await invokeApp(handler, { method: 'PATCH', urlPath: `/api/v1/jobs/${JOB_ID_A}`, headers: { 'content-type': JSON_TYPE }, body: JSON.stringify({ action: 'start', workerSessionId: 'tab-1' }) });
    await invokeApp(handler, { method: 'PATCH', urlPath: `/api/v1/jobs/${JOB_ID_A}`, headers: { 'content-type': JSON_TYPE }, body: JSON.stringify({ action: 'item_start', itemId: 'seg-1' }) });
    await invokeApp(handler, {
      method: 'PATCH',
      urlPath: `/api/v1/jobs/${JOB_ID_A}`,
      headers: { 'content-type': JSON_TYPE },
      body: JSON.stringify({ action: 'item_complete', itemId: 'seg-1', outputAssetId: ASSET_ID, takeId: 'take-1', durationSeconds: 2.1 }),
    });
    await invokeApp(handler, { method: 'PATCH', urlPath: `/api/v1/jobs/${JOB_ID_A}`, headers: { 'content-type': JSON_TYPE }, body: JSON.stringify({ action: 'item_start', itemId: 'seg-2' }) });

    // Check /api/v1/stats surfaces activeJobsCount & jobsCount
    const statsRes = await invokeApp(handler, { urlPath: '/api/v1/stats' });
    assert.equal(statsRes.status, 200);
    assert.equal(statsRes.json().data.storage.jobsCount, 1);
    assert.equal(statsRes.json().data.storage.activeJobsCount, 1);

    // Simulate Docker/storage service restart
    const restartedStore = createStorageStore({ dataDir });
    await restartedStore.init();
    const restartedHandler = createStorageHttpApp({ store: restartedStore, rateLimitOptions: { maxRequests: 500 }, logger: silentLogger });

    const recoveredGet = await invokeApp(restartedHandler, { urlPath: `/api/v1/jobs/${JOB_ID_A}` });
    assert.equal(recoveredGet.status, 200);
    assert.equal(recoveredGet.json().data.job.status, 'interrupted');
    assert.equal(recoveredGet.json().data.job.items[0].status, 'completed');
    assert.equal(recoveredGet.json().data.job.items[1].status, 'interrupted');
    assert.equal(recoveredGet.json().data.job.artifacts.length, 1);

    // Filter by status=interrupted and search query
    const filteredList = await invokeApp(restartedHandler, { urlPath: '/api/v1/jobs?status=interrupted&search=Lesson' });
    assert.equal(filteredList.status, 200);
    assert.equal(filteredList.json().meta.total, 1);

    // Retry via POST /api/v1/jobs/:id/retry
    const retryRes = await invokeApp(restartedHandler, { method: 'POST', urlPath: `/api/v1/jobs/${JOB_ID_A}/retry` });
    assert.equal(retryRes.status, 200);
    assert.equal(retryRes.json().data.job.status, 'queued');
    assert.equal(retryRes.json().data.job.items[0].status, 'completed');
    assert.equal(retryRes.json().data.job.items[1].status, 'pending');

    // Cancel queued job immediately -> cancelled, then clear-history removes it
    const cancelRes = await invokeApp(restartedHandler, { method: 'POST', urlPath: `/api/v1/jobs/${JOB_ID_A}/cancel` });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.json().data.job.status, 'cancelled');

    const clearRes = await invokeApp(restartedHandler, { method: 'POST', urlPath: '/api/v1/jobs/clear-history' });
    assert.equal(clearRes.status, 200);
    assert.equal(clearRes.json().data.clearedCount, 1);
  });
});

test('Jobs API enforces security, truthful error codes (400/404/409/422/429), and 512KB job document limit', async () => {
  await withJobApiServer(async ({ handler }) => {
    const traversal = await invokeApp(handler, { urlPath: '/api/v1/jobs/../secret' });
    assert.equal(traversal.status, 400);
    assert.equal(traversal.json().error.code, 'INVALID_JOB_ID');

    const invalidId = await invokeApp(handler, { urlPath: '/api/v1/jobs/not-a-uuid' });
    assert.equal(invalidId.status, 400);

    // Unsupported methods on /jobs, /jobs/recover, /jobs/clear-history return truthful 405 with Allow header
    const badJobsMethod = await invokeApp(handler, { method: 'PUT', urlPath: '/api/v1/jobs' });
    assert.equal(badJobsMethod.status, 405);
    assert.equal(badJobsMethod.headers.allow, 'GET, POST');

    const badRecoverMethod = await invokeApp(handler, { method: 'GET', urlPath: '/api/v1/jobs/recover' });
    assert.equal(badRecoverMethod.status, 405);
    assert.equal(badRecoverMethod.headers.allow, 'POST');

    const badClearMethod = await invokeApp(handler, { method: 'DELETE', urlPath: '/api/v1/jobs/clear-history' });
    assert.equal(badClearMethod.status, 405);
    assert.equal(badClearMethod.headers.allow, 'POST');

    const badItemMethod = await invokeApp(handler, { method: 'PUT', urlPath: `/api/v1/jobs/${JOB_ID_B}` });
    assert.equal(badItemMethod.status, 405);
    assert.equal(badItemMethod.headers.allow, 'GET, PATCH, DELETE');

    const badActionMethod = await invokeApp(handler, { method: 'GET', urlPath: `/api/v1/jobs/${JOB_ID_B}/retry` });
    assert.equal(badActionMethod.status, 405);
    assert.equal(badActionMethod.headers.allow, 'POST');

    // Spoofed deletedAt / revision / retryCount on POST /jobs are stripped to clean queued rev 1
    const spoofRes = await invokeApp(handler, {
      method: 'POST',
      urlPath: '/api/v1/jobs',
      headers: { 'content-type': JSON_TYPE },
      body: JSON.stringify({
        id: JOB_ID_B,
        type: 'tts_batch',
        title: 'Sanitized Enqueue',
        deletedAt: '2026-01-01T00:00:00Z',
        revision: 42,
        retryCount: 9,
      }),
    });
    assert.equal(spoofRes.status, 201);
    assert.equal(spoofRes.json().data.job.status, 'queued');
    assert.equal(spoofRes.json().data.job.revision, 1);
    assert.equal(spoofRes.json().data.job.retryCount, 0);
    const spoofGet = await invokeApp(handler, { urlPath: `/api/v1/jobs/${JOB_ID_B}` });
    assert.equal(spoofGet.status, 200);
    await invokeApp(handler, { method: 'POST', urlPath: `/api/v1/jobs/${JOB_ID_B}/cancel` });
    await invokeApp(handler, { method: 'DELETE', urlPath: `/api/v1/jobs/${JOB_ID_B}` });

    const missing = await invokeApp(handler, { urlPath: `/api/v1/jobs/${JOB_ID_B}` });
    assert.equal(missing.status, 404);
    assert.equal(missing.json().error.code, 'JOB_NOT_FOUND');

    const invalidBody = await invokeApp(handler, {
      method: 'POST',
      urlPath: '/api/v1/jobs',
      headers: { 'content-type': JSON_TYPE },
      body: JSON.stringify({ type: 'invalid', title: 'Bad' }),
    });
    assert.equal(invalidBody.status, 422);

    // 320 KB valid payload (within MAX_JOB_DOC_BYTES = 512 KB, larger than generic 256 KB limit) succeeds
    const largeText = 'x'.repeat(2800);
    const largeItems = Array.from({ length: 100 }, (_, i) => ({ itemId: `s-${i}`, segmentId: `s-${i}`, label: `S${i}`, metadata: { text: largeText } }));
    const largeRes = await invokeApp(handler, {
      method: 'POST',
      urlPath: '/api/v1/jobs',
      headers: { 'content-type': JSON_TYPE },
      body: JSON.stringify({ id: JOB_ID_A, type: 'tts_batch', title: 'Large Valid Batch', items: largeItems }),
    });
    assert.equal(largeRes.status, 201);

    // Duplicate ID -> 409 Conflict
    const dupRes = await invokeApp(handler, {
      method: 'POST',
      urlPath: '/api/v1/jobs',
      headers: { 'content-type': JSON_TYPE },
      body: JSON.stringify({ id: JOB_ID_A, type: 'tts_batch', title: 'Dup' }),
    });
    assert.equal(dupRes.status, 409);
    assert.equal(dupRes.json().error.code, 'JOB_ALREADY_EXISTS');

    // Active job cannot be deleted -> 409
    const delActive = await invokeApp(handler, { method: 'DELETE', urlPath: `/api/v1/jobs/${JOB_ID_A}` });
    assert.equal(delActive.status, 409);
    assert.equal(delActive.json().error.code, 'JOB_ACTIVE_DELETE_BLOCKED');

    // Enqueue 24 more active jobs (total 25), 26th triggers 429 JOB_QUEUE_FULL
    for (let i = 0; i < 24; i += 1) {
      const r = await invokeApp(handler, {
        method: 'POST',
        urlPath: '/api/v1/jobs',
        headers: { 'content-type': JSON_TYPE },
        body: JSON.stringify({ type: 'tts_batch', title: `Q-${i}` }),
      });
      assert.equal(r.status, 201);
    }
    const overflow = await invokeApp(handler, {
      method: 'POST',
      urlPath: '/api/v1/jobs',
      headers: { 'content-type': JSON_TYPE },
      body: JSON.stringify({ type: 'tts_batch', title: 'Overflow' }),
    });
    assert.equal(overflow.status, 429);
    assert.equal(overflow.json().error.code, 'JOB_QUEUE_FULL');

    // POST /api/v1/jobs/recover recovers in-flight jobs on demand
    await invokeApp(handler, { method: 'PATCH', urlPath: `/api/v1/jobs/${JOB_ID_A}`, headers: { 'content-type': JSON_TYPE }, body: JSON.stringify({ action: 'prepare' }) });
    const recRes = await invokeApp(handler, { method: 'POST', urlPath: '/api/v1/jobs/recover' });
    assert.equal(recRes.status, 200);
    assert.equal(recRes.json().data.recoveredCount, 1);
  });
});
