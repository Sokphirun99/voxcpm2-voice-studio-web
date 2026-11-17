/**
 * @fileoverview Presentation hook polling VoxCPM2 availability via injected speechGateway port.
 */

import { useCallback, useEffect, useState } from 'react';
import { useStudioServices } from '../StudioContext.jsx';

const ENGINE_POLL_INTERVAL_MS = 15000;

/**
 * Polls VoxCPM2 engine availability periodically and exposes a manual refresh callback.
 * Inputs: none (reads `speechGateway` from `StudioContext`).
 * Outputs: `[engineState, refresh]` tuple.
 * Side effects: sets a 15-second interval timer polling `speechGateway.checkAvailability()`.
 * Failure modes: resolves to `'offline'` if availability check fails.
 * @returns {['checking'|'ready'|'offline', () => void]} Engine status and manual refresh trigger.
 */
export function useEngineStatus() {
  const { speechGateway } = useStudioServices();
  const [engine, setEngine] = useState('checking');

  const refresh = useCallback(() => {
    void speechGateway.checkAvailability().then(ready => setEngine(ready ? 'ready' : 'offline'));
  }, [speechGateway]);

  useEffect(() => {
    let active = true;
    const poll = () => void speechGateway.checkAvailability().then(ready => {
      if (active) setEngine(ready ? 'ready' : 'offline');
    });
    poll();
    const timer = window.setInterval(poll, ENGINE_POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [speechGateway]);

  return [engine, refresh];
}
