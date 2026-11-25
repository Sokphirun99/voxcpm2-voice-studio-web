import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpTerminologyRepository } from '../../src/data/httpTerminologyRepository.js';
import { StorageError, ValidationError } from '../../src/domain/errors.js';

const JSON_HEADERS = { get: () => 'application/json' };
const envelope = (status, body) => ({ ok: status < 400, status, headers: JSON_HEADERS, json: async () => body });

function createMemoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return { getItem: key => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), dump: key => map.get(key) };
}

function createLogger() {
  const errors = [];
  return { errors, debug() {}, warn() {}, error: (...args) => errors.push(args) };
}

test('terminology repository loads terms from /terminology and mirrors them to localStorage', async () => {
  const storage = createMemoryStorage();
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, options?.method || 'GET']);
    return envelope(200, {
      data: {
        terms: [{ id: 't1', category: 'name', status: 'approved', term: 'VoxCPM', pronunciation: 'វ៉ុក' }],
      },
      error: null,
      meta: {},
    });
  };
  const repository = createHttpTerminologyRepository({ fetchImpl, storage });
  const terms = await repository.loadTerms();
  assert.deepEqual(calls, [['/api/v1/terminology', 'GET']]);
  assert.equal(terms.length, 1);
  assert.equal(terms[0].term, 'VoxCPM');
  assert.equal(JSON.parse(storage.dump('voxcpm.terminology.v1')).pending, false);
});

test('terminology repository saveTerms validates locally before any network request and PUTs { terms }', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, method: options.method, body: JSON.parse(options.body) });
    return envelope(200, { data: { terms: JSON.parse(options.body).terms }, error: null, meta: {} });
  };
  const repository = createHttpTerminologyRepository({ fetchImpl, storage: createMemoryStorage() });

  await assert.rejects(
    () => repository.saveTerms([{ category: 'translation', status: 'approved', term: 'Hello', translation: '' }]),
    error => error instanceof ValidationError && error.code === 'EMPTY_TERMINOLOGY_TRANSLATION'
  );
  assert.equal(requests.length, 0);

  const result = await repository.saveTerms([{
    id: 't1',
    category: 'spelling',
    status: 'approved',
    term: 'Phnom Penh',
    variants: ['Pnom Penh'],
  }]);
  assert.equal(result.localOnly, false);
  assert.equal(requests[0].method, 'PUT');
  assert.equal(requests[0].body.terms[0].term, 'Phnom Penh');
});

test('terminology repository surfaces server rejections cleanly and keeps offline pending sync intact', async () => {
  const storage = createMemoryStorage();
  const logger = createLogger();
  let online = false;
  let serverTerms = [{ id: 'old', category: 'spelling', status: 'approved', term: 'Old', variants: [] }];
  const fetchImpl = async (_url, options = {}) => {
    if (!online) throw new TypeError('offline');
    if (options.method === 'PUT') serverTerms = JSON.parse(options.body).terms;
    return envelope(200, { data: { terms: serverTerms }, error: null, meta: {} });
  };
  const repository = createHttpTerminologyRepository({ fetchImpl, storage, logger });

  const localSave = await repository.saveTerms([{ id: 'new', category: 'spelling', status: 'approved', term: 'NewTerm', variants: ['new term'] }]);
  assert.equal(localSave.localOnly, true);
  assert.equal((await repository.loadTerms())[0].term, 'NewTerm');

  online = true;
  const synced = await repository.loadTerms();
  assert.equal(synced[0].term, 'NewTerm');
  assert.equal(serverTerms[0].term, 'NewTerm');
  assert.equal(JSON.parse(storage.dump('voxcpm.terminology.v1')).pending, false);

  const failingRepo = createHttpTerminologyRepository({
    fetchImpl: async () => envelope(422, { data: null, error: { code: 'DUPLICATE_TERMINOLOGY_TERM', message: 'Duplicate' }, meta: {} }),
    storage: createMemoryStorage(),
    logger,
  });
  await assert.rejects(
    () => failingRepo.saveTerms([{ category: 'spelling', status: 'approved', term: 'A' }]),
    error => error instanceof StorageError && error.code === 'DUPLICATE_TERMINOLOGY_TERM' && error.status === 422
  );
});

test('vite dev proxy allowlist exposes /api/v1/terminology cleanly', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../vite.config.js', import.meta.url), 'utf8');
  const literal = /const ALLOWED_STORAGE_PATH = (\/.+\/);/.exec(source)?.[1];
  assert.ok(literal, 'ALLOWED_STORAGE_PATH literal not found');
  const allowed = new RegExp(literal.slice(1, -1));
  assert.equal(allowed.test('/api/v1/terminology'), true);
  assert.equal(allowed.test('/api/v1/terminology/extra'), false);
});
