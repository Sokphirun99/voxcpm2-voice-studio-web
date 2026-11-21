import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAudioMaster } from '../../server/audioMaster.js';
import { createStorageHttpApp } from '../../server/httpApp.js';
import { createStorageStore } from '../../server/storageStore.js';

function createValidWavBytes(payload = [1, 2, 3, 4]) {
  const buf = new ArrayBuffer(44 + payload.length * 2);
  const view = new DataView(buf);
  const write = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  write(0, 'RIFF'); view.setUint32(4, 36 + payload.length * 2, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 48000, true); view.setUint32(28, 96000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, payload.length * 2, true);
  payload.forEach((v, i) => view.setInt16(44 + i * 2, v, true));
  return new Uint8Array(buf);
}

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

async function withStorageHandler(run, rateLimitOptions = { maxRequests: 100 }, extra = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'voxcpm-storage-test-'));
  const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
  const store = createStorageStore({ dataDir, maxCacheEntries: extra.maxCacheEntries });
  await store.init();
  const handler = createStorageHttpApp({ store, audioMaster: extra.audioMaster, rateLimitOptions, logger: extra.logger || silentLogger });
  try {
    return await run({ handler, dataDir, store });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('storage API persists characters, anchors, binary audio across store restart, and soft-deletes cleanly', async () => {
  await withStorageHandler(async ({ handler, dataDir }) => {
    const health = await invokeApp(handler, { urlPath: '/api/v1/health' });
    assert.equal(health.status, 200);
    assert.equal(health.json().data.status, 'ok');
    assert.equal(health.json().error, null);

    // Create two custom characters and verify pagination
    const c1 = await invokeApp(handler, {
      method: 'PUT',
      urlPath: '/api/v1/characters/char-video-1',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Sokha Host', category: 'male', description: 'Steady documentary voice' }),
    });
    assert.equal(c1.status, 201);

    const c2 = await invokeApp(handler, {
      method: 'PUT',
      urlPath: '/api/v1/characters/char-video-2',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Malis Narrator', category: 'female', description: 'Warm storytelling tone' }),
    });
    assert.equal(c2.status, 201);

    const page1 = await invokeApp(handler, { urlPath: '/api/v1/characters?limit=1&offset=0' });
    assert.equal(page1.json().data.items.length, 1);
    assert.equal(page1.json().meta.total, 2);
    assert.equal(page1.json().meta.hasMore, true);

    // Upload WAV anchor via multipart/form-data
    const wavBytes = createValidWavBytes([100, -200, 300, -400]);
    const form = new FormData();
    form.set('metadata', JSON.stringify({ label: 'Sokha Host', source: 'generated', fileName: 'sokha.wav', promptText: 'សួស្តី', exactClone: true }));
    form.set('audio', new File([wavBytes], 'sokha.wav', { type: 'audio/wav' }));
    const putAnchor = await invokeApp(handler, { method: 'PUT', urlPath: '/api/v1/anchors/char-video-1', body: form });
    assert.equal(putAnchor.status, 200);
    assert.equal(putAnchor.json().data.anchor.sizeBytes, wavBytes.byteLength);
    assert.equal(putAnchor.json().data.anchor.exactClone, true);

    // Stream binary audio and verify security headers
    const audioRes = await invokeApp(handler, { urlPath: '/api/v1/anchors/char-video-1/audio' });
    assert.equal(audioRes.status, 200);
    assert.equal(audioRes.headers['content-type'], 'audio/wav');
    assert.equal(audioRes.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(new Uint8Array(audioRes.buffer), wavBytes);

    // Simulate container restart by creating a new store against same dataDir
    const restartedStore = createStorageStore({ dataDir });
    const persistedChars = await restartedStore.listCharacters({});
    const persistedAnchors = await restartedStore.listAnchors({});
    assert.equal(persistedChars.total, 2);
    assert.equal(persistedAnchors.total, 1);
    assert.equal(persistedAnchors.items[0].promptText, 'សួស្តី');

    // Patch transcript/exactClone
    const patchRes = await invokeApp(handler, {
      method: 'PATCH',
      urlPath: '/api/v1/anchors/char-video-1',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ promptText: 'សួស្តីអ្នកទាំងអស់គ្នា', exactClone: false }),
    });
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.json().data.anchor.exactClone, false);

    // Soft-delete character hides both character and anchor
    const delRes = await invokeApp(handler, { method: 'DELETE', urlPath: '/api/v1/characters/char-video-1' });
    assert.equal(delRes.status, 200);
    const delAgain = await invokeApp(handler, { method: 'DELETE', urlPath: '/api/v1/characters/char-video-1' });
    assert.equal(delAgain.status, 404);
    assert.equal((await invokeApp(handler, { urlPath: '/api/v1/anchors' })).json().meta.total, 0);
    assert.equal((await invokeApp(handler, { urlPath: '/api/v1/anchors/char-video-1/audio' })).status, 404);
  });
});

test('storage API rejects path traversal, fake audio magic bytes, wrong MIME, and enforces rate limit', async () => {
  await withStorageHandler(async ({ handler }) => {
    const traversal = await invokeApp(handler, { urlPath: '/api/v1/anchors/..%2Fetc/audio' });
    assert.equal(traversal.status, 422);

    const badAudioForm = new FormData();
    badAudioForm.set('metadata', JSON.stringify({ label: 'Bad' }));
    badAudioForm.set('audio', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])], 'fake.wav', { type: 'audio/wav' }));
    const spoofed = await invokeApp(handler, { method: 'PUT', urlPath: '/api/v1/anchors/char-nisa', body: badAudioForm });
    assert.equal(spoofed.status, 422);
    assert.equal(spoofed.json().error.code, 'INVALID_AUDIO_CONTENT');

    const badMime = await invokeApp(handler, {
      method: 'PUT',
      urlPath: '/api/v1/characters/char-1',
      headers: { 'content-type': 'text/plain' },
      body: 'not-json',
    });
    assert.equal(badMime.status, 415);

    const r4 = await invokeApp(handler, { urlPath: '/api/v1/health' });
    const r5 = await invokeApp(handler, { urlPath: '/api/v1/health' });
    assert.equal(r4.status, 200);
    assert.equal(r5.status, 429);
    assert.ok(Number(r5.headers['retry-after']) >= 1);
  }, { maxRequests: 4 });
});

test('storage API accepts legacy application/octet-stream WAV after verifying magic bytes while rejecting non-audio MIME', async () => {
  await withStorageHandler(async ({ handler }) => {
    const wavBytes = createValidWavBytes([12, -12]);
    const legacyForm = new FormData();
    legacyForm.set('metadata', JSON.stringify({ label: 'Nisa', source: 'generated', fileName: 'nisa.wav' }));
    legacyForm.set('audio', new File([wavBytes], 'nisa.wav', { type: 'application/octet-stream' }));
    const okRes = await invokeApp(handler, { method: 'PUT', urlPath: '/api/v1/anchors/char-nisa', body: legacyForm });
    assert.equal(okRes.status, 200);
    assert.equal(okRes.json().data.anchor.mimeType, 'audio/wav');

    const audioRes = await invokeApp(handler, { urlPath: '/api/v1/anchors/char-nisa/audio' });
    assert.equal(audioRes.status, 200);
    assert.equal(audioRes.headers['content-type'], 'audio/wav');

    const wrongMimeForm = new FormData();
    wrongMimeForm.set('metadata', JSON.stringify({ label: 'BadMime' }));
    wrongMimeForm.set('audio', new File([wavBytes], 'pic.png', { type: 'image/png' }));
    const wrongMime = await invokeApp(handler, { method: 'PUT', urlPath: '/api/v1/anchors/char-malis', body: wrongMimeForm });
    assert.equal(wrongMime.status, 415);
    assert.equal(wrongMime.json().error.code, 'UNSUPPORTED_AUDIO_TYPE');

    const badOctetForm = new FormData();
    badOctetForm.set('metadata', JSON.stringify({ label: 'Spoof' }));
    badOctetForm.set('audio', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])], 'spoof.bin', { type: 'application/octet-stream' }));
    const spoofedOctet = await invokeApp(handler, { method: 'PUT', urlPath: '/api/v1/anchors/char-malis', body: badOctetForm });
    assert.equal(spoofedOctet.status, 422);
    assert.equal(spoofedOctet.json().error.code, 'INVALID_AUDIO_CONTENT');
  });
});

test('storage API masters audio via two-pass FFmpeg, handles unavailable/silent clips, and manages bounded LRU cache', async () => {
  const wavBytes = createValidWavBytes([10, -10, 20, -20]);
  const masteredOut = createValidWavBytes([50, -50, 60, -60]);
  const calls = [];
  let silentMode = false;
  let unavailableMode = false;

  const mockMaster = createAudioMaster({
    async runProcess({ args }) {
      calls.push(args);
      if (unavailableMode) {
        const err = new Error('not found');
        err.code = 'ENOENT';
        throw Object.assign(new (await import('../../server/audioMaster.js')).FfmpegUnavailableError(), {});
      }
      if (args.includes('-version')) return { stderr: 'ffmpeg version 7.0' };
      if (args.includes('null')) {
        return {
          stderr: silentMode
            ? '{"input_i":"-inf"}'
            : 'Summary:\n{"input_i":"-22.4","input_lra":"4.0","input_tp":"-6.2","input_thresh":"-32.0","target_offset":"1.2"}',
        };
      }
      const outPath = args[args.length - 1];
      await writeFile(outPath, masteredOut);
      return { stderr: '' };
    },
  });

  await withStorageHandler(async ({ handler }) => {
    const health = await invokeApp(handler, { urlPath: '/api/v1/health' });
    assert.equal(health.json().data.ffmpegAvailable, true);

    const form = new FormData();
    form.set('audio', new File([wavBytes], 'take.wav', { type: 'audio/wav' }));
    const masterRes = await invokeApp(handler, { method: 'POST', urlPath: '/api/v1/audio/master', body: form });
    assert.equal(masterRes.status, 200);
    assert.equal(masterRes.headers['x-audio-mastered'], 'ffmpeg-ebur128');
    assert.deepEqual(new Uint8Array(masterRes.buffer), masteredOut);
    assert.ok(calls.some(args => args.includes('-ar') && args.includes('48000')));

    // Silent clip returns original WAV bytes safely
    silentMode = true;
    const silentForm = new FormData();
    silentForm.set('audio', new File([wavBytes], 'silent.wav', { type: 'audio/wav' }));
    const silentRes = await invokeApp(handler, { method: 'POST', urlPath: '/api/v1/audio/master', body: silentForm });
    assert.equal(silentRes.status, 200);
    assert.deepEqual(new Uint8Array(silentRes.buffer), wavBytes);

    // Missing ffmpeg surfaces truthful 503
    unavailableMode = true;
    const unavailForm = new FormData();
    unavailForm.set('audio', new File([wavBytes], 'x.wav', { type: 'audio/wav' }));
    const unavailRes = await invokeApp(handler, { method: 'POST', urlPath: '/api/v1/audio/master', body: unavailForm });
    assert.equal(unavailRes.status, 503);
    assert.equal(unavailRes.json().error.code, 'FFMPEG_UNAVAILABLE');

    // Synthesis cache put/get/invalid key & LRU eviction (maxCacheEntries: 2)
    const k1 = 'a'.repeat(64);
    const k2 = 'b'.repeat(64);
    const k3 = 'c'.repeat(64);
    for (const [k, seed] of [[k1, 1], [k2, 2], [k3, 3]]) {
      const f = new FormData();
      f.set('metadata', JSON.stringify({ characterId: 'char-malis', seed }));
      f.set('audio', new File([wavBytes], `${k}.wav`, { type: 'audio/wav' }));
      const putCache = await invokeApp(handler, { method: 'PUT', urlPath: `/api/v1/cache/${k}`, body: f });
      assert.equal(putCache.status, 200);
    }
    assert.equal((await invokeApp(handler, { urlPath: `/api/v1/cache/${k1}` })).status, 404);
    assert.equal((await invokeApp(handler, { urlPath: `/api/v1/cache/${k3}/audio` })).status, 200);
    assert.equal((await invokeApp(handler, { urlPath: '/api/v1/cache/not-a-sha' })).status, 422);
  }, { maxRequests: 100 }, { audioMaster: mockMaster, maxCacheEntries: 2 });
});

test('storage API skips noisy INFO logs on 200 /api/v1/health while keeping real request and error logs', async () => {
  const events = [];
  const captureLogger = {
    debug(msg, ctx) { events.push({ level: 'debug', msg, ctx }); },
    info(msg, ctx) { events.push({ level: 'info', msg, ctx }); },
    warn(msg, ctx) { events.push({ level: 'warn', msg, ctx }); },
    error(msg, ctx) { events.push({ level: 'error', msg, ctx }); },
  };
  await withStorageHandler(async ({ handler }) => {
    const h1 = await invokeApp(handler, { urlPath: '/api/v1/health' });
    assert.equal(h1.status, 200);
    assert.equal(events.filter(e => e.level === 'info').length, 0);

    const listRes = await invokeApp(handler, { urlPath: '/api/v1/characters' });
    assert.equal(listRes.status, 200);
    assert.equal(events.filter(e => e.level === 'info').length, 1);
    assert.equal(events.find(e => e.level === 'info').ctx.path, '/api/v1/characters');

    const limited = await invokeApp(handler, { urlPath: '/api/v1/health' });
    assert.equal(limited.status, 429);
    assert.equal(events.filter(e => e.level === 'error').length, 1);
  }, { maxRequests: 2 }, { logger: captureLogger });
});

test('storage API reports accurate /api/v1/stats capacity and container memory usage', async () => {
  const wavBytes = createValidWavBytes([10, -10, 20, -20]);
  await withStorageHandler(async ({ handler }) => {
    const f = new FormData();
    f.set('metadata', JSON.stringify({ characterId: 'char-nisa', seed: 123 }));
    f.set('audio', new File([wavBytes], 'cached.wav', { type: 'audio/wav' }));
    assert.equal((await invokeApp(handler, { method: 'PUT', urlPath: `/api/v1/cache/${'d'.repeat(64)}`, body: f })).status, 200);

    const statsRes = await invokeApp(handler, { urlPath: '/api/v1/stats' });
    assert.equal(statsRes.status, 200);
    const { storage, container } = statsRes.json().data;
    assert.equal(storage.cacheEntriesCount, 1);
    assert.equal(storage.maxCacheEntries, 5);
    assert.equal(storage.cacheBytes, wavBytes.byteLength);
    assert.equal(storage.usedBytes, wavBytes.byteLength);
    assert.equal(typeof container.rssBytes, 'number');
    assert.ok(container.rssBytes > 0);
  }, { maxRequests: 50 }, { maxCacheEntries: 5 });
});

test('storage API creates, lists, gets, updates, and soft-deletes subtitle projects', async () => {
  await withStorageHandler(async ({ handler, dataDir, store }) => {
    const projectId = '11111111-1111-1111-1111-111111111111';

    // Create a subtitle project
    const createRes = await invokeApp(handler, {
      method: 'PUT',
      urlPath: `/api/v1/projects/${projectId}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'subtitle',
        title: 'News Clip Subtitles',
        payload: {
          videoFileName: 'news.mp4',
          segments: [{ id: 'seg-1', start: 0.0, end: 2.0, text: 'Hello world' }],
          speakerNames: { 'speaker-1': 'Host' },
          subtitleOptions: { sourceLanguage: 'en', targetLanguage: 'km' },
        },
      }),
    });
    assert.equal(createRes.status, 201, 'create should return 201');
    assert.equal(createRes.json().data.project.kind, 'subtitle');
    assert.equal(createRes.json().data.project.title, 'News Clip Subtitles');
    assert.equal(createRes.json().data.project.id, projectId);
    assert.ok(createRes.json().data.project.createdAt);
    assert.ok(createRes.json().data.project.updatedAt);

    // Create a TTS project
    const ttsRes = await invokeApp(handler, {
      method: 'PUT',
      urlPath: '/api/v1/projects/22222222-2222-2222-2222-222222222222',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'tts',
        title: 'Khmer TTS Script',
        payload: { script: 'សួស្តី', voiceId: 'voice-1', ttsOptions: { guidance: 1.5 } },
      }),
    });
    assert.equal(ttsRes.status, 201);

    // List projects (paginated, sorted by updatedAt desc)
    const listRes = await invokeApp(handler, { urlPath: '/api/v1/projects?limit=50&offset=0' });
    assert.equal(listRes.status, 200);
    assert.equal(listRes.json().meta.total, 2);
    assert.equal(listRes.json().meta.limit, 50);
    assert.equal(listRes.json().meta.offset, 0);
    assert.equal(listRes.json().meta.hasMore, false);
    assert.equal(listRes.json().data.items.length, 2);
    assert.equal('items' in listRes.json().meta, false);
    const ids = listRes.json().data.items.map(i => i.id);
    assert.ok(ids.includes(projectId));
    assert.ok(ids.includes('22222222-2222-2222-2222-222222222222'));
    const subtitleItem = listRes.json().data.items.find(i => i.id === projectId);
    assert.equal(subtitleItem.kind, 'subtitle');
    const firstPage = await invokeApp(handler, { urlPath: '/api/v1/projects?limit=1&offset=0' });
    assert.equal(firstPage.json().data.items.length, 1);
    assert.equal(firstPage.json().meta.hasMore, true);

    // Get full project snapshot
    const getRes = await invokeApp(handler, { urlPath: `/api/v1/projects/${projectId}` });
    assert.equal(getRes.status, 200);
    assert.equal(getRes.json().data.project.id, projectId);
    assert.equal(getRes.json().data.project.payload.videoFileName, 'news.mp4');
    assert.equal(getRes.json().data.project.payload.segments.length, 1);
    assert.equal(getRes.json().data.project.payload.speakerNames['speaker-1'], 'Host');

    // Update project (should preserve createdAt)
    const updateRes = await invokeApp(handler, {
      method: 'PUT',
      urlPath: `/api/v1/projects/${projectId}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'subtitle',
        title: 'News Clip Subtitles (revised)',
        payload: { videoFileName: 'news.mp4', segments: [], speakerNames: {}, subtitleOptions: {} },
      }),
    });
    assert.equal(updateRes.status, 200);
    assert.equal(updateRes.json().data.project.title, 'News Clip Subtitles (revised)');
    assert.equal(updateRes.json().data.project.revision, 2);
    const createdAtBefore = createRes.json().data.project.createdAt;
    assert.equal(updateRes.json().data.project.createdAt, createdAtBefore);
    assert.notEqual(updateRes.json().data.project.updatedAt, createRes.json().data.project.updatedAt);

    // Stale expectedRevision returns HTTP 409 Conflict
    const staleRes = await invokeApp(handler, {
      method: 'PUT',
      urlPath: `/api/v1/projects/${projectId}?expectedRevision=1`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'subtitle',
        title: 'Stale attempt',
        payload: {},
      }),
    });
    assert.equal(staleRes.status, 409);
    assert.equal(staleRes.json().error.code, 'REVISION_CONFLICT');

    // Matching expectedRevision succeeds
    const matchRes = await invokeApp(handler, {
      method: 'PUT',
      urlPath: `/api/v1/projects/${projectId}?expectedRevision=2`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'subtitle',
        title: 'News Clip Subtitles (revised)',
        payload: { videoFileName: 'news.mp4', segments: [], speakerNames: {}, subtitleOptions: {} },
      }),
    });
    assert.equal(matchRes.status, 200);
    assert.equal(matchRes.json().data.project.revision, 3);

    // Restart persistence: new store against same dataDir
    const restartedStore = createStorageStore({ dataDir });
    const persisted = await restartedStore.getProject(projectId);
    assert.ok(persisted, 'project should persist across store restart');
    assert.equal(persisted.title, 'News Clip Subtitles (revised)');
    assert.equal(persisted.createdAt, createdAtBefore);

    // Stale expectedRevision on DELETE returns HTTP 409 Conflict
    const staleDel = await invokeApp(handler, {
      method: 'DELETE',
      urlPath: `/api/v1/projects/${projectId}?expectedRevision=1`,
    });
    assert.equal(staleDel.status, 409);
    assert.equal(staleDel.json().error.code, 'REVISION_CONFLICT');

    // Matching expectedRevision on Soft-delete succeeds
    const delRes = await invokeApp(handler, {
      method: 'DELETE',
      urlPath: `/api/v1/projects/${projectId}?expectedRevision=3`,
    });
    assert.equal(delRes.status, 200);
    assert.equal(delRes.json().data.deleted, true);

    // Soft-deleted project returns 404 on get
    const getDeleted = await invokeApp(handler, { urlPath: `/api/v1/projects/${projectId}` });
    assert.equal(getDeleted.status, 404);

    // Delete again returns 404
    const delAgain = await invokeApp(handler, { method: 'DELETE', urlPath: `/api/v1/projects/${projectId}` });
    assert.equal(delAgain.status, 404);

    // List no longer includes deleted project
    const listAfterDelete = await invokeApp(handler, { urlPath: '/api/v1/projects' });
    assert.equal(listAfterDelete.json().meta.total, 1);
    assert.equal(listAfterDelete.json().data.items.length, 1);
    assert.notEqual(listAfterDelete.json().data.items[0].id, projectId);
  });
});

test('storage API rejects invalid project IDs and path traversal with 400', async () => {
  await withStorageHandler(async ({ handler }) => {
    // Non-UUID ID
    const badId = await invokeApp(handler, {
      method: 'PUT',
      urlPath: '/api/v1/projects/not-a-uuid',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'subtitle', title: 'Bad', payload: {} }),
    });
    assert.equal(badId.status, 400);
    assert.equal(badId.json().error.code, 'INVALID_PROJECT_ID');

    // Raw path traversal must be rejected before URL normalization can hide the bad segment.
    const traversal = await invokeApp(handler, { urlPath: '/api/v1/projects/../etc/passwd' });
    assert.equal(traversal.status, 400);

    // URL-encoded path traversal matches route but fails UUID validation
    const encodedTraversal = await invokeApp(handler, {
      method: 'PUT',
      urlPath: '/api/v1/projects/..%2Fetc%2Fpasswd',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'subtitle', title: 'Bad', payload: {} }),
    });
    assert.equal(encodedTraversal.status, 400);
    assert.equal(encodedTraversal.json().error.code, 'INVALID_PROJECT_ID');

    // Missing project returns 404
    const missing = await invokeApp(handler, { urlPath: '/api/v1/projects/33333333-3333-3333-3333-333333333333' });
    assert.equal(missing.status, 404);
    assert.equal(missing.json().error.code, 'PROJECT_NOT_FOUND');

    // Invalid kind returns 422
    const badKind = await invokeApp(handler, {
      method: 'PUT',
      urlPath: '/api/v1/projects/44444444-4444-4444-4444-444444444444',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'invalid', title: 'Bad', payload: {} }),
    });
    assert.equal(badKind.status, 422);
    assert.equal(badKind.json().error.code, 'INVALID_PROJECT_KIND');

    // Missing title returns 422
    const badTitle = await invokeApp(handler, {
      method: 'PUT',
      urlPath: '/api/v1/projects/55555555-5555-5555-5555-555555555555',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'subtitle', title: '', payload: {} }),
    });
    assert.equal(badTitle.status, 422);
    assert.equal(badTitle.json().error.code, 'INVALID_PROJECT_TITLE');

    // Non-object payload returns 422
    const badPayload = await invokeApp(handler, {
      method: 'PUT',
      urlPath: '/api/v1/projects/66666666-6666-6666-6666-666666666666',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'subtitle', title: 'OK', payload: 'not-an-object' }),
    });
    assert.equal(badPayload.status, 422);
    assert.equal(badPayload.json().error.code, 'INVALID_PROJECT_PAYLOAD');

    const oversized = await invokeApp(handler, {
      method: 'PUT',
      urlPath: '/api/v1/projects/77777777-7777-7777-7777-777777777777',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'tts', title: 'Large', payload: { script: 'x'.repeat(256 * 1024) } }),
    });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.json().error.code, 'PAYLOAD_TOO_LARGE');

    const unsupportedType = await invokeApp(handler, {
      method: 'PUT',
      urlPath: '/api/v1/projects/88888888-8888-8888-8888-888888888888',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    assert.equal(unsupportedType.status, 415);
    assert.equal(unsupportedType.json().error.code, 'UNSUPPORTED_MEDIA_TYPE');
  });
});

const JSON_HEADERS = { 'content-type': 'application/json' };
const putGlossary = (handler, body, headers = JSON_HEADERS) => invokeApp(handler, {
  method: 'PUT', urlPath: '/api/v1/glossary', headers, body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('storage API persists the pronunciation glossary atomically in glossary.json across store restart', async () => {
  await withStorageHandler(async ({ handler, dataDir }) => {
    const empty = await invokeApp(handler, { urlPath: '/api/v1/glossary' });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json().data, { rules: [] });
    assert.equal(empty.json().error, null);
    assert.equal(empty.json().meta.count, 0);
    assert.equal(empty.json().meta.maxRules, 200);

    const saved = await putGlossary(handler, { rules: [
      { id: 'r1', source: '  NASA ', replacement: 'ណាសា' },
      { source: 'ភ្នំពេញ', replacement: 'ភ្នំ ពេញ', enabled: false },
      { source: '$&', replacement: '$$' },
    ] });
    assert.equal(saved.status, 200);
    const { rules } = saved.json().data;
    assert.deepEqual(rules.map(item => [item.source, item.replacement, item.enabled]), [
      ['NASA', 'ណាសា', true], ['ភ្នំពេញ', 'ភ្នំ ពេញ', false], ['$&', '$$', true],
    ]);
    assert.equal(saved.json().meta.count, 3);

    const onDisk = JSON.parse(await readFile(path.join(dataDir, 'glossary.json'), 'utf8'));
    assert.deepEqual(onDisk.rules, rules);
    assert.deepEqual((await readdir(dataDir)).filter(name => name.endsWith('.tmp')), []);

    const restartedHandler = createStorageHttpApp({
      store: createStorageStore({ dataDir }), rateLimitOptions: { maxRequests: 100 }, logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    const reloaded = await invokeApp(restartedHandler, { urlPath: '/api/v1/glossary' });
    assert.equal(reloaded.status, 200);
    assert.deepEqual(reloaded.json().data.rules, rules);
    assert.equal(reloaded.json().meta.updatedAt, onDisk.updatedAt);

    const replaced = await putGlossary(restartedHandler, { rules: [{ source: 'AI', replacement: 'ay eye' }] });
    assert.equal(replaced.status, 200);
    const replacedDisk = JSON.parse(await readFile(path.join(dataDir, 'glossary.json'), 'utf8'));
    assert.equal(replacedDisk.createdAt, onDisk.createdAt);
    assert.equal(replacedDisk.rules.length, 1);

    const cleared = await putGlossary(restartedHandler, { rules: [] });
    assert.equal(cleared.status, 200);
    assert.deepEqual((await invokeApp(restartedHandler, { urlPath: '/api/v1/glossary' })).json().data.rules, []);
  });
});

test('storage API serializes concurrent glossary writes so glossary.json is always a complete valid snapshot', async () => {
  await withStorageHandler(async ({ handler, dataDir }) => {
    const writes = Array.from({ length: 8 }, (_, index) => putGlossary(handler, {
      rules: Array.from({ length: index + 1 }, (_, ruleIndex) => ({ source: `term-${ruleIndex}`, replacement: `say-${index}` })),
    }));
    const results = await Promise.all(writes);
    assert.ok(results.every(result => result.status === 200));
    const onDisk = JSON.parse(await readFile(path.join(dataDir, 'glossary.json'), 'utf8'));
    assert.equal(onDisk.rules.length, 8);
    assert.ok(onDisk.rules.every(item => item.replacement === 'say-7'));
    assert.deepEqual((await readdir(dataDir)).filter(name => name.endsWith('.tmp')), []);
  });
});

test('storage API rejects invalid glossary payloads with truthful 400/405/415/422 envelopes and keeps stored rules', async () => {
  await withStorageHandler(async ({ handler, dataDir }) => {
    const good = await putGlossary(handler, { rules: [{ source: 'keep', replacement: 'me' }] });
    assert.equal(good.status, 200);

    const badShape = [
      ['{not json', 'INVALID_JSON'],
      [JSON.stringify([{ source: 'x' }]), 'INVALID_JSON_OBJECT'],
      [JSON.stringify({}), 'INVALID_GLOSSARY_PAYLOAD'],
      [JSON.stringify({ rules: 'nope' }), 'INVALID_GLOSSARY_PAYLOAD'],
      [JSON.stringify({ rules: [], extra: true }), 'INVALID_GLOSSARY_PAYLOAD'],
    ];
    for (const [body, code] of badShape) {
      const res = await putGlossary(handler, body);
      assert.equal(res.status, 400, code);
      assert.equal(res.json().error.code, code);
      assert.equal(res.json().data, null);
    }

    const wrongType = await putGlossary(handler, '{"rules":[]}', { 'content-type': 'text/plain' });
    assert.equal(wrongType.status, 415);

    const tooMany = Array.from({ length: 201 }, (_, index) => ({ source: `t${index}`, replacement: 'x' }));
    const semantic = [
      [[{ source: '   ', replacement: 'x' }], 'EMPTY_GLOSSARY_SOURCE'],
      [[{ replacement: 'x' }], 'EMPTY_GLOSSARY_SOURCE'],
      [[{ source: 'a'.repeat(121), replacement: 'x' }], 'GLOSSARY_TERM_TOO_LONG'],
      [[{ source: 'a', replacement: 'b'.repeat(121) }], 'GLOSSARY_TERM_TOO_LONG'],
      [[{ source: 'a', replacement: 5 }], 'INVALID_GLOSSARY_TERM'],
      [['bare string'], 'INVALID_GLOSSARY_RULE'],
      [[{ source: 'dup', replacement: 'a' }, { source: 'dup', replacement: 'b' }], 'DUPLICATE_GLOSSARY_SOURCE'],
      [tooMany, 'GLOSSARY_TOO_MANY_RULES'],
    ];
    for (const [rules, code] of semantic) {
      const res = await putGlossary(handler, { rules });
      assert.equal(res.status, 422, code);
      assert.equal(res.json().error.code, code);
      assert.equal(typeof res.json().meta.requestId, 'string');
    }

    const unsupportedVerb = await invokeApp(handler, { method: 'DELETE', urlPath: '/api/v1/glossary' });
    assert.equal(unsupportedVerb.status, 405);
    assert.equal(unsupportedVerb.headers.allow, 'GET, PUT');
    assert.equal(unsupportedVerb.json().error.code, 'METHOD_NOT_ALLOWED');

    const stillThere = await invokeApp(handler, { urlPath: '/api/v1/glossary' });
    assert.deepEqual(stillThere.json().data.rules.map(item => item.source), ['keep']);
    assert.deepEqual((await readdir(dataDir)).filter(name => name.endsWith('.tmp')), []);
  });
});

test('storage API reports a corrupt glossary as 500 and lets a valid PUT repair it', async () => {
  await withStorageHandler(async ({ handler, dataDir }) => {
    await writeFile(path.join(dataDir, 'glossary.json'), '{"rules": [');
    const broken = await invokeApp(handler, { urlPath: '/api/v1/glossary' });
    assert.equal(broken.status, 500);
    assert.equal(broken.json().data, null);
    assert.ok(broken.json().error.code);

    const repaired = await putGlossary(handler, { rules: [{ source: 'ok', replacement: 'fixed' }] });
    assert.equal(repaired.status, 200);
    assert.equal((await invokeApp(handler, { urlPath: '/api/v1/glossary' })).json().data.rules[0].replacement, 'fixed');
  });
});
