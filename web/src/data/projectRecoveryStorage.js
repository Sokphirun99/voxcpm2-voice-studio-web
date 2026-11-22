/**
 * @fileoverview Data adapter for persisting last active project state and local uncommitted drafts in Web Storage.
 */

import { buildProjectDraft } from '../domain/projectRecovery.js';

export const LAST_ACTIVE_PROJECT_KEY = 'voxcpm_last_active_project';
export const PROJECT_DRAFT_KEY_PREFIX = 'voxcpm_project_draft_';

const fallbackMemoryStore = new Map();

/**
 * Creates an in-memory storage adapter conforming to Storage interface.
 * Inputs: store (Map|undefined).
 * Outputs: Storage adapter with getItem, setItem, removeItem, clear.
 * Side effects: none.
 * Failure modes: none.
 * @param {Map} [store] - Underlying Map instance.
 * @returns {Storage} Storage instance.
 */
export function createMemoryStorage(store = fallbackMemoryStore) {
  return {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, val) => store.set(key, String(val)),
    removeItem: key => store.delete(key),
    clear: () => store.clear(),
  };
}

/**
 * Clears the module-level in-memory fallback storage store.
 * Inputs: none.
 * Outputs: none.
 * Side effects: clears fallback memory map.
 * Failure modes: none.
 */
export function clearInMemoryRecoveryStorage() {
  fallbackMemoryStore.clear();
}

/**
 * Resolves available Web Storage or creates a resilient in-memory fallback.
 * Inputs: storageOption (Storage|undefined), logger (object|undefined).
 * Outputs: Storage interface with getItem, setItem, removeItem.
 * Side effects: logs warning when falling back to memory.
 * Failure modes: never throws.
 * @param {Storage} [storageOption] - Custom storage provider.
 * @param {object} [logger] - Optional logger.
 * @returns {Storage} Available storage instance.
 */
export function resolveStorage(storageOption, logger) {
  if (storageOption && typeof storageOption.getItem === 'function') return storageOption;
  try {
    if (typeof globalThis.localStorage !== 'undefined' && globalThis.localStorage) {
      const probeKey = '__probe_storage__';
      globalThis.localStorage.setItem(probeKey, '1');
      globalThis.localStorage.removeItem(probeKey);
      return globalThis.localStorage;
    }
  } catch (error) {
    logger?.warn?.('projectRecoveryStorage.localStorageUnavailable', { error: error?.message });
  }
  return createMemoryStorage();
}

/**
 * Persists the last active project identifier and workspace.
 * Inputs: `{ projectId, workspace, storage, logger }`.
 * Outputs: saved record or null.
 * Side effects: writes to storage.
 * Failure modes: logs on storage write failure; returns null.
 * @param {object} params - Input parameters.
 * @returns {object|null} Saved record.
 */
export function saveLastActiveProject({ projectId, workspace = 'tts', storage: storageOpt, logger } = {}) {
  const store = resolveStorage(storageOpt, logger);
  const record = {
    projectId: projectId || null,
    workspace: workspace === 'subtitles' || workspace === 'subtitle' ? 'subtitles' : 'tts',
    updatedAt: new Date().toISOString(),
  };
  try {
    store.setItem(LAST_ACTIVE_PROJECT_KEY, JSON.stringify(record));
    return record;
  } catch (error) {
    logger?.error?.('projectRecoveryStorage.saveLastActiveFailed', error, { record });
    return null;
  }
}

/**
 * Retrieves the last active project state.
 * Inputs: `{ storage, logger }`.
 * Outputs: active project record or null.
 * Side effects: none.
 * Failure modes: returns null on missing or corrupted data.
 * @param {object} [params] - Options.
 * @returns {{ projectId: string|null, workspace: string, updatedAt: string }|null} Active project record.
 */
export function getLastActiveProject({ storage: storageOpt, logger } = {}) {
  const store = resolveStorage(storageOpt, logger);
  try {
    const raw = store.getItem(LAST_ACTIVE_PROJECT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (error) {
    logger?.error?.('projectRecoveryStorage.getLastActiveFailed', error);
    return null;
  }
}

/**
 * Clears the stored last active project pointer.
 * Inputs: `{ storage, logger }`.
 * Outputs: boolean indicating success.
 * Side effects: removes key from storage.
 * Failure modes: returns false on error.
 * @param {object} [params] - Options.
 * @returns {boolean} True if removed.
 */
export function clearLastActiveProject({ storage: storageOpt, logger } = {}) {
  const store = resolveStorage(storageOpt, logger);
  try {
    store.removeItem(LAST_ACTIVE_PROJECT_KEY);
    return true;
  } catch (error) {
    logger?.error?.('projectRecoveryStorage.clearLastActiveFailed', error);
    return false;
  }
}

/**
 * Generates a consistent storage key for an uncommitted project draft.
 * Inputs: projectId (string|null), workspace (string).
 * Outputs: storage key string.
 * Side effects: none.
 * Failure modes: none.
 * @param {string|null} projectId - Project UUID or null.
 * @param {string} workspace - Workspace name.
 * @returns {string} Storage key.
 */
export function buildDraftStorageKey(projectId, workspace = 'tts') {
  const normWorkspace = workspace === 'subtitles' || workspace === 'subtitle' ? 'subtitles' : 'tts';
  const normId = projectId ? String(projectId).trim() : 'new';
  return `${PROJECT_DRAFT_KEY_PREFIX}${normWorkspace}_${normId}`;
}

/**
 * Saves an in-flight uncommitted draft snapshot to local storage.
 * Inputs: `{ draft, storage, logger }`.
 * Outputs: saved draft object or null.
 * Side effects: writes to storage.
 * Failure modes: logs error and returns null on failure.
 * @param {object} params - Draft save parameters.
 * @returns {object|null} Saved draft.
 */
export function saveProjectDraft({ draft, storage: storageOpt, logger } = {}) {
  if (!draft || typeof draft !== 'object') return null;
  const store = resolveStorage(storageOpt, logger);
  try {
    const validated = buildProjectDraft(draft);
    const key = buildDraftStorageKey(validated.projectId, validated.workspace);
    store.setItem(key, JSON.stringify(validated));
    return validated;
  } catch (error) {
    logger?.error?.('projectRecoveryStorage.saveDraftFailed', error, {
      projectId: draft?.projectId,
      workspace: draft?.workspace,
    });
    return null;
  }
}

/**
 * Retrieves a persisted uncommitted project draft.
 * Inputs: `{ projectId, workspace, storage, logger }`.
 * Outputs: draft object or null.
 * Side effects: none.
 * Failure modes: returns null on missing or corrupted data.
 * @param {object} params - Query parameters.
 * @returns {object|null} Project draft.
 */
export function getProjectDraft({ projectId = null, workspace = 'tts', storage: storageOpt, logger } = {}) {
  const store = resolveStorage(storageOpt, logger);
  const key = buildDraftStorageKey(projectId, workspace);
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (error) {
    logger?.error?.('projectRecoveryStorage.getDraftFailed', error, { key });
    return null;
  }
}

/**
 * Removes an uncommitted project draft after confirmed save or user discard.
 * Inputs: `{ projectId, workspace, storage, logger }`.
 * Outputs: boolean.
 * Side effects: removes draft from storage.
 * Failure modes: returns false on error.
 * @param {object} params - Query parameters.
 * @returns {boolean} True if removed.
 */
export function clearProjectDraft({ projectId = null, workspace = 'tts', storage: storageOpt, logger } = {}) {
  const store = resolveStorage(storageOpt, logger);
  const key = buildDraftStorageKey(projectId, workspace);
  try {
    store.removeItem(key);
    return true;
  } catch (error) {
    logger?.error?.('projectRecoveryStorage.clearDraftFailed', error, { key });
    return false;
  }
}
