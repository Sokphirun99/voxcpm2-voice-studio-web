/**
 * @fileoverview Unit and integration tests for httpProjectRepository and httpAssetRepository.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpProjectRepository } from '../../src/data/httpProjectRepository.js';
import { createHttpAssetRepository } from '../../src/data/httpAssetRepository.js';
import { createSubtitleProjectSnapshot, createTtsProjectSnapshot } from '../../src/domain/projects.js';
import { ConflictError } from '../../src/domain/errors.js';

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, val) => map.set(key, String(val)),
  };
}

test('createHttpProjectRepository duplicateProject clones project online and falls back offline', async () => {
  const storage = createMemoryStorage();
  const projects = new Map([
    ['11111111-1111-4111-8111-111111111111', {
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Original Project',
      type: 'tts',
      kind: 'tts',
      revision: 3,
      payload: { script: 'Hello' },
    }],
  ]);

  const onlineRepo = createHttpProjectRepository({
    fetchImpl: async (url, init = {}) => {
      if (url.includes('/duplicate') && init.method === 'POST') {
        const body = JSON.parse(init.body || '{}');
        const duplicated = {
          id: '22222222-2222-4222-8222-222222222222',
          title: body.title || 'Copy of Original Project',
          type: 'tts',
          kind: 'tts',
          revision: 1,
          payload: { script: 'Hello' },
        };
        return new Response(JSON.stringify({ data: { project: duplicated }, error: null, meta: {} }), {
          status: 201, headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
    storage,
  });

  const duplicated = await onlineRepo.duplicateProject('11111111-1111-4111-8111-111111111111', { title: 'My Clone' });
  assert.equal(duplicated.project.title, 'My Clone');
  assert.equal(duplicated.project.revision, 1);

  // Test offline fallback
  const offlineRepo = createHttpProjectRepository({
    fetchImpl: async () => { throw new TypeError('offline'); },
    storage,
  });
  const offlineOriginal = await offlineRepo.saveProject(createTtsProjectSnapshot({ title: 'Offline Source', script: 'Demo' }));
  const offlineDuplicated = await offlineRepo.duplicateProject(offlineOriginal.project.id);
  assert.ok(offlineDuplicated.project.id);
  assert.notEqual(offlineDuplicated.project.id, offlineOriginal.project.id);
  assert.equal(offlineDuplicated.project.title, 'Copy of Offline Source');
  assert.equal(offlineDuplicated.project.localOnly, true);
});

test('createHttpProjectRepository restoreProject revives soft-deleted project', async () => {
  const storage = createMemoryStorage();
  let isRestored = false;

  const repo = createHttpProjectRepository({
    fetchImpl: async (url, init = {}) => {
      if (url.includes('/restore') && init.method === 'POST') {
        isRestored = true;
        const project = { id: '33333333-3333-4333-8333-333333333333', title: 'Restored', deletedAt: null, revision: 2 };
        return new Response(JSON.stringify({ data: { project, restored: true }, error: null, meta: {} }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
    storage,
  });

  const res = await repo.restoreProject('33333333-3333-4333-8333-333333333333');
  assert.equal(isRestored, true);
  assert.equal(res.project.title, 'Restored');
  assert.equal(res.restored, true);
});

test('createHttpProjectRepository listProjects supports type, kind, and search query parameters', async () => {
  let requestedUrl = '';
  const repo = createHttpProjectRepository({
    fetchImpl: async url => {
      requestedUrl = url;
      return new Response(JSON.stringify({ data: { items: [] }, error: null, meta: { total: 0 } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    },
    storage: createMemoryStorage(),
  });

  await repo.listProjects({ type: 'tts', status: 'draft', search: 'intro' });
  assert.ok(requestedUrl.includes('type=tts'));
  assert.ok(requestedUrl.includes('status=draft'));
  assert.ok(requestedUrl.includes('search=intro'));
});

test('createHttpAssetRepository uploads, fetches meta, streams binary, and deletes assets', async () => {
  const assets = new Map();
  const binaryPayload = new Uint8Array([1, 2, 3, 4, 5]);

  const repo = createHttpAssetRepository({
    fetchImpl: async (url, init = {}) => {
      if (url === '/api/v1/assets' && init.method === 'POST') {
        const id = '44444444-4444-4444-4444-444444444444';
        const asset = { id, fileName: 'voice.wav', mimeType: 'audio/wav', kind: 'audio', sizeBytes: 5 };
        assets.set(id, asset);
        return new Response(JSON.stringify({ data: { asset }, error: null, meta: {} }), {
          status: 201, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === '/api/v1/assets/44444444-4444-4444-4444-444444444444' && (!init.method || init.method === 'GET')) {
        const asset = assets.get('44444444-4444-4444-4444-444444444444');
        return new Response(JSON.stringify({ data: { asset }, error: null, meta: {} }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === '/api/v1/assets/44444444-4444-4444-4444-444444444444/binary' && (!init.method || init.method === 'GET')) {
        return new Response(binaryPayload, {
          status: 200, headers: { 'Content-Type': 'audio/wav' },
        });
      }
      if (url.startsWith('/api/v1/assets') && (!init.method || init.method === 'GET')) {
        return new Response(JSON.stringify({ data: { items: Array.from(assets.values()) }, error: null, meta: { total: assets.size } }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/44444444-4444-4444-4444-444444444444') && init.method === 'DELETE') {
        assets.delete('44444444-4444-4444-4444-444444444444');
        return new Response(JSON.stringify({ data: { deleted: true, id: '44444444-4444-4444-4444-444444444444' }, error: null, meta: {} }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ data: null, error: { code: 'NOT_FOUND' }, meta: {} }), { status: 404 });
    },
  });

  const uploadResult = await repo.uploadAsset({
    bytes: binaryPayload,
    fileName: 'voice.wav',
    kind: 'audio',
    mimeType: 'audio/wav',
  });
  assert.equal(uploadResult.asset.id, '44444444-4444-4444-4444-444444444444');
  assert.equal(uploadResult.asset.fileName, 'voice.wav');

  const meta = await repo.getAssetMeta('44444444-4444-4444-4444-444444444444');
  assert.equal(meta.id, '44444444-4444-4444-4444-444444444444');

  const binary = await repo.getAssetBinary('44444444-4444-4444-4444-444444444444');
  assert.deepEqual(binary.bytes, binaryPayload);
  assert.equal(binary.mimeType, 'audio/wav');
  assert.ok(binary.meta);
  assert.equal(binary.meta.mimeType, 'audio/wav');

  const list = await repo.listAssets();
  assert.equal(list.items.length, 1);

  const del = await repo.deleteAsset('44444444-4444-4444-4444-444444444444');
  assert.equal(del.deleted, true);

  const missingMeta = await repo.getAssetMeta('non-existent');
  assert.equal(missingMeta, null);
});

test('createHttpProjectRepository createProject uses POST /projects and enforces conflict handling', async () => {
  let postCalled = false;
  let postedBody = null;
  const storage = createMemoryStorage();

  const repo = createHttpProjectRepository({
    fetchImpl: async (url, init = {}) => {
      if (url.endsWith('/projects') && init.method === 'POST') {
        postCalled = true;
        postedBody = JSON.parse(init.body);
        return new Response(JSON.stringify({
          data: { project: { ...postedBody, id: '55555555-5555-4555-8555-555555555555', revision: 1 } },
          error: null,
          meta: {},
        }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected call: ${url}`);
    },
    storage,
  });

  const created = await repo.createProject({ type: 'tts', title: 'Brand New Script' });
  assert.equal(postCalled, true);
  assert.equal(created.project.id, '55555555-5555-4555-8555-555555555555');
  assert.equal(created.project.title, 'Brand New Script');
  assert.equal(created.isCreated, true);

  // Offline conflict check
  const offlineRepo = createHttpProjectRepository({
    fetchImpl: async () => { throw new TypeError('offline'); },
    storage,
  });
  await assert.rejects(
    async () => offlineRepo.createProject({ id: '55555555-5555-4555-8555-555555555555', type: 'tts', title: 'Colliding ID' }),
    error => error instanceof ConflictError
  );
});

test('createHttpProjectRepository saveProject and restoreProject offline enforce expectedRevision conflict', async () => {
  const storage = createMemoryStorage();
  const offlineRepo = createHttpProjectRepository({
    fetchImpl: async () => { throw new TypeError('offline'); },
    storage,
  });

  const initial = await offlineRepo.saveProject(createTtsProjectSnapshot({ title: 'Revision Controlled' }));
  assert.equal(initial.project.revision, 1);

  await assert.rejects(
    async () => offlineRepo.saveProject({ ...initial.project, title: 'Conflicting Update' }, { expectedRevision: 99 }),
    error => error instanceof ConflictError
  );

  await offlineRepo.deleteProject(initial.project.id);
  await assert.rejects(
    async () => offlineRepo.restoreProject(initial.project.id, { expectedRevision: 99 }),
    error => error instanceof ConflictError
  );
});
