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
 * Resolves a playable audio URL for a take from memory or durable asset storage.
 * Inputs: take entity, optional baseUrl.
 * Outputs: string audio URL or null.
 * Side effects: none.
 * Failure modes: returns null for missing take or unresolvable audio.
 * @param {object} take - SegmentTake entity.
 * @param {string} [baseUrl='/api/v1'] - Storage API base URL.
 * @returns {string|null} Audio URL or null.
 */
export function resolveTakeAudioUrl(take, baseUrl = DEFAULT_API_BASE) {
  if (!take) return null;
  if (typeof take.audioUrl === 'string' && take.audioUrl) return take.audioUrl;
  if (take.blob && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    return URL.createObjectURL(take.blob);
  }
  if (take.audioAssetId) {
    return `${baseUrl}/assets/${encodeURIComponent(take.audioAssetId)}/binary`;
  }
  return null;
}
