/**
 * @fileoverview Presentation hook detecting new Voice Studio deployments for safe auto-reload or banner prompt.
 */

import { useEffect, useRef, useState } from 'react';
import { useStudioServices } from '../StudioContext.jsx';

const DEFAULT_CHECK_INTERVAL_MS = 30000;
const RELOAD_GUARD_KEY = 'voxcpm.reloadedForBuild';

/**
 * Records an impending reload for `remoteBuildId` in sessionStorage to guarantee zero infinite reload loops.
 * @param {Storage|null|undefined} storage - Session storage handle.
 * @param {string} remoteBuildId - Newly detected build identifier.
 * @param {object} [logger] - Optional logger.
 * @returns {boolean} True if safe to trigger reload now; false if already attempted or storage blocked.
 */
export function claimSafeAutoReload(storage, remoteBuildId, logger) {
  if (!remoteBuildId || !storage) return false;
  try {
    if (storage.getItem(RELOAD_GUARD_KEY) === remoteBuildId) return false;
    storage.setItem(RELOAD_GUARD_KEY, remoteBuildId);
    return true;
  } catch (error) {
    logger?.debug?.('useAppVersionCheck.claimSafeAutoReload', error?.message || 'Session storage unavailable');
    return false;
  }
}

/**
 * Decides whether a detected update can reload cleanly right away or should show a manual reload prompt.
 * @param {object} spec - Evaluation inputs.
 * @returns {boolean} True when an automatic reload was invoked.
 */
export function applyVersionCheckResult({ result, canAutoReload, storage, onReload, setUpdateAvailable, logger }) {
  if (!result?.hasUpdate || !result.remoteBuildId) return false;
  if (canAutoReload && claimSafeAutoReload(storage, result.remoteBuildId, logger)) {
    onReload();
    return true;
  }
  setUpdateAvailable(true);
  return false;
}

/**
 * Subscribes to visibility, focus, and periodic checks against `versionChecker` for safe auto-updates.
 * Inputs: `{ canAutoReload, intervalMs, onReload }`.
 * Outputs: `{ updateAvailable, reloadNow }`.
 * Side effects: polls `/version.json` cleanly when visible/focused and reloads only when `canAutoReload` is true.
 * Failure modes: network/storage failures safely fall back without interrupting user input.
 * @param {{ canAutoReload: boolean, intervalMs?: number, onReload?: () => void }} params - Hook config.
 * @returns {{ updateAvailable: boolean, reloadNow: () => void }} Update banner state and manual trigger.
 */
export function useAppVersionCheck({
  canAutoReload,
  intervalMs = DEFAULT_CHECK_INTERVAL_MS,
  onReload = () => globalThis.location?.reload(),
}) {
  const { versionChecker = null, logger } = useStudioServices();
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const canAutoReloadRef = useRef(canAutoReload);
  const inFlightRef = useRef(false);
  const onReloadRef = useRef(onReload);
  canAutoReloadRef.current = Boolean(canAutoReload);
  onReloadRef.current = onReload;

  useEffect(() => {
    if (!versionChecker || typeof document === 'undefined') return undefined;
    const runCheck = async () => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const result = await versionChecker.checkForUpdate();
        applyVersionCheckResult({
          result, canAutoReload: canAutoReloadRef.current,
          storage: globalThis.sessionStorage, onReload: onReloadRef.current, setUpdateAvailable, logger,
        });
      } finally {
        inFlightRef.current = false;
      }
    };
    const onVisibility = () => { if (document.visibilityState === 'visible') void runCheck(); };
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void runCheck(); }, intervalMs);
    document.addEventListener('visibilitychange', onVisibility);
    globalThis.addEventListener?.('focus', runCheck);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      globalThis.removeEventListener?.('focus', runCheck);
    };
  }, [versionChecker, intervalMs, logger]);

  return { updateAvailable, reloadNow: () => onReloadRef.current() };
}
