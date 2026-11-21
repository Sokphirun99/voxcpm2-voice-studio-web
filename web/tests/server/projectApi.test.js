/**
 * @fileoverview Automated integration tests for R1-03 Project management and Asset HTTP APIs.
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
const OCTET_TYPE = 'application/octet-stream';
const TEST_PROJECT_ID_A = '11111111-1111-4111-8111-111111111111';
const TEST_PROJECT_ID_B = '22222222-2222-4222-8222-222222222222';

async function invokeApp(handler, { method = 'GET', urlPath, headers = {}, body = null }) {
  let reqHeaders = { ...headers };
  let rawBytes = Buffer.alloc(0);
  if (body instanceof FormData) {
    const serialized = new Request(`http://storage.local${urlPath}`, { method, body });
    reqHeaders = { ...Object.fromEntries(serialized.headers.entries()), ...reqHeaders };
    rawBytes = Buffer.from(await serialized.arrayBuffer());
  } else if (typeof body === 'string') {
    rawBytes = Buffer.from(body, 'utf8');
  } else if (body instanceof Uint8Array) {
    rawBytes = Buffer.from(body);
  }

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

async function withApiServer(run) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'voxcpm-project-api-'));
  const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
  const store = createStorageStore({ dataDir });
  await store.init();
  const handler = createStorageHttpApp({ store, rateLimitOptions: { maxRequests: 500 }, logger: silentLogger });
  try {
    return await run({ handler, store, dataDir });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('POST /api/v1/projects creates a project and returns 201 Created with schemaVersion 1', async () => {
  await withApiServer(async ({ handler }) => {
    const res = await invokeApp(handler, {
      method: 'POST',
      urlPath: '/api/v1/projects',
      headers: { 'content-type': JSON_TYPE },
      body: JSON.stringify({
        type: 'tts',
        title: 'Storytelling Intro',
        settings: { script: 'Hello world', voiceId: 'voice-sokha' },
      }),
    });
    assert.equal(res.status, 201);
    const { project } = res.json().data;
    assert.ok(project.id);
    assert.equal(project.type, 'tts');
    assert.equal(project.title, 'Storytelling Intro');
    assert.equal(project.revision, 1);
    assert.equal(project.status, 'draft');
    assert.equal(project.schemaVersion, 1);
    assert.equal(project.deletedAt, null);
  });
});

test('GET /api/v1/projects supports pagination, type filtering, and search query', async () => {
  await withApiServer(async ({ handler }) => {
    await invokeApp(handler, {
      method: 'POST',
      urlPath: '/api/v1/projects',
      headers: { 'content-type': JSON_TYPE },
      body: JSON.stringify({ type: 'tts', title: 'Khmer News Segment 1' }),
    });
    await invokeApp(handler, {
      method: 'POST',
      urlPath: '/api/v1/projects',
      headers: { 'content-type': JSON_TYPE },
      body: JSON.stringify({ type: 'subtitles', title: 'Khmer News Subtitles' }),
    });
    await invokeApp(handler, {
      method: 'POST',
      urlPath: '/api/v1/projects',
      headers: { 'content-type': JSON_TYPE },
      body: JSON.stringify({ type: 'dubbing', title: 'Anime Dub Ep 1' }),
    });

    const allRes = await invokeApp(handler, { urlPath: '/api/v1/projects?limit=10' });
    assert.equal(allRes.status, 200);
    assert.equal(allRes.json().meta.total, 3);
    assert.equal(allRes.json().data.items.length, 3);

    const ttsOnly = await invokeApp(handler, { urlPath: '/api/v1/projects?type=tts' });
    assert.equal(ttsOnly.json().meta.total, 1);
    assert.equal(ttsOnly.json().data.items[0].type, 'tts');

    const searchRes = await invokeApp(handler, { urlPath: '/api/v1/projects?search=anime' });
    assert.equal(searchRes.json().meta.total, 1);
    assert.equal(searchRes.json().data.items[0].title, 'Anime Dub Ep 1');
  });
});

test('PUT /api/v1/projects/:id enforces revision conflict detection with 409 Conflict', async () => {
  await withApiServer(async ({ handler }) => {
    const createRes = await invokeApp(handler, {
      method: 'PUT',
      urlPath: `/api/v1/projects/${TEST_PROJECT_ID_A}`,
      headers: { 'content-type': JSON_TYPE },
      body: JSON.stringify({ type: 'tts', title: 'Revision Test' }),
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.json().data.project.revision, 1);

    const updateRes = await invokeApp(handler, {
      method: 'PUT',
      urlPath: `/api/v1/projects/${TEST_PROJECT_ID_A}`,
      headers: { 'content-type': JSON_TYPE, 'if-match': '1' },
      body: JSON.stringify({ type: 'tts', title: 'Revision Test (Updated)' }),
    });
    assert.equal(updateRes.status, 200);
    assert.equal(updateRes.json().data.project.revision, 2);

    const conflictRes = await invokeApp(handler, {
      method: 'PUT',
      urlPath: `/api/v1/projects/${TEST_PROJECT_ID_A}`,
      headers: { 'content-type': JSON_TYPE, 'if-match': '1' },
      body: JSON.stringify({ type: 'tts', title: 'Stale Revision Overwrite' }),
    });
    assert.equal(conflictRes.status, 409);
    assert.equal(conflictRes.json().error.code, 'REVISION_CONFLICT');
  });
});

test('DELETE /api/v1/projects/:id soft-deletes with revision check and returns 404 when deleted', async () => {
  await withApiServer(async ({ handler }) => {
    await invokeApp(handler, {
      method: 'PUT',
      urlPath: `/api/v1/projects/${TEST_PROJECT_ID_A}`,
      headers: { 'content-type': JSON_TYPE },
      body: JSON.stringify({ type: 'subtitles', title: 'Delete Test' }),
    });

    const conflictDel = await invokeApp(handler, {
      method: 'DELETE',
      urlPath: `/api/v1/projects/${TEST_PROJECT_ID_A}?expectedRevision=99`,
    });
    assert.equal(conflictDel.status, 409);

    const okDel = await invokeApp(handler, {
      method: 'DELETE',
      urlPath: `/api/v1/projects/${TEST_PROJECT_ID_A}?expectedRevision=1`,
    });
    assert.equal(okDel.status, 200);
    assert.equal(okDel.json().data.deleted, true);

    const getDel = await invokeApp(handler, { urlPath: `/api/v1/projects/${TEST_PROJECT_ID_A}` });
    assert.equal(getDel.status, 404);
  });
});

test('POST /api/v1/projects/:id/duplicate creates a new project with fresh revision and title', async () => {
  await withApiServer(async ({ handler }) => {
    await invokeApp(handler, {
      method: 'PUT',
      urlPath: `/api/v1/projects/${TEST_PROJECT_ID_A}`,
      headers: { 'content-type': JSON_TYPE },
      body: JSON.stringify({
        type: 'tts',
        title: 'Original Voice Project',
        segments: [{ id: 'seg-1', text: 'Hello', translatedText: '', start: 0, end: 1 }],
      }),
    });

    const dupRes = await invokeApp(handler, {
      method: 'POST',
      urlPath: `/api/v1/projects/${TEST_PROJECT_ID_A}/duplicate`,
      headers: { 'content-type': JSON_TYPE },
      body: JSON.stringify({ title: 'Cloned Voice Project' }),
    });
    assert.equal(dupRes.status, 201);
    const cloned = dupRes.json().data.project;
    assert.notEqual(cloned.id, TEST_PROJECT_ID_A);
    assert.equal(cloned.title, 'Cloned Voice Project');
    assert.equal(cloned.revision, 1);
    assert.equal(cloned.segments.length, 1);
    assert.equal(cloned.segments[0].text, 'Hello');
  });
});

test('POST /api/v1/projects/:id/restore revives a soft-deleted project', async () => {
  await withApiServer(async ({ handler }) => {
    await invokeApp(handler, {
      method: 'PUT',
      urlPath: `/api/v1/projects/${TEST_PROJECT_ID_A}`,
      headers: { 'content-type': JSON_TYPE },
      body: JSON.stringify({ type: 'subtitles', title: 'Restore Me' }),
    });
    await invokeApp(handler, { method: 'DELETE', urlPath: `/api/v1/projects/${TEST_PROJECT_ID_A}` });

    const restoreRes = await invokeApp(handler, {
      method: 'POST',
      urlPath: `/api/v1/projects/${TEST_PROJECT_ID_A}/restore`,
    });
    assert.equal(restoreRes.status, 200);
    assert.equal(restoreRes.json().data.restored, true);
    assert.equal(restoreRes.json().data.project.deletedAt, null);

    const getRes = await invokeApp(handler, { urlPath: `/api/v1/projects/${TEST_PROJECT_ID_A}` });
    assert.equal(getRes.status, 200);
    assert.equal(getRes.json().data.project.title, 'Restore Me');
  });
});

test('POST /api/v1/projects/:id/assets uploads multipart asset and streams via GET binary', async () => {
  await withApiServer(async ({ handler }) => {
    await invokeApp(handler, {
      method: 'PUT',
      urlPath: `/api/v1/projects/${TEST_PROJECT_ID_A}`,
      headers: { 'content-type': JSON_TYPE },
      body: JSON.stringify({ type: 'subtitles', title: 'Video Project' }),
    });

    const form = new FormData();
    const videoBytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    form.set('file', new File([videoBytes], 'sample.mp4', { type: 'video/mp4' }));
    form.set('kind', 'video');

    const uploadRes = await invokeApp(handler, {
      method: 'POST',
      urlPath: `/api/v1/projects/${TEST_PROJECT_ID_A}/assets`,
      body: form,
    });
    assert.equal(uploadRes.status, 201);
    const { asset } = uploadRes.json().data;
    assert.ok(asset.id);
    assert.equal(asset.fileName, 'sample.mp4');
    assert.equal(asset.kind, 'video');
    assert.equal(asset.projectId, TEST_PROJECT_ID_A);

    const metaRes = await invokeApp(handler, { urlPath: `/api/v1/assets/${asset.id}` });
    assert.equal(metaRes.status, 200);
    assert.equal(metaRes.json().data.asset.id, asset.id);

    const streamRes = await invokeApp(handler, { urlPath: `/api/v1/assets/${asset.id}/binary` });
    assert.equal(streamRes.status, 200);
    assert.equal(streamRes.headers['content-type'], 'video/mp4');
    assert.equal(streamRes.headers['content-length'], '8');
    assert.ok(streamRes.headers['etag']);
    assert.deepEqual(new Uint8Array(streamRes.buffer), videoBytes);

    const listRes = await invokeApp(handler, { urlPath: `/api/v1/projects/${TEST_PROJECT_ID_A}/assets` });
    assert.equal(listRes.status, 200);
    assert.equal(listRes.json().meta.total, 1);
    assert.equal(listRes.json().data.items[0].id, asset.id);

    const delRes = await invokeApp(handler, { method: 'DELETE', urlPath: `/api/v1/assets/${asset.id}` });
    assert.equal(delRes.status, 200);
    assert.equal(delRes.json().data.deleted, true);
  });
});

test('POST /api/v1/assets supports direct binary upload and validates missing project', async () => {
  await withApiServer(async ({ handler }) => {
    const rawAudio = new Uint8Array([10, 20, 30, 40]);
    const uploadRes = await invokeApp(handler, {
      method: 'POST',
      urlPath: '/api/v1/assets',
      headers: {
        'content-type': 'audio/wav',
        'x-file-name': 'direct.wav',
        'x-asset-kind': 'audio',
      },
      body: rawAudio,
    });
    assert.equal(uploadRes.status, 201);
    const { asset } = uploadRes.json().data;
    assert.equal(asset.fileName, 'direct.wav');
    assert.equal(asset.kind, 'audio');

    const missingProjectRes = await invokeApp(handler, {
      method: 'POST',
      urlPath: `/api/v1/projects/${TEST_PROJECT_ID_B}/assets`,
      headers: { 'content-type': OCTET_TYPE, 'x-file-name': 'clip.mp4' },
      body: new Uint8Array([1, 2]),
    });
    assert.equal(missingProjectRes.status, 404);
    assert.equal(missingProjectRes.json().error.code, 'PROJECT_NOT_FOUND');
  });
});

test('Asset API rejects path traversal and invalid UUID formats with 400', async () => {
  await withApiServer(async ({ handler }) => {
    const badId = await invokeApp(handler, { urlPath: '/api/v1/assets/not-a-uuid' });
    assert.equal(badId.status, 400);
    assert.equal(badId.json().error.code, 'INVALID_ASSET_ID');

    const traversal = await invokeApp(handler, { urlPath: '/api/v1/assets/../etc/passwd' });
    assert.equal(traversal.status, 400);
  });
});

test('POST /api/v1/projects rejects duplicate active ID with 409 Conflict', async () => {
  await withApiServer(async ({ handler }) => {
    const first = await invokeApp(handler, {
      method: 'POST',
      urlPath: '/api/v1/projects',
      headers: { 'content-type': JSON_TYPE },
      body: JSON.stringify({ id: TEST_PROJECT_ID_A, type: 'tts', title: 'First Project' }),
    });
    assert.equal(first.status, 201);

    const dup = await invokeApp(handler, {
      method: 'POST',
      urlPath: '/api/v1/projects',
      headers: { 'content-type': JSON_TYPE },
      body: JSON.stringify({ id: TEST_PROJECT_ID_A, type: 'tts', title: 'Duplicate Project' }),
    });
    assert.equal(dup.status, 409);
    assert.equal(dup.json().error.code, 'PROJECT_ALREADY_EXISTS');
  });
});

test('PUT /api/v1/projects/:id with expectedRevision on non-existent project returns 409 Conflict', async () => {
  await withApiServer(async ({ handler }) => {
    const res = await invokeApp(handler, {
      method: 'PUT',
      urlPath: `/api/v1/projects/${TEST_PROJECT_ID_B}`,
      headers: { 'content-type': JSON_TYPE, 'if-match': '2' },
      body: JSON.stringify({ type: 'tts', title: 'Non-Existent Revision Check' }),
    });
    assert.equal(res.status, 409);
    assert.equal(res.json().error.code, 'REVISION_CONFLICT');
  });
});

test('GET /api/v1/projects/:id/assets returns 404 when project does not exist', async () => {
  await withApiServer(async ({ handler }) => {
    const res = await invokeApp(handler, { urlPath: `/api/v1/projects/${TEST_PROJECT_ID_B}/assets` });
    assert.equal(res.status, 404);
    assert.equal(res.json().error.code, 'PROJECT_NOT_FOUND');
  });
});

test('GET /api/v1/assets/:id/binary supports If-None-Match 304 and HEAD requests', async () => {
  await withApiServer(async ({ handler }) => {
    const uploadRes = await invokeApp(handler, {
      method: 'POST',
      urlPath: '/api/v1/assets',
      headers: { 'content-type': 'audio/wav', 'x-file-name': 'clip.wav' },
      body: new Uint8Array([5, 6, 7, 8]),
    });
    assert.equal(uploadRes.status, 201);
    const { asset } = uploadRes.json().data;

    const stream = await invokeApp(handler, { urlPath: `/api/v1/assets/${asset.id}/binary` });
    assert.equal(stream.status, 200);
    const etag = stream.headers['etag'];
    assert.ok(etag);

    const notModified = await invokeApp(handler, {
      urlPath: `/api/v1/assets/${asset.id}/binary`,
      headers: { 'if-none-match': etag },
    });
    assert.equal(notModified.status, 304);
    assert.equal(notModified.buffer.length, 0);

    const headRes = await invokeApp(handler, {
      method: 'HEAD',
      urlPath: `/api/v1/assets/${asset.id}/binary`,
    });
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers['content-type'], 'audio/wav');
    assert.equal(headRes.buffer.length, 0);
  });
});
