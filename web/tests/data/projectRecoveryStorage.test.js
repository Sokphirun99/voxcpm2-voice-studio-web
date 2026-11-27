/**
 * @fileoverview Unit tests for projectRecoveryStorage adapter.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  saveLastActiveProject,
  getLastActiveProject,
  clearLastActiveProject,
  saveProjectDraft,
  getProjectDraft,
  clearProjectDraft,
  buildDraftStorageKey,
  resolveStorage,
} from '../../src/data/projectRecoveryStorage.js';

function createMockStorage() {
  const store = new Map();
  return {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, val) => store.set(key, String(val)),
    removeItem: key => store.delete(key),
  };
}

test('resolveStorage falls back gracefully to in-memory store when localStorage is unavailable', () => {
  const storage = resolveStorage(null);
  assert.ok(typeof storage.getItem === 'function');
  assert.ok(typeof storage.setItem === 'function');
  storage.setItem('test-key', 'value-1');
  assert.equal(storage.getItem('test-key'), 'value-1');
});

test('saveLastActiveProject and getLastActiveProject persist and restore active project', () => {
  const storage = createMockStorage();
  const id = '11111111-1111-1111-1111-111111111111';

  saveLastActiveProject({ projectId: id, workspace: 'subtitles', storage });
  const active = getLastActiveProject({ storage });

  assert.equal(active.projectId, id);
  assert.equal(active.workspace, 'subtitles');
  assert.ok(active.updatedAt);

  clearLastActiveProject({ storage });
  assert.equal(getLastActiveProject({ storage }), null);
});

test('saveProjectDraft and getProjectDraft persist and clear in-flight drafts', () => {
  const storage = createMockStorage();
  const id = '11111111-1111-1111-1111-111111111111';
  const draft = {
    projectId: id,
    workspace: 'tts',
    snapshot: { script: 'In flight edit' },
    revision: 3,
  };

  saveProjectDraft({ draft, storage });
  const fetched = getProjectDraft({ projectId: id, workspace: 'tts', storage });

  assert.equal(fetched.projectId, id);
  assert.equal(fetched.workspace, 'tts');
  assert.equal(fetched.revision, 3);
  assert.equal(fetched.snapshot.script, 'In flight edit');

  clearProjectDraft({ projectId: id, workspace: 'tts', storage });
  assert.equal(getProjectDraft({ projectId: id, workspace: 'tts', storage }), null);
});

test('getProjectDraft and getLastActiveProject recover cleanly from corrupted JSON in storage', () => {
  const storage = createMockStorage();
  const logs = [];
  const mockLogger = { error: (msg, err) => logs.push({ msg, err }) };

  storage.setItem(buildDraftStorageKey('broken-id', 'tts'), '{ invalid: json');
  const result = getProjectDraft({ projectId: 'broken-id', workspace: 'tts', storage, logger: mockLogger });

  assert.equal(result, null);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].msg, 'projectRecoveryStorage.getDraftFailed');
});
