/**
 * @fileoverview Versioned `/api/v1/assets/*` and `/api/v1/projects/:id/assets` HTTP controllers for binary assets.
 */

import path from 'node:path';
import { assertSafeAssetId } from './assetStore.js';
import { assertSafeProjectId } from './projectStore.js';
import { API_PREFIX, HttpApiError, readBoundedBody, sendJson } from './httpApp.js';

export const MAX_ASSET_UPLOAD_BYTES = 100 * 1024 * 1024;
export const DEFAULT_ASSET_MIME = 'application/octet-stream';
export const CACHE_MAX_AGE_SECONDS = 31536000;

function extractAssetId(rawId) {
  try {
    return assertSafeAssetId(rawId, 'assetId');
  } catch (error) {
    throw new HttpApiError(400, 'INVALID_ASSET_ID', error.message);
  }
}

function inferKindFromMime(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.includes('vtt') || mime.includes('subrip') || mime.includes('ass')) return 'subtitle';
  return 'other';
}

async function readMultipartAsset(req) {
  const buffer = await readBoundedBody(req, MAX_ASSET_UPLOAD_BYTES);
  const request = new Request('http://storage.local/upload', { method: 'POST', headers: req.headers, body: buffer });
  const form = await request.formData();
  const file = form.get('file') || form.get('asset') || form.get('audio') || form.get('video');
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new HttpApiError(422, 'MISSING_ASSET_FILE', 'Asset file field is required.');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const fileName = form.get('fileName') || file.name || 'unnamed-asset';
  const mimeType = file.type || DEFAULT_ASSET_MIME;
  const rawKind = form.get('kind');
  const kind = rawKind || inferKindFromMime(mimeType);
  const projectId = form.get('projectId') || null;
  return { bytes, fileName, mimeType, kind, projectId };
}

async function readBinaryAsset(req) {
  const buffer = await readBoundedBody(req, MAX_ASSET_UPLOAD_BYTES);
  if (buffer.length === 0) {
    throw new HttpApiError(422, 'EMPTY_ASSET_PAYLOAD', 'Asset payload cannot be empty.');
  }
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const mimeType = req.headers['content-type'] || DEFAULT_ASSET_MIME;
  const rawFileName = req.headers['x-file-name'] || req.headers['content-disposition']?.match(/filename="?([^";]+)"?/)?.[1];
  const fileName = rawFileName ? path.basename(rawFileName) : 'asset.bin';
  const rawKind = req.headers['x-asset-kind'];
  const kind = rawKind || inferKindFromMime(mimeType);
  const projectId = req.headers['x-project-id'] || null;
  return { bytes, fileName, mimeType, kind, projectId };
}

async function readAssetPayload(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (contentType.includes('multipart/form-data')) {
    return readMultipartAsset(req);
  }
  return readBinaryAsset(req);
}

async function assertProjectExists(store, projectId) {
  if (!projectId) return;
  const project = await store.getProject(projectId);
  if (!project) {
    throw new HttpApiError(404, 'PROJECT_NOT_FOUND', `Project ${projectId} not found.`);
  }
}

async function handleAssetUploadRoute({ req, res, store, requestId, projectId }) {
  if (req.method !== 'POST') return false;
  if (projectId) await assertProjectExists(store, projectId);
  const parsed = await readAssetPayload(req);
  const effectiveProjectId = projectId || parsed.projectId;
  if (effectiveProjectId && !projectId) await assertProjectExists(store, effectiveProjectId);
  const asset = await store.saveAsset({ ...parsed, projectId: effectiveProjectId });
  sendJson({ res, status: 201, payload: { data: { asset } }, requestId });
  return true;
}

async function handleAssetListRoute({ req, res, url, store, requestId, projectId }) {
  if (req.method !== 'GET') return false;
  if (projectId) await assertProjectExists(store, projectId);
  const effectiveProjectId = projectId || url.searchParams.get('projectId') || undefined;
  const query = {
    limit: url.searchParams.get('limit'),
    offset: url.searchParams.get('offset'),
    kind: url.searchParams.get('kind') || undefined,
    projectId: effectiveProjectId,
  };
  const page = await store.listAssets(query);
  const { items, ...meta } = page;
  sendJson({ res, status: 200, payload: { data: { items }, meta }, requestId });
  return true;
}

function writeAssetHeaders({ res, binary, disposition, requestId, etag }) {
  res.writeHead(200, {
    'Content-Type': binary.meta.mimeType || DEFAULT_ASSET_MIME,
    'Content-Length': String(binary.bytes.byteLength),
    'ETag': etag,
    'Cache-Control': `public, max-age=${CACHE_MAX_AGE_SECONDS}, immutable`,
    'Content-Disposition': `${disposition}; filename="${binary.meta.fileName}"`,
    'X-Content-Type-Options': 'nosniff',
    'X-Request-Id': requestId,
  });
}

async function streamAssetBinary({ req, res, store, id, requestId, isDownload }) {
  const binary = await store.getAssetBinary(id);
  if (!binary) throw new HttpApiError(404, 'ASSET_NOT_FOUND', 'Asset not found.');
  const etag = `"${binary.meta.sha256}"`;
  const ifNoneMatch = req?.headers?.['if-none-match'];
  if (ifNoneMatch && (ifNoneMatch === etag || ifNoneMatch === binary.meta.sha256)) {
    res.writeHead(304, { 'ETag': etag, 'Cache-Control': `public, max-age=${CACHE_MAX_AGE_SECONDS}, immutable`, 'X-Request-Id': requestId });
    return res.end();
  }
  const disposition = isDownload ? 'attachment' : 'inline';
  writeAssetHeaders({ res, binary, disposition, requestId, etag });
  if (req?.method === 'HEAD') return res.end();
  res.end(binary.bytes);
}

async function handleAssetItemRoute({ req, res, url, store, requestId, id }) {
  if (req.method === 'GET') {
    const asset = await store.getAsset(id);
    if (!asset) throw new HttpApiError(404, 'ASSET_NOT_FOUND', 'Asset not found.');
    sendJson({ res, status: 200, payload: { data: { asset } }, requestId });
    return true;
  }
  if (req.method === 'DELETE') {
    const hard = url.searchParams.get('hard') === 'true';
    const deleted = await store.deleteAsset(id, { hard });
    if (!deleted) throw new HttpApiError(404, 'ASSET_NOT_FOUND', 'Asset was not found.');
    sendJson({ res, status: 200, payload: { data: { deleted: true, id } }, requestId });
    return true;
  }
  return false;
}

async function handleProjectAssetSubroute(ctx) {
  const match = /^\/api\/v1\/projects\/([^/]+)\/assets$/.exec(ctx.url.pathname);
  if (!match) return false;
  let projectId;
  try {
    projectId = assertSafeProjectId(match[1], 'projectId');
  } catch (e) {
    throw new HttpApiError(400, 'INVALID_PROJECT_ID', e.message);
  }
  if (ctx.req.method === 'POST') return handleAssetUploadRoute({ ...ctx, projectId });
  if (ctx.req.method === 'GET') return handleAssetListRoute({ ...ctx, projectId });
  return false;
}

async function handleAssetCollectionSubroute(ctx) {
  if (ctx.url.pathname !== `${API_PREFIX}/assets`) return false;
  if (ctx.req.method === 'POST') return handleAssetUploadRoute({ ...ctx, projectId: null });
  if (ctx.req.method === 'GET') return handleAssetListRoute({ ...ctx, projectId: null });
  return false;
}

async function handleAssetBinarySubroute(ctx) {
  const match = /^\/api\/v1\/assets\/([^/]+)\/(binary|download)$/.exec(ctx.url.pathname);
  if (!match || (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD')) return false;
  const id = extractAssetId(match[1]);
  await streamAssetBinary({ req: ctx.req, res: ctx.res, store: ctx.store, id, requestId: ctx.requestId, isDownload: match[2] === 'download' });
  return true;
}

async function handleAssetItemSubroute(ctx) {
  const match = /^\/api\/v1\/assets\/([^/]+)$/.exec(ctx.url.pathname);
  if (!match) return false;
  const id = extractAssetId(match[1]);
  return handleAssetItemRoute({ ...ctx, id });
}

/**
 * Dispatches binary asset endpoints (`/api/v1/assets/*` and `/api/v1/projects/:id/assets`).
 * Inputs: `ctx: { req, res, url, store, requestId }`.
 * Outputs: `Promise<boolean>` - True if route was handled.
 * Side effects: stores assets, streams binary, deletes assets, writes responses.
 * Failure modes: throws HttpApiError on validation, not found, payload size.
 * @param {object} ctx - Route context.
 * @returns {Promise<boolean>}
 */
export async function handleAssetRoutes(ctx) {
  return (await handleProjectAssetSubroute(ctx))
    || (await handleAssetCollectionSubroute(ctx))
    || (await handleAssetBinarySubroute(ctx))
    || (await handleAssetItemSubroute(ctx));
}
