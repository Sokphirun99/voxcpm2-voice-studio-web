/**
 * @fileoverview HTTP repository for the reusable terminology library with a localStorage mirror for offline use.
 */

import { normalizeTerminologyList } from '../domain/terminology.js';
import {
  StorageUnavailableError,
  buildStorageApiUrl,
  requestStorageJson,
} from './httpStorageClient.js';

const TERMINOLOGY_STORAGE_KEY = 'voxcpm.terminology.v1';
const TERMINOLOGY_PATH = '/terminology';
const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json' });

/**
 * Resolves the Web Storage backend used as the offline mirror.
 * @param {Storage|null|undefined} storage - Injected storage or `undefined` to use `localStorage`.
 * @param {object} [logger] - Application logger.
 * @returns {Storage|null} Usable storage or null.
 */
function resolveStorage(storage, logger) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch (error) {
    logger?.error?.('httpTerminologyRepository.resolveStorage', error, { fallback: 'memory' });
    return null;
  }
}

/**
 * Reads the offline mirror `{ terms, pending }`, returning an empty mirror when absent or corrupt.
 * @param {Storage|null} storage - Web Storage instance.
 * @param {object} [logger] - Application logger.
 * @returns {{ terms: readonly object[], pending: boolean }} Offline mirror state.
 */
function readMirror(storage, logger) {
  const empty = { terms: [], pending: false };
  if (!storage) return empty;
  try {
    const raw = storage.getItem(TERMINOLOGY_STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    return { terms: normalizeTerminologyList(parsed?.terms), pending: Boolean(parsed?.pending) };
  } catch (error) {
    logger?.error?.('httpTerminologyRepository.readMirror', error, { fallback: 'empty' });
    return empty;
  }
}

/**
 * Persists the offline mirror; `pending` marks edits the storage service has not confirmed yet.
 * @param {Storage|null} storage - Web Storage instance.
 * @param {{ terms: readonly object[], pending: boolean }} mirror - Mirror snapshot.
 * @param {object} [logger] - Application logger.
 */
function writeMirror(storage, mirror, logger) {
  if (!storage) return;
  try {
    storage.setItem(TERMINOLOGY_STORAGE_KEY, JSON.stringify(mirror));
  } catch (error) {
    logger?.error?.('httpTerminologyRepository.writeMirror', error);
  }
}

/**
 * Creates the terminology repository backed by `/api/v1/terminology` and localStorage offline fallback.
 * Inputs: `{ baseUrl, fetchImpl, storage, logger }`.
 * Outputs: `{ loadTerms(), saveTerms(terms) }`.
 * Side effects: performs HTTP GET/PUT and mirrors terms into `localStorage`; edits made offline are
 * flagged pending and flushed on the next successful load.
 * Failure modes: `loadTerms` falls back safely to the mirror and logs errors; `saveTerms` throws
 * ValidationError for invalid entries and StorageError for non-network server rejections.
 * @param {{ baseUrl?: string, fetchImpl?: typeof fetch, storage?: Storage|null, logger?: object }} [deps] - Adapter dependencies.
 * @returns {import('../domain/ports.js').TerminologyRepositoryPort} Terminology repository.
 */
export function createHttpTerminologyRepository({ baseUrl = '/api/v1', fetchImpl = globalThis.fetch, storage: storageOption, logger } = {}) {
  const storage = resolveStorage(storageOption, logger);
  const url = buildStorageApiUrl(baseUrl, TERMINOLOGY_PATH);

  async function putTerms(terms) {
    const options = { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ terms }) };
    const { data } = await requestStorageJson({ fetchImpl, url, options });
    return normalizeTerminologyList(data?.terms ?? terms);
  }

  async function saveTerms(rawTerms) {
    const terms = normalizeTerminologyList(rawTerms);
    try {
      const saved = await putTerms(terms);
      writeMirror(storage, { terms: saved, pending: false }, logger);
      return { terms: saved, localOnly: false };
    } catch (error) {
      if (!(error instanceof StorageUnavailableError)) {
        logger?.error?.('httpTerminologyRepository.saveTerms', error);
        throw error;
      }
      logger?.warn?.('httpTerminologyRepository.saveTerms', error.message, { fallback: 'localStorage' });
      writeMirror(storage, { terms, pending: true }, logger);
      return { terms, localOnly: true };
    }
  }

  async function loadTerms() {
    const mirror = readMirror(storage, logger);
    try {
      if (mirror.pending) return (await saveTerms(mirror.terms)).terms;
      const { data } = await requestStorageJson({ fetchImpl, url });
      const terms = normalizeTerminologyList(data?.terms ?? []);
      writeMirror(storage, { terms, pending: false }, logger);
      return terms;
    } catch (error) {
      logger?.error?.('httpTerminologyRepository.loadTerms', error, { fallback: 'localStorage' });
      return mirror.terms;
    }
  }

  return { loadTerms, saveTerms };
}
