/**
 * @fileoverview Unit tests for `/version.json` manifest polling adapter.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHttpVersionChecker } from '../../src/data/httpVersionChecker.js';

function createMockFetch(status, body) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (typeof body === 'function' ? body() : body),
    };
  };
  return { calls, fetchImpl };
}

describe('createHttpVersionChecker', () => {
  it('returns no update immediately when currentBuildId is missing', async () => {
    const { calls, fetchImpl } = createMockFetch(200, { buildId: 'build-2' });
    const checker = createHttpVersionChecker({ currentBuildId: null, fetchImpl });

    const result = await checker.checkForUpdate();
    assert.deepEqual(result, { hasUpdate: false, remoteBuildId: null });
    assert.equal(calls.length, 0);
  });

  it('requests versionUrl with cache-busting query and no-store cache mode', async () => {
    const { calls, fetchImpl } = createMockFetch(200, { buildId: 'build-1' });
    const checker = createHttpVersionChecker({
      currentBuildId: 'build-1',
      versionUrl: '/version.json?env=prod',
      fetchImpl,
    });

    const result = await checker.checkForUpdate();
    assert.deepEqual(result, { hasUpdate: false, remoteBuildId: 'build-1' });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /^\/version\.json\?env=prod&t=\d+$/);
    assert.equal(calls[0].init?.cache, 'no-store');
  });

  it('detects an update when remote buildId differs from currentBuildId', async () => {
    const { fetchImpl } = createMockFetch(200, { buildId: 'build-2' });
    const checker = createHttpVersionChecker({ currentBuildId: 'build-1', fetchImpl });

    const result = await checker.checkForUpdate();
    assert.deepEqual(result, { hasUpdate: true, remoteBuildId: 'build-2' });
  });

  it('returns no update on non-OK responses or malformed payloads', async () => {
    const notFound = createHttpVersionChecker({
      currentBuildId: 'build-1',
      fetchImpl: createMockFetch(404, {}).fetchImpl,
    });
    const invalidJson = createHttpVersionChecker({
      currentBuildId: 'build-1',
      fetchImpl: createMockFetch(200, { buildId: '' }).fetchImpl,
    });

    assert.deepEqual(await notFound.checkForUpdate(), { hasUpdate: false, remoteBuildId: null });
    assert.deepEqual(await invalidJson.checkForUpdate(), { hasUpdate: false, remoteBuildId: null });
  });

  it('logs debug diagnostics and never throws when network or JSON parsing fails', async () => {
    const logged = [];
    const checker = createHttpVersionChecker({
      currentBuildId: 'build-1',
      fetchImpl: async () => {
        throw new Error('offline');
      },
      logger: { debug: (tag, msg) => logged.push({ tag, msg }) },
    });

    const result = await checker.checkForUpdate();
    assert.deepEqual(result, { hasUpdate: false, remoteBuildId: null });
    assert.deepEqual(logged, [{ tag: 'httpVersionChecker.checkForUpdate', msg: 'offline' }]);
  });
});
