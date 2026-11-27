/**
 * @fileoverview Pure domain entity modeling system health, local AI model readiness, storage headroom, and actionable setup diagnostics.
 */

import { evaluateOfflineReadiness } from './offlineReadiness.js';

export const MODEL_STATE = Object.freeze({
  READY: 'ready',
  NOT_INSTALLED: 'not_installed',
  DOWNLOADING: 'downloading',
  LOADING: 'loading',
  UNAVAILABLE: 'unavailable',
  ERROR: 'error',
});

export const SERVICE_STATUS = Object.freeze({
  ONLINE: 'online',
  OFFLINE: 'offline',
  DEGRADED: 'degraded',
});

export const OVERALL_READINESS = Object.freeze({
  OFFLINE_READY: 'offline_ready',
  NEEDS_DOWNLOAD: 'needs_download',
  SERVICES_OFFLINE: 'services_offline',
  DEGRADED: 'degraded',
});

export const BYTES_PER_KB = 1024;
export const BYTES_PER_MB = 1024 * 1024;
export const BYTES_PER_GB = 1024 * 1024 * 1024;
export const LOW_VOLUME_THRESHOLD_BYTES = 1024 * 1024 * 1024; // 1 GB headroom warning

export const MODEL_CATALOG = Object.freeze({
  voxcpm: Object.freeze({
    id: 'voxcpm',
    name: 'VoxCPM2 Core Speech Model',
    repo: 'openbmb/VoxCPM2',
    task: 'Voice Cloning & TTS Synthesis',
    service: 'engine',
    device: 'Apple Silicon (MPS)',
    approxSize: '4.8 GB',
  }),
  whisper: Object.freeze({
    id: 'whisper',
    name: 'Whisper Large v3 Turbo',
    repo: 'mlx-community/whisper-large-v3-turbo',
    task: 'Multilingual Video Transcription',
    service: 'media',
    device: 'Apple Silicon MLX',
    approxSize: '1.6 GB',
  }),
  khmerAsr: Object.freeze({
    id: 'khmerAsr',
    name: 'Qwen3 Khmer ASR & Verifier',
    repo: 'seanghay/Qwen3-ASR-0.6B-Khmer',
    task: 'Khmer Speech Recognition & Verification',
    service: 'media',
    device: 'PyTorch MPS',
    approxSize: '1.2 GB',
  }),
  translator: Object.freeze({
    id: 'translator',
    name: 'NLLB-200 600M Translation',
    repo: 'facebook/nllb-200-distilled-600M',
    task: 'Multilingual Subtitle Translation',
    service: 'media',
    device: 'PyTorch MPS',
    approxSize: '2.4 GB',
  }),
  diarization: Object.freeze({
    id: 'diarization',
    name: 'Sherpa-ONNX Diarization & Denoiser',
    repo: 'Pyannote 3.0 / 3D-Speaker CAM++',
    task: 'Speaker Diarization & Voice Isolation',
    service: 'media',
    device: 'ONNX Runtime',
    approxSize: '60 MB',
  }),
  burnIn: Object.freeze({
    id: 'burnIn',
    name: 'FFmpeg Subtitle Burn-In (libass)',
    repo: 'libass filter',
    task: 'Hardcoded Subtitle Video Burn-In',
    service: 'media',
    device: 'Native CLI',
    approxSize: 'Homebrew ffmpeg-full',
  }),
  audioMastering: Object.freeze({
    id: 'audioMastering',
    name: 'FFmpeg EBU R128 Audio Master',
    repo: 'two-pass loudnorm',
    task: 'Broadcast Audio Normalization',
    service: 'storage',
    device: 'Native CLI',
    approxSize: 'Bundled in storage container',
  }),
});

/**
 * Formats a raw byte count into human-readable binary unit string.
 * Inputs: numeric byte count or null/undefined.
 * Outputs: formatted string (e.g. '12.4 GB', '450.0 MB') or 'Unknown'.
 * Side effects: none.
 * Failure modes: returns 'Unknown' on null or negative values.
 * @param {number|null|undefined} bytes - Byte size to format.
 * @returns {string} Human-readable byte representation.
 */
export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return 'Unknown';
  if (bytes < BYTES_PER_KB) return `${bytes} B`;
  if (bytes < BYTES_PER_MB) return `${(bytes / BYTES_PER_KB).toFixed(1)} KB`;
  if (bytes < BYTES_PER_GB) return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
  return `${(bytes / BYTES_PER_GB).toFixed(1)} GB`;
}

/**
 * Resolves a model state from raw inputs and online flag.
 * @param {unknown} rawStatus - Boolean, state string, or status object.
 * @param {boolean} isOnline - Whether the parent service is online.
 * @returns {{ state: string, message: string|null }} Resolved model state and message.
 */
export function resolveModelState(rawStatus, isOnline) {
  if (!isOnline) return { state: MODEL_STATE.UNAVAILABLE, message: null };
  if (typeof rawStatus === 'string' && Object.values(MODEL_STATE).includes(rawStatus)) {
    return { state: rawStatus, message: null };
  }
  if (rawStatus && typeof rawStatus === 'object') {
    const candidate = rawStatus.state;
    const state = Object.values(MODEL_STATE).includes(candidate) ? candidate : MODEL_STATE.NOT_INSTALLED;
    return { state, message: rawStatus.message || rawStatus.error || null };
  }
  if (rawStatus === true) return { state: MODEL_STATE.READY, message: null };
  return { state: MODEL_STATE.NOT_INSTALLED, message: null };
}

function resolveEngineDescription(state, engineHealth, device) {
  if (state === MODEL_STATE.READY) {
    return `VoxCPM2 engine is active on ${device} with /generate endpoint ready.`;
  }
  if (state === MODEL_STATE.LOADING) return `VoxCPM2 is initializing weights on ${device}…`;
  if (state === MODEL_STATE.DOWNLOADING) return 'VoxCPM2 model weights downloading in background…';
  if (state === MODEL_STATE.ERROR) return engineHealth?.reason || 'Engine encountered an internal error.';
  return engineHealth?.reason || 'Engine offline on port 8808. Start with ./studio.sh start or python app.py.';
}

/**
 * Builds the diagnostic model record for the VoxCPM2 speech generation engine.
 * @param {{ available: boolean, reason?: string|null, device?: string, state?: string }} engineHealth - Engine health response.
 * @returns {object} Normalized model diagnostic record.
 */
export function buildEngineModelRecord(engineHealth) {
  const isOnline = Boolean(engineHealth?.available);
  const device = engineHealth?.device || MODEL_CATALOG.voxcpm.device;
  const initial = engineHealth?.state || (isOnline ? MODEL_STATE.READY : MODEL_STATE.UNAVAILABLE);
  const resolved = resolveModelState(initial, isOnline);
  const description = resolveEngineDescription(resolved.state, engineHealth, device);
  return { ...MODEL_CATALOG.voxcpm, state: resolved.state, device, description };
}

function resolveHuggingFaceDescription(name, state, approxSize, customMessage) {
  if (state === MODEL_STATE.READY) return 'Cached locally in HuggingFace cache and ready for offline use.';
  if (state === MODEL_STATE.DOWNLOADING) return `Downloading ${name} weights in background…`;
  if (state === MODEL_STATE.LOADING) return `Loading ${name} into memory…`;
  if (state === MODEL_STATE.ERROR) return customMessage || `${name} failed during model initialization.`;
  if (state === MODEL_STATE.UNAVAILABLE) return 'Media service offline.';
  return `Model not cached. Initial run requires internet connection to download (~${approxSize}).`;
}

function buildModelRecordFromSpec(catalogItem, rawStatus, isOnline) {
  const resolved = resolveModelState(rawStatus, isOnline);
  const description = resolveHuggingFaceDescription(catalogItem.name, resolved.state, catalogItem.approxSize, resolved.message);
  return { ...catalogItem, state: resolved.state, description };
}

function buildDiarizationRecord(isOnline, rawStatus) {
  const resolved = resolveModelState(rawStatus, isOnline);
  let description = 'ONNX models cached locally in ~/.cache/voxcpm-media/diarization.';
  if (!isOnline) description = 'Media service offline.';
  else if (resolved.state === MODEL_STATE.NOT_INSTALLED) {
    description = 'Diarization models not found. Run ./studio.sh to initialize Sherpa-ONNX weights (~60 MB).';
  } else if (resolved.state === MODEL_STATE.ERROR) {
    description = resolved.message || 'Sherpa-ONNX runtime failed to initialize.';
  }
  return { ...MODEL_CATALOG.diarization, state: resolved.state, description };
}

function buildBurnInRecord(isOnline, burnInSupported) {
  if (!isOnline) return { ...MODEL_CATALOG.burnIn, state: MODEL_STATE.UNAVAILABLE, description: 'Media service offline.' };
  if (burnInSupported) return { ...MODEL_CATALOG.burnIn, state: MODEL_STATE.READY, description: 'FFmpeg with libass filter is ready for video burn-in.' };
  return { ...MODEL_CATALOG.burnIn, state: MODEL_STATE.NOT_INSTALLED, description: 'FFmpeg lacks libass support. Install via brew install ffmpeg-full.' };
}

/**
 * Builds the diagnostic model records for the media service components.
 * @param {{ online: boolean, reason?: string|null, models?: Record<string, unknown>, diarizationReady?: boolean, burnInSupported?: boolean }} mediaHealth - Media health response.
 * @returns {Array<object>} Normalized media model diagnostic records.
 */
export function buildMediaModelRecords(mediaHealth) {
  const isOnline = Boolean(mediaHealth?.online);
  const models = mediaHealth?.models || {};
  return [
    buildModelRecordFromSpec(MODEL_CATALOG.whisper, models.whisper, isOnline),
    buildModelRecordFromSpec(MODEL_CATALOG.khmerAsr, models.khmerAsr, isOnline),
    buildModelRecordFromSpec(MODEL_CATALOG.translator, models.translator, isOnline),
    buildDiarizationRecord(isOnline, models.diarization ?? mediaHealth?.diarizationReady),
    buildBurnInRecord(isOnline, mediaHealth?.burnInSupported),
  ];
}

/**
 * Builds the diagnostic model record for audio mastering in the storage service.
 * @param {{ online: boolean, ffmpegAvailable?: boolean, state?: string, reason?: string|null }} storageHealth - Storage health response.
 * @returns {object} Normalized audio mastering diagnostic record.
 */
export function buildStorageModelRecord(storageHealth) {
  const isOnline = Boolean(storageHealth?.online);
  if (!isOnline) return { ...MODEL_CATALOG.audioMastering, state: MODEL_STATE.UNAVAILABLE, description: 'Storage service offline.' };
  if (storageHealth?.state === MODEL_STATE.ERROR) {
    return { ...MODEL_CATALOG.audioMastering, state: MODEL_STATE.ERROR, description: storageHealth.reason || 'Audio mastering error.' };
  }
  if (storageHealth?.ffmpegAvailable) {
    return { ...MODEL_CATALOG.audioMastering, state: MODEL_STATE.READY, description: 'Broadcast-standard EBU R128 loudness normalization active.' };
  }
  return { ...MODEL_CATALOG.audioMastering, state: MODEL_STATE.UNAVAILABLE, description: 'FFmpeg is unavailable in the storage service container.' };
}

/**
 * Resolves volume headroom status from free bytes.
 * @param {number|null} volumeFreeBytes - Free disk space in bytes.
 * @returns {'healthy'|'warning'|'unknown'} Headroom rating.
 */
export function resolveHeadroomState(volumeFreeBytes) {
  if (typeof volumeFreeBytes !== 'number' || !Number.isFinite(volumeFreeBytes)) return 'unknown';
  if (volumeFreeBytes < LOW_VOLUME_THRESHOLD_BYTES) return 'warning';
  return 'healthy';
}

function extractVolumeMetrics(data) {
  const free = typeof data.volumeFreeBytes === 'number' ? data.volumeFreeBytes : null;
  const total = typeof data.volumeTotalBytes === 'number' ? data.volumeTotalBytes : null;
  return { free, total, freeFmt: formatBytes(free), totalFmt: formatBytes(total), state: resolveHeadroomState(free) };
}

function extractCatalogMetrics(data) {
  return {
    charactersCount: Number(data.charactersCount) || 0,
    anchorsCount: Number(data.anchorsCount) || 0,
    anchorBytes: Number(data.anchorBytes) || 0,
    anchorBytesFormatted: formatBytes(Number(data.anchorBytes) || 0),
    cacheEntriesCount: Number(data.cacheEntriesCount) || 0,
    maxCacheEntries: Number(data.maxCacheEntries) || 50,
    cacheBytes: Number(data.cacheBytes) || 0,
    cacheBytesFormatted: formatBytes(Number(data.cacheBytes) || 0),
    usedBytes: Number(data.usedBytes) || 0,
    usedBytesFormatted: formatBytes(Number(data.usedBytes) || 0),
  };
}

function extractContainerMetrics(rawStats) {
  const rss = Number(rawStats?.container?.rssBytes) || 0;
  return {
    containerRssBytes: rss,
    containerRssFormatted: formatBytes(rss),
    uptimeSeconds: Number(rawStats?.container?.uptimeSeconds) || 0,
  };
}

/**
 * Builds normalized storage metrics and volume headroom diagnostics.
 * @param {object|null} rawStats - Raw stats payload from `/api/v1/stats`.
 * @returns {object} Normalized storage metrics record.
 */
export function buildStorageMetrics(rawStats) {
  const data = rawStats?.storage || rawStats || {};
  const vol = extractVolumeMetrics(data);
  const cat = extractCatalogMetrics(data);
  const con = extractContainerMetrics(rawStats);
  return {
    volumeFreeBytes: vol.free,
    volumeTotalBytes: vol.total,
    volumeFreeFormatted: vol.freeFmt,
    volumeTotalFormatted: vol.totalFmt,
    headroomState: vol.state,
    ...cat,
    ...con,
  };
}

const STATUS_DESCRIPTIONS = Object.freeze({
  [OVERALL_READINESS.SERVICES_OFFLINE]: {
    label: 'Local Services Offline',
    description: 'One or more local services are unreachable. Run ./studio.sh start to start the studio.',
    isOfflineReady: false,
  },
  [OVERALL_READINESS.DEGRADED]: {
    label: 'Service Errors Encountered',
    description: 'One or more pipeline models or services failed during execution.',
    isOfflineReady: false,
  },
  [OVERALL_READINESS.NEEDS_DOWNLOAD]: {
    label: 'Online Only — Downloads Required',
    description: 'Some model weights are not cached on local disk. An internet connection is required on first use.',
    isOfflineReady: false,
  },
  [OVERALL_READINESS.OFFLINE_READY]: {
    label: 'Fully Ready for Offline Use',
    description: 'All services are active and all required model weights are cached locally on disk.',
    isOfflineReady: true,
  },
});

/**
 * Resolves overall readiness badge, label, and description from services and model items.
 * @param {{ services: Array<{ status: string }>, models: Array<{ state: string }> }} params - Services and models.
 * @returns {{ status: string, label: string, description: string, isOfflineReady: boolean }} Overall status descriptor.
 */
export function resolveOverallStatus({ services, models }) {
  if (services.some(s => s.status !== SERVICE_STATUS.ONLINE)) {
    return { status: OVERALL_READINESS.SERVICES_OFFLINE, ...STATUS_DESCRIPTIONS[OVERALL_READINESS.SERVICES_OFFLINE] };
  }
  if (models.some(m => m.state === MODEL_STATE.ERROR)) {
    return { status: OVERALL_READINESS.DEGRADED, ...STATUS_DESCRIPTIONS[OVERALL_READINESS.DEGRADED] };
  }
  if (models.some(m => m.state !== MODEL_STATE.READY)) {
    return { status: OVERALL_READINESS.NEEDS_DOWNLOAD, ...STATUS_DESCRIPTIONS[OVERALL_READINESS.NEEDS_DOWNLOAD] };
  }
  return { status: OVERALL_READINESS.OFFLINE_READY, ...STATUS_DESCRIPTIONS[OVERALL_READINESS.OFFLINE_READY] };
}

function resolveModelInstruction(model) {
  if (model.state === MODEL_STATE.NOT_INSTALLED) {
    if (model.id === 'burnIn') {
      return 'Install FFmpeg with libass support: run "brew install ffmpeg-full" or verify ffmpeg on PATH.';
    }
    if (model.id === 'diarization') {
      return 'Initialize Sherpa-ONNX diarization models: run "./studio.sh start" while connected to internet (~60 MB).';
    }
    if (model.id === 'voxcpm') {
      return 'Download VoxCPM2 core model: connect to internet and run "./studio.sh start" (~4.8 GB).';
    }
    return `Download ${model.name} (${model.repo}): connect to internet for initial run (~${model.approxSize}).`;
  }
  if (model.state === MODEL_STATE.ERROR) {
    return `${model.name} error: ${model.description || 'Check system logs for failure details.'}`;
  }
  return null;
}

/**
 * Derives actionable plain-language recovery instructions for any unready components.
 * @param {{ services: Array<object>, models: Array<object>, storage: object }} params - Diagnosed components.
 * @returns {Array<string>} Ordered plain-language setup instructions.
 */
export function deriveActionableInstructions({ services, models, storage }) {
  const instructions = [];
  for (const s of services) {
    if (s.status !== SERVICE_STATUS.ONLINE) instructions.push(s.instruction);
  }
  for (const m of models) {
    const item = resolveModelInstruction(m);
    if (item) instructions.push(item);
  }
  if (storage?.headroomState === 'warning') {
    instructions.push(`Storage volume free space is critically low (${storage.volumeFreeFormatted} remaining). Free up disk space.`);
  }
  return instructions;
}

function buildEngineService(engineHealth) {
  const isOnline = Boolean(engineHealth?.available);
  const device = engineHealth?.device || 'Apple Silicon (MPS)';
  const details = isOnline
    ? `Ready — /generate endpoint active (${device})`
    : (engineHealth?.reason || 'Cannot reach engine on port 8808.');
  return {
    id: 'engine',
    name: 'VoxCPM2 Engine',
    port: 8808,
    status: isOnline ? SERVICE_STATUS.ONLINE : SERVICE_STATUS.OFFLINE,
    details,
    instruction: 'Start the VoxCPM2 engine: run ./studio.sh start or python app.py.',
  };
}

function buildMediaService(mediaHealth) {
  return {
    id: 'media',
    name: 'Media Subtitle Service',
    port: 8810,
    status: mediaHealth?.online ? SERVICE_STATUS.ONLINE : SERVICE_STATUS.OFFLINE,
    details: mediaHealth?.online ? `PID ${mediaHealth.pid || 'active'}` : mediaHealth?.reason || 'Cannot reach media service on port 8810.',
    instruction: 'Start the media subtitle service: run ./studio.sh start or uvicorn server:app.',
  };
}

function buildStorageService(storageHealth) {
  return {
    id: 'storage',
    name: 'Storage & Audio Mastering API',
    port: 8090,
    status: storageHealth?.online ? SERVICE_STATUS.ONLINE : SERVICE_STATUS.OFFLINE,
    details: storageHealth?.online ? 'Docker volume storage active' : storageHealth?.reason || 'Cannot reach storage service on port 8090.',
    instruction: 'Start the storage API: run docker compose up -d storage or ./setup.sh.',
  };
}

function buildServicesList(engineHealth, mediaHealth, storageHealth) {
  return [
    buildEngineService(engineHealth),
    buildMediaService(mediaHealth),
    buildStorageService(storageHealth),
  ];
}

/**
 * Aggregates diagnostic checks from engine, media, and storage services into a cohesive report.
 * Inputs: raw responses from engine, media, storage health and stats.
 * Outputs: unified diagnostic report containing services, model catalog states, storage metrics, and actionable steps.
 * Side effects: none.
 * Failure modes: safely degrades to offline/uninstalled states without throwing.
 * @param {{ engineHealth?: object|null, mediaHealth?: object|null, storageHealth?: object|null, storageStats?: object|null }} params - Service health responses.
 * @returns {object} Aggregated diagnostic report.
 */
export function aggregateDiagnostics({ engineHealth = null, mediaHealth = null, storageHealth = null, storageStats = null, isOnline } = {}) {
  const models = [
    buildEngineModelRecord(engineHealth),
    ...buildMediaModelRecords(mediaHealth),
    buildStorageModelRecord(storageHealth),
  ];
  const services = buildServicesList(engineHealth, mediaHealth, storageHealth);
  const storage = buildStorageMetrics(storageStats);
  const overall = resolveOverallStatus({ services, models });
  const instructions = deriveActionableInstructions({ services, models, storage });
  const offlineReadiness = evaluateOfflineReadiness({ isOnline, models, services });

  return {
    overall,
    offlineReadiness,
    services,
    models,
    storage,
    instructions,
    timestamp: new Date().toISOString(),
  };
}
