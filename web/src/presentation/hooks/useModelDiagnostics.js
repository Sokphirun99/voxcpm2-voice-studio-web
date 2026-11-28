/**
 * @fileoverview React hook coordinating service probes, model readiness polling, and diagnostic state.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStudioServices } from '../StudioContext.jsx';

function resolveGateway(customGateway) {
  try {
    return customGateway || useStudioServices()?.diagnosticsGateway;
  } catch (error) {
    return customGateway || null;
  }
}

const DIAGNOSTICS_REFRESH_MS = 5_000;

function useAutoRefresh(refresh, active) {
  useEffect(() => {
    if (!active) return;
    const check = () => {
      if (!globalThis.document?.hidden) void refresh({ background: true });
    };
    check();
    const timer = setInterval(check, DIAGNOSTICS_REFRESH_MS);
    const document = globalThis.document;
    document?.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(timer);
      document?.removeEventListener('visibilitychange', check);
    };
  }, [refresh, active]);
}

function createRefreshHandler({ gateway, setLoading, setError, setDiagnostics, setLastRefreshedAt, inFlight }) {
  return async ({ background = false } = {}) => {
    if (!gateway?.getAggregatedDiagnostics) {
      setLoading(false);
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    if (!background) setLoading(true);
    try {
      setDiagnostics(await gateway.getAggregatedDiagnostics());
      setLastRefreshedAt(new Date().toLocaleTimeString());
      setError(null);
    } catch (err) {
      setError(err?.message || 'Failed to refresh model diagnostics.');
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  };
}

/**
 * Coordinates fetching and refreshing aggregated system diagnostics.
 * Inputs: optional `{ gateway, initialDiagnostics, active }` overrides.
 * Outputs: `{ diagnostics, loading, error, refresh, lastRefreshedAt }`.
 * Side effects: executes async diagnostic probes while the workspace is active and on explicit refresh.
 * Failure modes: sets `error` message and keeps last valid diagnostics.
 * @param {{ gateway?: object, initialDiagnostics?: object|null, active?: boolean }} [options] - Diagnostic options.
 * @returns {object} Diagnostic state and controls.
 */
export function useModelDiagnostics({ gateway: customGateway, initialDiagnostics = null, active = true } = {}) {
  const gateway = resolveGateway(customGateway);
  const [diagnostics, setDiagnostics] = useState(initialDiagnostics);
  const [loading, setLoading] = useState(!initialDiagnostics);
  const [error, setError] = useState(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(initialDiagnostics ? 'Initial' : null);

  const inFlight = useRef(false);
  const refresh = useCallback(
    createRefreshHandler({ gateway, setLoading, setError, setDiagnostics, setLastRefreshedAt, inFlight }),
    [gateway]
  );
  useAutoRefresh(refresh, active);
  return { diagnostics, loading, error, refresh, lastRefreshedAt };
}
