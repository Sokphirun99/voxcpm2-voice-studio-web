/**
 * @fileoverview Pure domain logic evaluating offline readiness, download specifications, and preflight guards.
 */

export const OFFLINE_STATUS = Object.freeze({
  OFFLINE_READY: 'offline_ready',
  DOWNLOADS_REQUIRED: 'downloads_required',
  OFFLINE_CACHED_AVAILABLE: 'offline_cached_available',
  SERVICES_OFFLINE: 'services_offline',
  DEGRADED: 'degraded',
});

export const FEATURE_KEYS = Object.freeze({
  TTS: 'tts',
  TRANSCRIPTION_WHISPER: 'transcription_whisper',
  TRANSCRIPTION_KHMER: 'transcription_khmer',
  TRANSLATION: 'translation',
  DIARIZATION: 'diarization',
  BURN_IN: 'burn_in',
  STORAGE: 'storage',
});

export const FEATURE_SPECS = Object.freeze({
  [FEATURE_KEYS.TTS]: Object.freeze({
    id: FEATURE_KEYS.TTS,
    name: 'Text-to-Speech (VoxCPM2)',
    modelId: 'voxcpm',
    repo: 'openbmb/VoxCPM2',
    approxSize: '4.8 GB',
    firstUseRequirement: 'Requires one-time internet download of VoxCPM2 weights (~4.8 GB) before offline synthesis.',
  }),
  [FEATURE_KEYS.TRANSCRIPTION_WHISPER]: Object.freeze({
    id: FEATURE_KEYS.TRANSCRIPTION_WHISPER,
    name: 'Video Transcription (Whisper)',
    modelId: 'whisper',
    repo: 'mlx-community/whisper-large-v3-turbo',
    approxSize: '1.6 GB',
    firstUseRequirement: 'Requires one-time internet download of Whisper Large-v3-Turbo weights (~1.6 GB).',
  }),
  [FEATURE_KEYS.TRANSCRIPTION_KHMER]: Object.freeze({
    id: FEATURE_KEYS.TRANSCRIPTION_KHMER,
    name: 'Khmer ASR & Speech Verifier',
    modelId: 'khmerAsr',
    repo: 'seanghay/Qwen3-ASR-0.6B-Khmer',
    approxSize: '1.2 GB',
    firstUseRequirement: 'Requires one-time internet download of Qwen3 Khmer ASR weights (~1.2 GB).',
  }),
  [FEATURE_KEYS.TRANSLATION]: Object.freeze({
    id: FEATURE_KEYS.TRANSLATION,
    name: 'Subtitle Translation (NLLB-200)',
    modelId: 'translator',
    repo: 'facebook/nllb-200-distilled-600M',
    approxSize: '2.4 GB',
    firstUseRequirement: 'Requires one-time internet download of NLLB-200 translation weights (~2.4 GB).',
  }),
  [FEATURE_KEYS.DIARIZATION]: Object.freeze({
    id: FEATURE_KEYS.DIARIZATION,
    name: 'Speaker Diarization (Sherpa-ONNX)',
    modelId: 'diarization',
    repo: 'Pyannote 3.0 / 3D-Speaker CAM++',
    approxSize: '60 MB',
    firstUseRequirement: 'Requires one-time download of ONNX segmentation and embedding models (~60 MB).',
  }),
  [FEATURE_KEYS.BURN_IN]: Object.freeze({
    id: FEATURE_KEYS.BURN_IN,
    name: 'Subtitle Video Burn-In (FFmpeg libass)',
    modelId: 'burnIn',
    repo: 'libass filter',
    approxSize: 'Homebrew ffmpeg-full',
    firstUseRequirement: 'Requires FFmpeg with libass filter installed on the host system.',
  }),
  [FEATURE_KEYS.STORAGE]: Object.freeze({
    id: FEATURE_KEYS.STORAGE,
    name: 'Project Storage & Audio Mastering',
    modelId: 'audioMastering',
    repo: 'two-pass loudnorm',
    approxSize: 'Bundled in container',
    firstUseRequirement: 'Bundled with the storage service container.',
  }),
});

const FEATURE_ALIASES = Object.freeze({
  whisper: FEATURE_KEYS.TRANSCRIPTION_WHISPER,
  khmerAsr: FEATURE_KEYS.TRANSCRIPTION_KHMER,
  translator: FEATURE_KEYS.TRANSLATION,
  burnIn: FEATURE_KEYS.BURN_IN,
  audioMastering: FEATURE_KEYS.STORAGE,
});

import { OfflineModelMissingError } from './errors.js';

export { OfflineModelMissingError };

/**
 * Resolves the feature specification by key or alias.
 * Inputs: string feature key or alias.
 * Outputs: specification object from FEATURE_SPECS or null.
 * Side effects: none.
 * Failure modes: returns null if key is invalid or unrecognized.
 * @param {string} key - Feature key or alias.
 * @returns {object|null} Feature specification or null.
 */
export function getFeatureSpec(key) {
  if (!key || typeof key !== 'string') return null;
  const canonical = FEATURE_ALIASES[key] || key;
  return FEATURE_SPECS[canonical] || null;
}

/**
 * Checks whether a given model is cached locally and ready for offline use.
 * Inputs: models array or map object, and target modelId.
 * Outputs: boolean true if model is cached.
 * Side effects: none.
 * Failure modes: returns false on invalid or missing inputs.
 * @param {unknown} models - Models array or object map.
 * @param {string} modelId - Model ID to inspect.
 * @returns {boolean} True if model is cached locally.
 */
export function isModelReady(models, modelId) {
  if (!models || typeof models !== 'object') return false;
  if (models.models) return isModelReady(models.models, modelId);
  if (Array.isArray(models)) {
    const item = models.find(m => m.id === modelId || m.modelId === modelId);
    return item?.state === 'ready';
  }
  const value = models[modelId];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'ready';
  if (value && typeof value === 'object') return value.state === 'ready';
  return false;
}

/**
 * Evaluates whether a specific feature has its required model cached locally.
 * Inputs: feature key and models container.
 * Outputs: boolean true if model is cached.
 * Side effects: none.
 * Failure modes: returns false if spec is missing or model not ready.
 * @param {string} featureKey - Feature key or alias.
 * @param {unknown} models - Models array or map.
 * @returns {boolean} True if cached locally.
 */
export function isFeatureCached(featureKey, models) {
  const spec = getFeatureSpec(featureKey);
  if (!spec) return false;
  return isModelReady(models, spec.modelId);
}

/**
 * Evaluates whether a feature can execute 100% offline without network.
 * Inputs: feature key and models container.
 * Outputs: boolean true if feature is offline ready.
 * Side effects: none.
 * Failure modes: returns false if uncached.
 * @param {string} featureKey - Feature key or alias.
 * @param {unknown} models - Models array or map.
 * @returns {boolean} True if offline ready.
 */
export function isFeatureOfflineReady(featureKey, models) {
  return isFeatureCached(featureKey, models);
}

/**
 * Pre-flight guard validating feature offline readiness before executing a model-backed task.
 * Inputs: `{ featureId, models, isOnline }`.
 * Outputs: `{ ok: boolean, isCached: boolean, isOfflineReady: boolean, requiresDownload?: boolean, spec?: object }`.
 * Side effects: none.
 * Failure modes: throws OfflineModelMissingError if offline and uncached.
 * @param {{ featureId: string, models: unknown, isOnline?: boolean }} params - Guard parameters.
 * @returns {object} Validation result.
 */
export function assertFeatureOfflineReady({ featureId, models, isOnline = true }) {
  const spec = getFeatureSpec(featureId);
  if (!spec) return { ok: true, isCached: true, isOfflineReady: true };
  const cached = isFeatureCached(featureId, models);
  if (cached) {
    return { ok: true, isCached: true, isOfflineReady: true, spec };
  }
  if (!isOnline) {
    throw new OfflineModelMissingError({
      featureId: spec.id,
      featureName: spec.name,
      modelId: spec.modelId,
      modelName: spec.name,
      repo: spec.repo,
      approxSize: spec.approxSize,
    });
  }
  return { ok: true, isCached: false, isOfflineReady: false, requiresDownload: true, spec };
}

function buildDownloadSpec(spec, cached) {
  if (cached) return null;
  return {
    featureId: spec.id,
    featureName: spec.name,
    modelId: spec.modelId,
    modelName: spec.name,
    repo: spec.repo,
    approxSize: spec.approxSize,
    firstUseRequirement: spec.firstUseRequirement,
  };
}

function evaluateFeatureReadiness(spec, models) {
  const cached = isModelReady(models, spec.modelId);
  return {
    id: spec.id,
    name: spec.name,
    modelId: spec.modelId,
    repo: spec.repo,
    approxSize: spec.approxSize,
    firstUseRequirement: spec.firstUseRequirement,
    isCached: cached,
    isOfflineReady: cached,
    downloadSpec: buildDownloadSpec(spec, cached),
  };
}

function resolveServiceOrReadyStatus(servicesOnline, uncachedCount) {
  if (!servicesOnline) {
    return {
      status: OFFLINE_STATUS.SERVICES_OFFLINE,
      label: 'Local Services Offline',
      description: 'One or more local services are unreachable. Run ./studio.sh start to start the studio.',
      isOfflineReady: false,
    };
  }
  if (uncachedCount === 0) {
    return {
      status: OFFLINE_STATUS.OFFLINE_READY,
      label: 'Offline Ready',
      description: 'All required models are cached locally on disk. Voice Studio is 100% ready for offline operation.',
      isOfflineReady: true,
    };
  }
  return null;
}

function resolveDownloadsRequiredDesc(isNetworkOnline, uncachedCount) {
  return isNetworkOnline
    ? `${uncachedCount} model(s) require an internet connection on first use to download missing weights.`
    : 'Internet disconnected and no models are cached. Connect to internet to download required model weights.';
}

function resolveOfflineStatus({ uncachedCount, cachedCount, isNetworkOnline, servicesOnline }) {
  const base = resolveServiceOrReadyStatus(servicesOnline, uncachedCount);
  if (base) return base;
  if (isNetworkOnline || cachedCount === 0) {
    return {
      status: OFFLINE_STATUS.DOWNLOADS_REQUIRED,
      label: 'Downloads Required',
      description: resolveDownloadsRequiredDesc(isNetworkOnline, uncachedCount),
      isOfflineReady: false,
    };
  }
  return {
    status: OFFLINE_STATUS.OFFLINE_CACHED_AVAILABLE,
    label: 'Offline (Cached Features Available)',
    description: `Internet disconnected. ${cachedCount} cached feature(s) available; ${uncachedCount} uncached feature(s) require internet.`,
    isOfflineReady: false,
  };
}

function deriveOfflineGuidance({ status, uncachedFeatures }) {
  if (status === OFFLINE_STATUS.OFFLINE_READY) {
    return ['All models cached. You can disconnect from the internet and run all Voice Studio workflows offline.'];
  }
  if (status === OFFLINE_STATUS.DOWNLOADS_REQUIRED) {
    return uncachedFeatures.map(f => `${f.name}: ${f.firstUseRequirement}`);
  }
  if (status === OFFLINE_STATUS.OFFLINE_CACHED_AVAILABLE) {
    return [
      'Internet is offline. Features with cached models continue to operate normally.',
      ...uncachedFeatures.map(f => `${f.name} (~${f.approxSize}) requires an internet connection to download before use.`),
    ];
  }
  return ['Local services are offline. Run ./studio.sh start to initialize local services.'];
}

function partitionFeatures(models) {
  const features = Object.values(FEATURE_SPECS).map(spec => evaluateFeatureReadiness(spec, models));
  return {
    features,
    cachedFeatures: features.filter(f => f.isCached),
    uncachedFeatures: features.filter(f => !f.isCached),
  };
}

function resolveEffectiveOnline(isOnline) {
  if (typeof isOnline === 'boolean') return isOnline;
  if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
    return navigator.onLine;
  }
  return true;
}

function resolveServicesOnline(services, diagnostics) {
  const effectiveServices = services || diagnostics?.services || null;
  return !effectiveServices || effectiveServices.every(s => s.status === 'online');
}

function assembleReadinessRecord({ statusInfo, effectiveIsOnline, features, cachedFeatures, uncachedFeatures }) {
  return {
    ...statusInfo,
    isNetworkOnline: effectiveIsOnline,
    features,
    cachedFeatures,
    uncachedFeatures,
    cachedCount: cachedFeatures.length,
    totalCount: features.length,
    downloadSpecs: uncachedFeatures.map(f => f.downloadSpec),
    actionableGuidance: deriveOfflineGuidance({ status: statusInfo.status, uncachedFeatures }),
  };
}

/**
 * Evaluates full offline readiness across all features, models, and network state.
 * Inputs: optional `{ isOnline, models, services, diagnostics }`.
 * Outputs: comprehensive offline readiness record with status, counts, download specs, and actionable guidance.
 * Side effects: reads navigator.onLine when isOnline is omitted.
 * Failure modes: safely degrades to uninstalled/downloads_required without throwing.
 * @param {{ isOnline?: boolean, models?: unknown, services?: Array<object>, diagnostics?: object }} [params] - Inputs.
 * @returns {object} Offline readiness evaluation.
 */
export function evaluateOfflineReadiness({ isOnline, models, services, diagnostics } = {}) {
  const effectiveIsOnline = resolveEffectiveOnline(isOnline);
  const effectiveModels = models || diagnostics?.models || null;
  const servicesOnline = resolveServicesOnline(services, diagnostics);
  const { features, cachedFeatures, uncachedFeatures } = partitionFeatures(effectiveModels);
  const statusInfo = resolveOfflineStatus({
    uncachedCount: uncachedFeatures.length,
    cachedCount: cachedFeatures.length,
    isNetworkOnline: effectiveIsOnline,
    servicesOnline,
  });
  return assembleReadinessRecord({ statusInfo, effectiveIsOnline, features, cachedFeatures, uncachedFeatures });
}
