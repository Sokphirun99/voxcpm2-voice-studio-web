/**
 * @fileoverview Per-IP sliding-window rate limiter protecting storage API endpoints.
 */

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 180;
const MAX_TRACKED_KEYS = 2_000;

/**
 * Removes expired timestamps and prunes oldest map entries if key cardinality grows large.
 * @param {Map<string, number[]>} buckets - Client request timestamp buckets.
 * @param {number} cutoff - Oldest valid timestamp (`now - windowMs`).
 */
function pruneBuckets(buckets, cutoff) {
  for (const [key, timestamps] of buckets.entries()) {
    const active = timestamps.filter(ts => ts > cutoff);
    if (active.length === 0) buckets.delete(key);
    else buckets.set(key, active);
  }
  if (buckets.size <= MAX_TRACKED_KEYS) return;
  const firstKey = buckets.keys().next().value;
  if (firstKey !== undefined) buckets.delete(firstKey);
}

/**
 * Creates an in-memory fixed/sliding window rate limiter keyed by client identifier.
 * Inputs: `{ windowMs, maxRequests, nowFn }`.
 * Outputs: `{ check(clientKey) }` returning `{ allowed, remaining, retryAfterSeconds }`.
 * Side effects: tracks request timestamps in bounded memory.
 * Failure modes: defaults to permissive key `'unknown'` when IP is absent.
 * @param {{ windowMs?: number, maxRequests?: number, nowFn?: () => number }} [options] - Rate limit settings.
 * @returns {{ check: (clientKey: string) => { allowed: boolean, remaining: number, retryAfterSeconds: number } }} Limiter instance.
 */
export function createRateLimiter({ windowMs = DEFAULT_WINDOW_MS, maxRequests = DEFAULT_MAX_REQUESTS, nowFn = Date.now } = {}) {
  const buckets = new Map();

  return {
    check(clientKey) {
      const key = String(clientKey || 'unknown');
      const now = nowFn();
      const cutoff = now - windowMs;
      if (buckets.size > MAX_TRACKED_KEYS) pruneBuckets(buckets, cutoff);
      const recent = (buckets.get(key) || []).filter(ts => ts > cutoff);
      if (recent.length >= maxRequests) {
        const retryMs = Math.max(1_000, recent[0] + windowMs - now);
        buckets.set(key, recent);
        return { allowed: false, remaining: 0, retryAfterSeconds: Math.ceil(retryMs / 1_000) };
      }
      recent.push(now);
      buckets.set(key, recent);
      return { allowed: true, remaining: Math.max(0, maxRequests - recent.length), retryAfterSeconds: 0 };
    },
  };
}
