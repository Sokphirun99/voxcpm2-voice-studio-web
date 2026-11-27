import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConflictError, StorageError, ValidationError } from '../../src/domain/errors.js';
import {
  createProjectStore,
  assertSafeProjectId,
  resolveSafeProjectPath,
  PROJECT_FILE_EXT,
} from '../../server/projectStore.js';

const TEST_UUID_1 = '11111111-1111-1111-1111-111111111111';
const TEST_UUID_2 = '22222222-2222-2222-2222-222222222222';
const TEST_UUID_3 = '33333333-3333-3333-3333-333333333333';

async function withTempProjectStore(callback) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'voxcpm-project-test-'));
  const projectsDir = path.join(tempDir, 'projects');
  const store = createProjectStore({ projectsDir });
  await store.init();
  try {
    return await callback({ store, projectsDir, tempDir });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test('projectStore creates, reads, and persists tts, subtitles, and dubbing projects across restart', async () => {
  await withTempProjectStore(async ({ store, projectsDir }) => {
    const ttsSave = await store.saveProject(TEST_UUID_1, {
      type: 'tts',
      name: 'Khmer Narration',
      status: 'draft',
      settings: { script: 'សួស្តីពិភពលោក', voiceId: 'voice-1' },
      segments: [{ id: 'seg-1', text: 'សួស្តីពិភពលោក' }],
    });
    assert.equal(ttsSave.isCreated, true);
    assert.equal(ttsSave.project.type, 'tts');
    assert.equal(ttsSave.project.revision, 1);

    const subSave = await store.saveProject(TEST_UUID_2, {
      type: 'subtitles',
      name: 'Documentary Subtitles',
      segments: [{ id: 'seg-1', text: 'Hello', start: 0, end: 2 }],
    });
    assert.equal(subSave.project.type, 'subtitles');
    assert.equal(subSave.project.kind, 'subtitle');

    const dubSave = await store.saveProject(TEST_UUID_3, {
      type: 'dubbing',
      name: 'English Dub',
      sourceLanguage: 'km',
      targetLanguage: 'en',
    });
    assert.equal(dubSave.project.type, 'dubbing');

    const restarted = createProjectStore({ projectsDir });
    const loaded = await restarted.getProject(TEST_UUID_1);
    assert.ok(loaded);
    assert.equal(loaded.name, 'Khmer Narration');
    assert.equal(loaded.type, 'tts');
    assert.equal(loaded.segments.length, 1);
    assert.equal(loaded.segments[0].text, 'សួស្តីពិភពលោក');
  });
});

test('projectStore increments revisions and detects revision conflict on stale expectedRevision', async () => {
  await withTempProjectStore(async ({ store }) => {
    const created = await store.saveProject(TEST_UUID_1, {
      type: 'tts',
      name: 'Revision Test',
      payload: { script: 'Initial script' },
    });
    assert.equal(created.project.revision, 1);

    const updated = await store.saveProject(TEST_UUID_1, {
      type: 'tts',
      name: 'Revision Test 2',
      payload: { script: 'Second script' },
    });
    assert.equal(updated.isCreated, false);
    assert.equal(updated.project.revision, 2);

    const updatedWithRev = await store.saveProject(
      TEST_UUID_1,
      { type: 'tts', name: 'Revision Test 3', payload: { script: 'Third script' } },
      { expectedRevision: 2 }
    );
    assert.equal(updatedWithRev.project.revision, 3);

    await assert.rejects(
      async () => {
        await store.saveProject(
          TEST_UUID_1,
          { type: 'tts', name: 'Stale update', payload: { script: 'Stale' } },
          { expectedRevision: 2 }
        );
      },
      error => {
        assert.ok(error instanceof ConflictError);
        assert.equal(error.code, 'REVISION_CONFLICT');
        assert.equal(error.currentRevision, 3);
        assert.equal(error.expectedRevision, 2);
        return true;
      }
    );

    const current = await store.getProject(TEST_UUID_1);
    assert.equal(current.revision, 3);
    assert.equal(current.name, 'Revision Test 3');
  });
});

test('projectStore guarantees atomic writes and preserves previous state on save failure', async () => {
  await withTempProjectStore(async ({ store, projectsDir }) => {
    await store.saveProject(TEST_UUID_1, {
      type: 'tts',
      name: 'Original Title',
      payload: { script: 'Valid initial content' },
    });
    const filePath = resolveSafeProjectPath(projectsDir, TEST_UUID_1);
    const originalJson = await readFile(filePath, 'utf8');

    await assert.rejects(
      async () => {
        await store.saveProject(TEST_UUID_1, {
          type: 'invalid-type',
          name: 'Bad Title',
        });
      },
      error => error instanceof ValidationError
    );

    const preservedJson = await readFile(filePath, 'utf8');
    assert.equal(preservedJson, originalJson);
  });
});

test('projectStore reports unreadable corrupted files with StorageError', async () => {
  await withTempProjectStore(async ({ store, projectsDir }) => {
    const filePath = resolveSafeProjectPath(projectsDir, TEST_UUID_1);
    await writeFile(filePath, '{ corrupted json : ', 'utf8');

    await assert.rejects(
      async () => {
        await store.getProject(TEST_UUID_1);
      },
      error => {
        assert.ok(error instanceof StorageError);
        assert.ok(error.message.includes('unreadable'));
        return true;
      }
    );
  });
});

test('projectStore rejects invalid UUID, path traversal, and enforces limits', async () => {
  await withTempProjectStore(async ({ store, projectsDir }) => {
    assert.throws(() => assertSafeProjectId('not-a-uuid'), ValidationError);
    assert.throws(() => assertSafeProjectId('../11111111-1111-1111-1111-111111111111'), ValidationError);

    await assert.rejects(
      async () => store.saveProject('../11111111-1111-1111-1111-111111111111', { type: 'tts', name: 'Bad' }),
      ValidationError
    );

    await assert.rejects(
      async () => store.saveProject(TEST_UUID_1, { type: 'tts', name: '' }),
      ValidationError
    );

    const longTitle = 'x'.repeat(201);
    await assert.rejects(
      async () => store.saveProject(TEST_UUID_1, { type: 'tts', name: longTitle }),
      ValidationError
    );

    const smallStore = createProjectStore({ projectsDir, maxDocBytes: 50 });
    await assert.rejects(
      async () => smallStore.saveProject(TEST_UUID_1, { type: 'tts', name: 'Oversized', payload: { data: 'toolarge' } }),
      ValidationError
    );
  });
});

test('projectStore soft-deletes records, respects includeDeleted flag, and paginates lists', async () => {
  await withTempProjectStore(async ({ store }) => {
    await store.saveProject(TEST_UUID_1, { type: 'tts', name: 'Project One' });
    await store.saveProject(TEST_UUID_2, { type: 'subtitles', name: 'Project Two' });

    const initialList = await store.listProjects({ limit: 10, offset: 0 });
    assert.equal(initialList.total, 2);
    assert.equal(initialList.items.length, 2);

    const deleted = await store.deleteProject(TEST_UUID_1);
    assert.equal(deleted, true);

    const deletedAgain = await store.deleteProject(TEST_UUID_1);
    assert.equal(deletedAgain, false);

    const afterDelete = await store.getProject(TEST_UUID_1);
    assert.equal(afterDelete, null);

    const withDeleted = await store.getProject(TEST_UUID_1, { includeDeleted: true });
    assert.ok(withDeleted?.deletedAt);

    const listActive = await store.listProjects();
    assert.equal(listActive.total, 1);
    assert.equal(listActive.items[0].id, TEST_UUID_2);

    const listAll = await store.listProjects({ includeDeleted: true });
    assert.equal(listAll.total, 2);
  });
});

test('projectStore serializes concurrent writes without losing data', async () => {
  await withTempProjectStore(async ({ store }) => {
    const promises = [
      store.saveProject(TEST_UUID_1, { type: 'tts', name: 'Concurrent 1' }),
      store.saveProject(TEST_UUID_2, { type: 'subtitles', name: 'Concurrent 2' }),
      store.saveProject(TEST_UUID_3, { type: 'dubbing', name: 'Concurrent 3' }),
    ];
    const results = await Promise.all(promises);
    assert.equal(results.length, 3);

    const list = await store.listProjects();
    assert.equal(list.total, 3);
  });
});

test('projectStore automatically upgrades unversioned legacy project records on disk', async () => {
  await withTempProjectStore(async ({ store, projectsDir }) => {
    const filePath = resolveSafeProjectPath(projectsDir, TEST_UUID_1);
    await writeFile(
      filePath,
      JSON.stringify({
        id: TEST_UUID_1,
        kind: 'subtitle',
        title: 'Legacy News Clip',
        payload: {
          videoFileName: 'news.mp4',
          segments: [{ id: 'seg-1', text: 'Hello', start: 0, end: 2 }],
          speakerNames: { 'spk-1': 'Anchor' },
        },
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      }),
      'utf8'
    );

    const project = await store.getProject(TEST_UUID_1);
    assert.ok(project);
    assert.equal(project.type, 'subtitles');
    assert.equal(project.name, 'Legacy News Clip');
    assert.equal(project.revision, 1);
    assert.equal(project.status, 'draft');
    assert.equal(project.schemaVersion, 1);
    assert.equal(project.settings.videoFileName, 'news.mp4');

    const list = await store.listProjects();
    assert.equal(list.total, 1);
    assert.equal(list.items[0].type, 'subtitles');
    assert.equal(list.items[0].name, 'Legacy News Clip');
    assert.equal(list.items[0].revision, 1);
    assert.equal(list.items[0].status, 'draft');
  });
});

test('projectStore validates expectedRevision and detects revision conflict on delete', async () => {
  await withTempProjectStore(async ({ store }) => {
    await store.saveProject(TEST_UUID_1, { type: 'tts', name: 'Delete Rev Test' });

    await assert.rejects(
      async () => store.saveProject(TEST_UUID_1, { type: 'tts', name: 'Update' }, { expectedRevision: 'invalid' }),
      error => error instanceof ValidationError && error.code === 'INVALID_REVISION'
    );

    await assert.rejects(
      async () => store.saveProject(TEST_UUID_1, { type: 'tts', name: 'Update' }, { expectedRevision: -5 }),
      error => error instanceof ValidationError && error.code === 'INVALID_REVISION'
    );

    await assert.rejects(
      async () => store.deleteProject(TEST_UUID_1, { expectedRevision: 99 }),
      error => error instanceof ConflictError && error.code === 'REVISION_CONFLICT'
    );

    const deleted = await store.deleteProject(TEST_UUID_1, { expectedRevision: 1 });
    assert.equal(deleted, true);

    await assert.rejects(
      async () => store.saveProject(TEST_UUID_1, { type: 'tts', name: 'Resurrect' }, { expectedRevision: 1 }),
      error => error instanceof ConflictError && error.code === 'REVISION_CONFLICT'
    );
  });
});

test('projectStore filters project lists by type, kind, and status', async () => {
  await withTempProjectStore(async ({ store }) => {
    await store.saveProject(TEST_UUID_1, { type: 'tts', name: 'TTS Project', status: 'ready' });
    await store.saveProject(TEST_UUID_2, { type: 'subtitles', name: 'Sub Project', status: 'draft' });
    await store.saveProject(TEST_UUID_3, { type: 'dubbing', name: 'Dub Project', status: 'draft' });

    const ttsOnly = await store.listProjects({ type: 'tts' });
    assert.equal(ttsOnly.total, 1);
    assert.equal(ttsOnly.items[0].id, TEST_UUID_1);

    const readyOnly = await store.listProjects({ status: 'ready' });
    assert.equal(readyOnly.total, 1);
    assert.equal(readyOnly.items[0].id, TEST_UUID_1);

    const subOnly = await store.listProjects({ kind: 'subtitle' });
    assert.equal(subOnly.total, 1);
    assert.equal(subOnly.items[0].id, TEST_UUID_2);
  });
});

test('projectStore persists exportHistory across save, disk reload, update, and schema bounding', async () => {
  await withTempProjectStore(async ({ store }) => {
    await store.saveProject(TEST_UUID_1, {
      kind: 'subtitle',
      title: 'Documentary Cut',
      payload: {
        videoFileName: 'doc.mkv',
        segments: [{ id: 's1', start: 0, end: 1.5, text: 'Hello' }],
      },
      exportHistory: [
        {
          id: 'exp-a',
          presetId: 'subtitle_vtt',
          category: 'subtitle',
          label: 'WebVTT Subtitles (.vtt)',
          filename: 'doc.km.vtt',
          format: 'VTT',
          durationSeconds: 1.5,
          languageCode: 'km',
          languageLabel: 'Khmer',
        },
        null,
      ],
    });

    const loaded = await store.getProject(TEST_UUID_1);
    assert.ok(loaded);
    assert.equal(loaded.exportHistory.length, 1);
    assert.equal(loaded.exportHistory[0].filename, 'doc.km.vtt');
    assert.equal(loaded.payload.exportHistory[0].languageCode, 'km');

    const overflowHistory = Array.from({ length: 65 }, (_, i) => ({
      presetId: 'video_dubbed_mp4',
      category: 'video',
      filename: `take-${i}-dubbed.mp4`,
      format: 'MP4',
    }));
    await store.saveProject(
      TEST_UUID_1,
      { ...loaded, exportHistory: overflowHistory, payload: { ...loaded.payload, exportHistory: overflowHistory } },
      { expectedRevision: loaded.revision }
    );
    const reloaded = await store.getProject(TEST_UUID_1);
    assert.equal(reloaded.exportHistory.length, 50);
    assert.equal(reloaded.exportHistory[0].filename, 'take-0-dubbed.mp4');
  });
});
