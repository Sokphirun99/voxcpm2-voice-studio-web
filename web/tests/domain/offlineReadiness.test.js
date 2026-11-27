/**
 * @fileoverview Unit tests for pure domain offline readiness evaluations and pre-flight guards (R1-08).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEATURE_KEYS,
  FEATURE_SPECS,
  OFFLINE_STATUS,
  OfflineModelMissingError,
  assertFeatureOfflineReady,
  evaluateOfflineReadiness,
  getFeatureSpec,
  isFeatureCached,
  isFeatureOfflineReady,
  isModelReady,
} from '../../src/domain/offlineReadiness.js';

test('FEATURE_SPECS catalog defines exact repository and download size metadata for all 6 studio features', () => {
  // TTS (VoxCPM2)
  const tts = getFeatureSpec(FEATURE_KEYS.TTS);
  assert.ok(tts);
  assert.equal(tts.modelId, 'voxcpm');
  assert.equal(tts.repo, 'openbmb/VoxCPM2');
  assert.equal(tts.approxSize, '4.8 GB');

  // Video Transcription (Whisper)
  const whisper = getFeatureSpec(FEATURE_KEYS.TRANSCRIPTION_WHISPER);
  assert.ok(whisper);
  assert.equal(whisper.modelId, 'whisper');
  assert.equal(whisper.repo, 'mlx-community/whisper-large-v3-turbo');
  assert.equal(whisper.approxSize, '1.6 GB');

  // Khmer ASR (Qwen3)
  const khmer = getFeatureSpec(FEATURE_KEYS.TRANSCRIPTION_KHMER);
  assert.ok(khmer);
  assert.equal(khmer.modelId, 'khmerAsr');
  assert.equal(khmer.repo, 'seanghay/Qwen3-ASR-0.6B-Khmer');
  assert.equal(khmer.approxSize, '1.2 GB');

  // Subtitle Translation (NLLB-200)
  const translation = getFeatureSpec(FEATURE_KEYS.TRANSLATION);
  assert.ok(translation);
  assert.equal(translation.modelId, 'translator');
  assert.equal(translation.repo, 'facebook/nllb-200-distilled-600M');
  assert.equal(translation.approxSize, '2.4 GB');

  // Speaker Diarization (Sherpa-ONNX)
  const diarization = getFeatureSpec(FEATURE_KEYS.DIARIZATION);
  assert.ok(diarization);
  assert.equal(diarization.modelId, 'diarization');
  assert.equal(diarization.approxSize, '60 MB');

  // Subtitle Burn-In (FFmpeg libass)
  const burnIn = getFeatureSpec(FEATURE_KEYS.BURN_IN);
  assert.ok(burnIn);
  assert.equal(burnIn.modelId, 'burnIn');

  // Storage & Audio Mastering
  const storage = getFeatureSpec(FEATURE_KEYS.STORAGE);
  assert.ok(storage);
  assert.equal(storage.modelId, 'audioMastering');

  // Aliases resolve to canonical specs
  assert.equal(getFeatureSpec('whisper'), whisper);
  assert.equal(getFeatureSpec('translator'), translation);
  assert.equal(getFeatureSpec('khmerAsr'), khmer);
  assert.equal(getFeatureSpec('burnIn'), burnIn);
  assert.equal(getFeatureSpec('unknown_key'), null);
  assert.equal(getFeatureSpec(null), null);
});

test('isModelReady and isFeatureCached handle diverse input shapes accurately', () => {
  // Array of model records
  const arrayModels = [
    { id: 'voxcpm', state: 'ready' },
    { id: 'whisper', state: 'not_installed' },
    { id: 'translator', state: 'loading' },
  ];
  assert.equal(isModelReady(arrayModels, 'voxcpm'), true);
  assert.equal(isModelReady(arrayModels, 'whisper'), false);
  assert.equal(isModelReady(arrayModels, 'translator'), false);
  assert.equal(isFeatureCached('tts', arrayModels), true);
  assert.equal(isFeatureCached('whisper', arrayModels), false);

  // Object map
  const objectModels = {
    voxcpm: true,
    whisper: false,
    translator: 'ready',
    khmerAsr: { state: 'ready' },
  };
  assert.equal(isModelReady(objectModels, 'voxcpm'), true);
  assert.equal(isModelReady(objectModels, 'whisper'), false);
  assert.equal(isModelReady(objectModels, 'translator'), true);
  assert.equal(isModelReady(objectModels, 'khmerAsr'), true);
  assert.equal(isFeatureOfflineReady('translation', objectModels), true);

  // Nested diagnostic object
  const diagModels = { models: [{ id: 'voxcpm', state: 'ready' }] };
  assert.equal(isModelReady(diagModels, 'voxcpm'), true);

  // Empty / invalid
  assert.equal(isModelReady(null, 'voxcpm'), false);
  assert.equal(isModelReady({}, 'voxcpm'), false);
  assert.equal(isFeatureCached('nonexistent', objectModels), false);
});

test('assertFeatureOfflineReady succeeds 100% offline when required model is cached', () => {
  const models = {
    voxcpm: true,
    whisper: true,
    translator: true,
  };

  // Offline mode (isOnline = false) with cached models
  const ttsRes = assertFeatureOfflineReady({ featureId: 'tts', models, isOnline: false });
  assert.equal(ttsRes.ok, true);
  assert.equal(ttsRes.isCached, true);
  assert.equal(ttsRes.isOfflineReady, true);

  const transRes = assertFeatureOfflineReady({ featureId: 'translation', models, isOnline: false });
  assert.equal(transRes.ok, true);
  assert.equal(transRes.isCached, true);
  assert.equal(transRes.isOfflineReady, true);
});

test('assertFeatureOfflineReady pre-flight blocks with honest actionable error when offline and uncached', () => {
  const models = {
    voxcpm: true,
    whisper: true,
    translator: false, // Not cached!
  };

  assert.throws(
    () => assertFeatureOfflineReady({ featureId: 'translation', models, isOnline: false }),
    err => {
      assert.ok(err instanceof OfflineModelMissingError);
      assert.equal(err.name, 'OfflineModelMissingError');
      assert.equal(err.code, 'OFFLINE_MODEL_MISSING');
      assert.equal(err.featureId, 'translation');
      assert.equal(err.modelName, 'Subtitle Translation (NLLB-200)');
      assert.equal(err.repo, 'facebook/nllb-200-distilled-600M');
      assert.equal(err.approxSize, '2.4 GB');
      assert.match(err.message, /Subtitle Translation \(NLLB-200\)/);
      assert.match(err.message, /facebook\/nllb-200-distilled-600M/);
      assert.match(err.message, /2\.4 GB/);
      assert.match(err.message, /one-time internet connection is required/);
      return true;
    }
  );

  // When online (isOnline = true), it does NOT throw, but flags download required
  const onlineRes = assertFeatureOfflineReady({ featureId: 'translation', models, isOnline: true });
  assert.equal(onlineRes.ok, true);
  assert.equal(onlineRes.isCached, false);
  assert.equal(onlineRes.requiresDownload, true);
  assert.ok(onlineRes.spec);
});

test('evaluateOfflineReadiness reports OFFLINE_READY when all models are cached', () => {
  const allCached = {
    voxcpm: true,
    whisper: true,
    khmerAsr: true,
    translator: true,
    diarization: true,
    burnIn: true,
    audioMastering: true,
  };

  // Both when online and offline
  const resultOffline = evaluateOfflineReadiness({ isOnline: false, models: allCached });
  assert.equal(resultOffline.status, OFFLINE_STATUS.OFFLINE_READY);
  assert.equal(resultOffline.label, 'Offline Ready');
  assert.equal(resultOffline.isOfflineReady, true);
  assert.equal(resultOffline.isNetworkOnline, false);
  assert.equal(resultOffline.cachedCount, 7);
  assert.equal(resultOffline.uncachedFeatures.length, 0);
  assert.equal(resultOffline.downloadSpecs.length, 0);
  assert.match(resultOffline.actionableGuidance[0], /All models cached/);

  const resultOnline = evaluateOfflineReadiness({ isOnline: true, models: allCached });
  assert.equal(resultOnline.status, OFFLINE_STATUS.OFFLINE_READY);
  assert.equal(resultOnline.isOfflineReady, true);
  assert.equal(resultOnline.isNetworkOnline, true);
});

test('evaluateOfflineReadiness reports DOWNLOADS_REQUIRED when online and models need download', () => {
  const partialCached = {
    voxcpm: true,
    whisper: true,
    khmerAsr: true,
    translator: false, // missing
    diarization: false, // missing
    burnIn: true,
    audioMastering: true,
  };

  const result = evaluateOfflineReadiness({ isOnline: true, models: partialCached });
  assert.equal(result.status, OFFLINE_STATUS.DOWNLOADS_REQUIRED);
  assert.equal(result.label, 'Downloads Required');
  assert.equal(result.isOfflineReady, false);
  assert.equal(result.isNetworkOnline, true);
  assert.equal(result.cachedCount, 5);
  assert.equal(result.uncachedFeatures.length, 2);

  // Breakdown of uncached models
  assert.equal(result.downloadSpecs.length, 2);
  const translatorSpec = result.downloadSpecs.find(s => s.featureId === 'translation');
  assert.ok(translatorSpec);
  assert.equal(translatorSpec.repo, 'facebook/nllb-200-distilled-600M');
  assert.equal(translatorSpec.approxSize, '2.4 GB');

  const diarizationSpec = result.downloadSpecs.find(s => s.featureId === 'diarization');
  assert.ok(diarizationSpec);
  assert.equal(diarizationSpec.approxSize, '60 MB');
});

test('evaluateOfflineReadiness reports OFFLINE_CACHED_AVAILABLE when internet is down and partial features cached', () => {
  const partialCached = {
    voxcpm: true,
    whisper: true,
    khmerAsr: true,
    translator: false, // missing
    diarization: false, // missing
    burnIn: true,
    audioMastering: true,
  };

  const result = evaluateOfflineReadiness({ isOnline: false, models: partialCached });
  assert.equal(result.status, OFFLINE_STATUS.OFFLINE_CACHED_AVAILABLE);
  assert.equal(result.label, 'Offline (Cached Features Available)');
  assert.equal(result.isOfflineReady, false);
  assert.equal(result.isNetworkOnline, false);
  assert.equal(result.cachedCount, 5);
  assert.equal(result.uncachedFeatures.length, 2);
  assert.match(result.description, /Internet disconnected/);
  assert.match(result.description, /5 cached feature\(s\) available/);
  assert.match(result.actionableGuidance[0], /Features with cached models continue to operate normally/);
});

test('OfflineModelMissingError is canonical and identical across errors.js and offlineReadiness.js', async () => {
  const errorsModule = await import('../../src/domain/errors.js');
  const offlineModule = await import('../../src/domain/offlineReadiness.js');
  assert.equal(errorsModule.OfflineModelMissingError, offlineModule.OfflineModelMissingError);
  const err = new offlineModule.OfflineModelMissingError({
    featureId: 'tts',
    modelName: 'VoxCPM2',
    repo: 'openbmb/VoxCPM2',
    approxSize: '4.8 GB',
  });
  assert.ok(err instanceof errorsModule.OfflineModelMissingError);
  assert.ok(err instanceof offlineModule.OfflineModelMissingError);
  assert.equal(err.code, 'OFFLINE_MODEL_MISSING');
});

test('evaluateOfflineReadiness reports DOWNLOADS_REQUIRED when offline and 0 models are cached', () => {
  const noneCached = {
    voxcpm: false,
    whisper: false,
    khmerAsr: false,
    translator: false,
    diarization: false,
    burnIn: false,
    audioMastering: false,
  };

  const result = evaluateOfflineReadiness({ isOnline: false, models: noneCached });
  assert.equal(result.status, OFFLINE_STATUS.DOWNLOADS_REQUIRED);
  assert.equal(result.label, 'Downloads Required');
  assert.equal(result.isOfflineReady, false);
  assert.equal(result.cachedCount, 0);
  assert.match(result.description, /no models are cached/);
});

test('evaluateOfflineReadiness reports SERVICES_OFFLINE when local services are down', () => {
  const result = evaluateOfflineReadiness({
    isOnline: true,
    models: { voxcpm: true },
    services: [
      { id: 'engine', status: 'offline' },
      { id: 'media', status: 'online' },
    ],
  });
  assert.equal(result.status, OFFLINE_STATUS.SERVICES_OFFLINE);
  assert.equal(result.label, 'Local Services Offline');
  assert.equal(result.isOfflineReady, false);
});
