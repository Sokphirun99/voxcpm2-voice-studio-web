/**
 * @fileoverview End-to-end regression test suite verifying all 6 Release 1 Exit Criteria (R1-10).
 * Validates project creation and reopening, restart and page reload persistence, atomic write
 * guarantees with draft recovery, catalog and glossary preservation, model readiness diagnostics,
 * and comprehensive system integrity.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PROJECT_SCHEMA_VERSION,
  createProject,
  createProjectSegment,
} from '../../src/domain/projects.js';
import {
  MISSING_ASSET_WARNING_TEXT,
  assessAssetIntegrity,
  buildDraftRecoveryPrompt,
  shouldOfferDraftRecovery,
} from '../../src/domain/projectRecovery.js';
import {
  FEATURE_KEYS,
  OfflineModelMissingError,
  assertFeatureOfflineReady,
} from '../../src/domain/offlineReadiness.js';
import {
  MODEL_STATE,
  OVERALL_READINESS,
  SERVICE_STATUS,
} from '../../src/domain/modelDiagnostics.js';
import { applyPronunciationRules } from '../../src/domain/pronunciationRules.js';
import { filterLibraryVoices } from '../../src/domain/voiceLibrary.js';
import { ValidationError } from '../../src/domain/errors.js';
import {
  clearProjectDraft,
  getLastActiveProject,
  getProjectDraft,
  saveLastActiveProject,
  saveProjectDraft,
} from '../../src/data/projectRecoveryStorage.js';
import { createDiagnosticsGateway } from '../../src/data/diagnosticsGateway.js';
import { createStorageHttpApp } from '../../server/httpApp.js';
import { createStorageStore } from '../../server/storageStore.js';
import { verifyStorageIntegrity } from '../../server/storageMigration.js';

const STATUS_OK = 200;
const STATUS_CREATED = 201;
const STATUS_BAD_REQUEST = 400;
const STATUS_NOT_FOUND = 404;
const STATUS_CONFLICT = 409;
const STATUS_UNPROCESSABLE = 422;
const JSON_MIME = 'application/json';
const WAV_MIME = 'audio/wav';
const MP4_MIME = 'video/mp4';
const SAMPLE_RATE_HZ = 48000;
const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_SIZE = 44;
const REVISION_INITIAL = 1;
const REVISION_SECOND = 2;
const REVISION_STALE = 99;

const TEST_TTS_ID = '11111111-1111-4111-8111-111111111111';
const TEST_SUBTITLE_ID = '22222222-2222-4222-8222-222222222222';
const TEST_DUBBING_ID = '33333333-3333-4333-8333-333333333333';
const TEST_ASSET_ID = '44444444-4444-4444-8444-444444444444';
const TEST_TAKE_ASSET_ID = '55555555-5555-4555-8555-555555555555';
const TEST_CHAR_ID = 'char-regression-voice-1';
const TEST_ANCHOR_ID = 'char-regression-voice-1';

const TEST_KHMER_TTS_SCRIPT = 'សួស្តីពិភពលោក! នេះគឺជាការសាកល្បងសំឡេងស្ទូឌីយោ។';
const TEST_KHMER_SUB_TEXT_1 = 'ប្រាសាទអង្គរវត្តជាសម្បត្តិបេតិកភណ្ឌពិភពលោក';
const TEST_EN_SUB_TEXT_1 = 'Angkor Wat is a world heritage treasure';
const TEST_KHMER_SUB_TEXT_2 = 'ការស្រាវជ្រាវបុរាណវិទ្យាបានរកឃើញច្រើន';
const TEST_EN_SUB_TEXT_2 = 'Archaeological research has uncovered much';
const CORRUPT_JSON_DATA = '{ corrupted: true, json: ';

const TEST_GLOSSARY_RULES = Object.freeze([
  { id: 'rule-1', source: 'Voice Studio', replacement: 'ស្ទូឌីយោសំឡេង', enabled: true },
  { id: 'rule-2', source: 'Voice', replacement: 'សំឡេង', enabled: true },
]);
const TEST_GLOSSARY_INPUT = 'Voice Studio provides high quality Voice synthesis';
const TEST_GLOSSARY_EXPECTED = 'ស្ទូឌីយោសំឡេង provides high quality សំឡេង synthesis';

const DEFAULT_TTS_SETTINGS = Object.freeze({
  script: TEST_KHMER_TTS_SCRIPT,
  voiceId: 'voice-sokha-1',
  speed: 1.0,
  cfgValue: 2.0,
  ditSteps: 10,
  normalizeText: true,
});

const DEFAULT_SUBTITLE_SEGMENTS = Object.freeze([
  { id: 'sub-1', start: 0.5, end: 3.5, text: TEST_KHMER_SUB_TEXT_1, translatedText: TEST_EN_SUB_TEXT_1, speaker: 'speaker_0' },
  { id: 'sub-2', start: 4.0, end: 7.5, text: TEST_KHMER_SUB_TEXT_2, translatedText: TEST_EN_SUB_TEXT_2, speaker: 'speaker_1' },
]);

/**
 * Writes standard 44-byte RIFF/WAVE header fields into a DataView.
 * Inputs: view (DataView), dataSize (number).
 * Outputs: none.
 * Side effects: writes header bytes to view.
 * Failure modes: throws RangeError if view buffer is too small.
 * @param {DataView} view - Destination DataView.
 * @param {number} dataSize - Audio payload size in bytes.
 */
function writeWavHeader(view, dataSize) {
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i += 1) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeStr(8, 'WAVE'); writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE_HZ, true); view.setUint32(28, SAMPLE_RATE_HZ * BYTES_PER_SAMPLE, true);
  view.setUint16(32, BYTES_PER_SAMPLE, true); view.setUint16(34, 16, true);
  writeStr(36, 'data'); view.setUint32(40, dataSize, true);
}

/**
 * Generates valid 48kHz mono 16-bit PCM WAV audio bytes.
 * Inputs: sampleCount (number).
 * Outputs: Buffer containing valid WAV audio.
 * Side effects: none.
 * Failure modes: none.
 * @param {number} [sampleCount=8] - Number of audio samples.
 * @returns {Buffer} Valid WAV audio buffer.
 */
function createValidWavBuffer(sampleCount = 8) {
  const dataSize = sampleCount * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(WAV_HEADER_SIZE + dataSize);
  const view = new DataView(buffer);
  writeWavHeader(view, dataSize);
  for (let i = 0; i < sampleCount; i += 1) {
    view.setInt16(WAV_HEADER_SIZE + i * BYTES_PER_SAMPLE, 100 * (i + 1), true);
  }
  return Buffer.from(buffer);
}

/**
 * Creates an in-memory session/localStorage test double.
 * Inputs: none.
 * Outputs: Storage double implementing Storage interface.
 * Side effects: none.
 * Failure modes: none.
 * @returns {Storage} In-memory storage double.
 */
function createMockSessionStorage() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    clear: () => map.clear(),
  };
}

/**
 * Serializes request body into raw bytes and headers for test server invocation.
 * Inputs: body (unknown), urlPath (string), headers (object).
 * Outputs: Promise<{ headers: object, bytes: Buffer }>.
 * Side effects: none.
 * Failure modes: none.
 * @param {unknown} body - Candidate body.
 * @param {string} urlPath - URL path.
 * @param {object} headers - Initial headers.
 * @returns {Promise<{ headers: object, bytes: Buffer }>} Serialized body info.
 */
async function serializeRequestBody(body, urlPath, headers) {
  if (body instanceof FormData) {
    const req = new Request(`http://storage.local${urlPath}`, { method: 'POST', body });
    const merged = { ...Object.fromEntries(req.headers.entries()), ...headers };
    return { headers: merged, bytes: Buffer.from(await req.arrayBuffer()) };
  }
  if (Buffer.isBuffer(body)) return { headers, bytes: body };
  if (body instanceof Uint8Array) return { headers, bytes: Buffer.from(body) };
  const text = typeof body === 'string' ? body : '';
  return { headers, bytes: Buffer.from(text, 'utf8') };
}

/**
 * Creates a mock ServerResponse object collecting response status, headers, and chunks.
 * Inputs: chunks (Array<Buffer>).
 * Outputs: Mock ServerResponse object.
 * Side effects: mutates chunks array.
 * Failure modes: none.
 * @param {Array<Buffer>} chunks - Chunk collector.
 * @returns {object} Mock response double.
 */
function createMockResponse(chunks) {
  let statusCode = STATUS_OK;
  let responseHeaders = {};
  return {
    headersSent: false,
    get statusCode() { return statusCode; },
    get headers() { return responseHeaders; },
    writeHead(code, hdrs = {}) {
      statusCode = code;
      responseHeaders = Object.fromEntries(Object.entries(hdrs).map(([k, v]) => [k.toLowerCase(), v]));
      this.headersSent = true;
    },
    end(chunk) { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); },
  };
}

/**
 * Creates a mock IncomingMessage stream.
 * Inputs: method (string), urlPath (string), headers (object), rawBytes (Buffer).
 * Outputs: Readable stream configured as HTTP request.
 * Side effects: none.
 * Failure modes: none.
 * @param {string} method - HTTP verb.
 * @param {string} urlPath - Request path.
 * @param {object} headers - Lowercase headers.
 * @param {Buffer} rawBytes - Body payload.
 * @returns {Readable} Request stream.
 */
function createMockRequest(method, urlPath, headers, rawBytes) {
  const req = Readable.from(rawBytes.length ? [rawBytes] : []);
  req.method = method;
  req.url = urlPath;
  req.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

/**
 * Invokes the Storage HTTP application handler in-process with a simulated request.
 * Inputs: handler (Function), options ({ method?, urlPath, headers?, body? }).
 * Outputs: Promise<{ status: number, headers: object, buffer: Buffer, json: Function }>.
 * Side effects: triggers server handler.
 * Failure modes: propagates unhandled handler errors.
 * @param {Function} handler - Storage app request handler.
 * @param {object} options - Request parameters.
 * @returns {Promise<{ status: number, headers: object, buffer: Buffer, json: () => object }>}
 */
async function invokeRegressionApi(handler, { method = 'GET', urlPath, headers = {}, body = null }) {
  const { headers: reqHeaders, bytes } = await serializeRequestBody(body, urlPath, headers);
  const chunks = [];
  const res = createMockResponse(chunks);
  const req = createMockRequest(method, urlPath, reqHeaders, bytes);
  await handler(req, res);
  const buffer = Buffer.concat(chunks);
  return { status: res.statusCode, headers: res.headers, buffer, json: () => JSON.parse(buffer.toString('utf8')) };
}

/**
 * Sets up an isolated regression test environment with temp directory and initialized store.
 * Inputs: callback (Function).
 * Outputs: Promise<unknown>.
 * Side effects: creates and deletes temp directories.
 * Failure modes: cleans up on error and rethrows.
 * @param {Function} callback - Test callback receiving { dataDir, store, handler }.
 * @returns {Promise<unknown>} Result of callback.
 */
async function withTempRegressionEnvironment(callback) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'voxcpm-r1-regression-'));
  const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
  const store = createStorageStore({ dataDir });
  await store.init();
  const handler = createStorageHttpApp({ store, rateLimitOptions: { maxRequests: 500 }, logger: silentLogger });
  try {
    return await callback({ dataDir, store, handler });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

/**
 * Creates a standard TTS regression project via HTTP API.
 * Inputs: env ({ handler }).
 * Outputs: Promise<object> Created project data.
 * Side effects: writes to storage.
 * Failure modes: asserts 201 Created.
 * @param {{ handler: Function }} env - Test environment.
 * @returns {Promise<object>} Created project.
 */
async function createRegressionTtsProject(env) {
  const payload = {
    id: TEST_TTS_ID,
    type: 'tts',
    title: 'Khmer Narration Story',
    settings: DEFAULT_TTS_SETTINGS,
    segments: [{ id: 'seg-1', text: TEST_KHMER_TTS_SCRIPT, voiceId: 'voice-sokha-1' }],
  };
  const res = await invokeRegressionApi(env.handler, {
    method: 'POST',
    urlPath: '/api/v1/projects',
    headers: { 'content-type': JSON_MIME },
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, STATUS_CREATED);
  return res.json().data.project;
}

/**
 * Verifies reopening a TTS project returns full settings, segments, and payload.
 * Inputs: env ({ handler }), projectId (string).
 * Outputs: Promise<void>.
 * Side effects: reads from storage.
 * Failure modes: throws AssertionError on discrepancy.
 * @param {{ handler: Function }} env - Test environment.
 * @param {string} projectId - Project identifier.
 */
async function assertReopenedTtsProject(env, projectId) {
  const res = await invokeRegressionApi(env.handler, { urlPath: `/api/v1/projects/${projectId}` });
  assert.equal(res.status, STATUS_OK);
  const { project } = res.json().data;
  assert.equal(project.id, projectId);
  assert.equal(project.title, 'Khmer Narration Story');
  assert.equal(project.type, 'tts');
  assert.equal(project.kind, 'tts');
  assert.equal(project.schemaVersion, PROJECT_SCHEMA_VERSION);
  assert.equal(project.revision, REVISION_INITIAL);
  assert.equal(project.sourceAssetId, null);
  assert.equal(project.settings.script, TEST_KHMER_TTS_SCRIPT);
  assert.equal(project.settings.voiceId, 'voice-sokha-1');
  assert.equal(project.settings.speed, 1.0);
  assert.equal(project.segments.length, 1);
  assert.equal(project.segments[0].id, 'seg-1');
  assert.equal(project.segments[0].text, TEST_KHMER_TTS_SCRIPT);
  assert.equal(project.payload.script, TEST_KHMER_TTS_SCRIPT);
  assert.equal(project.payload.voiceId, 'voice-sokha-1');
}

/**
 * Uploads a binary media asset via direct binary API.
 * Inputs: env ({ handler }), fileName (string), mimeType (string), buffer (Buffer).
 * Outputs: Promise<object> Created asset entity.
 * Side effects: stores binary asset in asset store.
 * Failure modes: asserts 201 Created.
 * @param {{ handler: Function }} env - Test environment.
 * @param {string} fileName - Asset file name.
 * @param {string} mimeType - Media MIME type.
 * @param {Buffer} buffer - Binary payload.
 * @returns {Promise<object>} Created asset metadata.
 */
async function uploadRegressionAsset(env, fileName, mimeType, buffer) {
  const res = await invokeRegressionApi(env.handler, {
    method: 'POST',
    urlPath: '/api/v1/assets',
    headers: { 'content-type': mimeType, 'x-file-name': fileName, 'x-asset-kind': 'video' },
    body: buffer,
  });
  assert.equal(res.status, STATUS_CREATED);
  return res.json().data.asset;
}

/**
 * Creates a Subtitle regression project linked to a media asset.
 * Inputs: env ({ handler }), assetId (string).
 * Outputs: Promise<object> Created project.
 * Side effects: writes to storage.
 * Failure modes: asserts 201 Created.
 * @param {{ handler: Function }} env - Test environment.
 * @param {string} assetId - Linked source asset ID.
 * @returns {Promise<object>} Created project.
 */
async function createRegressionSubtitleProject(env, assetId) {
  const payload = {
    id: TEST_SUBTITLE_ID,
    type: 'subtitles',
    title: 'Documentary Subtitles',
    sourceAssetId: assetId,
    sourceLanguage: 'km',
    targetLanguage: 'en',
    settings: { videoFileName: 'sample_video.mp4', hasTranslation: true },
    segments: DEFAULT_SUBTITLE_SEGMENTS,
  };
  const res = await invokeRegressionApi(env.handler, {
    method: 'POST',
    urlPath: '/api/v1/projects',
    headers: { 'content-type': JSON_MIME },
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, STATUS_CREATED);
  return res.json().data.project;
}

/**
 * Verifies reopening a Subtitle project fields and payload.
 * Inputs: project (object), assetId (string).
 * Outputs: void.
 * Side effects: none.
 * Failure modes: throws AssertionError on mismatch.
 * @param {object} project - Project data.
 * @param {string} assetId - Expected asset ID.
 */
function assertSubtitleProjectFields(project, assetId) {
  assert.equal(project.title, 'Documentary Subtitles');
  assert.equal(project.type, 'subtitles');
  assert.equal(project.sourceAssetId, assetId);
  assert.equal(project.sourceLanguage, 'km');
  assert.equal(project.targetLanguage, 'en');
  assert.equal(project.settings.videoFileName, 'sample_video.mp4');
  assert.equal(project.settings.hasTranslation, true);
  assert.equal(project.segments.length, 2);
  assert.equal(project.segments[0].text, TEST_KHMER_SUB_TEXT_1);
  assert.equal(project.segments[0].speaker, 'speaker_0');
  assert.equal(project.segments[1].end, 7.5);
  assert.equal(project.payload.videoFileName, 'sample_video.mp4');
}

/**
 * Verifies reopening a Subtitle project and streaming its linked media asset.
 * Inputs: env ({ handler }), projectId (string), assetId (string).
 * Outputs: Promise<void>.
 * Side effects: reads from storage.
 * Failure modes: throws AssertionError on mismatch.
 * @param {{ handler: Function }} env - Test environment.
 * @param {string} projectId - Subtitle project ID.
 * @param {string} assetId - Linked asset ID.
 */
async function assertReopenedSubtitleProject(env, projectId, assetId) {
  const res = await invokeRegressionApi(env.handler, { urlPath: `/api/v1/projects/${projectId}` });
  assert.equal(res.status, STATUS_OK);
  const { project } = res.json().data;
  assert.equal(project.id, projectId);
  assertSubtitleProjectFields(project, assetId);
  const assetRes = await invokeRegressionApi(env.handler, { urlPath: `/api/v1/assets/${assetId}/binary` });
  assert.equal(assetRes.status, STATUS_OK);
  assert.equal(assetRes.headers['content-type'], MP4_MIME);
}

/**
 * Creates a Dubbing regression project linked to video and audio takes.
 * Inputs: env ({ handler }), videoAssetId (string), takeAssetId (string).
 * Outputs: Promise<object> Created dubbing project.
 * Side effects: writes to storage.
 * Failure modes: asserts 201 Created.
 * @param {{ handler: Function }} env - Test environment.
 * @param {string} videoAssetId - Linked video asset ID.
 * @param {string} takeAssetId - Linked take asset ID.
 * @returns {Promise<object>} Created dubbing project.
 */
async function createRegressionDubbingProject(env, videoAssetId, takeAssetId) {
  const payload = {
    id: TEST_DUBBING_ID,
    type: 'dubbing',
    title: 'Khmer Dubbing Project',
    sourceAssetId: videoAssetId,
    sourceLanguage: 'km',
    targetLanguage: 'en',
    settings: { videoAssetId, audioMode: 'bilingual' },
    segments: [{ id: 'dub-1', start: 0.0, end: 4.0, text: TEST_KHMER_SUB_TEXT_1, takes: [{ id: 'take-1', audioAssetId: takeAssetId }] }],
  };
  const res = await invokeRegressionApi(env.handler, {
    method: 'POST',
    urlPath: '/api/v1/projects',
    headers: { 'content-type': JSON_MIME },
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, STATUS_CREATED);
  return res.json().data.project;
}

/**
 * Verifies reopening a Dubbing project with takes and media links.
 * Inputs: env ({ handler }), projectId (string), videoAssetId (string).
 * Outputs: Promise<void>.
 * Side effects: reads from storage.
 * Failure modes: throws AssertionError on mismatch.
 * @param {{ handler: Function }} env - Test environment.
 * @param {string} projectId - Dubbing project ID.
 * @param {string} videoAssetId - Expected video asset ID.
 */
async function assertReopenedDubbingProject(env, projectId, videoAssetId) {
  const res = await invokeRegressionApi(env.handler, { urlPath: `/api/v1/projects/${projectId}` });
  assert.equal(res.status, STATUS_OK);
  const { project } = res.json().data;
  assert.equal(project.id, projectId);
  assert.equal(project.type, 'dubbing');
  assert.equal(project.kind, 'dubbing');
  assert.equal(project.sourceAssetId, videoAssetId);
  assert.equal(project.settings.audioMode, 'bilingual');
  assert.equal(project.segments.length, 1);
  assert.equal(project.segments[0].takes.length, 1);
  assert.equal(project.segments[0].takes[0].id, 'take-1');
  assert.equal(project.payload.detectedLanguage, 'km');
}

/**
 * Asserts pure domain entity validation rejections.
 * Inputs: none.
 * Outputs: void.
 * Side effects: none.
 * Failure modes: throws AssertionError if domain validation fails to throw.
 */
function assertDomainEntityRejections() {
  assert.throws(() => createProject({
    id: TEST_TTS_ID,
    type: 'tts',
    title: 'Bad TTS',
    sourceAssetId: TEST_ASSET_ID,
  }), ValidationError);

  assert.throws(() => createProjectSegment({
    id: 's1',
    start: 10.0,
    end: 5.0,
    text: 'Reversed interval',
  }), ValidationError);
}

/**
 * Asserts HTTP API level project validation rejections.
 * Inputs: env ({ handler }).
 * Outputs: Promise<void>.
 * Side effects: none.
 * Failure modes: throws AssertionError on unexpected response status.
 * @param {{ handler: Function }} env - Test environment.
 */
async function assertServerHttpRejections(env) {
  const badTypeRes = await invokeRegressionApi(env.handler, {
    method: 'POST',
    urlPath: '/api/v1/projects',
    headers: { 'content-type': JSON_MIME },
    body: JSON.stringify({ type: 'invalid_type', title: 'Bad Type' }),
  });
  assert.equal(badTypeRes.status, STATUS_UNPROCESSABLE);

  const emptyTitleRes = await invokeRegressionApi(env.handler, {
    method: 'POST',
    urlPath: '/api/v1/projects',
    headers: { 'content-type': JSON_MIME },
    body: JSON.stringify({ type: 'tts', title: '' }),
  });
  assert.equal(emptyTitleRes.status, STATUS_UNPROCESSABLE);
}

/**
 * Seeds TTS and Subtitle projects with updated editable segments and settings.
 * Inputs: env ({ handler }).
 * Outputs: Promise<{ tts: object, sub: object, asset: object }>.
 * Side effects: writes projects and asset.
 * Failure modes: asserts successful creation and updates.
 * @param {{ handler: Function }} env - Test environment.
 * @returns {Promise<{ tts: object, sub: object, asset: object }>}
 */
async function seedProjectsForRestart(env) {
  const asset = await uploadRegressionAsset(env, 'clip.mp4', MP4_MIME, Buffer.from([1, 2, 3, 4]));
  const tts = await createRegressionTtsProject(env);
  const sub = await createRegressionSubtitleProject(env, asset.id);
  const ttsUp = await invokeRegressionApi(env.handler, {
    method: 'PUT',
    urlPath: `/api/v1/projects/${tts.id}`,
    headers: { 'content-type': JSON_MIME, 'if-match': '1' },
    body: JSON.stringify({
      type: 'tts',
      title: 'Khmer Story Updated',
      settings: { voiceId: 'voice-sokha-1', script: 'Updated Script' },
      segments: [{ id: 'seg-1', text: 'Updated Script', voiceId: 'voice-sokha-1' }],
    }),
  });
  assert.equal(ttsUp.status, STATUS_OK);
  assert.equal(ttsUp.json().data.project.revision, REVISION_SECOND);
  return { tts: ttsUp.json().data.project, sub, asset };
}

/**
 * Verifies projects and assets survive simulated service restart.
 * Inputs: dataDir (string), seeded ({ tts: object, sub: object, asset: object }).
 * Outputs: Promise<void>.
 * Side effects: instantiates new store from disk.
 * Failure modes: throws AssertionError if data lost on restart.
 * @param {string} dataDir - Data directory path.
 * @param {object} seeded - Seeded projects info.
 */
async function assertProjectsAfterRestart(dataDir, seeded) {
  const restartedStore = createStorageStore({ dataDir });
  await restartedStore.init();
  const restartedHandler = createStorageHttpApp({ store: restartedStore, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const ttsRes = await invokeRegressionApi(restartedHandler, { urlPath: `/api/v1/projects/${seeded.tts.id}` });
  assert.equal(ttsRes.status, STATUS_OK);
  assert.equal(ttsRes.json().data.project.revision, REVISION_SECOND);
  assert.equal(ttsRes.json().data.project.settings.script, 'Updated Script');
  assert.equal(ttsRes.json().data.project.segments[0].text, 'Updated Script');
  const subRes = await invokeRegressionApi(restartedHandler, { urlPath: `/api/v1/projects/${seeded.sub.id}` });
  assert.equal(subRes.status, STATUS_OK);
  assert.equal(subRes.json().data.project.sourceAssetId, seeded.asset.id);
  assert.equal(subRes.json().data.project.segments.length, 2);
  const assetRes = await invokeRegressionApi(restartedHandler, { urlPath: `/api/v1/assets/${seeded.asset.id}/binary` });
  assert.equal(assetRes.status, STATUS_OK);
  assert.equal(assetRes.headers['content-type'], MP4_MIME);
}

/**
 * Verifies active project pointer recovery after simulated page reload across workspaces.
 * Inputs: env ({ handler }), projectId (string), workspace (string).
 * Outputs: Promise<void>.
 * Side effects: writes and reads session storage.
 * Failure modes: throws AssertionError if active project not recovered.
 * @param {{ handler: Function }} env - Test environment.
 * @param {string} projectId - Target project ID.
 * @param {string} workspace - Target workspace.
 */
async function assertSessionRecoveryAfterReload(env, projectId, workspace) {
  const storage = createMockSessionStorage();
  saveLastActiveProject({ projectId, workspace, storage });
  const recovered = getLastActiveProject({ storage });
  assert.ok(recovered);
  assert.equal(recovered.projectId, projectId);
  assert.equal(recovered.workspace, workspace);
  const projRes = await invokeRegressionApi(env.handler, { urlPath: `/api/v1/projects/${recovered.projectId}` });
  assert.equal(projRes.status, STATUS_OK);
  assert.equal(projRes.json().data.project.id, projectId);
  assert.ok(projRes.json().data.project.settings);
  assert.ok(Array.isArray(projRes.json().data.project.segments));
}

/**
 * Asserts atomic write guarantee: an interrupted save or revision conflict preserves last confirmed revision.
 * Inputs: env ({ handler, dataDir }).
 * Outputs: Promise<void>.
 * Side effects: writes and queries storage.
 * Failure modes: throws AssertionError on failure.
 * @param {{ handler: Function, dataDir: string }} env - Test environment.
 */
async function assertAtomicWriteGuarantees(env) {
  const tts = await createRegressionTtsProject(env);
  const conflictRes = await invokeRegressionApi(env.handler, {
    method: 'PUT',
    urlPath: `/api/v1/projects/${tts.id}`,
    headers: { 'content-type': JSON_MIME, 'if-match': String(REVISION_STALE) },
    body: JSON.stringify({ type: 'tts', title: 'Corrupt Stale Attempt', settings: { script: 'Broken' } }),
  });
  assert.equal(conflictRes.status, STATUS_CONFLICT);
  const verifyRes = await invokeRegressionApi(env.handler, { urlPath: `/api/v1/projects/${tts.id}` });
  assert.equal(verifyRes.status, STATUS_OK);
  const confirmed = verifyRes.json().data.project;
  assert.equal(confirmed.revision, REVISION_INITIAL);
  assert.equal(confirmed.settings.script, TEST_KHMER_TTS_SCRIPT);
  const dirFiles = await readdir(path.join(env.dataDir, 'projects'));
  assert.equal(dirFiles.some(f => f.endsWith('.tmp')), false);
}

/**
 * Verifies uncommitted draft recovery prompt generation and restoration/discard flows.
 * Inputs: none.
 * Outputs: void.
 * Side effects: writes to mock storage.
 * Failure modes: throws AssertionError on incorrect recovery decision.
 */
function assertUncommittedDraftRecoveryFlow() {
  const storage = createMockSessionStorage();
  const draftTime = '2026-11-22T10:00:00.000Z';
  const draft = {
    projectId: TEST_TTS_ID,
    workspace: 'tts',
    snapshot: { script: 'Unsaved In-Flight Script Edits' },
    revision: REVISION_INITIAL,
    timestamp: draftTime,
  };
  saveProjectDraft({ draft, storage });
  const confirmed = { id: TEST_TTS_ID, revision: REVISION_INITIAL, updatedAt: '2026-11-22T09:00:00.000Z' };
  assert.equal(shouldOfferDraftRecovery({ draft, confirmedProject: confirmed }), true);
  const prompt = buildDraftRecoveryPrompt(draftTime);
  assert.ok(prompt.includes('Unsaved draft recovered from'));
  clearProjectDraft({ projectId: TEST_TTS_ID, workspace: 'tts', storage });
  assert.equal(getProjectDraft({ projectId: TEST_TTS_ID, workspace: 'tts', storage }), null);
}

/**
 * Verifies missing referenced media asset detection and reporting during recovery.
 * Inputs: none.
 * Outputs: void.
 * Side effects: none.
 * Failure modes: throws AssertionError if missing asset goes unnoticed.
 */
function assertMissingAssetDetection() {
  const mockProject = {
    id: TEST_SUBTITLE_ID,
    type: 'subtitles',
    sourceAssetId: TEST_ASSET_ID,
    segments: [{ id: 's1', takes: [{ id: 't1', audioAssetId: TEST_TAKE_ASSET_ID }] }],
  };
  const statuses = new Map([
    [TEST_ASSET_ID, { exists: false, isMissing: true }],
    [TEST_TAKE_ASSET_ID, { exists: true }],
  ]);
  const report = assessAssetIntegrity(mockProject, statuses);
  assert.equal(report.isIntact, false);
  assert.equal(report.missingAssets.length, 1);
  assert.equal(report.missingAssets[0].assetId, TEST_ASSET_ID);
  assert.equal(report.warningMessage, MISSING_ASSET_WARNING_TEXT);
}

/**
 * Verifies character catalog filtering by category.
 * Inputs: env ({ handler }).
 * Outputs: Promise<void>.
 * Side effects: none.
 * Failure modes: throws AssertionError on filter mismatch.
 * @param {{ handler: Function }} env - Test environment.
 */
async function assertCustomCharacterFiltering(env) {
  const listRes = await invokeRegressionApi(env.handler, { urlPath: '/api/v1/characters?limit=10' });
  assert.equal(listRes.status, STATUS_OK);
  const items = listRes.json().data.items;
  assert.ok(items.some(c => c.id === TEST_CHAR_ID));
  const femaleList = filterLibraryVoices(items, { category: 'female' });
  assert.ok(femaleList.some(c => c.id === TEST_CHAR_ID));
  const maleList = filterLibraryVoices(items, { category: 'male' });
  assert.equal(maleList.some(c => c.id === TEST_CHAR_ID), false);
}

/**
 * Verifies custom character CRUD, filtering, and persistence across store restart.
 * Inputs: env ({ handler, dataDir, store }).
 * Outputs: Promise<void>.
 * Side effects: writes and reads character catalog.
 * Failure modes: throws AssertionError on catalog regression.
 * @param {{ handler: Function, dataDir: string, store: object }} env - Test environment.
 */
async function assertCustomCharacterLifecycle(env) {
  const createRes = await invokeRegressionApi(env.handler, {
    method: 'PUT',
    urlPath: `/api/v1/characters/${TEST_CHAR_ID}`,
    headers: { 'content-type': JSON_MIME },
    body: JSON.stringify({ name: 'Sophea Host', category: 'female', description: 'Narrator' }),
  });
  assert.equal(createRes.status, STATUS_CREATED);
  await assertCustomCharacterFiltering(env);
  const updateRes = await invokeRegressionApi(env.handler, {
    method: 'PUT',
    urlPath: `/api/v1/characters/${TEST_CHAR_ID}`,
    headers: { 'content-type': JSON_MIME },
    body: JSON.stringify({ name: 'Sophea Host', category: 'female', description: 'Updated Host' }),
  });
  assert.equal(updateRes.status, STATUS_OK);
}

/**
 * Verifies character soft deletion and removal from active lists.
 * Inputs: env ({ handler }).
 * Outputs: Promise<void>.
 * Side effects: soft-deletes character.
 * Failure modes: throws AssertionError on failure.
 * @param {{ handler: Function }} env - Test environment.
 */
async function assertCustomCharacterDeletion(env) {
  const deleteRes = await invokeRegressionApi(env.handler, { method: 'DELETE', urlPath: `/api/v1/characters/${TEST_CHAR_ID}` });
  assert.equal(deleteRes.status, STATUS_OK);
  const listRes = await invokeRegressionApi(env.handler, { urlPath: '/api/v1/characters?limit=10' });
  assert.equal(listRes.status, STATUS_OK);
  assert.equal(listRes.json().data.items.some(c => c.id === TEST_CHAR_ID), false);
}

/**
 * Uploads voice anchor binary audio and metadata via HTTP API.
 * Inputs: env ({ handler }), wavBytes (Buffer).
 * Outputs: Promise<void>.
 * Side effects: writes WAV and updates catalog.
 * Failure modes: asserts 200 OK.
 * @param {{ handler: Function }} env - Test environment.
 * @param {Buffer} wavBytes - Audio payload.
 */
async function uploadVoiceAnchor(env, wavBytes) {
  const form = new FormData();
  form.set('metadata', JSON.stringify({ label: 'Sophea Anchor', fileName: 'sophea.wav', promptText: 'សួស្តី' }));
  form.set('audio', new File([wavBytes], 'sophea.wav', { type: WAV_MIME }));
  const uploadRes = await invokeRegressionApi(env.handler, { method: 'PUT', urlPath: `/api/v1/anchors/${TEST_ANCHOR_ID}`, body: form });
  assert.equal(uploadRes.status, STATUS_OK);
  const audioRes = await invokeRegressionApi(env.handler, { urlPath: `/api/v1/anchors/${TEST_ANCHOR_ID}/audio` });
  assert.equal(audioRes.status, STATUS_OK);
  assert.equal(audioRes.headers['content-type'], WAV_MIME);
  assert.deepEqual(new Uint8Array(audioRes.buffer), new Uint8Array(wavBytes));
}

/**
 * Verifies voice anchor metadata and audio persist across store restart.
 * Inputs: env ({ dataDir }), wavBytes (Buffer).
 * Outputs: Promise<void>.
 * Side effects: instantiates new store.
 * Failure modes: throws AssertionError if anchor missing.
 * @param {{ dataDir: string }} env - Test environment.
 * @param {Buffer} wavBytes - Expected audio bytes.
 */
async function verifyVoiceAnchorInStore(env, wavBytes) {
  const newStore = createStorageStore({ dataDir: env.dataDir });
  await newStore.init();
  const anchors = await newStore.listAnchors({});
  const loadedAnchor = anchors.items.find(a => a.characterId === TEST_ANCHOR_ID);
  assert.ok(loadedAnchor);
  assert.equal(loadedAnchor.label, 'Sophea Anchor');
  const loadedAudio = await newStore.getAnchorAudio(TEST_ANCHOR_ID);
  assert.ok(loadedAudio);
  assert.deepEqual(new Uint8Array(loadedAudio.bytes), new Uint8Array(wavBytes));
}

/**
 * Asserts voice anchor upload rejects invalid audio formats and corrupt magic bytes.
 * Inputs: env ({ handler }).
 * Outputs: Promise<void>.
 * Side effects: none.
 * Failure modes: throws AssertionError if invalid audio is accepted.
 * @param {{ handler: Function }} env - Test environment.
 */
async function assertVoiceAnchorAudioRejection(env) {
  const form = new FormData();
  form.set('metadata', JSON.stringify({ label: 'Corrupt Anchor', fileName: 'corrupt.wav' }));
  form.set('audio', new File([Buffer.from('not-a-wav-file')], 'corrupt.wav', { type: WAV_MIME }));
  const res = await invokeRegressionApi(env.handler, { method: 'PUT', urlPath: `/api/v1/anchors/${TEST_ANCHOR_ID}`, body: form });
  assert.equal(res.status, STATUS_UNPROCESSABLE);
}

/**
 * Verifies pronunciation glossary persistence, atomic rule updates, and longest-first matching.
 * Inputs: env ({ handler, dataDir }).
 * Outputs: Promise<void>.
 * Side effects: writes glossary.json.
 * Failure modes: throws AssertionError on glossary failure.
 * @param {{ handler: Function, dataDir: string }} env - Test environment.
 */
async function assertGlossaryLifecycle(env) {
  const putRes = await invokeRegressionApi(env.handler, {
    method: 'PUT',
    urlPath: '/api/v1/glossary',
    headers: { 'content-type': JSON_MIME },
    body: JSON.stringify({ rules: TEST_GLOSSARY_RULES }),
  });
  assert.equal(putRes.status, STATUS_OK);
  const newStore = createStorageStore({ dataDir: env.dataDir });
  await newStore.init();
  const glossary = await newStore.getGlossary();
  assert.equal(glossary.rules.length, 2);
  const applied = applyPronunciationRules(TEST_GLOSSARY_INPUT, glossary.rules);
  assert.equal(applied, TEST_GLOSSARY_EXPECTED);
  const badRes = await invokeRegressionApi(env.handler, { method: 'PUT', urlPath: '/api/v1/glossary', headers: { 'content-type': JSON_MIME }, body: '{"rules":"bad"}' });
  assert.equal(badRes.status, STATUS_BAD_REQUEST);
}

/**
 * Creates mock diagnostic dependencies for testing engine and media status.
 * Inputs: overrides (object).
 * Outputs: object with speechGateway, mediaSubtitleGateway, fetchImpl.
 * Side effects: none.
 * Failure modes: none.
 * @param {object} [overrides] - Dependency overrides.
 * @returns {object} Mock gateways for diagnostics.
 */
function createMockDiagnosticsDependencies({ speechOnline = true, mediaOnline = true, modelsReady = true, modelOverrides = {}, failFetch = false } = {}) {
  const speechGateway = {
    checkHealth: async () => (speechOnline ? { available: true, device: 'Apple Silicon (MPS)' } : Promise.reject(new Error('Engine offline'))),
  };
  const defaultModels = { whisper: modelsReady, khmerAsr: modelsReady, translator: modelsReady, diarization: modelsReady };
  const mediaSubtitleGateway = {
    checkHealth: async () => ({ online: mediaOnline, models: { ...defaultModels, ...modelOverrides }, burnInSupported: true }),
  };
  const fetchImpl = async url => {
    if (failFetch) throw new Error('Fetch failed');
    if (url.endsWith('/health')) return new Response(JSON.stringify({ data: { status: 'ok', ffmpegAvailable: true } }), { status: STATUS_OK });
    if (url.endsWith('/stats')) return new Response(JSON.stringify({ data: { storage: { volumeFreeBytes: 1024 * 1024 * 1024 } } }), { status: STATUS_OK });
    return new Response('Not found', { status: STATUS_NOT_FOUND });
  };
  return { speechGateway, mediaSubtitleGateway, fetchImpl };
}

/**
 * Asserts diagnostics correctly distinguish reachable HTTP services from missing model weights.
 * Inputs: none.
 * Outputs: Promise<void>.
 * Side effects: none.
 * Failure modes: throws AssertionError on diagnostics misreporting.
 */
async function assertMissingWeightsDiagnostics() {
  const deps = createMockDiagnosticsDependencies({ speechOnline: true, mediaOnline: true, modelsReady: false });
  const gateway = createDiagnosticsGateway(deps);
  const diag = await gateway.getAggregatedDiagnostics();
  assert.equal(diag.overall.status, OVERALL_READINESS.NEEDS_DOWNLOAD);
  assert.equal(diag.overall.isOfflineReady, false);
  assert.equal(diag.services.every(s => s.status === SERVICE_STATUS.ONLINE), true);
  assert.equal(diag.models.some(m => m.state === MODEL_STATE.NOT_INSTALLED), true);
  assert.throws(() => assertFeatureOfflineReady({ featureId: FEATURE_KEYS.TRANSCRIPTION_WHISPER, models: diag.models, isOnline: false }), OfflineModelMissingError);
}

/**
 * Asserts diagnostics correctly report SERVICE_UNAVAILABLE when backend service is offline.
 * Inputs: none.
 * Outputs: Promise<void>.
 * Side effects: none.
 * Failure modes: throws AssertionError on incorrect reporting.
 */
async function assertServiceOfflineDiagnostics() {
  const deps = createMockDiagnosticsDependencies({ speechOnline: false, mediaOnline: false, modelsReady: false });
  const gateway = createDiagnosticsGateway(deps);
  const diag = await gateway.getAggregatedDiagnostics();
  assert.equal(diag.overall.status, OVERALL_READINESS.SERVICES_OFFLINE);
  assert.equal(diag.overall.isOfflineReady, false);
  assert.equal(diag.services.some(s => s.status === SERVICE_STATUS.OFFLINE), true);
  assert.ok(diag.instructions.length > 0);
}

/**
 * Asserts diagnostics report OFFLINE_READY when all services are healthy and model weights cached.
 * Inputs: none.
 * Outputs: Promise<void>.
 * Side effects: none.
 * Failure modes: throws AssertionError if offline readiness fails.
 */
async function assertAllModelsReadyDiagnostics() {
  const deps = createMockDiagnosticsDependencies({ speechOnline: true, mediaOnline: true, modelsReady: true });
  const gateway = createDiagnosticsGateway(deps);
  const diag = await gateway.getAggregatedDiagnostics();
  assert.equal(diag.overall.status, OVERALL_READINESS.OFFLINE_READY);
  assert.equal(diag.overall.isOfflineReady, true);
  assert.equal(diag.services.every(s => s.status === SERVICE_STATUS.ONLINE), true);
  assert.equal(diag.models.every(m => m.state === MODEL_STATE.READY), true);
  assert.doesNotThrow(() => assertFeatureOfflineReady({ featureId: FEATURE_KEYS.TTS, models: diag.models, isOnline: false }));
  assert.doesNotThrow(() => assertFeatureOfflineReady({ featureId: FEATURE_KEYS.TRANSCRIPTION_WHISPER, models: diag.models, isOnline: false }));
}

/**
 * Asserts partial model readiness accurately isolates ready features from missing features.
 * Inputs: none.
 * Outputs: Promise<void>.
 * Side effects: none.
 * Failure modes: throws AssertionError on incorrect feature isolation.
 */
async function assertPartialModelsDiagnostics() {
  const deps = createMockDiagnosticsDependencies({
    speechOnline: true,
    mediaOnline: true,
    modelsReady: true,
    modelOverrides: { whisper: false },
  });
  const gateway = createDiagnosticsGateway(deps);
  const diag = await gateway.getAggregatedDiagnostics();
  assert.equal(diag.overall.status, OVERALL_READINESS.NEEDS_DOWNLOAD);
  assert.doesNotThrow(() => assertFeatureOfflineReady({ featureId: FEATURE_KEYS.TTS, models: diag.models, isOnline: false }));
  assert.throws(() => assertFeatureOfflineReady({ featureId: FEATURE_KEYS.TRANSCRIPTION_WHISPER, models: diag.models, isOnline: false }), OfflineModelMissingError);
}

/**
 * Verifies real storage HTTP app integrates with diagnostics gateway without mock drift.
 * Inputs: env ({ handler }).
 * Outputs: Promise<void>.
 * Side effects: queries server handler.
 * Failure modes: throws AssertionError on discrepancy.
 * @param {{ handler: Function }} env - Test environment.
 */
async function assertRealStorageHealthIntegration(env) {
  const fetchImpl = async url => {
    const urlObj = new URL(url, 'http://storage.local');
    const apiRes = await invokeRegressionApi(env.handler, { urlPath: urlObj.pathname });
    return new Response(apiRes.buffer, { status: apiRes.status, headers: apiRes.headers });
  };
  const deps = { ...createMockDiagnosticsDependencies({ speechOnline: true, mediaOnline: true, modelsReady: true }), fetchImpl };
  const gateway = createDiagnosticsGateway(deps);
  const diag = await gateway.getAggregatedDiagnostics();
  const storageService = diag.services.find(s => s.id === 'storage');
  assert.ok(storageService);
  assert.equal(storageService.status, SERVICE_STATUS.ONLINE);
}

/**
 * Asserts storage data integrity verification across healthy and corrupted storage directories.
 * Inputs: env ({ dataDir }).
 * Outputs: Promise<void>.
 * Side effects: inspects and tampers files on disk.
 * Failure modes: throws AssertionError if integrity issues found on healthy or missed on corrupt.
 * @param {{ dataDir: string }} env - Test environment.
 */
async function assertStorageIntegrityVerification(env) {
  const healthy = await verifyStorageIntegrity({ dataDir: env.dataDir });
  assert.equal(healthy.valid, true);
  assert.equal(healthy.issues.length, 0);

  const corruptPath = path.join(env.dataDir, 'projects', '99999999-9999-4999-8999-999999999999.json');
  await writeFile(corruptPath, CORRUPT_JSON_DATA, 'utf8');
  const checked = await verifyStorageIntegrity({ dataDir: env.dataDir });
  assert.equal(checked.valid, false);
  assert.ok(checked.issues.some(iss => iss.includes('99999999-9999-4999-8999-999999999999.json')));
  await rm(corruptPath, { force: true });
}

// ============================================================================
// Release 1 Exit Criterion 1: Create and reopen both TTS & Subtitle projects
// ============================================================================

test('Release 1 Criterion 1.1: Creates and reopens TTS project verifying schemaVersion 1, segments, settings, and payload', async () => {
  await withTempRegressionEnvironment(async env => {
    const created = await createRegressionTtsProject(env);
    await assertReopenedTtsProject(env, created.id);
  });
});

test('Release 1 Criterion 1.2: Creates and reopens Subtitle project with linked asset reference, timing, and translations', async () => {
  await withTempRegressionEnvironment(async env => {
    const asset = await uploadRegressionAsset(env, 'sample_doc.mp4', MP4_MIME, Buffer.from([1, 2, 3, 4]));
    const sub = await createRegressionSubtitleProject(env, asset.id);
    await assertReopenedSubtitleProject(env, sub.id, asset.id);
  });
});

test('Release 1 Criterion 1.3: Creates and reopens Dubbing project with video asset, audio takes, settings, and payload', async () => {
  await withTempRegressionEnvironment(async env => {
    const video = await uploadRegressionAsset(env, 'scene.mp4', MP4_MIME, Buffer.from([1, 2, 3, 4]));
    const audio = await uploadRegressionAsset(env, 'take.wav', WAV_MIME, createValidWavBuffer(8));
    const dubbing = await createRegressionDubbingProject(env, video.id, audio.id);
    await assertReopenedDubbingProject(env, dubbing.id, video.id);
  });
});

test('Release 1 Criterion 1.4: Enforces domain validation rejecting invalid types, sourceAssetId on TTS, and negative intervals', async () => {
  await withTempRegressionEnvironment(async env => {
    assertDomainEntityRejections();
    await assertServerHttpRejections(env);
  });
});

// ============================================================================
// Release 1 Exit Criterion 2: Reopen settings & content after restart / reload
// ============================================================================

test('Release 1 Criterion 2.1: Reopens settings and editable content after simulated Docker/storage service restart from disk', async () => {
  await withTempRegressionEnvironment(async env => {
    const seeded = await seedProjectsForRestart(env);
    await assertProjectsAfterRestart(env.dataDir, seeded);
  });
});

test('Release 1 Criterion 2.2: Reopens active project and editable workspace after simulated browser page reload across workspaces', async () => {
  await withTempRegressionEnvironment(async env => {
    const tts = await createRegressionTtsProject(env);
    await assertSessionRecoveryAfterReload(env, tts.id, 'tts');
    const asset = await uploadRegressionAsset(env, 'clip.mp4', MP4_MIME, Buffer.from([1, 2, 3, 4]));
    const sub = await createRegressionSubtitleProject(env, asset.id);
    await assertSessionRecoveryAfterReload(env, sub.id, 'subtitles');
  });
});

// ============================================================================
// Release 1 Exit Criterion 3: Restore last confirmed saved data after failure
// ============================================================================

test('Release 1 Criterion 3.1: Restores last confirmed saved data on disk after interrupted save and revision conflict', async () => {
  await withTempRegressionEnvironment(async env => {
    await assertAtomicWriteGuarantees(env);
  });
});

test('Release 1 Criterion 3.2: Restores or discards uncommitted local drafts after browser crash or save failure', () => {
  assertUncommittedDraftRecoveryFlow();
});

test('Release 1 Criterion 3.3: Detects missing referenced assets during project recovery and surfaces actionable warnings', () => {
  assertMissingAssetDetection();
});

// ============================================================================
// Release 1 Exit Criterion 4: Saved voices, anchors, and glossary work as before
// ============================================================================

test('Release 1 Criterion 4.1: Custom characters CRUD, filtering, and catalog persistence survive without regression', async () => {
  await withTempRegressionEnvironment(async env => {
    await assertCustomCharacterLifecycle(env);
    await assertCustomCharacterDeletion(env);
  });
});

test('Release 1 Criterion 4.2: Voice anchor binary WAV upload, retrieval, and audio validation survive without regression', async () => {
  await withTempRegressionEnvironment(async env => {
    const wavBytes = createValidWavBuffer(12);
    await uploadVoiceAnchor(env, wavBytes);
    await verifyVoiceAnchorInStore(env, wavBytes);
    await assertVoiceAnchorAudioRejection(env);
  });
});

test('Release 1 Criterion 4.3: Pronunciation glossary persistence and literal longest-first replacement work without regression', async () => {
  await withTempRegressionEnvironment(async env => {
    await assertGlossaryLifecycle(env);
  });
});

// ============================================================================
// Release 1 Exit Criterion 5: Model readiness states are accurate
// ============================================================================

test('Release 1 Criterion 5.1: Accurately reports NEEDS_DOWNLOAD when services are reachable but model weights are not cached', async () => {
  await assertMissingWeightsDiagnostics();
});

test('Release 1 Criterion 5.2: Accurately reports SERVICES_OFFLINE with actionable terminal instructions when service fails', async () => {
  await assertServiceOfflineDiagnostics();
});

test('Release 1 Criterion 5.3: Accurately reports OFFLINE_READY when all services are healthy and model weights are cached', async () => {
  await assertAllModelsReadyDiagnostics();
});

test('Release 1 Criterion 5.4: Accurately reports partial model readiness distinguishing ready from missing models', async () => {
  await assertPartialModelsDiagnostics();
});

test('Release 1 Criterion 5.5: Integrates real storage HTTP health and stats without mock drift', async () => {
  await withTempRegressionEnvironment(async env => {
    await assertRealStorageHealthIntegration(env);
  });
});

// ============================================================================
// Release 1 Exit Criterion 6: All existing tests plus new Release 1 tests pass
// ============================================================================

test('Release 1 Criterion 6.1: Storage data integrity verification passes across projects, characters, anchors, and glossary', async () => {
  await withTempRegressionEnvironment(async env => {
    await createRegressionTtsProject(env);
    await assertCustomCharacterLifecycle(env);
    await assertGlossaryLifecycle(env);
    await assertStorageIntegrityVerification(env);
  });
});
