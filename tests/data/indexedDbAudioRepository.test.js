import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageError } from '../../src/domain/errors.js';
import { createIndexedDbVoiceAnchorRepository } from '../../src/data/indexedDbAudioRepository.js';

test('createIndexedDbVoiceAnchorRepository falls back cleanly in memory when indexedDB is unavailable', async () => {
  const repo = createIndexedDbVoiceAnchorRepository({ indexedDB: null });
  const blob = new Blob(['RIFF'], { type: 'audio/wav' });
  await repo.saveAnchor('builtin-khmer-warm-female', { label: 'Nisa', blob });
  const all = await repo.loadAllAnchors();
  assert.equal(all['builtin-khmer-warm-female'].label, 'Nisa');
  await repo.deleteAnchor('builtin-khmer-warm-female');
  assert.deepEqual(await repo.loadAllAnchors(), {});
});

test('createIndexedDbVoiceAnchorRepository handles IndexedDB failures safely', async () => {
  const errors = [];
  const brokenIdb = {
    open() {
      const req = {};
      queueMicrotask(() => {
        req.error = new Error('IDB blocked');
        req.onerror?.();
      });
      return req;
    },
  };
  const repo = createIndexedDbVoiceAnchorRepository({
    indexedDB: brokenIdb,
    logger: { debug() {}, error: (loc, err) => errors.push({ loc, err }) },
  });

  assert.deepEqual(await repo.loadAllAnchors(), {});
  await assert.rejects(() => repo.saveAnchor('id1', { blob: new Blob(['x']) }), StorageError);
  assert.equal(errors.length, 2);
});

test('createIndexedDbVoiceAnchorRepository waits for transaction commit and always closes db on commit error', async () => {
  let closed = false;
  const mockIdb = {
    open() {
      const req = {};
      queueMicrotask(() => {
        req.result = {
          close() { closed = true; },
          transaction() {
            const tx = {
              error: new Error('QuotaExceededError'),
              objectStore() { return { put() {}, delete() {} }; },
            };
            queueMicrotask(() => tx.onerror?.());
            return tx;
          },
        };
        req.onsuccess?.();
      });
      return req;
    },
  };
  const repo = createIndexedDbVoiceAnchorRepository({ indexedDB: mockIdb });
  await assert.rejects(() => repo.saveAnchor('char-nisa', { blob: new Blob(['RIFF']) }), StorageError);
  assert.equal(closed, true);
});
