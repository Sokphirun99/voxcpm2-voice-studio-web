/**
 * @fileoverview Versioned `/api/v1/projects/*` HTTP controllers supporting the full project management lifecycle.
 */

import { randomUUID } from 'node:crypto';
import { assertSafeProjectId } from './projectStore.js';
import { API_PREFIX, HttpApiError, readJsonPayload, sendJson } from './httpApp.js';

function resolveProjectExpectedRevision(req, url, body) {
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

function extractProjectId(rawId) {
  try {
    return assertSafeProjectId(rawId, 'projectId');
  } catch (error) {
    throw new HttpApiError(400, 'INVALID_PROJECT_ID', error.message);
  }
}

function buildProjectListQuery(url) {
  return {
    limit: url.searchParams.get('limit'),
    offset: url.searchParams.get('offset'),
    type: url.searchParams.get('type') || undefined,
    kind: url.searchParams.get('kind') || undefined,
    status: url.searchParams.get('status') || undefined,
    search: url.searchParams.get('search') || url.searchParams.get('q') || undefined,
  };
}

async function listProjectsRoute({ res, url, store, requestId }) {
  const page = await store.listProjects(buildProjectListQuery(url));
  const { items, ...meta } = page;
  sendJson({ res, status: 200, payload: { data: { items }, meta }, requestId });
  return true;
}

async function createProjectRoute({ req, res, store, requestId }) {
  const body = await readJsonPayload(req);
  const { project } = await store.createProject(body);
  sendJson({ res, status: 201, payload: { data: { project } }, requestId });
  return true;
}

async function handleProjectCollectionRoute(ctx) {
  if (ctx.url.pathname !== `${API_PREFIX}/projects`) return false;
  if (ctx.req.method === 'GET') return listProjectsRoute(ctx);
  if (ctx.req.method === 'POST') return createProjectRoute(ctx);
  return false;
}

async function getProjectRoute({ res, store, requestId, id }) {
  const project = await store.getProject(id);
  if (!project) throw new HttpApiError(404, 'PROJECT_NOT_FOUND', 'Project snapshot not found.');
  sendJson({ res, status: 200, payload: { data: { project } }, requestId });
  return true;
}

async function putProjectRoute({ req, res, url, store, requestId, id }) {
  const body = await readJsonPayload(req);
  const expectedRevision = resolveProjectExpectedRevision(req, url, body);
  const { project, isCreated } = await store.upsertProject(id, body, { expectedRevision });
  sendJson({ res, status: isCreated ? 201 : 200, payload: { data: { project } }, requestId });
  return true;
}

async function deleteProjectRoute({ req, res, url, store, requestId, id }) {
  const expectedRevision = resolveProjectExpectedRevision(req, url, null);
  const deleted = await store.deleteProject(id, { expectedRevision });
  if (!deleted) throw new HttpApiError(404, 'PROJECT_NOT_FOUND', 'Project was not found.');
  sendJson({ res, status: 200, payload: { data: { deleted: true, id } }, requestId });
  return true;
}

async function handleProjectItemRoute(ctx) {
  if (ctx.req.method === 'GET') return getProjectRoute(ctx);
  if (ctx.req.method === 'PUT') return putProjectRoute(ctx);
  if (ctx.req.method === 'DELETE') return deleteProjectRoute(ctx);
  return false;
}

async function duplicateProjectRoute({ req, res, store, requestId, id }) {
  const body = req.headers['content-type']?.includes('application/json')
    ? await readJsonPayload(req)
    : {};
  const result = await store.duplicateProject(id, body);
  if (!result) throw new HttpApiError(404, 'PROJECT_NOT_FOUND', 'Project was not found.');
  sendJson({ res, status: 201, payload: { data: { project: result.project } }, requestId });
  return true;
}

async function restoreProjectRoute({ req, res, url, store, requestId, id }) {
  const expectedRevision = resolveProjectExpectedRevision(req, url, null);
  const result = await store.restoreProject(id, { expectedRevision });
  if (!result) throw new HttpApiError(404, 'PROJECT_NOT_FOUND', 'Project was not found.');
  sendJson({ res, status: 200, payload: { data: { project: result.project, restored: result.restored } }, requestId });
  return true;
}

async function handleProjectActionRoute(ctx) {
  if (ctx.action === 'duplicate' && ctx.req.method === 'POST') return duplicateProjectRoute(ctx);
  if (ctx.action === 'restore' && ctx.req.method === 'POST') return restoreProjectRoute(ctx);
  return false;
}

/**
 * Dispatches versioned project management endpoints (`/api/v1/projects/*`).
 * Inputs: `ctx: { req, res, url, store, requestId }`.
 * Outputs: `Promise<boolean>` - True if route was handled.
 * Side effects: reads/writes projects in store, sends JSON response.
 * Failure modes: throws HttpApiError on validation, not found, or revision conflict.
 * @param {object} ctx - Request context.
 * @returns {Promise<boolean>}
 */
export async function handleProjectRoutes(ctx) {
  if (await handleProjectCollectionRoute(ctx)) return true;
  const match = /^\/api\/v1\/projects\/([^/]+)(?:\/(duplicate|restore))?$/.exec(ctx.url.pathname);
  if (!match) return false;
  const id = extractProjectId(match[1]);
  const action = match[2];
  if (action) {
    return handleProjectActionRoute({ ...ctx, id, action });
  }
  return handleProjectItemRoute({ ...ctx, id });
}
