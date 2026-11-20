/**
 * @fileoverview HTTP repository for the pronunciation dictionary with a localStorage mirror for offline use.
 */

import { normalizeGlossaryRules } from '../domain/pronunciationRules.js';
import {
  StorageUnavailableError,
  buildStorageApiUrl,
  requestStorageJson,
} from './httpStorageClient.js';

const GLOSSARY_STORAGE_KEY = 'voxcpm.glossary.v1';
const GLOSSARY_PATH = '/glossary';
const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json' });

/**
 * Resolves the Web Storage used as the offline mirror.
 * @param {Storage|null|undefined} storage - Injected storage or `undefined` to use `localStorage`.
 * @param {object} [logger] - Application logger.
 * @returns {Storage|null} Usable storage or null.
 */
function resolveStorage(storage, logger) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch (error) {
    logger?.error?.('httpGlossaryRepository.resolveStorage', error, { fallback: 'memory' });
    return null;
  }
}

/**
 * Reads the offline mirror `{ rules, pending }`, returning an empty mirror when absent or corrupt.
 * @param {Storage|null} storage - Web Storage.
 * @param {object} [logger] - Application logger.
 * @returns {{ rules: Array<object>, pending: boolean }} Mirror state.
 */
function readMirror(storage, logger) {
  const empty = { rules: [], pending: false };
  if (!storage) return empty;
  try {
    const raw = storage.getItem(GLOSSARY_STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    return { rules: normalizeGlossaryRules(parsed?.rules), pending: Boolean(parsed?.pending) };
  } catch (error) {
    logger?.error?.('httpGlossaryRepository.readMirror', error, { fallback: 'empty' });
    return empty;
  }
}

/**
 * Persists the offline mirror; `pending` marks edits the server has not accepted yet.
 * @param {Storage|null} storage - Web Storage.
 * @param {{ rules: Array<object>, pending: boolean }} mirror - Mirror state.
 * @param {object} [logger] - Application logger.
 */
function writeMirror(storage, mirror, logger) {
  if (!storage) return;
  try {
    storage.setItem(GLOSSARY_STORAGE_KEY, JSON.stringify(mirror));
  } catch (error) {
    logger?.error?.('httpGlossaryRepository.writeMirror', error);
  }
}

/**
 * Creates the pronunciation glossary repository backed by `/api/v1/glossary`.
 * Inputs: `{ baseUrl, fetchImpl, storage, logger }`.
 * Outputs: `{ loadRules(), saveRules(rules) }`.
 * Side effects: HTTP GET/PUT and a localStorage mirror; edits made while the server is unreachable are
 * flagged pending and pushed on the next successful load.
 * Failure modes: `loadRules` never rejects (falls back to the mirror and logs); `saveRules` throws
 * ValidationError for invalid rules and StorageError for server rejections.
 * @param {{ baseUrl?: string, fetchImpl?: typeof fetch, storage?: Storage|null, logger?: object }} [deps] - Repository deps.
 * @returns {import('../domain/ports.js').GlossaryRepositoryPort} Glossary repository.
 */
export function createHttpGlossaryRepository({ baseUrl = '/api/v1', fetchImpl = globalThis.fetch, storage: storageOption, logger } = {}) {
  const storage = resolveStorage(storageOption, logger);
  const url = buildStorageApiUrl(baseUrl, GLOSSARY_PATH);

  async function putRules(rules) {
    const options = { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ rules }) };
    const { data } = await requestStorageJson({ fetchImpl, url, options });
    return normalizeGlossaryRules(data?.rules ?? rules);
  }

  async function saveRules(rawRules) {
    const rules = normalizeGlossaryRules(rawRules);
    try {
      const saved = await putRules(rules);
      writeMirror(storage, { rules: saved, pending: false }, logger);
      return { rules: saved, localOnly: false };
    } catch (error) {
      if (!(error instanceof StorageUnavailableError)) {
        logger?.error?.('httpGlossaryRepository.saveRules', error);
        throw error;
      }
      logger?.warn?.('httpGlossaryRepository.saveRules', error.message, { fallback: 'localStorage' });
      writeMirror(storage, { rules, pending: true }, logger);
      return { rules, localOnly: true };
    }
  }

  async function loadRules() {
    const mirror = readMirror(storage, logger);
    try {
      if (mirror.pending) return (await saveRules(mirror.rules)).rules;
      const { data } = await requestStorageJson({ fetchImpl, url });
      const rules = normalizeGlossaryRules(data?.rules ?? []);
      writeMirror(storage, { rules, pending: false }, logger);
      return rules;
    } catch (error) {
      logger?.error?.('httpGlossaryRepository.loadRules', error, { fallback: 'localStorage' });
      return mirror.rules;
    }
  }

  return { loadRules, saveRules };
}
