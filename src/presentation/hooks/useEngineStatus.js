/**
 * @fileoverview Presentation hook polling VoxCPM2 health and exposing actionable outage diagnostics.
 */

import { useCallback, useEffect, useState } from 'react';
import { useStudioServices } from '../StudioContext.jsx';

const ENGINE_POLL_INTERVAL_MS = 15000;
const DEFAULT_OFFLINE_REASON = 'Cannot reach the VoxCPM2 engine. Check that engine/app.py is running.';

/**
 * Resolves engine readiness and offline diagnostics via `checkHealth` or legacy `checkAvailability`.
 * @param {import('../../domain/ports.js').SpeechGatewayPort} speechGateway - Gateway port.
 * @returns {Promise<{ status: 'ready'|'offline', reason: string|null }>} Resolved health tuple.
 */
export async function resolveEngineHealth(speechGateway) {
  if (typeof speechGateway.checkHealth === 'function') {
    const health = await speechGateway.checkHealth();
    return {
      status: health?.available ? 'ready' : 'offline',
      reason: health?.available ? null : (health?.reason || DEFAULT_OFFLINE_REASON),
    };
  }
  const available = await speechGateway.checkAvailability();
  return { status: available ? 'ready' : 'offline', reason: available ? null : DEFAULT_OFFLINE_REASON };
}

function subscribeVisibilityRecheck(poll) {
  if (typeof document === 'undefined') return () => {};
  const onVisible = () => { if (document.visibilityState === 'visible') poll(); };
  document.addEventListener('visibilitychange', onVisible);
  globalThis.addEventListener?.('focus', poll);
  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    globalThis.removeEventListener?.('focus', poll);
  };
}

/**
 * Polls VoxCPM2 engine availability and exposes manual retry plus top-alert dismissal state.
 * Inputs: none (reads `speechGateway` from `StudioContext`).
 * Outputs: `[engineState, refresh, { reason, checking, showAlert, dismissAlert }]`.
 * Side effects: polls on mount, focus/visibility, and every 15s via `speechGateway`.
 * Failure modes: resolves to `'offline'` with diagnostic reason if check fails.
 * @returns {['checking'|'ready'|'offline', () => void, { reason: string|null, checking: boolean, showAlert: boolean, dismissAlert: () => void }]} Status tuple.
 */
export function useEngineStatus() {
  const { speechGateway } = useStudioServices();
  const [health, setHealth] = useState({ status: 'checking', reason: null, checking: false });
  const [dismissed, setDismissed] = useState(false);

  const runCheck = useCallback((isManual = false) => {
    if (isManual) {
      setDismissed(false);
      setHealth(prev => ({ ...prev, checking: true }));
    }
    return resolveEngineHealth(speechGateway).then(next => {
      if (next.status === 'ready') setDismissed(false);
      setHealth({ ...next, checking: false });
    });
  }, [speechGateway]);

  const refresh = useCallback(() => { void runCheck(true); }, [runCheck]);
  const dismissAlert = useCallback(() => setDismissed(true), []);

  useEffect(() => {
    let active = true;
    const poll = () => void resolveEngineHealth(speechGateway).then(next => {
      if (!active) return;
      if (next.status === 'ready') setDismissed(false);
      setHealth({ ...next, checking: false });
    });
    poll();
    const timer = globalThis.setInterval(poll, ENGINE_POLL_INTERVAL_MS);
    const cleanupVisibility = subscribeVisibilityRecheck(poll);
    return () => { active = false; globalThis.clearInterval(timer); cleanupVisibility(); };
  }, [speechGateway]);

  return [
    health.status,
    refresh,
    { reason: health.reason, checking: health.checking, showAlert: health.status === 'offline' && !dismissed, dismissAlert },
  ];
}
