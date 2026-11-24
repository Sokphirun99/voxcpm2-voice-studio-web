/**
 * @fileoverview Data adapter for persisting audio take binaries as durable assets and resolving stream URLs.
 */

const DEFAULT_AUDIO_MIME = 'audio/wav';
const DEFAULT_API_BASE = '/api/v1';

/**
 * Persists an audio take Blob to the durable asset store.
 * Inputs: `{ assetRepository, blob, segmentId, seed, projectId, logger }`.
 * Outputs: created asset ID (string UUID) or null.
 * Side effects: uploads asset via assetRepository.
 * Failure modes: returns null and logs warning on error without throwing.
 * @param {object} params - Take asset persistence parameters.
 * @returns {Promise<string|null>} Durable asset ID or null.
 */
export async function persistTakeAsset({ assetRepository, blob, segmentId, seed, projectId, logger }) {
  if (!assetRepository?.uploadAsset || !blob) return null;
  try {
    const fileName = `take-${segmentId || 'seg'}-${seed ?? Date.now()}.wav`;
    const result = await assetRepository.uploadAsset({
      bytes: blob,
      fileName,
      mimeType: DEFAULT_AUDIO_MIME,
      kind: 'audio',
      projectId: projectId || undefined,
    });
    return result?.asset?.id || null;
  } catch (error) {
    logger?.warn?.('persistTakeAsset failed to upload durable take asset', error);
    return null;
  }
}

/**
 * Safely creates an object URL for a candidate Blob, returning null on failure.
 * Inputs: candidate blob, optional logger.
 * Outputs: string URL or null.
 * Side effects: allocates object URL when successful.
 * Failure modes: returns null and logs debug info if createObjectURL throws.
 * @param {unknown} blob - Candidate audio blob.
 * @param {object|null} [logger=null] - Optional logger.
 * @returns {string|null} Object URL or null.
 */
function tryCreateBlobUrl(blob, logger = null) {
  if (!blob || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return null;
  }
  try {
    return URL.createObjectURL(blob);
  } catch (error) {
    logger?.debug?.('takeAssetStorage.tryCreateBlobUrl', error);
    return null;
  }
}

/**
 * Resolves a playable audio URL for a take from memory or durable asset storage.
 * Inputs: take entity, optional baseUrl, optional logger.
 * Outputs: string audio URL or null.
 * Side effects: none.
 * Failure modes: returns null for missing take or unresolvable audio.
 * @param {object} take - SegmentTake entity.
 * @param {string} [baseUrl='/api/v1'] - Storage API base URL.
 * @param {object|null} [logger=null] - Optional logger for debugging.
 * @returns {string|null} Audio URL or null.
 */
export function resolveTakeAudioUrl(take, baseUrl = DEFAULT_API_BASE, logger = null) {
  if (!take) return null;
  if (typeof take.audioUrl === 'string' && take.audioUrl) return take.audioUrl;
  const blobUrl = tryCreateBlobUrl(take.blob, logger);
  if (blobUrl) return blobUrl;
  if (take.audioAssetId) {
    return `${baseUrl}/assets/${encodeURIComponent(take.audioAssetId)}/binary`;
  }
  return null;
}
