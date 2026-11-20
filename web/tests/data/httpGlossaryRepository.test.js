import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpGlossaryRepository } from '../../src/data/httpGlossaryRepository.js';
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

test('glossary repository loads rules from /glossary and mirrors them to localStorage', async () => {
  const storage = createMemoryStorage();
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, options?.method || 'GET']);
    return envelope(200, { data: { rules: [{ id: 'a', source: 'NASA', replacement: 'x', enabled: true }] }, error: null, meta: {} });
  };
  const repository = createHttpGlossaryRepository({ fetchImpl, storage });
  const rules = await repository.loadRules();
  assert.deepEqual(calls, [['/api/v1/glossary', 'GET']]);
  assert.equal(rules[0].source, 'NASA');
  assert.deepEqual(JSON.parse(storage.dump('voxcpm.glossary.v1')).pending, false);
});

test('glossary repository saveRules validates before any request and PUTs { rules }', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, method: options.method, body: JSON.parse(options.body) });
    return envelope(200, { data: { rules: JSON.parse(options.body).rules }, error: null, meta: {} });
  };
  const repository = createHttpGlossaryRepository({ fetchImpl, storage: createMemoryStorage() });

  await assert.rejects(() => repository.saveRules([{ source: '  ', replacement: 'x' }]), error => error instanceof ValidationError && error.code === 'EMPTY_GLOSSARY_SOURCE');
  assert.equal(requests.length, 0);

  const result = await repository.saveRules([{ source: ' NASA ', replacement: 'x' }]);
  assert.equal(result.localOnly, false);
  assert.equal(requests[0].method, 'PUT');
  assert.deepEqual(requests[0].body.rules.map(rule => rule.source), ['NASA']);
});

test('glossary repository surfaces server rejections from saveRules instead of hiding them', async () => {
  const logger = createLogger();
  const fetchImpl = async () => envelope(422, { data: null, error: { code: 'GLOSSARY_TOO_MANY_RULES', message: 'Too many.' }, meta: {} });
  const repository = createHttpGlossaryRepository({ fetchImpl, storage: createMemoryStorage(), logger });
  await assert.rejects(() => repository.saveRules([{ source: 'a', replacement: 'b' }]), error => error instanceof StorageError && error.code === 'GLOSSARY_TOO_MANY_RULES' && error.status === 422);
  assert.equal(logger.errors.length, 1);
});

test('glossary repository keeps offline edits pending, serves them locally, and syncs them when the server returns', async () => {
  const storage = createMemoryStorage();
  let online = false;
  let serverRules = [{ id: 's', source: 'OLD', replacement: 'old', enabled: true }];
  const fetchImpl = async (_url, options = {}) => {
    if (!online) throw new TypeError('network down');
    if (options.method === 'PUT') serverRules = JSON.parse(options.body).rules;
    return envelope(200, { data: { rules: serverRules }, error: null, meta: {} });
  };
  const repository = createHttpGlossaryRepository({ fetchImpl, storage, logger: createLogger() });

  const saved = await repository.saveRules([{ source: 'NEW', replacement: 'new' }]);
  assert.equal(saved.localOnly, true);
  assert.deepEqual((await repository.loadRules()).map(rule => rule.source), ['NEW']);

  online = true;
  assert.deepEqual((await repository.loadRules()).map(rule => rule.source), ['NEW']);
  assert.deepEqual(serverRules.map(rule => rule.source), ['NEW']);
  assert.equal(JSON.parse(storage.dump('voxcpm.glossary.v1')).pending, false);
});

test('glossary repository loadRules never rejects: unreachable server with no mirror yields an empty dictionary and logs', async () => {
  const logger = createLogger();
  const repository = createHttpGlossaryRepository({ fetchImpl: async () => { throw new TypeError('down'); }, storage: createMemoryStorage(), logger });
  assert.deepEqual(await repository.loadRules(), []);
  assert.equal(logger.errors.length, 1);
});

test('vite dev proxy allowlist exposes /api/v1/glossary but still rejects unknown storage paths', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../vite.config.js', import.meta.url), 'utf8');
  const literal = /const ALLOWED_STORAGE_PATH = (\/.+\/);/.exec(source)?.[1];
  assert.ok(literal, 'ALLOWED_STORAGE_PATH literal not found');
  const allowed = new RegExp(literal.slice(1, -1));
  assert.equal(allowed.test('/api/v1/glossary'), true);
  assert.equal(allowed.test('/api/v1/glossary/extra'), false);
  assert.equal(allowed.test('/api/v1/projects/abc'), true);
  assert.equal(allowed.test('/api/v1/secrets'), false);
});
