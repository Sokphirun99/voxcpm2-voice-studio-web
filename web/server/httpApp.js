/**
 * @fileoverview Versioned `/api/v1/*` HTTP controller exposing character library and voice anchor storage.
 */

import { randomUUID } from 'node:crypto';
import { StorageError, ValidationError } from '../src/domain/errors.js';
import { MAX_GLOSSARY_RULES } from '../src/domain/pronunciationRules.js';
import { assertSafeProjectId } from './storageStore.js';
import { FfmpegUnavailableError, createAudioMaster } from './audioMaster.js';
import { createServerLogger } from './logger.js';
import { createRateLimiter } from './rateLimiter.js';

const MAX_JSON_BODY_BYTES = 256 * 1024;
const MAX_MULTIPART_BODY_BYTES = 22 * 1024 * 1024;
const API_PREFIX = '/api/v1';

/**
 * Typed HTTP error mapped directly to truthful status codes and error envelopes.
 */
class HttpApiError extends Error {
  /**
   * @param {number} status - HTTP status code.
   * @param {string} code - Machine-readable error code.
   * @param {string} message - User-safe error description.
   * @param {number} [retryAfterSeconds] - Optional Retry-After hint.
   */
  constructor(status, code, message, retryAfterSeconds) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Resolves a correlation request ID from headers or creates a fresh UUID.
 * @param {import('node:http').IncomingMessage} req - HTTP request.
 * @returns {string} Request correlation ID.
 */
function resolveRequestId(req) {
  const incoming = req.headers['x-request-id'];
  if (typeof incoming === 'string' && /^[a-z0-9_-]{4,64}$/i.test(incoming.trim())) {
    return incoming.trim();
  }
  return randomUUID();
}

/**
 * Extracts client IP identifier for rate limiting.
 * @param {import('node:http').IncomingMessage} req - HTTP request.
 * @returns {string} Client IP string.
 */
function resolveClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'local';
}

/**
 * Writes a JSON envelope `{ data, error, meta }` with security headers.
 * @param {{ res: import('node:http').ServerResponse, status: number, payload: { data: unknown, error: unknown, meta?: object }, requestId: string, headers?: Record<string, string> }} spec - Response spec.
 */
function sendJson({ res, status, payload, requestId, headers = {} }) {
  const body = JSON.stringify({
    data: payload.data ?? null,
    error: payload.error ?? null,
    meta: { ...(payload.meta || {}), requestId },
  });
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'X-Request-Id': requestId,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

/**
 * Streams an HTTP request body into a Buffer while enforcing a strict maximum byte ceiling.
 * @param {import('node:http').IncomingMessage} req - HTTP request.
 * @param {number} maxBytes - Maximum permitted payload size.
 * @returns {Promise<Buffer>} Buffered request bytes.
 */
async function readBoundedBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new HttpApiError(413, 'PAYLOAD_TOO_LARGE', 'Request payload exceeds the size limit.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Validates JSON Content-Type and parses a bounded JSON body.
 * @param {import('node:http').IncomingMessage} req - HTTP request.
 * @returns {Promise<object>} Parsed JSON object.
 */
async function readJsonPayload(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    throw new HttpApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected application/json request body.');
  }
  const buffer = await readBoundedBody(req, MAX_JSON_BODY_BYTES);
  try {
    const parsed = JSON.parse(buffer.toString('utf8') || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpApiError(400, 'INVALID_JSON_OBJECT', 'Request body must be a JSON object.');
    }
    return parsed;
  } catch (error) {
    if (error instanceof HttpApiError) throw error;
    throw new HttpApiError(400, 'INVALID_JSON', 'Malformed JSON request body.');
  }
}

/**
 * Parses `multipart/form-data` uploads containing `metadata` JSON and an `audio` file Blob.
 * @param {import('node:http').IncomingMessage} req - HTTP request.
 * @returns {Promise<{ metadata: object, bytes: Uint8Array, mimeType: string }>} Parsed anchor fields and audio bytes.
 */
async function readMultipartAnchor(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('multipart/form-data')) {
    throw new HttpApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected multipart/form-data upload.');
  }
  const buffer = await readBoundedBody(req, MAX_MULTIPART_BODY_BYTES);
  const request = new Request('http://storage.local/upload', { method: 'PUT', headers: req.headers, body: buffer });
  const form = await request.formData();
  const audio = form.get('audio');
  if (!audio || typeof audio.arrayBuffer !== 'function') {
    throw new HttpApiError(422, 'MISSING_AUDIO_FILE', 'Audio file field is required.');
  }
  const rawMeta = form.get('metadata');
  let metadata = {};
  if (typeof rawMeta === 'string' && rawMeta.trim()) {
    try { metadata = JSON.parse(rawMeta); } catch { throw new HttpApiError(400, 'INVALID_METADATA', 'Malformed metadata JSON.'); }
  }
  return { metadata, bytes: new Uint8Array(await audio.arrayBuffer()), mimeType: audio.type || '' };
}

/**
 * Safely decodes a captured route path segment without crashing on malformed `%` escapes.
 * @param {string} rawSegment - Raw URL segment.
 * @returns {string} Decoded ID string.
 */
function decodePathId(rawSegment) {
  try {
    return decodeURIComponent(rawSegment);
  } catch {
    throw new HttpApiError(400, 'INVALID_URL_ENCODING', 'Malformed character identifier in URL.');
  }
}

/**
 * Maps internal/domain errors into safe HTTP status codes and user-readable JSON errors.
 * @param {unknown} error - Thrown error.
 * @returns {{ status: number, code: string, message: string }} Sanitized error descriptor.
 */
function mapErrorToHttp(error) {
  if (error instanceof HttpApiError) return { status: error.status, code: error.code, message: error.message };
  if (error instanceof FfmpegUnavailableError) return { status: 503, code: error.code, message: error.message };
  if (error instanceof ValidationError) {
    const status = error.code === 'UNSUPPORTED_AUDIO_TYPE' ? 415 : 422;
    return { status, code: error.code || 'VALIDATION_ERROR', message: error.message };
  }
  if (error instanceof StorageError) return { status: 500, code: error.code || 'STORAGE_ERROR', message: error.message };
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Internal storage service error.' };
}

/**
 * Dispatches character collection and item endpoints (`/api/v1/characters`).
 * @param {{ req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL, store: object, requestId: string }} ctx - Route context.
 * @returns {Promise<boolean>} True if route matched.
 */
async function handleCharacterRoutes({ req, res, url, store, requestId }) {
  if (url.pathname === `${API_PREFIX}/characters` && req.method === 'GET') {
    const page = await store.listCharacters({ limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset') });
    sendJson({ res, status: 200, payload: { data: { items: page.items }, meta: page }, requestId });
    return true;
  }
  const match = /^\/api\/v1\/characters\/([^/]+)$/.exec(url.pathname);
  if (!match) return false;
  const id = decodePathId(match[1]);
  if (req.method === 'PUT') {
    const body = await readJsonPayload(req);
    const { character, isCreated } = await store.upsertCharacter(id, body);
    sendJson({ res, status: isCreated ? 201 : 200, payload: { data: { character } }, requestId });
    return true;
  }
  if (req.method === 'DELETE') {
    const deleted = await store.deleteCharacter(id);
    if (!deleted) throw new HttpApiError(404, 'CHARACTER_NOT_FOUND', 'Character was not found.');
    sendJson({ res, status: 200, payload: { data: { deleted: true, id } }, requestId });
    return true;
  }
  return false;
}

/**
 * Streams an active anchor's stored binary audio clip with safe response headers.
 * @param {{ res: import('node:http').ServerResponse, store: object, rawId: string, requestId: string }} spec - Stream context.
 * @returns {Promise<void>} Resolves once response ends.
 */
async function streamAnchorAudio({ res, store, rawId, requestId }) {
  const audio = await store.getAnchorAudio(rawId);
  if (!audio) throw new HttpApiError(404, 'ANCHOR_NOT_FOUND', 'Voice sample audio not found.');
  res.writeHead(200, {
    'Content-Type': audio.mimeType,
    'Content-Length': String(audio.bytes.byteLength),
    'ETag': `"${audio.sha256}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Request-Id': requestId,
  });
  res.end(audio.bytes);
}

/**
 * Dispatches anchor metadata and binary audio endpoints (`/api/v1/anchors`).
 * @param {{ req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL, store: object, requestId: string }} ctx - Route context.
 * @returns {Promise<boolean>} True if route matched.
 */
async function handleAnchorRoutes({ req, res, url, store, requestId }) {
  if (url.pathname === `${API_PREFIX}/anchors` && req.method === 'GET') {
    const page = await store.listAnchors({ limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset') });
    sendJson({ res, status: 200, payload: { data: { items: page.items }, meta: page }, requestId });
    return true;
  }
  const audioMatch = /^\/api\/v1\/anchors\/([^/]+)\/audio$/.exec(url.pathname);
  if (audioMatch && req.method === 'GET') {
    await streamAnchorAudio({ res, store, rawId: decodePathId(audioMatch[1]), requestId });
    return true;
  }
  return handleAnchorMutationRoutes({ req, res, url, store, requestId });
}

/**
 * Dispatches mutating anchor endpoints (`PUT`, `PATCH`, `DELETE /api/v1/anchors/:id`).
 * @param {{ req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL, store: object, requestId: string }} ctx - Route context.
 * @returns {Promise<boolean>} True if route matched.
 */
async function handleAnchorMutationRoutes({ req, res, url, store, requestId }) {
  const match = /^\/api\/v1\/anchors\/([^/]+)$/.exec(url.pathname);
  if (!match) return false;
  const characterId = decodePathId(match[1]);
  if (req.method === 'PUT') {
    const parsed = await readMultipartAnchor(req);
    const anchor = await store.upsertAnchor({ characterId, ...parsed });
    sendJson({ res, status: 200, payload: { data: { anchor } }, requestId });
    return true;
  }
  if (req.method === 'PATCH') {
    const anchor = await store.patchAnchor(characterId, await readJsonPayload(req));
    if (!anchor) throw new HttpApiError(404, 'ANCHOR_NOT_FOUND', 'Locked voice anchor not found.');
    sendJson({ res, status: 200, payload: { data: { anchor } }, requestId });
    return true;
  }
  if (req.method === 'DELETE') {
    const deleted = await store.deleteAnchor(characterId);
    sendJson({ res, status: 200, payload: { data: { deleted, characterId } }, requestId });
    return true;
  }
  return false;
}

/**
 * Writes binary WAV audio bytes with safe download headers.
 * @param {object} spec - Response stream configuration.
 */
function sendBinaryAudio({ res, bytes, mimeType, requestId, extraHeaders = {} }) {
  res.writeHead(200, {
    'Content-Type': mimeType || 'audio/wav',
    'Content-Length': String(bytes.byteLength),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Request-Id': requestId,
    ...extraHeaders,
  });
  res.end(bytes);
}

/**
 * Dispatches FFmpeg EBU R128 mastering endpoint (`POST /api/v1/audio/master`).
 * @param {{ req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL, audioMaster: object, requestId: string }} ctx - Route context.
 * @returns {Promise<boolean>} True if route matched.
 */
async function handleAudioMasterRoute({ req, res, url, audioMaster, requestId }) {
  if (url.pathname !== `${API_PREFIX}/audio/master` || req.method !== 'POST') return false;
  if (!audioMaster) throw new FfmpegUnavailableError();
  const parsed = await readMultipartAnchor(req);
  const bytes = await audioMaster.masterWav({ bytes: parsed.bytes, mimeType: parsed.mimeType });
  sendBinaryAudio({ res, bytes, mimeType: 'audio/wav', requestId, extraHeaders: { 'X-Audio-Mastered': 'ffmpeg-ebur128' } });
  return true;
}

/**
 * Dispatches bounded synthesis cache endpoints (`GET`, `PUT /api/v1/cache/:key`).
 * @param {{ req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL, store: object, requestId: string }} ctx - Route context.
 * @returns {Promise<boolean>} True if route matched.
 */
async function handleCacheRoutes({ req, res, url, store, requestId }) {
  const audioMatch = /^\/api\/v1\/cache\/([^/]+)\/audio$/.exec(url.pathname);
  if (audioMatch && req.method === 'GET') {
    const cached = await store.getCacheAudio(decodePathId(audioMatch[1]));
    if (!cached) throw new HttpApiError(404, 'CACHE_MISS', 'Cached synthesis audio not found.');
    sendBinaryAudio({ res, bytes: cached.bytes, mimeType: cached.meta.mimeType, requestId });
    return true;
  }
  const metaMatch = /^\/api\/v1\/cache\/([^/]+)$/.exec(url.pathname);
  if (!metaMatch) return false;
  const key = decodePathId(metaMatch[1]);
  if (req.method === 'GET') {
    const entry = await store.getCacheEntry(key);
    if (!entry) throw new HttpApiError(404, 'CACHE_MISS', 'Cached synthesis entry not found.');
    sendJson({ res, status: 200, payload: { data: { hit: true, entry } }, requestId });
    return true;
  }
  if (req.method !== 'PUT') return false;
  const entry = await store.putCacheEntry({ key, ...(await readMultipartAnchor(req)) });
  sendJson({ res, status: 200, payload: { data: { entry } }, requestId });
  return true;
}

/**
 * Dispatches versioned project snapshot endpoints (`GET`, `PUT`, `DELETE /api/v1/projects[:id]`).
 * @param {{ req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL, store: object, requestId: string }} ctx - Route context.
 * @returns {Promise<boolean>} True if route matched.
 */
async function handleProjectRoutes({ req, res, url, store, requestId }) {
  if (url.pathname === `${API_PREFIX}/projects` && req.method === 'GET') {
    const page = await store.listProjects({ limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset') });
    const { items, ...meta } = page;
    sendJson({ res, status: 200, payload: { data: { items }, meta }, requestId });
    return true;
  }
  const match = /^\/api\/v1\/projects\/([^/]+)$/.exec(url.pathname);
  if (!match) return false;
  let id;
  try {
    id = assertSafeProjectId(match[1], 'projectId');
  } catch (error) {
    throw new HttpApiError(400, 'INVALID_PROJECT_ID', error.message);
  }
  if (req.method === 'GET') {
    const project = await store.getProject(id);
    if (!project) throw new HttpApiError(404, 'PROJECT_NOT_FOUND', 'Project snapshot not found.');
    sendJson({ res, status: 200, payload: { data: { project } }, requestId });
    return true;
  }
  if (req.method === 'PUT') {
    const body = await readJsonPayload(req);
    const { project, isCreated } = await store.upsertProject(id, body);
    sendJson({ res, status: isCreated ? 201 : 200, payload: { data: { project } }, requestId });
    return true;
  }
  if (req.method === 'DELETE') {
    const deleted = await store.deleteProject(id);
    if (!deleted) throw new HttpApiError(404, 'PROJECT_NOT_FOUND', 'Project was not found.');
    sendJson({ res, status: 200, payload: { data: { deleted: true, id } }, requestId });
    return true;
  }
  return false;
}

/**
 * Dispatches the pronunciation dictionary endpoint (`GET`, `PUT /api/v1/glossary`).
 * `PUT` replaces the whole dictionary: malformed body shape → 400, rule violations → 422, other verbs → 405.
 * @param {{ req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL, store: object, requestId: string }} ctx - Route context.
 * @returns {Promise<boolean>} True if route matched.
 */
async function handleGlossaryRoutes({ req, res, url, store, requestId }) {
  if (url.pathname !== `${API_PREFIX}/glossary`) return false;
  if (req.method === 'GET') {
    const glossary = await store.getGlossary();
    sendGlossary({ res, status: 200, glossary, requestId });
    return true;
  }
  if (req.method === 'PUT') {
    const body = await readJsonPayload(req);
    const unknownKeys = Object.keys(body).filter(key => key !== 'rules');
    if (!Array.isArray(body.rules) || unknownKeys.length > 0) {
      throw new HttpApiError(400, 'INVALID_GLOSSARY_PAYLOAD', 'Body must be { "rules": [...] }.');
    }
    sendGlossary({ res, status: 200, glossary: await store.replaceGlossary(body.rules), requestId });
    return true;
  }
  throw new HttpApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET or PUT for the pronunciation glossary.');
}

/**
 * Writes the `{ data: { rules }, meta }` glossary envelope.
 * @param {{ res: import('node:http').ServerResponse, status: number, glossary: { rules: Array<object>, updatedAt: string|null }, requestId: string }} spec - Response spec.
 */
function sendGlossary({ res, status, glossary, requestId }) {
  const meta = { count: glossary.rules.length, maxRules: MAX_GLOSSARY_RULES, updatedAt: glossary.updatedAt ?? null };
  sendJson({ res, status, payload: { data: { rules: glossary.rules }, meta }, requestId });
}

/**
 * Resolves health or domain/audio routes inside the API gateway.
 * @param {object} ctx - Dispatch context.
 * @returns {Promise<void>} Resolves once response has been written.
 */
async function routeApiRequest(ctx) {
  const { req, res, url, store, audioMaster, requestId } = ctx;
  if (url.pathname === `${API_PREFIX}/health` && req.method === 'GET') {
    const ffmpegAvailable = audioMaster ? await audioMaster.checkAvailability() : false;
    sendJson({ res, status: 200, payload: { data: { status: 'ok', service: 'voice-studio-storage', ffmpegAvailable } }, requestId });
    return;
  }
  if (url.pathname === `${API_PREFIX}/stats` && req.method === 'GET') {
    const storage = await store.getStats();
    const { rss } = process.memoryUsage();
    sendJson({ res, status: 200, payload: { data: { storage, container: { rssBytes: rss, uptimeSeconds: Math.round(process.uptime()) } } }, requestId });
    return;
  }
  const handled = (await handleCharacterRoutes(ctx))
    || (await handleAnchorRoutes(ctx))
    || (await handleProjectRoutes(ctx))
    || (await handleGlossaryRoutes(ctx))
    || (await handleAudioMasterRoute(ctx))
    || (await handleCacheRoutes(ctx));
  if (!handled) throw new HttpApiError(404, 'NOT_FOUND', 'Endpoint not found.');
}

/**
 * Routes a single API request and guarantees structured error/access logging.
 * @param {object} deps - Request handler dependencies.
 * @returns {Promise<void>} Resolves once response ends.
 */
async function dispatchStorageRequest({ req, res, store, audioMaster, limiter, logger }) {
  const startedAt = Date.now();
  const requestId = resolveRequestId(req);
  const url = new URL(req.url || '/', 'http://storage.local');
  try {
    const rate = limiter.check(resolveClientIp(req));
    if (!rate.allowed) throw new HttpApiError(429, 'RATE_LIMIT_EXCEEDED', 'Too many storage requests. Retry shortly.', rate.retryAfterSeconds);
    const rawPath = String(req.url || '/').split(/[?#]/, 1)[0];
    if (/^\/api\/v1\/projects\/(?:\.{1,2}|%2e(?:%2e)?)(?:\/|$)/i.test(rawPath)) {
      throw new HttpApiError(400, 'INVALID_PROJECT_ID', 'Project id must be a UUID.');
    }
    await routeApiRequest({ req, res, url, store, audioMaster, requestId });
    if (url.pathname !== `${API_PREFIX}/health`) {
      logger.info('HTTP request completed', { method: req.method, path: url.pathname, status: res.statusCode, durationMs: Date.now() - startedAt }, requestId);
    }
  } catch (error) {
    const mapped = mapErrorToHttp(error);
    const retryHeader = mapped.status === 429 ? { 'Retry-After': String(error?.retryAfterSeconds || 60) } : {};
    const extraHeaders = mapped.status === 405 ? { Allow: 'GET, PUT' } : retryHeader;
    logger.error('HTTP request failed', { method: req.method, path: url.pathname, status: mapped.status, code: mapped.code, errorMessage: error?.message }, requestId);
    if (!res.headersSent) sendJson({ res, status: mapped.status, payload: { data: null, error: { code: mapped.code, message: mapped.message } }, requestId, headers: extraHeaders });
  }
}

/**
 * Creates the Node HTTP request listener for Voice Studio persistent backend storage.
 * Inputs: `{ store, audioMaster, rateLimitOptions, logger }`.
 * Outputs: `(req, res) => Promise<void>` HTTP handler.
 * Side effects: reads/writes `store`, invokes FFmpeg mastering if available, applies per-IP rate limiting, emits structured JSON logs.
 * Failure modes: converts all unhandled rejections into HTTP 500 JSON envelopes without crashing.
 * @param {{ store: object, audioMaster?: object, rateLimitOptions?: object, logger?: object }} deps - App dependencies.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} Request handler.
 */
export function createStorageHttpApp({ store, audioMaster, rateLimitOptions = {}, logger = createServerLogger() }) {
  const limiter = createRateLimiter(rateLimitOptions);
  const effectiveAudioMaster = audioMaster ?? createAudioMaster({ logger });
  return (req, res) => dispatchStorageRequest({ req, res, store, audioMaster: effectiveAudioMaster, limiter, logger });
}
