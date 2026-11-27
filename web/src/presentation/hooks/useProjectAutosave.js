/**
 * @fileoverview Debounced, revision-aware autosave hook for project workspaces.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStudioServices } from '../StudioContext.jsx';
import { clearProjectDraft, saveProjectDraft } from '../../data/projectRecoveryStorage.js';

export const AUTOSAVE_STATUS = Object.freeze({
  IDLE: 'idle',
  DIRTY: 'dirty',
  SAVING: 'saving',
  SAVED: 'saved',
  ERROR: 'error',
});

export const DEFAULT_AUTOSAVE_DEBOUNCE_MS = 1500;
export const DEFAULT_INITIAL_REVISION = 1;
const REVISION_CONFLICT_STATUS = 409;
const REVISION_CONFLICT_CODE = 'REVISION_CONFLICT';

/**
 * Checks whether an error is a 409 revision conflict.
 * Inputs: error (unknown).
 * Outputs: boolean.
 * Side effects: none.
 * Failure modes: returns false on null/undefined.
 * @param {unknown} error - Error to test.
 * @returns {boolean} True if conflict.
 */
export function isConflictError(error) {
  if (!error || typeof error !== 'object') return false;
  return error.status === REVISION_CONFLICT_STATUS ||
    error.statusCode === REVISION_CONFLICT_STATUS ||
    error.code === REVISION_CONFLICT_CODE ||
    error.name === 'ConflictError';
}

function resolveExpectedRevision(revision, hasPersisted) {
  if (!hasPersisted) return undefined;
  if (typeof revision === 'number' && Number.isFinite(revision) && revision > 0) {
    return revision;
  }
  return undefined;
}

async function invokeRepositorySave(repo, id, snapshot, options) {
  if (typeof repo?.saveProject !== 'function') {
    throw new Error('Project repository does not support saveProject.');
  }
  const payload = id ? { ...snapshot, id } : snapshot;
  if (repo.saveProject.length === 1) {
    return repo.saveProject(payload);
  }
  return repo.saveProject(id, payload, options);
}

function extractSavedProject(result) {
  if (result && typeof result === 'object' && result.project) {
    return result.project;
  }
  return result;
}

function calculateNextRevision(saved, expectedRevision) {
  const parsed = Number(saved?.revision);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return expectedRevision ? expectedRevision + 1 : DEFAULT_INITIAL_REVISION;
}

async function resolveLatestRevisionIfConflict(repo, id, isConflict) {
  if (!isConflict || !id || typeof repo?.getProject !== 'function') return undefined;
  try {
    const remote = await repo.getProject(id);
    const remoteRev = Number(remote?.revision);
    return Number.isFinite(remoteRev) && remoteRev > 0 ? remoteRev : undefined;
  } catch (err) {
    return undefined;
  }
}

async function performSaveExecution(ctx) {
  const { repo, id, expectedRevision, snapshot } = ctx;
  const saveOptions = expectedRevision ? { expectedRevision } : {};
  const result = await invokeRepositorySave(repo, id, snapshot, saveOptions);
  const saved = extractSavedProject(result);
  const nextRevision = calculateNextRevision(saved, expectedRevision);
  const nextId = saved?.id || id;
  return { result, saved, nextRevision, nextId };
}

function useAutosaveServices(customRepo, customLogger) {
  let contextServices = null;
  try {
    contextServices = useStudioServices();
  } catch (err) {
    contextServices = null;
  }
  const activeRepo = customRepo || contextServices?.projectRepository || null;
  const activeLogger = customLogger || contextServices?.logger || null;
  return { activeRepo, activeLogger };
}

function registerBeforeUnload(dirtyRef, inFlightRef) {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
  const handleBeforeUnload = event => {
    if (dirtyRef.current || inFlightRef.current) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', handleBeforeUnload);
  return () => window.removeEventListener('beforeunload', handleBeforeUnload);
}

function registerVisibilityFlush(dirtyRef, executeSaveRef) {
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined;
  const handleVisibility = () => {
    if (document.visibilityState === 'hidden' && dirtyRef.current) {
      void executeSaveRef.current?.();
    }
  };
  document.addEventListener('visibilitychange', handleVisibility);
  return () => document.removeEventListener('visibilitychange', handleVisibility);
}

function handlePostSuccessDirty(refs, debounceMs, isUnmounting, updateStatus, scheduleDebouncedSave, executeSaveRef) {
  if (!refs.pendingSaveRef.current && !refs.dirtyRef.current) {
    updateStatus(AUTOSAVE_STATUS.SAVED, isUnmounting);
    return;
  }
  refs.dirtyRef.current = true;
  updateStatus(AUTOSAVE_STATUS.DIRTY, isUnmounting);
  if (isUnmounting || !refs.isMountedRef.current) {
    void executeSaveRef.current?.({ isUnmounting: true });
    return;
  }
  scheduleDebouncedSave(debounceMs);
}

function backupLocalDraft(refs, workspace, logger) {
  try {
    const snap = refs.buildSnapshotRef.current?.();
    if (!snap) return;
    saveProjectDraft({
      draft: {
        projectId: refs.projectIdRef.current || snap.id || null,
        workspace,
        snapshot: snap,
        revision: refs.revisionRef.current || 1,
        timestamp: new Date().toISOString(),
      },
      logger,
    });
  } catch (err) {
    logger?.error?.('useProjectAutosave.backupDraftFailed', err);
  }
}

function clearLocalDraft(refs, workspace, nextId, logger) {
  try {
    const id = nextId || refs.projectIdRef.current || null;
    clearProjectDraft({ projectId: id, workspace, logger });
  } catch (err) {
    logger?.error?.('useProjectAutosave.clearDraftFailed', err);
  }
}

async function prepareSaveContext(refs, repo, snapshot) {
  const id = refs.projectIdRef.current || snapshot.id || null;
  const remoteRev = await resolveLatestRevisionIfConflict(repo, id, refs.isConflictRef.current);
  if (remoteRev) refs.revisionRef.current = remoteRev;
  const expectedRevision = resolveExpectedRevision(refs.revisionRef.current, refs.hasPersistedRef.current);
  return { repo, id, expectedRevision, snapshot };
}

async function runSavePipeline(ctx, saveOpts) {
  const { refs, repo, updateStatus, applySaveSuccess, applySaveFailure } = ctx;
  const snapshot = refs.buildSnapshotRef.current?.();
  if (!snapshot || typeof snapshot !== 'object') return null;
  refs.inFlightRef.current = true;
  refs.pendingSaveRef.current = false;
  refs.dirtyRef.current = false;
  updateStatus(AUTOSAVE_STATUS.SAVING, saveOpts.isUnmounting);
  try {
    const saveCtx = await prepareSaveContext(refs, repo, snapshot);
    const outcome = await performSaveExecution(saveCtx);
    return applySaveSuccess(outcome, saveOpts.isUnmounting);
  } catch (err) {
    return applySaveFailure(err, saveOpts.isUnmounting);
  } finally {
    refs.inFlightRef.current = false;
  }
}

/**
 * Custom hook managing debounced, revision-aware autosave for project editors.
 * Inputs: `{ projectId, initialRevision, buildSnapshot, enabled, debounceMs, deps, hidden, projectRepository, logger, onSaveSuccess, onSaveError, onConflict }`.
 * Outputs: autosave controller with strict status, saveNow, retry, markDirty, resetStatus, and resetProject functions.
 * Side effects: debounces persistence via timers; flushes on unmount, navigation, and tab hide.
 * Failure modes: retains uncommitted edits on persistence failures; surfaces 409 conflicts.
 * @param {object} options - Hook options.
 * @returns {object} Autosave controller.
 */
export function useProjectAutosave({
  projectId: initialProjectId = null,
  initialRevision = null,
  buildSnapshot,
  enabled = true,
  debounceMs = DEFAULT_AUTOSAVE_DEBOUNCE_MS,
  deps = [],
  hidden = false,
  projectRepository,
  logger,
  onSaveSuccess,
  onSaveError,
  onConflict,
  workspace = 'tts',
  enableDraftBackup = true,
} = {}) {
  const services = useAutosaveServices(projectRepository, logger);
  const [status, setStatus] = useState(AUTOSAVE_STATUS.IDLE);
  const [error, setError] = useState(null);
  const [isConflict, setIsConflict] = useState(false);
  const [revision, setRevision] = useState(initialRevision || DEFAULT_INITIAL_REVISION);
  const [projectId, setProjectId] = useState(initialProjectId);
  const [lastSavedAt, setLastSavedAt] = useState(null);

  const hasPersistedRef = useRef(Boolean(initialProjectId && initialRevision));
  const statusRef = useRef(AUTOSAVE_STATUS.IDLE);
  const dirtyRef = useRef(false);
  const inFlightRef = useRef(false);
  const pendingSaveRef = useRef(false);
  const isMountedRef = useRef(true);
  const suppressDepsRef = useRef(false);
  const isConflictRef = useRef(false);
  const revisionRef = useRef(initialRevision || DEFAULT_INITIAL_REVISION);
  const projectIdRef = useRef(initialProjectId);
  const timerRef = useRef(null);
  const buildSnapshotRef = useRef(buildSnapshot);
  buildSnapshotRef.current = buildSnapshot;

  const refs = {
    hasPersistedRef, statusRef, dirtyRef, inFlightRef,
    pendingSaveRef, isMountedRef, suppressDepsRef, isConflictRef,
    revisionRef, projectIdRef, timerRef, buildSnapshotRef,
  };

  const callbacks = useRef({ onSaveSuccess, onSaveError, onConflict, logger: services.activeLogger });
  callbacks.current = { onSaveSuccess, onSaveError, onConflict, logger: services.activeLogger };
  const executeSaveRef = useRef(null);

  const updateStatus = useCallback((next, isUnmounting) => {
    statusRef.current = next;
    if (!isUnmounting && isMountedRef.current) setStatus(next);
  }, []);

  const scheduleDebouncedSave = useCallback(delayMs => {
    dirtyRef.current = true;
    updateStatus(AUTOSAVE_STATUS.DIRTY, false);
    if (enableDraftBackup) backupLocalDraft(refs, workspace, callbacks.current.logger);
    if (timerRef.current) {
      globalThis.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    timerRef.current = globalThis.setTimeout(() => {
      timerRef.current = null;
      void executeSaveRef.current?.();
    }, delayMs);
  }, [updateStatus, enableDraftBackup, workspace]);

  const applySaveSuccess = useCallback((outcome, isUnmounting) => {
    const { saved, nextRevision, nextId, result } = outcome;
    hasPersistedRef.current = true;
    isConflictRef.current = false;
    revisionRef.current = nextRevision;
    if (nextId) projectIdRef.current = nextId;
    if (enableDraftBackup) clearLocalDraft(refs, workspace, nextId, callbacks.current.logger);
    if (!isUnmounting && isMountedRef.current) {
      setRevision(nextRevision);
      if (nextId) setProjectId(nextId);
      setLastSavedAt(new Date().toISOString());
      setError(null);
      setIsConflict(false);
    }
    callbacks.current.onSaveSuccess?.(saved);
    handlePostSuccessDirty(refs, debounceMs, isUnmounting, updateStatus, scheduleDebouncedSave, executeSaveRef);
    return result;
  }, [debounceMs, updateStatus, scheduleDebouncedSave, enableDraftBackup, workspace]); // eslint-disable-line react-hooks/exhaustive-deps

  const applySaveFailure = useCallback((err, isUnmounting) => {
    dirtyRef.current = true;
    const conflict = isConflictError(err);
    isConflictRef.current = conflict;
    if (!isUnmounting && isMountedRef.current) {
      setError(err);
      setIsConflict(conflict);
    }
    updateStatus(AUTOSAVE_STATUS.ERROR, isUnmounting);
    if (conflict) callbacks.current.onConflict?.(err);
    callbacks.current.onSaveError?.(err);
    callbacks.current.logger?.error?.('useProjectAutosave.saveFailed', err, {
      projectId: projectIdRef.current,
      revision: revisionRef.current,
    });
    return null;
  }, [updateStatus]);

  const executeSave = useCallback(async (saveOpts = {}) => {
    if (timerRef.current) {
      globalThis.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (inFlightRef.current) {
      pendingSaveRef.current = true;
      return null;
    }
    return runSavePipeline({
      refs, repo: services.activeRepo, updateStatus, applySaveSuccess, applySaveFailure,
    }, saveOpts);
  }, [services.activeRepo, updateStatus, applySaveSuccess, applySaveFailure]); // eslint-disable-line react-hooks/exhaustive-deps
  executeSaveRef.current = executeSave;

  const saveNow = useCallback(() => executeSave(), [executeSave]);
  const retry = useCallback(() => executeSave(), [executeSave]);
  const markDirty = useCallback(() => scheduleDebouncedSave(debounceMs), [scheduleDebouncedSave, debounceMs]);

  const resetStatus = useCallback(() => {
    dirtyRef.current = false;
    pendingSaveRef.current = false;
    isConflictRef.current = false;
    if (timerRef.current) {
      globalThis.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setError(null);
    setIsConflict(false);
    updateStatus(AUTOSAVE_STATUS.IDLE, false);
  }, [updateStatus]);

  const prevInitialProjectIdRef = useRef(initialProjectId);
  const prevInitialRevisionRef = useRef(initialRevision);

  const resetProject = useCallback((nextId, nextRev) => {
    resetStatus();
    suppressDepsRef.current = true;
    hasPersistedRef.current = Boolean(nextId && nextRev);
    projectIdRef.current = nextId || null;
    prevInitialProjectIdRef.current = nextId;
    prevInitialRevisionRef.current = nextRev;
    setProjectId(nextId || null);
    const parsedRev = Number(nextRev) || DEFAULT_INITIAL_REVISION;
    revisionRef.current = parsedRev;
    setRevision(parsedRev);
  }, [resetStatus]);

  useEffect(() => {
    if (initialProjectId === undefined || initialProjectId === prevInitialProjectIdRef.current) return;
    prevInitialProjectIdRef.current = initialProjectId;
    suppressDepsRef.current = true;
    hasPersistedRef.current = Boolean(initialProjectId && initialRevision);
    projectIdRef.current = initialProjectId;
    setProjectId(initialProjectId);
    resetStatus();
  }, [initialProjectId, initialRevision, resetStatus]);

  useEffect(() => {
    if (initialRevision === undefined || initialRevision === null || initialRevision === prevInitialRevisionRef.current) return;
    prevInitialRevisionRef.current = initialRevision;
    revisionRef.current = initialRevision;
    setRevision(initialRevision);
  }, [initialRevision]);

  const isFirstRenderRef = useRef(true);
  useEffect(() => {
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      return;
    }
    if (suppressDepsRef.current) {
      suppressDepsRef.current = false;
      return;
    }
    if (!enabled) return;
    scheduleDebouncedSave(debounceMs);
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (timerRef.current) {
        globalThis.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (dirtyRef.current) void executeSaveRef.current?.({ isUnmounting: true });
    };
  }, []);

  const prevHiddenRef = useRef(hidden);
  useEffect(() => {
    if (!prevHiddenRef.current && hidden && (dirtyRef.current || timerRef.current)) {
      void executeSaveRef.current?.();
    }
    prevHiddenRef.current = hidden;
  }, [hidden]);

  useEffect(() => registerBeforeUnload(dirtyRef, inFlightRef), []);
  useEffect(() => registerVisibilityFlush(dirtyRef, executeSaveRef), []);

  return {
    status,
    isSaving: status === AUTOSAVE_STATUS.SAVING,
    isDirty: status === AUTOSAVE_STATUS.DIRTY,
    isSaved: status === AUTOSAVE_STATUS.SAVED,
    isError: status === AUTOSAVE_STATUS.ERROR,
    error,
    isConflict,
    revision,
    projectId,
    lastSavedAt,
    getProjectId: () => projectIdRef.current || null,
    hasUnsavedChanges: () => dirtyRef.current,
    saveNow,
    retry,
    markDirty,
    resetStatus,
    resetProject,
  };
}
