/**
 * @fileoverview Integration test suite verifying take history persistence across restarts (R2-04).
 * Ensures multiple takes per segment survive project save and reload, retain durable asset IDs and
 * synthesis settings, and resolve stream URLs correctly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStorageStore } from '../../server/storageStore.js';
import {
  createEditableSegment,
  selectSegmentTake,
  removeSegmentTake,
  getSegmentActiveTake,
} from '../../src/domain/projectSegments.js';
import { createSegmentTake, createProject, generateProjectId } from '../../src/domain/projects.js';
import { resolveTakeAudioUrl } from '../../src/data/takeAssetStorage.js';

const WAV_MIME = 'audio/wav';
const SAMPLE_RATE_HZ = 48000;
const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_SIZE = 44;

function writeWavHeader(view, dataSize) {
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE_HZ, true);
  view.setUint32(28, SAMPLE_RATE_HZ * BYTES_PER_SAMPLE, true);
  view.setUint16(32, BYTES_PER_SAMPLE, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
}

function makeWavBuffer(sampleCount = 16) {
  const dataSize = sampleCount * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(WAV_HEADER_SIZE + dataSize);
  const view = new DataView(buffer);
  writeWavHeader(view, dataSize);
  for (let i = 0; i < sampleCount; i += 1) {
    view.setInt16(WAV_HEADER_SIZE + i * BYTES_PER_SAMPLE, 200 * (i + 1), true);
  }
  return Buffer.from(buffer);
}

async function createTempStorage() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'take-history-test-'));
  const store = createStorageStore({ dataDir: tempDir });
  await store.init();
  return { tempDir, store };
}

function buildTestProjectData(projectId, assetId1, assetId2) {
  const take1 = createSegmentTake({
    id: 'take-seg1-1',
    audioAssetId: assetId1,
    duration: 1.5,
    isSelected: false,
    settings: {
      text: 'ជំរាបសួរ',
      voiceId: 'char-kiri',
      seed: 101,
      anchorVersion: 1,
      guidance: 2.0,
      steps: 10,
      styleMode: 'auto',
      customStyle: '',
    },
  });
  const take2 = createSegmentTake({
    id: 'take-seg1-2',
    audioAssetId: assetId2,
    duration: 1.8,
    isSelected: true,
    settings: {
      text: 'ជំរាបសួរ',
      voiceId: 'char-kiri',
      seed: 102,
      anchorVersion: 2,
      guidance: 2.5,
      steps: 12,
      styleMode: 'custom',
      customStyle: 'energetic',
    },
  });
  const seg1 = createEditableSegment({
    id: 'seg-1',
    text: 'ជំរាបសួរ',
    voiceId: 'char-kiri',
    takes: [take1, take2],
    status: 'ready',
  });
  return createProject({
    id: projectId,
    name: 'Take History Persistence Test',
    type: 'tts',
    status: 'draft',
    segments: [seg1],
    settings: { script: 'ជំរាបសួរ', voiceId: 'char-kiri' },
  });
}

test('Take History Persistence: multiple takes survive restart, retain settings, and resolve stream URLs', async () => {
  const { tempDir, store } = await createTempStorage();
  try {
    const audioBytes1 = makeWavBuffer(20);
    const audioBytes2 = makeWavBuffer(30);
    const asset1 = await store.saveAsset({
      bytes: audioBytes1,
      fileName: 'take-seg1-101.wav',
      mimeType: WAV_MIME,
      kind: 'audio',
    });
    const asset2 = await store.saveAsset({
      bytes: audioBytes2,
      fileName: 'take-seg1-102.wav',
      mimeType: WAV_MIME,
      kind: 'audio',
    });
    const assetId1 = asset1.id;
    const assetId2 = asset2.id;

    const projectId = generateProjectId();
    const project = buildTestProjectData(projectId, assetId1, assetId2);
    await store.upsertProject(projectId, project);

    // Simulate complete server restart by opening storage at the same directory
    const reloadedStore = createStorageStore({ dataDir: tempDir });
    await reloadedStore.init();
    const loaded = await reloadedStore.getProject(projectId);

    assert.equal(loaded.id, projectId);
    assert.equal(loaded.segments.length, 1);

    const reloadedSeg = loaded.segments[0];
    assert.equal(reloadedSeg.id, 'seg-1');
    assert.equal(reloadedSeg.takes.length, 2);

    // Verify Take 1
    const loadedTake1 = reloadedSeg.takes[0];
    assert.equal(loadedTake1.id, 'take-seg1-1');
    assert.equal(loadedTake1.audioAssetId, assetId1);
    assert.equal(loadedTake1.isSelected, false);
    assert.equal(loadedTake1.duration, 1.5);
    assert.equal(loadedTake1.settings.seed, 101);
    assert.equal(loadedTake1.settings.anchorVersion, 1);
    assert.equal(loadedTake1.settings.guidance, 2.0);
    assert.equal(loadedTake1.settings.steps, 10);
    assert.equal(loadedTake1.settings.styleMode, 'auto');
    assert.equal(resolveTakeAudioUrl(loadedTake1), `/api/v1/assets/${assetId1}/binary`);

    // Verify Take 2 (Active/Selected)
    const loadedTake2 = reloadedSeg.takes[1];
    assert.equal(loadedTake2.id, 'take-seg1-2');
    assert.equal(loadedTake2.audioAssetId, assetId2);
    assert.equal(loadedTake2.isSelected, true);
    assert.equal(loadedTake2.duration, 1.8);
    assert.equal(loadedTake2.settings.seed, 102);
    assert.equal(loadedTake2.settings.anchorVersion, 2);
    assert.equal(loadedTake2.settings.guidance, 2.5);
    assert.equal(loadedTake2.settings.steps, 12);
    assert.equal(loadedTake2.settings.styleMode, 'custom');
    assert.equal(loadedTake2.settings.customStyle, 'energetic');
    assert.equal(resolveTakeAudioUrl(loadedTake2), `/api/v1/assets/${assetId2}/binary`);

    // Verify active take helper
    const activeTake = getSegmentActiveTake(reloadedSeg);
    assert.equal(activeTake.id, 'take-seg1-2');

    // Verify binary integrity from asset store
    const binary1 = await reloadedStore.getAssetBinary(assetId1);
    assert.equal(binary1.bytes.length, audioBytes1.length);
    assert.equal(binary1.meta.mimeType, WAV_MIME);

    // Verify take selection switch survives mutation
    const switchedSeg = selectSegmentTake(reloadedSeg, 'take-seg1-1');
    assert.equal(switchedSeg.takes[0].isSelected, true);
    assert.equal(switchedSeg.takes[1].isSelected, false);

    // Verify take removal
    const prunedSeg = removeSegmentTake(switchedSeg, 'take-seg1-2');
    assert.equal(prunedSeg.takes.length, 1);
    assert.equal(prunedSeg.takes[0].id, 'take-seg1-1');
    assert.equal(prunedSeg.takes[0].isSelected, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
