/**
 * @fileoverview React hook coordinating service probes, model readiness polling, and diagnostic state.
 */

import { useCallback, useEffect, useState } from 'react';
import { useStudioServices } from '../StudioContext.jsx';

function resolveGateway(customGateway) {
  try {
    return customGateway || useStudioServices()?.diagnosticsGateway;
  } catch (error) {
    return customGateway || null;
  }
}

function useAutoRefresh(refresh, active) {
  useEffect(() => {
    let mounted = true;
    const run = async () => {
      if (mounted && active) await refresh();
    };
    void run();
    return () => {
      mounted = false;
    };
  }, [refresh, active]);
}

function createRefreshHandler({ gateway, setLoading, setError, setDiagnostics, setLastRefreshedAt }) {
  return async () => {
    if (!gateway?.getAggregatedDiagnostics) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setDiagnostics(await gateway.getAggregatedDiagnostics());
      setLastRefreshedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setError(err?.message || 'Failed to refresh model diagnostics.');
    } finally {
      setLoading(false);
    }
  };
}

/**
 * Coordinates fetching and refreshing aggregated system diagnostics.
 * Inputs: optional `{ gateway, initialDiagnostics, active }` overrides.
 * Outputs: `{ diagnostics, loading, error, refresh, lastRefreshedAt }`.
 * Side effects: executes async diagnostic probes on mount and on explicit refresh.
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

  const refresh = useCallback(
    createRefreshHandler({ gateway, setLoading, setError, setDiagnostics, setLastRefreshedAt }),
    [gateway]
  );
  useAutoRefresh(refresh, active);
  return { diagnostics, loading, error, refresh, lastRefreshedAt };
}
