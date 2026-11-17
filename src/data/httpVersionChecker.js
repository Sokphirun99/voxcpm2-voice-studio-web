/**
 * @fileoverview Build manifest checker polling `/version.json` to detect freshly deployed Voice Studio updates.
 */

const DEFAULT_VERSION_URL = '/version.json';

/**
 * Returns the compile-time Vite build identifier embedded in the active client bundle.
 * Inputs: none.
 * Outputs: build ID string or `null` outside Vite-transformed builds.
 * Side effects: none.
 * Failure modes: never throws.
 * @returns {string|null} Active client bundle build ID.
 */
export function resolveCurrentBuildId() {
  return typeof __APP_BUILD_ID__ === 'string' && __APP_BUILD_ID__ ? __APP_BUILD_ID__ : null;
}

/**
 * Queries `/version.json` cleanly with cache busting and compares against `currentBuildId`.
 * @param {{ currentBuildId: string|null, versionUrl: string, fetchImpl: typeof fetch, logger?: object }} spec - Check params.
 * @returns {Promise<{ hasUpdate: boolean, remoteBuildId: string|null }>} Update detection result.
 */
async function fetchVersionStatus({ currentBuildId, versionUrl, fetchImpl, logger }) {
  if (!currentBuildId) return { hasUpdate: false, remoteBuildId: null };
  const sep = versionUrl.includes('?') ? '&' : '?';
  try {
    const response = await fetchImpl(`${versionUrl}${sep}t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) return { hasUpdate: false, remoteBuildId: null };
    const payload = await response.json();
    const remoteBuildId = typeof payload?.buildId === 'string' && payload.buildId ? payload.buildId : null;
    return { hasUpdate: Boolean(remoteBuildId && remoteBuildId !== currentBuildId), remoteBuildId };
  } catch (error) {
    logger?.debug?.('httpVersionChecker.checkForUpdate', error?.message || 'Version check skipped');
    return { hasUpdate: false, remoteBuildId: null };
  }
}

/**
 * Creates a build-version checker adapter comparing the running bundle ID against `/version.json`.
 * Inputs: optional `{ currentBuildId, versionUrl, fetchImpl, logger }`.
 * Outputs: `{ checkForUpdate() }` service object.
 * Side effects: performs lightweight `GET /version.json` HTTP check with `no-store`.
 * Failure modes: returns `{ hasUpdate: false, remoteBuildId: null }` on offline/HTTP errors.
 * @param {{ currentBuildId?: string|null, versionUrl?: string, fetchImpl?: typeof fetch, logger?: object }} [deps] - Adapter deps.
 * @returns {{ checkForUpdate: () => Promise<{ hasUpdate: boolean, remoteBuildId: string|null }> }} Version checker adapter.
 */
export function createHttpVersionChecker({
  currentBuildId = resolveCurrentBuildId(),
  versionUrl = DEFAULT_VERSION_URL,
  fetchImpl = globalThis.fetch,
  logger,
} = {}) {
  return {
    checkForUpdate: () => fetchVersionStatus({ currentBuildId, versionUrl, fetchImpl, logger }),
  };
}
