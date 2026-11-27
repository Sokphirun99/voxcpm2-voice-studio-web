/**
 * @fileoverview Versioned `/api/v1/jobs/*` HTTP controllers for durable batch job queueing, progress, cancellation, retry, and recovery.
 */

import { MAX_JOB_DOC_BYTES, assertSafeJobId } from './jobStore.js';
import { API_PREFIX, HttpApiError, readJsonPayload, sendJson } from './httpApp.js';

function resolveExpectedRevision(req, url, body) {
  const ifMatch = req.headers['if-match'];
  if (typeof ifMatch === 'string' && ifMatch.trim()) {
    return ifMatch.trim().replace(/^"|"$/g, '');
  }
  const xExpected = req.headers['x-expected-revision'];
  if (typeof xExpected === 'string' && xExpected.trim()) {
    return xExpected.trim();
  }
  const queryExpected = url.searchParams.get('expectedRevision');
  if (queryExpected !== null && queryExpected !== '') {
    return queryExpected;
  }
  return body?.expectedRevision;
}

function extractJobId(rawId) {
  try {
    return assertSafeJobId(rawId, 'jobId');
  } catch (error) {
    throw new HttpApiError(400, 'INVALID_JOB_ID', error.message);
  }
}

async function readOptionalJsonPayload(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) return {};
  return readJsonPayload(req);
}

function buildJobListQuery(url) {
  return {
    limit: url.searchParams.get('limit'),
    offset: url.searchParams.get('offset'),
    status: url.searchParams.get('status') || undefined,
    type: url.searchParams.get('type') || undefined,
    projectId: url.searchParams.get('projectId') || undefined,
    search: url.searchParams.get('search') || url.searchParams.get('q') || undefined,
  };
}

async function listJobsRoute({ res, url, store, requestId }) {
  const page = await store.listJobs(buildJobListQuery(url));
  const { items, ...meta } = page;
  sendJson({ res, status: 200, payload: { data: { items }, meta }, requestId });
  return true;
}

async function createJobRoute({ req, res, store, requestId }) {
  const body = await readJsonPayload(req, MAX_JOB_DOC_BYTES);
  const { job, evictedIds } = await store.enqueueJob(body);
  sendJson({ res, status: 201, payload: { data: { job }, meta: { evictedIds } }, requestId });
  return true;
}

async function recoverJobsRoute({ res, store, requestId }) {
  const result = await store.recoverInterruptedJobs();
  sendJson({ res, status: 200, payload: { data: result }, requestId });
  return true;
}

async function clearHistoryRoute({ res, store, requestId }) {
  const result = await store.clearHistory();
  sendJson({ res, status: 200, payload: { data: result }, requestId });
  return true;
}

function throwMethodNotAllowed(allow) {
  const err = new HttpApiError(405, 'METHOD_NOT_ALLOWED', `Method not allowed. Use: ${allow}.`);
  err.allow = allow;
  throw err;
}

async function handleJobCollectionRoutes(ctx) {
  if (ctx.url.pathname === `${API_PREFIX}/jobs`) {
    if (ctx.req.method === 'GET') return listJobsRoute(ctx);
    if (ctx.req.method === 'POST') return createJobRoute(ctx);
    throwMethodNotAllowed('GET, POST');
  }
  if (ctx.url.pathname === `${API_PREFIX}/jobs/recover`) {
    if (ctx.req.method === 'POST') return recoverJobsRoute(ctx);
    throwMethodNotAllowed('POST');
  }
  if (ctx.url.pathname === `${API_PREFIX}/jobs/clear-history`) {
    if (ctx.req.method === 'POST') return clearHistoryRoute(ctx);
    throwMethodNotAllowed('POST');
  }
  return false;
}

async function getJobRoute({ res, store, requestId, id }) {
  const job = await store.getJob(id);
  if (!job) throw new HttpApiError(404, 'JOB_NOT_FOUND', 'Batch job was not found.');
  sendJson({ res, status: 200, payload: { data: { job } }, requestId });
  return true;
}

async function patchJobRoute({ req, res, url, store, requestId, id }) {
  const body = await readJsonPayload(req, MAX_JOB_DOC_BYTES);
  const expectedRevision = resolveExpectedRevision(req, url, body);
  const result = await store.updateJob(id, body, { expectedRevision });
  if (!result) throw new HttpApiError(404, 'JOB_NOT_FOUND', 'Batch job was not found.');
  sendJson({ res, status: 200, payload: { data: { job: result.job } }, requestId });
  return true;
}

async function deleteJobRoute({ req, res, url, store, requestId, id }) {
  const expectedRevision = resolveExpectedRevision(req, url, null);
  const deleted = await store.deleteJob(id, { expectedRevision });
  if (!deleted) throw new HttpApiError(404, 'JOB_NOT_FOUND', 'Batch job was not found.');
  sendJson({ res, status: 200, payload: { data: { deleted: true, id } }, requestId });
  return true;
}

async function handleJobActionRoute({ req, res, url, store, requestId, id, action }) {
  if (req.method !== 'POST') throwMethodNotAllowed('POST');
  const body = await readOptionalJsonPayload(req);
  const expectedRevision = resolveExpectedRevision(req, url, body);
  let result = null;
  if (action === 'cancel') result = await store.cancelJob(id, { ...body, expectedRevision });
  else if (action === 'retry') result = await store.retryJob(id, { expectedRevision });
  else if (action === 'interrupt') result = await store.interruptJob(id, { ...body, expectedRevision });
  if (!result) throw new HttpApiError(404, 'JOB_NOT_FOUND', 'Batch job was not found.');
  sendJson({ res, status: 200, payload: { data: { job: result.job } }, requestId });
  return true;
}

/**
 * Dispatches versioned batch job endpoints (`/api/v1/jobs/*`).
 * Inputs: `ctx: { req, res, url, store, requestId }`.
 * Outputs: `Promise<boolean>` - True if route matched and completed.
 * Side effects: reads/writes durable jobs in `store`, emits HTTP JSON responses.
 * Failure modes: throws HttpApiError on malformed IDs or missing jobs; maps conflict/validation errors via httpApp.
 * @param {object} ctx - Route dispatch context.
 * @returns {Promise<boolean>} True if handled.
 */
export async function handleJobRoutes(ctx) {
  if (await handleJobCollectionRoutes(ctx)) return true;
  const match = /^\/api\/v1\/jobs\/([^/]+)(?:\/(cancel|retry|interrupt))?$/.exec(ctx.url.pathname);
  if (!match) return false;
  const id = extractJobId(match[1]);
  const action = match[2];
  if (action) return handleJobActionRoute({ ...ctx, id, action });
  if (ctx.req.method === 'GET') return getJobRoute({ ...ctx, id });
  if (ctx.req.method === 'PATCH') return patchJobRoute({ ...ctx, id });
  if (ctx.req.method === 'DELETE') return deleteJobRoute({ ...ctx, id });
  throwMethodNotAllowed('GET, PATCH, DELETE');
}
