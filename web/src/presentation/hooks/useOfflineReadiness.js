/**
 * @fileoverview React hook coordinating network connectivity and system offline readiness state.
 */

import { useCallback, useEffect, useState } from 'react';
import { evaluateOfflineReadiness } from '../../domain/offlineReadiness.js';
import { useModelDiagnostics } from './useModelDiagnostics.js';

function getInitialOnlineStatus(initialIsOnline) {
  if (typeof initialIsOnline === 'boolean') return initialIsOnline;
  if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
    return navigator.onLine;
  }
  return true;
}

function subscribeNetworkEvents(setOnline) {
  const target = typeof window !== 'undefined' ? window : globalThis;
  if (!target || typeof target.addEventListener !== 'function') return () => {};
  const handleOnline = () => setOnline(true);
  const handleOffline = () => setOnline(false);
  target.addEventListener('online', handleOnline);
  target.addEventListener('offline', handleOffline);
  return () => {
    target.removeEventListener?.('online', handleOnline);
    target.removeEventListener?.('offline', handleOffline);
  };
}

/**
 * Coordinates browser online/offline status and evaluates model offline readiness.
 * Inputs: optional `{ gateway, initialDiagnostics, isOnline: initialOnline, active }`.
 * Outputs: `{ readiness, isOnline, loading, error, refresh }`.
 * Side effects: attaches network event listeners and polls diagnostics.
 * Failure modes: safely degrades to cached available or downloads required.
 * @param {object} [options] - Injected options.
 * @returns {object} Offline readiness state.
 */
export function useOfflineReadiness(options = {}) {
  const { gateway, initialDiagnostics, isOnline: initialOnline, active = true } = options;
  const [isOnline, setIsOnline] = useState(() => getInitialOnlineStatus(initialOnline));
  const diag = useModelDiagnostics({ gateway, initialDiagnostics, active });

  useEffect(() => {
    if (typeof initialOnline === 'boolean') return undefined;
    return subscribeNetworkEvents(setIsOnline);
  }, [initialOnline]);

  const readiness = evaluateOfflineReadiness({ isOnline, diagnostics: diag.diagnostics });
  return { readiness, isOnline, loading: diag.loading, error: diag.error, refresh: diag.refresh };
}
