/**
 * @fileoverview Unit tests for takeAssetStorage data adapter.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { persistTakeAsset, resolveTakeAudioUrl } from '../../src/data/takeAssetStorage.js';

test('persistTakeAsset: returns null on missing assetRepository or blob', async () => {
  const blob = { size: 1024, type: 'audio/wav' };
  assert.equal(await persistTakeAsset({ blob }), null);
  assert.equal(await persistTakeAsset({ assetRepository: {} }), null);
  assert.equal(await persistTakeAsset({ assetRepository: null, blob: null }), null);
});

test('persistTakeAsset: uploads audio blob and returns durable asset ID', async () => {
  let uploadedPayload = null;
  const validAssetId = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d';
  const mockRepo = {
    async uploadAsset(payload) {
      uploadedPayload = payload;
      return { asset: { id: validAssetId } };
    },
  };
  const mockBlob = { size: 2048, type: 'audio/wav' };
  const assetId = await persistTakeAsset({
    assetRepository: mockRepo,
    blob: mockBlob,
    segmentId: 'seg-1',
    seed: 999,
    projectId: 'proj-1',
  });

  assert.equal(assetId, validAssetId);
  assert.equal(uploadedPayload.bytes, mockBlob);
  assert.equal(uploadedPayload.kind, 'audio');
  assert.equal(uploadedPayload.mimeType, 'audio/wav');
  assert.equal(uploadedPayload.projectId, 'proj-1');
  assert.equal(uploadedPayload.fileName, 'take-seg-1-999.wav');
});

test('persistTakeAsset: logs warning and returns null when upload fails', async () => {
  let loggedWarning = null;
  const mockRepo = {
    async uploadAsset() {
      throw new Error('Disk full');
    },
  };
  const mockLogger = {
    warn(msg, err) {
      loggedWarning = { msg, err };
    },
  };
  const assetId = await persistTakeAsset({
    assetRepository: mockRepo,
    blob: { size: 100 },
    logger: mockLogger,
  });

  assert.equal(assetId, null);
  assert.ok(loggedWarning);
  assert.equal(loggedWarning.msg, 'persistTakeAsset failed to upload durable take asset');
});

test('resolveTakeAudioUrl: resolves audioUrl, blob URL, and durable asset binary endpoint', () => {
  assert.equal(resolveTakeAudioUrl(null), null);
  assert.equal(resolveTakeAudioUrl({}), null);

  // 1. Direct audioUrl
  const takeWithUrl = { audioUrl: 'https://example.com/audio.wav' };
  assert.equal(resolveTakeAudioUrl(takeWithUrl), 'https://example.com/audio.wav');

  // 2. Blob URL via global URL.createObjectURL
  const prevCreateObjectURL = globalThis.URL.createObjectURL;
  try {
    globalThis.URL.createObjectURL = blob => `blob:mock://${blob.id}`;
    const takeWithBlob = { blob: { id: 'blob-1' } };
    assert.equal(resolveTakeAudioUrl(takeWithBlob), 'blob:mock://blob-1');
  } finally {
    globalThis.URL.createObjectURL = prevCreateObjectURL;
  }

  // 3. Durable audioAssetId fallback
  const takeWithAssetId = { audioAssetId: 'uuid-123-abc' };
  assert.equal(resolveTakeAudioUrl(takeWithAssetId), '/api/v1/assets/uuid-123-abc/binary');

  // 4. Custom baseUrl
  assert.equal(resolveTakeAudioUrl(takeWithAssetId, '/custom/api'), '/custom/api/assets/uuid-123-abc/binary');
});
