import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BYTES_PER_GB,
  BYTES_PER_KB,
  BYTES_PER_MB,
  MODEL_STATE,
  OVERALL_READINESS,
  SERVICE_STATUS,
  aggregateDiagnostics,
  buildEngineModelRecord,
  buildMediaModelRecords,
  buildStorageMetrics,
  buildStorageModelRecord,
  formatBytes,
  resolveHeadroomState,
  resolveModelState,
  resolveOverallStatus,
} from '../../src/domain/modelDiagnostics.js';

test('formatBytes handles boundary values, invalid inputs, and scales', () => {
  assert.equal(formatBytes(null), 'Unknown');
  assert.equal(formatBytes(undefined), 'Unknown');
  assert.equal(formatBytes(-10), 'Unknown');
  assert.equal(formatBytes(NaN), 'Unknown');
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(500), '500 B');
  assert.equal(formatBytes(BYTES_PER_KB), '1.0 KB');
  assert.equal(formatBytes(BYTES_PER_MB * 2.5), '2.5 MB');
  assert.equal(formatBytes(BYTES_PER_GB * 12.4), '12.4 GB');
});

test('resolveModelState handles booleans, strings, status objects, and offline degradation', () => {
  assert.deepEqual(resolveModelState(true, true), { state: MODEL_STATE.READY, message: null });
  assert.deepEqual(resolveModelState(false, true), { state: MODEL_STATE.NOT_INSTALLED, message: null });
  assert.deepEqual(resolveModelState(MODEL_STATE.DOWNLOADING, true), { state: MODEL_STATE.DOWNLOADING, message: null });
  assert.deepEqual(resolveModelState(MODEL_STATE.LOADING, true), { state: MODEL_STATE.LOADING, message: null });
  assert.deepEqual(resolveModelState({ state: MODEL_STATE.ERROR, error: 'Out of memory' }, true), {
    state: MODEL_STATE.ERROR,
    message: 'Out of memory',
  });
  assert.deepEqual(resolveModelState(true, false), { state: MODEL_STATE.UNAVAILABLE, message: null });
});

test('buildEngineModelRecord reflects engine availability, custom device, and offline reasons', () => {
  const ready = buildEngineModelRecord({ available: true, reason: null });
  assert.equal(ready.id, 'voxcpm');
  assert.equal(ready.state, MODEL_STATE.READY);
  assert.match(ready.description, /Apple Silicon/);

  const customDevice = buildEngineModelRecord({ available: true, device: 'CUDA (cuda:0)' });
  assert.equal(customDevice.device, 'CUDA (cuda:0)');
  assert.match(customDevice.description, /CUDA/);

  const offline = buildEngineModelRecord({ available: false, reason: 'Port 8808 blocked' });
  assert.equal(offline.state, MODEL_STATE.UNAVAILABLE);
  assert.equal(offline.description, 'Port 8808 blocked');

  const empty = buildEngineModelRecord(null);
  assert.equal(empty.state, MODEL_STATE.UNAVAILABLE);
  assert.match(empty.description, /offline/i);
});

test('buildMediaModelRecords distinguishes service offline from uncached, downloading, and error models', () => {
  // Service completely offline
  const offlineRecords = buildMediaModelRecords({ online: false });
  assert.equal(offlineRecords.length, 5);
  for (const record of offlineRecords) {
    assert.equal(record.state, MODEL_STATE.UNAVAILABLE);
  }

  // Service online with partial models, downloading, and error states
  const partialRecords = buildMediaModelRecords({
    online: true,
    models: {
      whisper: true,
      khmerAsr: MODEL_STATE.DOWNLOADING,
      translator: { state: MODEL_STATE.ERROR, error: 'CUDA out of memory' },
      diarization: true,
    },
    burnInSupported: true,
  });

  const whisper = partialRecords.find(r => r.id === 'whisper');
  assert.equal(whisper.state, MODEL_STATE.READY);

  const khmerAsr = partialRecords.find(r => r.id === 'khmerAsr');
  assert.equal(khmerAsr.state, MODEL_STATE.DOWNLOADING);
  assert.match(khmerAsr.description, /downloading/i);

  const translator = partialRecords.find(r => r.id === 'translator');
  assert.equal(translator.state, MODEL_STATE.ERROR);
  assert.match(translator.description, /CUDA out of memory/);

  const diarization = partialRecords.find(r => r.id === 'diarization');
  assert.equal(diarization.state, MODEL_STATE.READY);

  const burnIn = partialRecords.find(r => r.id === 'burnIn');
  assert.equal(burnIn.state, MODEL_STATE.READY);
});

test('buildStorageModelRecord and buildStorageMetrics report headroom and container stats', () => {
  const storageOnlineWithMastering = buildStorageModelRecord({ online: true, ffmpegAvailable: true });
  assert.equal(storageOnlineWithMastering.state, MODEL_STATE.READY);

  const storageOffline = buildStorageModelRecord({ online: false });
  assert.equal(storageOffline.state, MODEL_STATE.UNAVAILABLE);

  assert.equal(resolveHeadroomState(null), 'unknown');
  assert.equal(resolveHeadroomState(500 * 1024 * 1024), 'warning'); // 500 MB < 1 GB
  assert.equal(resolveHeadroomState(10 * BYTES_PER_GB), 'healthy');

  const metrics = buildStorageMetrics({
    storage: {
      volumeFreeBytes: 50 * BYTES_PER_GB,
      volumeTotalBytes: 500 * BYTES_PER_GB,
      charactersCount: 14,
      anchorsCount: 8,
      anchorBytes: 25 * BYTES_PER_MB,
      cacheEntriesCount: 5,
      maxCacheEntries: 50,
      cacheBytes: 10 * BYTES_PER_MB,
      usedBytes: 35 * BYTES_PER_MB,
    },
    container: {
      rssBytes: 180 * BYTES_PER_MB,
      uptimeSeconds: 3600,
    },
  });

  assert.equal(metrics.headroomState, 'healthy');
  assert.equal(metrics.volumeFreeFormatted, '50.0 GB');
  assert.equal(metrics.charactersCount, 14);
  assert.equal(metrics.anchorsCount, 8);
  assert.equal(metrics.cacheEntriesCount, 5);
  assert.equal(metrics.containerRssFormatted, '180.0 MB');
  assert.equal(metrics.uptimeSeconds, 3600);
});

test('resolveOverallStatus correctly identifies OFFLINE_READY, NEEDS_DOWNLOAD, DEGRADED, and SERVICES_OFFLINE', () => {
  // Services offline
  const offlineResult = resolveOverallStatus({
    services: [{ status: SERVICE_STATUS.OFFLINE }, { status: SERVICE_STATUS.ONLINE }],
    models: [{ state: MODEL_STATE.READY }],
  });
  assert.equal(offlineResult.status, OVERALL_READINESS.SERVICES_OFFLINE);
  assert.equal(offlineResult.isOfflineReady, false);

  // Model error -> DEGRADED
  const degradedResult = resolveOverallStatus({
    services: [{ status: SERVICE_STATUS.ONLINE }, { status: SERVICE_STATUS.ONLINE }],
    models: [{ state: MODEL_STATE.READY }, { state: MODEL_STATE.ERROR }],
  });
  assert.equal(degradedResult.status, OVERALL_READINESS.DEGRADED);
  assert.equal(degradedResult.isOfflineReady, false);

  // Services online, but model not cached
  const downloadResult = resolveOverallStatus({
    services: [{ status: SERVICE_STATUS.ONLINE }, { status: SERVICE_STATUS.ONLINE }],
    models: [{ state: MODEL_STATE.READY }, { state: MODEL_STATE.NOT_INSTALLED }],
  });
  assert.equal(downloadResult.status, OVERALL_READINESS.NEEDS_DOWNLOAD);
  assert.equal(downloadResult.isOfflineReady, false);

  // All online and all models ready
  const readyResult = resolveOverallStatus({
    services: [{ status: SERVICE_STATUS.ONLINE }, { status: SERVICE_STATUS.ONLINE }],
    models: [{ state: MODEL_STATE.READY }, { state: MODEL_STATE.READY }],
  });
  assert.equal(readyResult.status, OVERALL_READINESS.OFFLINE_READY);
  assert.equal(readyResult.isOfflineReady, true);
});

test('aggregateDiagnostics produces cohesive diagnostics report with plain-language instructions', () => {
  const result = aggregateDiagnostics({
    engineHealth: { available: true },
    mediaHealth: {
      online: true,
      models: { whisper: true, khmerAsr: false, translator: true, diarization: true },
      burnInSupported: true,
      pid: 4567,
    },
    storageHealth: { online: true, ffmpegAvailable: true },
    storageStats: {
      storage: {
        volumeFreeBytes: 800 * 1024 * 1024, // 800 MB -> low headroom warning
        volumeTotalBytes: 100 * BYTES_PER_GB,
      },
    },
  });

  assert.equal(result.overall.status, OVERALL_READINESS.NEEDS_DOWNLOAD);
  assert.equal(result.overall.isOfflineReady, false);
  assert.equal(result.services.length, 3);
  assert.equal(result.models.length, 7);
  assert.equal(result.storage.headroomState, 'warning');

  // Should have instructions for missing Khmer model and low disk space
  assert.ok(result.instructions.some(i => i.includes('Qwen3 Khmer ASR')));
  assert.ok(result.instructions.some(i => i.includes('critically low')));
});
