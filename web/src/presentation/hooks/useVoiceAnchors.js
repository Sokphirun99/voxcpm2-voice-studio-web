/**
 * @fileoverview Presentation hook managing persistent per-character voice audio anchors via IndexedDB.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStudioServices } from '../StudioContext.jsx';

/**
 * Merges asynchronously loaded anchors with any local character mutations applied before load finished.
 * @param {Record<string, object>|null|undefined} loaded - Anchors fetched from storage.
 * @param {Record<string, number>} revisions - Per-character mutation counters.
 * @param {Record<string, object>} currentAnchors - Latest in-memory anchor state.
 * @returns {Record<string, object>} Merged anchor map.
 */
export function mergeLoadedAnchors(loaded, revisions, currentAnchors) {
  const merged = { ...(loaded || {}) };
  for (const id of Object.keys(revisions)) {
    if (currentAnchors[id]) merged[id] = currentAnchors[id];
    else delete merged[id];
  }
  return merged;
}

/**
 * Applies partial transcript or exact-clone fields onto an in-memory anchor record.
 * @param {object} anchor - Existing anchor record.
 * @param {object} patch - Patch fields.
 * @returns {object} Optimistically patched anchor record.
 */
function mergeAnchorPatch(anchor, patch) {
  return {
    ...anchor,
    ...(patch?.promptText !== undefined ? { promptText: String(patch.promptText) } : {}),
    ...(patch?.exactClone !== undefined ? { exactClone: Boolean(patch.exactClone) } : {}),
  };
}

/**
 * Creates a deferred promise handle for coalesced update callers.
 * @returns {{ promise: Promise<object|null>, resolve: Function, reject: Function }} Deferred handle.
 */
function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * Looks up or creates the per-character serialization queue record.
 * @param {Map<string, object>} queues - Per-character queue map.
 * @param {string} characterId - Character identifier.
 * @returns {object} Queue state record.
 */
function getOrCreateQueue(queues, characterId) {
  if (!queues.has(characterId)) {
    queues.set(characterId, {
      activeCount: 0, tail: Promise.resolve(), pendingPatch: null, pendingDeferred: null, hasSnapshot: false, persistedSnapshot: null,
    });
  }
  return queues.get(characterId);
}

/**
 * Cancels any unstarted coalesced update batch before a superseding pin or unpin operation.
 * @param {object|undefined} queue - Character queue record.
 */
function cancelPendingPatch(queue) {
  if (!queue?.pendingDeferred) return;
  const deferred = queue.pendingDeferred;
  queue.pendingPatch = null;
  queue.pendingDeferred = null;
  deferred.resolve(null);
}

/**
 * Applies an optimistic patch to in-memory state and captures the pre-edit snapshot for rollback.
 * @param {object} store - Voice anchor store internals.
 * @param {object} queue - Character queue record.
 * @param {string} characterId - Character identifier.
 * @param {object} patch - Patch fields.
 */
function applyOptimisticUpdate(store, queue, characterId, patch) {
  const current = store.state.anchors[characterId];
  store.bumpRevision(characterId);
  if (!current) return;
  if (!queue.hasSnapshot) {
    queue.persistedSnapshot = current;
    queue.hasSnapshot = true;
  }
  store.setAnchor(characterId, mergeAnchorPatch(current, patch));
}

/**
 * Normalizes a character identifier string for anchor store indexing.
 * @param {unknown} characterId - Raw character ID.
 * @returns {string} Trimmed character ID or empty string.
 */
function normalizeId(characterId) {
  return typeof characterId === 'string' ? characterId.trim() : '';
}

/**
 * Clears the persisted rollback snapshot once an anchor queue settles or unpins.
 * @param {object|undefined} queue - Character queue record.
 */
function clearSnapshot(queue) {
  if (!queue) return;
  queue.hasSnapshot = false;
  queue.persistedSnapshot = null;
}

/**
 * Reverts unpersisted optimistic anchor state back to the last persisted snapshot.
 * @param {object} store - Voice anchor store internals.
 * @param {string} characterId - Character identifier.
 * @param {object|undefined} queue - Character queue record.
 */
function rollbackSnapshot(store, characterId, queue) {
  if (queue?.pendingPatch || !queue?.hasSnapshot) return;
  store.bumpRevision(characterId);
  store.setAnchor(characterId, queue.persistedSnapshot);
}

/**
 * Executes one persisted anchor update batch with frozen dispatch revision and rollback on failure.
 * @param {object} store - Voice anchor store internals.
 * @param {string} characterId - Character identifier.
 * @param {{ queue: object, patch: object, dispatchRev: number }} spec - Frozen update batch spec.
 * @returns {Promise<object|null>} Saved anchor or null when missing.
 */
async function executeUpdateBatch(store, characterId, { queue, patch, dispatchRev }) {
  try {
    const updated = await store.voiceAnchors.updateAnchor(characterId, patch);
    queue.persistedSnapshot = updated || null;
    queue.hasSnapshot = true;
    if (store.getRevision(characterId) === dispatchRev) store.setAnchor(characterId, updated || null);
    return updated;
  } catch (error) {
    if (store.getRevision(characterId) === dispatchRev) rollbackSnapshot(store, characterId, queue);
    throw error;
  }
}

/**
 * Starts the next coalesced update batch or cleans up an idle character queue.
 * @param {object} store - Voice anchor store internals.
 * @param {string} characterId - Character identifier.
 * @param {object} queue - Character queue record.
 */
function drainCharacterQueue(store, characterId, queue) {
  if (!queue.pendingPatch) {
    clearSnapshot(queue);
    if (store.queues.get(characterId) === queue) store.queues.delete(characterId);
    return;
  }
  const { pendingPatch, pendingDeferred } = queue;
  const dispatchRev = store.getRevision(characterId);
  queue.pendingPatch = null;
  queue.pendingDeferred = null;
  const nextRun = enqueueCharacterTask(
    store, characterId, () => executeUpdateBatch(store, characterId, { queue, patch: pendingPatch, dispatchRev })
  );
  nextRun.then(pendingDeferred.resolve, pendingDeferred.reject);
}

/**
 * Enqueues an async task on a character's sequential promise chain without microtask drain gaps.
 * @param {object} store - Voice anchor store internals.
 * @param {string} characterId - Character identifier.
 * @param {() => Promise<unknown>} task - Async anchor operation.
 * @returns {Promise<unknown>} Task result promise.
 */
function enqueueCharacterTask(store, characterId, task) {
  const queue = getOrCreateQueue(store.queues, characterId);
  queue.activeCount += 1;
  const run = queue.tail.then(task, task);
  const finish = () => {
    queue.activeCount -= 1;
    if (queue.activeCount === 0) drainCharacterQueue(store, characterId, queue);
  };
  queue.tail = run.then(finish, finish);
  return run;
}

/**
 * Loads all persisted anchors once and merges them with any concurrent local mutations.
 * @param {object} store - Voice anchor store internals.
 * @returns {Promise<void>} Completion promise.
 */
async function loadStoreAnchors(store) {
  try {
    const loaded = await store.voiceAnchors.loadAll();
    if (!store.active) return;
    store.state.anchorWarning = null;
    store.state.anchors = mergeLoadedAnchors(loaded, store.state.revisions, store.state.anchors);
  } catch (error) {
    store.logger.error('useVoiceAnchors.loadAll', error);
    if (!store.active) return;
    store.state.anchorWarning = 'Could not load saved character voices.';
  } finally {
    if (store.active) {
      store.state.isLoaded = true;
      store.sync();
    }
  }
}

/**
 * Queues or coalesces an anchor transcript/exactClone update for a character.
 * @param {object} store - Voice anchor store internals.
 * @param {string} rawCharacterId - Character identifier.
 * @param {object} patch - Patch fields.
 * @returns {Promise<object|null>} Saved anchor or null.
 */
function queueAnchorUpdate(store, rawCharacterId, patch) {
  const characterId = normalizeId(rawCharacterId);
  if (!characterId) return Promise.resolve(null);
  const queue = getOrCreateQueue(store.queues, characterId);
  applyOptimisticUpdate(store, queue, characterId, patch);
  const dispatchRev = store.getRevision(characterId);
  if (queue.activeCount === 0) {
    return enqueueCharacterTask(store, characterId, () => executeUpdateBatch(store, characterId, { queue, patch, dispatchRev }));
  }
  queue.pendingDeferred = queue.pendingDeferred || createDeferred();
  queue.pendingPatch = { ...(queue.pendingPatch || {}), ...patch };
  return queue.pendingDeferred.promise;
}

/**
 * Executes a serialized pin write and rolls back cancelled optimistic edits if pinning fails.
 * @param {object} store - Voice anchor store internals.
 * @param {string} characterId - Normalized character identifier.
 * @param {object} params - Pin parameters.
 * @returns {Promise<object>} Persisted anchor record.
 */
async function executePinAnchor(store, characterId, params) {
  try {
    const saved = await store.voiceAnchors.pinCharacter(params);
    const activeQueue = getOrCreateQueue(store.queues, saved.characterId);
    activeQueue.persistedSnapshot = saved;
    activeQueue.hasSnapshot = true;
    store.bumpRevision(saved.characterId);
    store.state.anchorWarning = null;
    store.setAnchor(saved.characterId, saved);
    return saved;
  } catch (error) {
    rollbackSnapshot(store, characterId, store.queues.get(characterId));
    throw error;
  }
}

/**
 * Serializes pinning a character audio anchor behind any pending updates for that character.
 * @param {object} store - Voice anchor store internals.
 * @param {object} params - Pin parameters.
 * @returns {Promise<object>} Persisted anchor record.
 */
function queueAnchorPin(store, params) {
  const characterId = normalizeId(params?.characterId);
  if (!characterId) return store.voiceAnchors.pinCharacter(params);
  cancelPendingPatch(store.queues.get(characterId));
  return enqueueCharacterTask(store, characterId, () => executePinAnchor(store, characterId, params));
}

/**
 * Executes a serialized unpin delete and restores the last persisted snapshot if deletion fails.
 * @param {object} store - Voice anchor store internals.
 * @param {string} characterId - Normalized character identifier.
 * @returns {Promise<void>} Completion promise.
 */
async function executeUnpinAnchor(store, characterId) {
  try {
    await store.voiceAnchors.unpinCharacter(characterId);
    clearSnapshot(store.queues.get(characterId));
    store.bumpRevision(characterId);
    store.setAnchor(characterId, null);
  } catch (error) {
    rollbackSnapshot(store, characterId, store.queues.get(characterId));
    throw error;
  }
}

/**
 * Serializes unpinning a character audio anchor behind any pending updates for that character.
 * @param {object} store - Voice anchor store internals.
 * @param {string} rawCharacterId - Character identifier.
 * @returns {Promise<void>} Completion promise.
 */
function queueAnchorUnpin(store, rawCharacterId) {
  const characterId = normalizeId(rawCharacterId);
  if (!characterId) return Promise.resolve();
  cancelPendingPatch(store.queues.get(characterId));
  return enqueueCharacterTask(store, characterId, () => executeUnpinAnchor(store, characterId));
}

/**
 * Updates the in-memory anchor map for one character and notifies subscribers.
 * @param {object} store - Voice anchor store internals.
 * @param {string} id - Character identifier.
 * @param {object|null} record - Anchor record or null to remove.
 */
function setStoreAnchor(store, id, record) {
  const next = { ...store.state.anchors };
  if (record) next[id] = record;
  else delete next[id];
  store.state.anchors = next;
  store.sync();
}

/**
 * Creates a serialized, coalescing store coordinating persistent character voice anchors.
 * Inputs: `{ voiceAnchors, logger, onStateChange }`.
 * Outputs: store controller `{ state, setActive, setServices, loadAll, hasAnchor, getRevision, pinCharacterAnchor, updateCharacterAnchor, unpinCharacterAnchor }`.
 * Side effects: delegates IndexedDB reads/writes to `voiceAnchors` and pushes state snapshots to `onStateChange`.
 * Failure modes: sets `anchorWarning` on load failure and rejects write promises after rolling back failed optimistic updates.
 * @param {{ voiceAnchors: object, logger: object, onStateChange?: (snapshot: object) => void }} deps - Store dependencies.
 * @returns {object} Voice anchor store controller.
 */
export function createVoiceAnchorStore({ voiceAnchors, logger, onStateChange }) {
  const state = { anchors: {}, isLoaded: false, anchorWarning: null, revisions: {} };
  const store = {
    voiceAnchors, logger, state, queues: new Map(), active: true,
    sync: () => { if (store.active) onStateChange?.({ anchors: state.anchors, isLoaded: state.isLoaded, anchorWarning: state.anchorWarning }); },
    getRevision: id => state.revisions[id] || 0,
    bumpRevision: id => { state.revisions[id] = (state.revisions[id] || 0) + 1; return state.revisions[id]; },
    setAnchor: (id, record) => setStoreAnchor(store, id, record),
  };
  return {
    state, setActive: value => { store.active = value; },
    setServices: (nextAnchors, nextLogger) => { store.voiceAnchors = nextAnchors; store.logger = nextLogger; },
    loadAll: () => loadStoreAnchors(store), hasAnchor: id => Boolean(state.anchors[id]), getRevision: store.getRevision,
    pinCharacterAnchor: params => queueAnchorPin(store, params),
    updateCharacterAnchor: (id, patch) => queueAnchorUpdate(store, id, patch),
    unpinCharacterAnchor: id => queueAnchorUnpin(store, id),
  };
}

/**
 * Loads and updates persistent 1-person audio anchors bound to Character IDs with serialized writes.
 * Inputs: none (reads `voiceAnchors` use cases from `StudioContext`).
 * Outputs: `{ anchors, isLoaded, anchorWarning, hasAnchor, getRevision, pinCharacterAnchor, updateCharacterAnchor, unpinCharacterAnchor }`.
 * Side effects: reads/writes binary WAV anchors through `voiceAnchors`.
 * Failure modes: surfaces non-blocking storage errors in `anchorWarning` and rethrows on explicit write failure.
 * @returns {object} Character voice anchor state and mutations.
 */
export function useVoiceAnchors() {
  const { voiceAnchors, logger } = useStudioServices();
  const [snapshot, setSnapshot] = useState({ anchors: {}, isLoaded: false, anchorWarning: null });
  const storeRef = useRef(null);
  if (!storeRef.current) storeRef.current = createVoiceAnchorStore({ voiceAnchors, logger, onStateChange: setSnapshot });
  storeRef.current.setServices(voiceAnchors, logger);

  useEffect(() => {
    storeRef.current.setActive(true);
    void storeRef.current.loadAll();
    return () => { storeRef.current.setActive(false); };
  }, [voiceAnchors, logger]);

  const pinCharacterAnchor = useCallback(params => storeRef.current.pinCharacterAnchor(params), []);
  const updateCharacterAnchor = useCallback((id, patch) => storeRef.current.updateCharacterAnchor(id, patch), []);
  const unpinCharacterAnchor = useCallback(id => storeRef.current.unpinCharacterAnchor(id), []);
  return { ...snapshot, hasAnchor: storeRef.current.hasAnchor, getRevision: storeRef.current.getRevision, pinCharacterAnchor, updateCharacterAnchor, unpinCharacterAnchor };
}
