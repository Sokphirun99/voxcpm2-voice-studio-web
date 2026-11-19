/**
 * @fileoverview HTTP synthesis cache adapter backed by Docker volume LRU storage.
 */

import { ensureAudioWavBlob } from '../domain/wavCodec.js';
import { StorageUnavailableError, buildStorageApiUrl, requestStorageJson } from './httpStorageClient.js';

const CACHE_VERSION = 1;

const SHA256_INIT = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * Circular right rotation on a 32-bit unsigned integer.
 * @param {number} value - 32-bit word.
 * @param {number} bits - Shift count.
 * @returns {number} Rotated 32-bit word.
 */
function rotr(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

/**
 * Applies FIPS 180-4 SHA-256 bit padding cleanly into 64-byte big-endian blocks.
 * @param {Uint8Array} src - Raw message bytes.
 * @returns {Uint8Array} Padded multiple-of-64 byte array.
 */
function padSha256Bytes(src) {
  const bitLen = src.length * 8;
  const paddedLen = Math.ceil((src.length + 9) / 64) * 64;
  const out = new Uint8Array(paddedLen);
  out.set(src);
  out[src.length] = 0x80;
  const view = new DataView(out.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);
  return out;
}

/**
 * Expands one 64-byte block into the 64-word SHA-256 message schedule.
 * @param {DataView} view - Padded message view.
 * @param {number} blockOffset - Byte offset of the 64-byte block.
 * @returns {Uint32Array} 64-word message schedule.
 */
function buildMessageSchedule(view, blockOffset) {
  const w = new Uint32Array(64);
  for (let i = 0; i < 16; i++) w[i] = view.getUint32(blockOffset + i * 4, false);
  for (let i = 16; i < 64; i++) {
    const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
    const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
  }
  return w;
}

/**
 * Executes 64 SHA-256 compression rounds on the active 8-word state vector.
 * @param {Uint32Array} hash - Mutable 8-word SHA-256 state.
 * @param {Uint32Array} w - 64-word message schedule.
 */
function compressSha256Block(hash, w) {
  let [a, b, c, d, e, f, g, h] = hash;
  for (let i = 0; i < 64; i++) {
    const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = (e & f) ^ (~e & g);
    const temp1 = (h + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
    const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const temp2 = (s0 + maj) >>> 0;
    h = g; g = f; f = e; e = (d + temp1) >>> 0;
    d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
  }
  const next = [a, b, c, d, e, f, g, h];
  for (let i = 0; i < 8; i++) hash[i] = (hash[i] + next[i]) >>> 0;
}

/**
 * Pure-JS SHA-256 hex digest fallback for non-HTTPS LAN origins where `crypto.subtle` is absent.
 * @param {Uint8Array} bytes - Binary bytes to digest.
 * @returns {string} 64-character lowercase hex digest.
 */
export function pureSha256Hex(bytes) {
  const padded = padSha256Bytes(bytes);
  const view = new DataView(padded.buffer);
  const hash = new Uint32Array(SHA256_INIT);
  for (let offset = 0; offset < padded.length; offset += 64) {
    compressSha256Block(hash, buildMessageSchedule(view, offset));
  }
  return Array.from(hash, word => word.toString(16).padStart(8, '0')).join('');
}

/**
 * Computes lowercase SHA-256 hex digest using Web Crypto when available, or `pureSha256Hex` over LAN HTTP.
 * @param {ArrayBuffer|Uint8Array|string} input - Data to digest.
 * @returns {Promise<string>} 64-character lowercase hex digest.
 */
async function sha256Hex(input) {
  const bytes = typeof input === 'string'
    ? new TextEncoder().encode(input)
    : (input instanceof Uint8Array ? input : new Uint8Array(input));
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return pureSha256Hex(bytes);
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
