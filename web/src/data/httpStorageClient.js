/**
 * @fileoverview Shared HTTP client helpers for the Docker voice-studio backend storage API.
 */

import { StorageError } from '../domain/errors.js';

/**
 * Error indicating the Docker storage service itself could not be reached (e.g. offline or non-Docker dev).
 */
export class StorageUnavailableError extends StorageError {
  /**
   * @param {string} message - Human-readable error message.
   * @param {unknown} [cause] - Underlying fetch or HTTP error.
   */
  constructor(message, cause) {
    super(message, cause);
    this.name = 'StorageUnavailableError';
    this.code = 'STORAGE_UNAVAILABLE';
  }
}

/**
 * Builds an absolute/relative API URL under `baseUrl`.
 * @param {string} baseUrl - Base `/api/v1` prefix.
 * @param {string} routePath - Route suffix starting with `/`.
 * @returns {string} Combined endpoint URL.
 */
export function buildStorageApiUrl(baseUrl, routePath) {
  const trimmedBase = String(baseUrl || '/api/v1').replace(/\/+$/, '');
  const normalizedPath = routePath.startsWith('/') ? routePath : `/${routePath}`;
  return `${trimmedBase}${normalizedPath}`;
}

/**
 * Parses a `/api/v1/*` JSON envelope `{ data, error, meta }` and translates failure statuses cleanly.
 * Inputs: `{ fetchImpl, url, options, unavailableOn404 }`.
 * Outputs: parsed `envelope.data` and `envelope.meta`.
 * Side effects: performs HTTP fetch request.
 * Failure modes: throws `StorageUnavailableError` when unreachable or `StorageError` on HTTP/API failure.
 * @param {{ fetchImpl?: typeof fetch, url: string, options?: RequestInit, unavailableOn404?: boolean }} params - Request params.
 * @returns {Promise<{ data: any, meta: object, status: number }>} Parsed response payload and metadata.
 */
export async function requestStorageJson({ fetchImpl = globalThis.fetch, url, options = {}, unavailableOn404 = false }) {
  let response;
  try {
    response = await fetchImpl(url, options);
  } catch (error) {
    throw new StorageUnavailableError('Backend voice storage is unreachable.', error);
  }
  const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
  const isUnavailableStatus = response.status === 502 || response.status === 503 || (unavailableOn404 && response.status === 404);
  if (isUnavailableStatus || (response.ok && !contentType.includes('application/json'))) {
    throw new StorageUnavailableError(`Backend voice storage is unavailable (${response.status}).`);
  }
  const envelope = await response.json().catch(parseErr => {
    throw new StorageError('Invalid response received from backend voice storage.', parseErr);
  });
  if (!response.ok || envelope?.error) {
    const error = new StorageError(envelope?.error?.message || `Voice storage request failed (${response.status}).`);
    error.code = envelope?.error?.code || error.code;
    error.status = response.status;
    throw error;
  }
  return { data: envelope?.data ?? null, meta: envelope?.meta ?? {}, status: response.status };
}
