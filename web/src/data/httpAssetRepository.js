/**
 * @fileoverview HTTP client adapter for binary media assets and metadata.
 */

import { buildStorageApiUrl, requestStorageJson } from './httpStorageClient.js';

function buildAssetFormData({ bytes, fileName, kind, mimeType, projectId }) {
  const form = new FormData();
  const fileBlob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mimeType || 'application/octet-stream' });
  form.set('file', fileBlob, fileName || 'asset.bin');
  if (kind) form.set('kind', kind);
  if (projectId) form.set('projectId', projectId);
  if (fileName) form.set('fileName', fileName);
  return form;
}

function buildAssetListUrl(baseUrl, query = {}) {
  const params = new URLSearchParams();
  if (query.limit) params.set('limit', String(query.limit));
  if (query.offset) params.set('offset', String(query.offset));
  if (query.kind) params.set('kind', String(query.kind));
  if (query.projectId) params.set('projectId', String(query.projectId));
  const queryPart = params.toString() ? `?${params.toString()}` : '';
  const basePath = query.projectId ? `/projects/${encodeURIComponent(query.projectId)}/assets` : '/assets';
  return buildStorageApiUrl(baseUrl, `${basePath}${queryPart}`);
}

async function uploadAssetItem({ baseUrl, fetchImpl }, spec) {
  const form = buildAssetFormData(spec);
  const basePath = spec.projectId ? `/projects/${encodeURIComponent(spec.projectId)}/assets` : '/assets';
  const url = buildStorageApiUrl(baseUrl, basePath);
  const { data } = await requestStorageJson({ fetchImpl, url, options: { method: 'POST', body: form } });
  return { asset: data.asset };
}

async function getAssetMetaItem({ baseUrl, fetchImpl, logger }, id) {
  const url = buildStorageApiUrl(baseUrl, `/assets/${encodeURIComponent(id)}`);
  try {
    const { data } = await requestStorageJson({ fetchImpl, url });
    return data?.asset ?? null;
  } catch (error) {
    if (error?.status === 404 || error?.code === 'ASSET_NOT_FOUND') return null;
    logger?.error?.('httpAssetRepository.getAssetMeta', error, { id });
    throw error;
  }
}

function extractAssetMetaFromHeaders(response, bytesLength) {
  const etag = response.headers.get('etag')?.replace(/^"|"$/g, '') || '';
  const disposition = response.headers.get('content-disposition') || '';
  const fileNameMatch = /filename="?([^";]+)"?/.exec(disposition);
  const fileName = fileNameMatch ? fileNameMatch[1] : '';
  const mimeType = response.headers.get('content-type') || 'application/octet-stream';
  return { fileName, sha256: etag, sizeBytes: bytesLength, mimeType };
}

async function getAssetBinaryItem({ baseUrl, fetchImpl }, id) {
  const url = buildStorageApiUrl(baseUrl, `/assets/${encodeURIComponent(id)}/binary`);
  const response = await fetchImpl(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Failed to fetch asset binary: ${response.status}`);
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const meta = extractAssetMetaFromHeaders(response, bytes.byteLength);
  return { bytes, mimeType: meta.mimeType, meta };
}

async function deleteAssetItem({ baseUrl, fetchImpl }, id, options = {}) {
  const query = options.hard ? '?hard=true' : '';
  const url = buildStorageApiUrl(baseUrl, `/assets/${encodeURIComponent(id)}${query}`);
  const { data } = await requestStorageJson({ fetchImpl, url, options: { method: 'DELETE' } });
  return data;
}

async function listAssetsItems({ baseUrl, fetchImpl }, query = {}) {
  const url = buildAssetListUrl(baseUrl, query);
  const { data, meta } = await requestStorageJson({ fetchImpl, url });
  return { items: data?.items || [], total: meta?.total ?? 0, limit: meta?.limit ?? 50, offset: meta?.offset ?? 0, hasMore: Boolean(meta?.hasMore) };
}

/**
 * Creates an HTTP repository adapter for binary media assets.
 * Inputs: `{ baseUrl, fetchImpl, logger }`.
 * Outputs: Asset repository interface exposing uploadAsset, getAssetMeta, getAssetBinary, deleteAsset, and listAssets.
 * Side effects: executes HTTP fetch requests against `/api/v1/assets`.
 * Failure modes: throws on network failure, 4xx/5xx responses; surfaces 404 as null.
 * @param {{ baseUrl?: string, fetchImpl?: typeof fetch, logger?: object }} [deps] - Adapter dependencies.
 * @returns {object} Asset repository adapter.
 */
export function createHttpAssetRepository({
  baseUrl = '/api/v1',
  fetchImpl = globalThis.fetch,
  logger,
} = {}) {
  const ctx = { baseUrl, fetchImpl, logger };
  return {
    uploadAsset: spec => uploadAssetItem(ctx, spec),
    getAssetMeta: id => getAssetMetaItem(ctx, id),
    getAssetBinary: id => getAssetBinaryItem(ctx, id),
    deleteAsset: (id, options) => deleteAssetItem(ctx, id, options),
    listAssets: query => listAssetsItems(ctx, query),
  };
}
