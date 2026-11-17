/**
 * @fileoverview HTTP client adapter for server-side FFmpeg EBU R128 mastering with pure-JS fallback.
 */

import { ensureAudioWavBlob, trySmoothWavBlob } from '../domain/wavCodec.js';
import { buildStorageApiUrl } from './httpStorageClient.js';

const UNAVAILABLE_STATUSES = new Set([404, 502, 503]);

/**
 * Checks whether a caught error represents user cancellation (`AbortError`).
 * @param {unknown} error - Caught exception.
 * @returns {boolean} True if aborted.
 */
function isAbortError(error) {
  return error?.name === 'AbortError' || error?.name === 'SynthesisCancelledError';
}

/**
 * Uploads a WAV Blob to `POST /api/v1/audio/master` and falls back to local smoothing if unavailable.
 * @param {{ baseUrl: string, fetchImpl: typeof fetch, blob: Blob, signal?: AbortSignal, logger?: object }} params - Request options.
 * @returns {Promise<{ blob: Blob, mastered: boolean }>} Mastered or locally smoothed WAV Blob.
 */
async function requestMasteredAudio({ baseUrl, fetchImpl, blob, signal, logger }) {
  const form = new FormData();
  form.set('audio', new File([ensureAudioWavBlob(blob)], 'take.wav', { type: 'audio/wav' }));
  const url = buildStorageApiUrl(baseUrl, '/audio/master');
  try {
    const response = await fetchImpl(url, { method: 'POST', body: form, signal });
    if (response.ok) {
      return { blob: ensureAudioWavBlob(await response.blob()), mastered: true };
    }
    if (!UNAVAILABLE_STATUSES.has(response.status)) {
      logger?.warn?.('httpAudioMaster.masterWav', `Mastering skipped (${response.status})`);
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    logger?.debug?.('httpAudioMaster.masterWav', error?.message || 'Mastering service unreachable');
  }
  return { blob: await trySmoothWavBlob(blob), mastered: false };
}

/**
 * Creates the AudioMasterPort adapter backed by Docker FFmpeg and local PCM fallback.
 * Inputs: optional `{ baseUrl, fetchImpl, logger }`.
 * Outputs: `{ masterWav(blob, options) }`.
 * Side effects: posts WAV audio to `/api/v1/audio/master` or runs local PCM smoothing.
 * Failure modes: propagates abort cancellation; falls back gracefully on backend unavailability.
 * @param {{ baseUrl?: string, fetchImpl?: typeof fetch, logger?: object }} [deps] - Adapter dependencies.
 * @returns {{ masterWav: (blob: Blob, options?: { signal?: AbortSignal }) => Promise<{ blob: Blob, mastered: boolean }> }} Audio master port.
 */
export function createHttpAudioMaster({ baseUrl = '/api/v1', fetchImpl = globalThis.fetch, logger } = {}) {
  return {
    masterWav: (blob, { signal } = {}) => requestMasteredAudio({ baseUrl, fetchImpl, blob, signal, logger }),
  };
}
