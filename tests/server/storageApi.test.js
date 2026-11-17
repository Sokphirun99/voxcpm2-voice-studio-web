import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
