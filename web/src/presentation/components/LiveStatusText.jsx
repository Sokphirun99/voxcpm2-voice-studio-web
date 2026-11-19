/**
 * @fileoverview Isolated live-elapsed status text component avoiding full-workspace 100ms re-renders.
 */

import React, { useEffect, useState } from 'react';

const LIVE_TICK_MS = 100;

/**
 * Renders status copy and animates an independent elapsed-seconds counter only while busy.
 * Inputs: `{ id, className, role, ariaLive, as, status, busyStartedAt, busyMessage, fallbackMessage }`.
 * Outputs: `<p>` or `<div>` status element.
 * Side effects: runs a 100ms interval scoped strictly to this leaf node while `busyStartedAt` is set.
 * Failure modes: falls back to static `status.message` or `fallbackMessage` cleanly.
 * @param {object} props - Status display props.
 * @returns {React.ReactElement} Live status node.
 */
export function LiveStatusText({
  id,
  className,
  role = 'status',
  ariaLive,
  as = 'p',
  status,
  busyStartedAt = null,
  busyMessage = '',
  fallbackMessage = '',
}) {
  const [now, setNow] = useState(() => (busyStartedAt ? Date.now() : 0));

  useEffect(() => {
    if (!busyStartedAt) return undefined;
    setNow(Date.now());
    const timer = globalThis.setInterval(() => setNow(Date.now()), LIVE_TICK_MS);
    return () => globalThis.clearInterval(timer);
  }, [busyStartedAt]);

  let text = status?.message || fallbackMessage;
  if (busyStartedAt && busyMessage) {
    const secs = (Math.max(0, (now || busyStartedAt) - busyStartedAt) / 1000).toFixed(1);
    text = `${busyMessage} (${secs}s)`;
  }

  const Tag = as === 'div' ? 'div' : 'p';
  return (
    <Tag id={id} className={className} role={role} aria-live={ariaLive}>
      {text}
    </Tag>
  );
}
