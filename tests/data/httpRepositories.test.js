import test from 'node:test';
import assert from 'node:assert/strict';
import { createDockerVoiceAnchorRepository } from '../../src/data/httpAudioRepository.js';
import { createHttpVoiceRepository } from '../../src/data/httpVoiceRepository.js';
import { StorageError } from '../../src/domain/errors.js';

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, val) => map.set(key, String(val)),
  };
}

test('createDockerVoiceAnchorRepository migrates local anchors once, syncs audio, and propagates delete', async () => {
  const localMap = new Map([
    ['char-nisa', { characterId: 'char-nisa', label: 'Nisa', source: 'generated', fileName: 'nisa.wav', mimeType: 'audio/wav', promptText: 'សួស្តី', exactClone: false, blob: new Blob(['RIFFlegacy']) }],
  ]);
  const localRepo = {
    loadAllAnchors: async () => Object.fromEntries(localMap.entries()),
    saveAnchor: async (id, rec) => localMap.set(id, rec),
    deleteAnchor: async id => localMap.delete(id),
  };
  const storage = createMemoryStorage();
  const remoteAnchors = new Map([
    ['char-malis', { characterId: 'char-malis', label: 'Malis', source: 'upload', fileName: 'malis.wav', mimeType: 'audio/wav', promptText: 'Hello', exactClone: true, updated_at: '2026-11-17T00:00:00Z', audioUrl: '/api/v1/anchors/char-malis/audio' }],
  ]);
  const remoteBytes = new Map([['char-malis', new Uint8Array([0x52, 0x49, 0x46, 0x46])]]);

  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith('/api/v1/anchors?') && (!init.method || init.method === 'GET')) {
      return new Response(JSON.stringify({ data: { items: Array.from(remoteAnchors.values()) }, error: null, meta: { hasMore: false } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url === '/api/v1/anchors/char-malis/audio') {
      return new Response(remoteBytes.get('char-malis'), { status: 200, headers: { 'Content-Type': 'audio/wav' } });
    }
    if (url === '/api/v1/anchors/char-nisa' && init.method === 'PUT') {
      const meta = JSON.parse(init.body.get('metadata'));
      const audio = init.body.get('audio');
      remoteAnchors.set('char-nisa', { characterId: 'char-nisa', ...meta, audioUrl: '/api/v1/anchors/char-nisa/audio' });
      remoteBytes.set('char-nisa', new Uint8Array(await audio.arrayBuffer()));
      return new Response(JSON.stringify({ data: { anchor: remoteAnchors.get('char-nisa') }, error: null, meta: {} }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url === '/api/v1/anchors/char-nisa' && init.method === 'DELETE') {
      remoteAnchors.delete('char-nisa');
      remoteBytes.delete('char-nisa');
      return new Response(JSON.stringify({ data: { deleted: true }, error: null, meta: {} }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${init.method || 'GET'} ${url}`);
  };

  const repo = createDockerVoiceAnchorRepository({ localRepository: localRepo, fetchImpl, storage });
  const loaded = await repo.loadAllAnchors();
  assert.ok(loaded['char-malis'].blob instanceof Blob);
  assert.ok(loaded['char-nisa'].blob instanceof Blob);
  assert.equal(remoteAnchors.has('char-nisa'), true);

  // Reset deletes both remote & local; reload after migration flag does not resurrect stale IndexedDB copy
  await repo.deleteAnchor('char-nisa');
  assert.equal(remoteAnchors.has('char-nisa'), false);
  localMap.set('char-nisa', { characterId: 'char-nisa', blob: new Blob(['RIFFstale']) });
  const reloaded = await repo.loadAllAnchors();
  assert.equal(Boolean(reloaded['char-nisa']), false);
  assert.equal(localMap.has('char-nisa'), false);
});

test('createDockerVoiceAnchorRepository falls back to IndexedDB read when backend offline and fails loudly on bad save', async () => {
  const localRepo = {
    loadAllAnchors: async () => ({ 'char-nisa': { characterId: 'char-nisa', blob: new Blob(['RIFF']) } }),
    saveAnchor: async () => {},
    deleteAnchor: async () => {},
  };
  const offlineRepo = createDockerVoiceAnchorRepository({
    localRepository: localRepo,
    fetchImpl: async () => { throw new TypeError('connect ECONNREFUSED'); },
    storage: createMemoryStorage(),
  });
  const anchors = await offlineRepo.loadAllAnchors();
  assert.ok(anchors['char-nisa']);

  const rejectingRepo = createDockerVoiceAnchorRepository({
    localRepository: localRepo,
    fetchImpl: async () => new Response(JSON.stringify({ data: null, error: { code: 'INVALID_WAV', message: 'Invalid audio file' } }), {
      status: 422, headers: { 'Content-Type': 'application/json' },
    }),
    storage: createMemoryStorage(),
  });
  await assert.rejects(() => rejectingRepo.saveAnchor('char-nisa', { blob: new Blob(['RIFF']) }), StorageError);
});

test('createHttpVoiceRepository syncs local custom characters up to backend and supports CRUD', async () => {
  const remote = new Map();
  const repo = createHttpVoiceRepository({
    fetchImpl: async (url, init = {}) => {
      if (url.startsWith('/api/v1/characters?') && (!init.method || init.method === 'GET')) {
        return new Response(JSON.stringify({ data: { items: Array.from(remote.values()) }, error: null, meta: { hasMore: false } }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.startsWith('/api/v1/characters/') && init.method === 'PUT') {
        const entry = JSON.parse(init.body);
        remote.set(entry.id, entry);
        return new Response(JSON.stringify({ data: { character: entry }, error: null, meta: {} }), {
          status: 201, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.startsWith('/api/v1/characters/') && init.method === 'DELETE') {
        remote.delete(decodeURIComponent(url.split('/').pop()));
        return new Response(JSON.stringify({ data: { deleted: true }, error: null, meta: {} }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected call: ${url}`);
    },
  });

  const merged = await repo.syncWithLocal([
    { id: 'char-local-1', name: 'Dara Video', category: 'male', description: 'Warm host voice' },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(remote.has('char-local-1'), true);
  await repo.deleteRemoteEntry('char-local-1');
  assert.equal(remote.has('char-local-1'), false);
});

test('createDockerVoiceAnchorRepository normalizes legacy octet-stream MIME and retries failed migrations', async () => {
  const localMap = new Map([
    ['char-nisa', {
      characterId: 'char-nisa',
      label: 'Nisa',
      source: 'generated',
      fileName: 'nisa.wav',
      mimeType: 'application/octet-stream',
      blob: new Blob(['RIFFlegacy'], { type: 'application/octet-stream' }),
    }],
  ]);
  const localRepo = {
    loadAllAnchors: async () => Object.fromEntries(localMap.entries()),
    saveAnchor: async () => {},
    deleteAnchor: async id => localMap.delete(id),
  };
  const storage = createMemoryStorage();
  const uploadedMimeTypes = [];
  let putCalls = 0;

  const repo = createDockerVoiceAnchorRepository({
    localRepository: localRepo,
    storage,
    logger: { error() {}, warn() {}, debug() {} },
    fetchImpl: async (url, init = {}) => {
      if (url.startsWith('/api/v1/anchors?') && (!init.method || init.method === 'GET')) {
        return new Response(JSON.stringify({ data: { items: [] }, error: null, meta: { hasMore: false } }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === '/api/v1/anchors/char-nisa' && init.method === 'PUT') {
        putCalls += 1;
        uploadedMimeTypes.push(init.body.get('audio').type);
        if (putCalls === 1) {
          return new Response(JSON.stringify({ data: null, error: { code: 'TEMP', message: 'Temporary error' } }), {
            status: 500, headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ data: { anchor: { characterId: 'char-nisa', mimeType: 'audio/wav' } }, error: null, meta: {} }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });

  const firstAttempt = await repo.loadAllAnchors();
  assert.equal(Boolean(firstAttempt['char-nisa']), false);
  assert.equal(storage.getItem('voxcpm.dockerAnchorsMigrated.v2'), null);
  assert.equal(localMap.has('char-nisa'), true);

  const retryAttempt = await repo.loadAllAnchors();
  assert.equal(putCalls, 2);
  assert.deepEqual(uploadedMimeTypes, ['audio/wav', 'audio/wav']);
  assert.equal(retryAttempt['char-nisa'].blob.type, 'audio/wav');
  assert.equal(storage.getItem('voxcpm.dockerAnchorsMigrated.v2'), '1');
});
