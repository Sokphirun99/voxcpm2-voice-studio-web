/**
 * @fileoverview HTTP synthesis cache adapter backed by Docker volume LRU storage.
 */

import { ensureAudioWavBlob } from '../domain/wavCodec.js';
import { StorageUnavailableError, buildStorageApiUrl, requestStorageJson } from './httpStorageClient.js';

const CACHE_VERSION = 1;

/**
 * Computes lowercase SHA-256 hex digest for a binary buffer or UTF-8 string.
 * @param {ArrayBuffer|Uint8Array|string} input - Data to digest.
 * @returns {Promise<string>} 64-character lowercase hex digest.
 */
async function sha256Hex(input) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto SubtleCrypto is required for cache hashing.');
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Resolves a content digest identifying the voice anchor audio (if any).
 * @param {object|null|undefined} anchor - Active character anchor record.
 * @returns {Promise<string>} SHA-256 hex digest or `'none'`.
 */
async function resolveAnchorDigest(anchor) {
  if (!anchor) return 'none';
  if (typeof anchor.sha256 === 'string' && anchor.sha256.length === 64) return anchor.sha256;
  if (anchor.blob && typeof anchor.blob.arrayBuffer === 'function') {
    return sha256Hex(await anchor.blob.arrayBuffer());
  }
  return 'none';
}

/**
 * Computes a deterministic 64-char SHA-256 cache key over every parameter that influences synthesis output.
 * @param {object} spec - Normalized synthesis input descriptor.
 * @returns {Promise<string>} Cache key hex string.
 */
async function computeSynthesisCacheKey(spec) {
  const anchorSha256 = await resolveAnchorDigest(spec.anchor);
  const canonical = JSON.stringify({
    v: CACHE_VERSION,
    text: spec.text,
    characterId: spec.characterId,
    instruction: spec.instruction || '',
    anchorSha256,
    usePromptText: Boolean(spec.usePromptText),
    promptText: spec.usePromptText ? (spec.promptText || '') : '',
    denoiseReference: Boolean(spec.denoiseReference),
    guidance: Number(spec.guidance),
    steps: Number(spec.steps),
    seed: Number(spec.seed),
    masterAudio: Boolean(spec.masterAudio),
  });
  return sha256Hex(canonical);
}

/**
 * Fetches cached WAV audio for a cache key or returns null on miss/unavailability.
 * @param {{ baseUrl: string, fetchImpl: typeof fetch, key: string, signal?: AbortSignal, logger?: object }} spec - Lookup options.
 * @returns {Promise<{ blob: Blob, seed: number|null }|null>} Cached audio entry or null.
 */
async function fetchCachedEntry({ baseUrl, fetchImpl, key, signal, logger }) {
  try {
    const metaUrl = buildStorageApiUrl(baseUrl, `/cache/${encodeURIComponent(key)}`);
    const { data } = await requestStorageJson({ fetchImpl, url: metaUrl, options: { signal }, unavailableOn404: true });
    if (!data?.hit || !data?.entry) return null;
    const audioUrl = data.entry.audioUrl || buildStorageApiUrl(baseUrl, `/cache/${encodeURIComponent(key)}/audio`);
    const audioRes = await fetchImpl(audioUrl, { signal });
    if (!audioRes.ok) return null;
    return { blob: ensureAudioWavBlob(await audioRes.blob()), seed: data.entry.seed ?? null };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    if (!(error instanceof StorageUnavailableError)) logger?.debug?.('httpSynthesisCache.get', error?.message || 'Cache miss');
    return null;
  }
}

/**
 * Uploads a finished synthesis WAV clip into the Docker LRU cache without failing synthesis on IO errors.
 * @param {{ baseUrl: string, fetchImpl: typeof fetch, key: string, blob: Blob, meta: object, logger?: object }} spec - Upload options.
 * @returns {Promise<void>} Resolves once upload completes or is safely skipped.
 */
async function storeCachedEntry({ baseUrl, fetchImpl, key, blob, meta, logger }) {
  try {
    const form = new FormData();
    form.set('metadata', JSON.stringify(meta || {}));
    form.set('audio', new File([ensureAudioWavBlob(blob)], `${key}.wav`, { type: 'audio/wav' }));
    const url = buildStorageApiUrl(baseUrl, `/cache/${encodeURIComponent(key)}`);
    await requestStorageJson({ fetchImpl, url, options: { method: 'PUT', body: form } });
  } catch (error) {
    logger?.debug?.('httpSynthesisCache.put', error?.message || 'Cache write skipped');
  }
}

/**
 * Creates a SynthesisCachePort backed by Docker volume LRU cache endpoints.
 * Inputs: optional `{ baseUrl, fetchImpl, logger }`.
 * Outputs: `{ computeKey, getCachedAudio, putCachedAudio }`.
 * Side effects: hashes synthesis parameters and stores/fetches WAV files via `/api/v1/cache/*`.
 * Failure modes: degrades cleanly to cache miss when storage service is unreachable.
 * @param {{ baseUrl?: string, fetchImpl?: typeof fetch, logger?: object }} [deps] - Cache adapter deps.
 * @returns {object} Synthesis cache port.
 */
export function createHttpSynthesisCache({ baseUrl = '/api/v1', fetchImpl = globalThis.fetch, logger } = {}) {
  return {
    computeKey: computeSynthesisCacheKey,
    getCachedAudio: (key, { signal } = {}) => fetchCachedEntry({ baseUrl, fetchImpl, key, signal, logger }),
    putCachedAudio: (key, blob, meta = {}) => storeCachedEntry({ baseUrl, fetchImpl, key, blob, meta, logger }),
  };
}
