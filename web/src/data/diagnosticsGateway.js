/**
 * @fileoverview Gateway adapter probing local Engine, Media Subtitle, and Storage services to aggregate diagnostics.
 */

import { aggregateDiagnostics } from '../domain/modelDiagnostics.js';

const STORAGE_HEALTH_ENDPOINT = '/api/v1/health';
const STORAGE_STATS_ENDPOINT = '/api/v1/stats';
const PROBE_TIMEOUT_MS = 3000;

function formatStorageProbeError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return 'Storage service did not respond within 3s on port 8090.';
  }
  return 'Cannot reach storage service on port 8090.';
}

/**
 * Probes the local storage service `/api/v1/health` endpoint with a bounded timeout.
 * @param {{ fetchImpl: typeof fetch, baseUrl?: string, logger?: object }} deps - HTTP dependencies.
 * @returns {Promise<{ online: boolean, ffmpegAvailable?: boolean, reason?: string|null }>} Storage health.
 */
async function probeStorageHealth({ fetchImpl, baseUrl = '', logger = null }) {
  try {
    const url = `${baseUrl}${STORAGE_HEALTH_ENDPOINT}`;
    const res = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return { online: false, reason: `Storage service returned HTTP ${res.status}.` };
    const envelope = await res.json();
    return { online: true, ffmpegAvailable: Boolean(envelope?.data?.ffmpegAvailable), reason: null };
  } catch (error) {
    logger?.debug?.('diagnosticsGateway.probeStorageHealth', 'Health check failed', { error: error?.message });
    return { online: false, reason: formatStorageProbeError(error) };
  }
}

/**
 * Probes the local storage service `/api/v1/stats` endpoint to retrieve disk and cache metrics.
 * @param {{ fetchImpl: typeof fetch, baseUrl?: string, logger?: object }} deps - HTTP dependencies.
 * @returns {Promise<object|null>} Storage stats data or null.
 */
async function probeStorageStats({ fetchImpl, baseUrl = '', logger = null }) {
  try {
    const url = `${baseUrl}${STORAGE_STATS_ENDPOINT}`;
    const res = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return null;
    const envelope = await res.json();
    return envelope?.data || null;
  } catch (error) {
    logger?.debug?.('diagnosticsGateway.probeStorageStats', 'Stats probe failed', { error: error?.message });
    return null;
  }
}

/**
 * Safely resolves an engine health probe from speech gateway or fallback.
 * @param {object} speechGateway - Injected speech gateway adapter.
 * @param {object|null} logger - Injected logger port.
 * @returns {Promise<object>} Engine health descriptor.
 */
async function resolveEngineHealth(speechGateway, logger) {
  try {
    if (typeof speechGateway?.checkHealth === 'function') {
      const health = await speechGateway.checkHealth();
      const isAvail = Boolean(health?.available);
      const device = health?.device || (isAvail ? 'Apple Silicon (MPS)' : 'Unavailable');
      return { available: isAvail, device, state: health?.state, reason: health?.reason || null };
    }
    if (typeof speechGateway?.checkAvailability === 'function') {
      const available = await speechGateway.checkAvailability();
      return { available, device: available ? 'Apple Silicon (MPS)' : 'Unavailable', reason: available ? null : 'Engine unavailable.' };
    }
    return { available: false, device: 'Unavailable', reason: 'Speech gateway is not configured.' };
  } catch (error) {
    logger?.debug?.('diagnosticsGateway.resolveEngineHealth', 'Engine probe error', { error: error?.message });
    return { available: false, device: 'Unavailable', reason: error?.message || 'Engine check failed.' };
  }
}

/**
 * Safely resolves a media subtitle service health probe.
 * @param {object} mediaSubtitleGateway - Injected media subtitle gateway adapter.
 * @param {object|null} logger - Injected logger port.
 * @returns {Promise<object>} Media health descriptor.
 */
async function resolveMediaHealth(mediaSubtitleGateway, logger) {
  try {
    if (typeof mediaSubtitleGateway?.checkHealth === 'function') {
      return await mediaSubtitleGateway.checkHealth();
    }
    return { online: false, reason: 'Media subtitle gateway is not configured.' };
  } catch (error) {
    logger?.debug?.('diagnosticsGateway.resolveMediaHealth', 'Media probe error', { error: error?.message });
    return { online: false, reason: error?.message || 'Media service check failed.' };
  }
}

function extractSettledResult(settled, fallback) {
  if (settled.status === 'fulfilled') return settled.value;
  return fallback(settled.reason);
}

async function collectServiceProbes({ speechGateway, mediaSubtitleGateway, fetchImpl, baseUrl, logger }) {
  const [engineRes, mediaRes, storageHealthRes, storageStatsRes] = await Promise.allSettled([
    resolveEngineHealth(speechGateway, logger),
    resolveMediaHealth(mediaSubtitleGateway, logger),
    probeStorageHealth({ fetchImpl, baseUrl, logger }),
    probeStorageStats({ fetchImpl, baseUrl, logger }),
  ]);
  const engineHealth = extractSettledResult(engineRes, err => ({ available: false, reason: err?.message }));
  const mediaHealth = extractSettledResult(mediaRes, err => ({ online: false, reason: err?.message }));
  const storageHealth = extractSettledResult(storageHealthRes, err => ({ online: false, reason: err?.message }));
  const storageStats = extractSettledResult(storageStatsRes, () => null);
  return { engineHealth, mediaHealth, storageHealth, storageStats };
}

/**
 * Creates the DiagnosticsGateway adapter aggregating health and model readiness across all local services.
 * Inputs: `{ speechGateway, mediaSubtitleGateway, fetchImpl, baseUrl, logger }`.
 * Outputs: `{ getAggregatedDiagnostics }`.
 * Side effects: executes concurrent HTTP probes against local services.
 * Failure modes: individual service probe failures degrade safely without throwing.
 * @param {{ speechGateway?: object, mediaSubtitleGateway?: object, fetchImpl?: typeof fetch, baseUrl?: string, logger?: object }} [deps] - Injected deps.
 * @returns {object} Diagnostics gateway port implementation.
 */
export function createDiagnosticsGateway({
  speechGateway = null,
  mediaSubtitleGateway = null,
  fetchImpl = globalThis.fetch,
  baseUrl = '',
  logger = null,
} = {}) {
  return {
    async getAggregatedDiagnostics() {
      const results = await collectServiceProbes({ speechGateway, mediaSubtitleGateway, fetchImpl, baseUrl, logger });
      logger?.debug?.('diagnosticsGateway.getAggregatedDiagnostics', 'Checks collected', {
        engine: results.engineHealth?.available,
        media: results.mediaHealth?.online,
        storage: results.storageHealth?.online,
      });
      return aggregateDiagnostics(results);
    },
  };
}
