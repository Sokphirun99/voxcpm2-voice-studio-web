/**
 * @fileoverview Unit and integration tests for storage schema migration, pre-migration backup, and atomic rollback.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StorageError } from '../../src/domain/errors.js';
import {
  CURRENT_CATALOG_VERSION,
  CURRENT_GLOSSARY_VERSION,
  CURRENT_PROJECT_SCHEMA_VERSION,
  detectStorageMigrationsNeeded,
  createStorageBackup,
  rollbackStorageBackup,
  runStorageMigrations,
  verifyStorageIntegrity,
  migrateCatalogFile,
  migrateGlossaryFile,
  migrateSingleProjectFile,
} from '../../server/storageMigration.js';
import { createStorageStore } from '../../server/storageStore.js';

const TEST_PROJECT_ID_1 = '11111111-1111-4111-8111-111111111111';
const TEST_PROJECT_ID_2 = '22222222-2222-4222-8222-222222222222';

function createValidWavBytes(payload = [1, 2, 3, 4]) {
  const buf = new ArrayBuffer(44 + payload.length * 2);
  const view = new DataView(buf);
  const write = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  write(0, 'RIFF'); view.setUint32(4, 36 + payload.length * 2, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 48000, true); view.setUint32(28, 96000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, payload.length * 2, true);
  payload.forEach((v, i) => view.setInt16(44 + i * 2, v, true));
  return new Uint8Array(buf);
}

async function withTempDataDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'voice-studio-migration-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('detectStorageMigrationsNeeded detects up-to-date and legacy storage', async () => {
  await withTempDataDir(async dataDir => {
    const emptyCheck = await detectStorageMigrationsNeeded({ dataDir });
    assert.equal(emptyCheck.anyNeeded, false);

    const legacyCatalog = {
      characters: {
        'char-1': { id: 'char-1', name: 'Kiri', desc: 'Old desc' },
      },
    };
    await writeFile(path.join(dataDir, 'catalog.json'), JSON.stringify(legacyCatalog));

    const checkWithLegacyCatalog = await detectStorageMigrationsNeeded({ dataDir });
    assert.equal(checkWithLegacyCatalog.catalogNeeded, true);
    assert.equal(checkWithLegacyCatalog.anyNeeded, true);

    await writeFile(path.join(dataDir, 'glossary.json'), JSON.stringify([{ find: 'AI', replace: 'Artificial' }]));
    const checkWithGlossary = await detectStorageMigrationsNeeded({ dataDir });
    assert.equal(checkWithGlossary.glossaryNeeded, true);

    const projectsDir = path.join(dataDir, 'projects');
    await mkdir(projectsDir, { recursive: true });
    await writeFile(path.join(projectsDir, `${TEST_PROJECT_ID_1}.json`), JSON.stringify({
      id: TEST_PROJECT_ID_1,
      kind: 'subtitle',
      title: 'Old Project',
      payload: {},
    }));

    const checkWithProjects = await detectStorageMigrationsNeeded({ dataDir });
    assert.equal(checkWithProjects.projectsNeeded, true);
    assert.deepEqual(checkWithProjects.legacyProjectIds, [TEST_PROJECT_ID_1]);
  });
});

test('detectStorageMigrationsNeeded does not falsely flag newly created characters as legacy', async () => {
  await withTempDataDir(async dataDir => {
    const store = createStorageStore({ dataDir, autoMigrate: false });
    await store.init();
    await store.upsertCharacter('char-new', {
      name: 'New Character',
      category: 'female',
      description: 'A completely new modern character',
    });

    const check = await detectStorageMigrationsNeeded({ dataDir });
    assert.equal(check.catalogNeeded, false);
    assert.equal(check.anyNeeded, false);
  });
});

test('createStorageBackup and rollbackStorageBackup snapshot and restore files atomically', async () => {
  await withTempDataDir(async dataDir => {
    const originalCatalog = JSON.stringify({ version: 0, characters: { c1: { name: 'PreBackup' } } });
    const originalGlossary = JSON.stringify([{ find: 'Hello', replace: 'Hi' }]);
    await writeFile(path.join(dataDir, 'catalog.json'), originalCatalog);
    await writeFile(path.join(dataDir, 'glossary.json'), originalGlossary);

    const { backupPath, manifest } = await createStorageBackup({ dataDir });
    assert.ok(backupPath.includes('.backup'));
    assert.equal(manifest.files.length, 2);

    await writeFile(path.join(dataDir, 'catalog.json'), '{"corrupted": true}');
    await writeFile(path.join(dataDir, 'glossary.json'), '{"corrupted": true}');

    const rollbackResult = await rollbackStorageBackup({ dataDir, backupPath });
    assert.equal(rollbackResult.rolledBack, true);
    assert.equal(await readFile(path.join(dataDir, 'catalog.json'), 'utf8'), originalCatalog);
    assert.equal(await readFile(path.join(dataDir, 'glossary.json'), 'utf8'), originalGlossary);
  });
});

test('rollbackStorageBackup rejects path traversal attacks in backup manifest', async () => {
  await withTempDataDir(async dataDir => {
    const { backupPath } = await createStorageBackup({ dataDir });
    const maliciousManifest = {
      timestamp: new Date().toISOString(),
      sourceDataDir: dataDir,
      files: [{ relPath: '../../traversal.txt', sizeBytes: 10, sha256: 'abc' }],
    };
    await writeFile(path.join(backupPath, 'manifest.json'), JSON.stringify(maliciousManifest));

    await assert.rejects(
      () => rollbackStorageBackup({ dataDir, backupPath }),
      /Path escaped directory boundary/
    );
  });
});

test('rollbackStorageBackup rejects tampered backup files with checksum mismatch', async () => {
  await withTempDataDir(async dataDir => {
    await writeFile(path.join(dataDir, 'catalog.json'), JSON.stringify({ version: 1, characters: {} }));
    const { backupPath } = await createStorageBackup({ dataDir });

    await writeFile(path.join(backupPath, 'catalog.json'), 'tampered content');

    await assert.rejects(
      () => rollbackStorageBackup({ dataDir, backupPath }),
      /Backup integrity verification failed.*SHA-256 mismatch/
    );
  });
});

test('upgrades legacy character catalog and voice anchors without data loss', async () => {
  await withTempDataDir(async dataDir => {
    const anchorsDir = path.join(dataDir, 'anchors');
    await mkdir(anchorsDir, { recursive: true });
    const wavBytes = createValidWavBytes([10, -10, 20, -20]);
    await writeFile(path.join(anchorsDir, 'char-kiri.audio'), wavBytes);

    const legacyCatalog = {
      characters: {
        'char-kiri': {
          id: 'char-kiri',
          name: 'Kiri Storyteller',
          desc: 'A gentle narrative voice for stories',
        },
      },
      anchors: {
        'char-kiri': {
          characterId: 'char-kiri',
          label: 'Kiri Storyteller',
          audioFile: 'char-kiri.audio',
          mimeType: 'application/octet-stream',
          exactClone: 1,
        },
      },
    };
    const catalogPath = path.join(dataDir, 'catalog.json');
    await writeFile(catalogPath, JSON.stringify(legacyCatalog, null, 2));

    const migrationResult = await migrateCatalogFile(catalogPath, anchorsDir);
    assert.equal(migrationResult.migrated, true);
    assert.equal(migrationResult.characterCount, 1);
    assert.equal(migrationResult.anchorCount, 1);

    const upgraded = JSON.parse(await readFile(catalogPath, 'utf8'));
    assert.equal(upgraded.version, CURRENT_CATALOG_VERSION);
    assert.equal(upgraded.characters['char-kiri'].description, 'A gentle narrative voice for stories');
    assert.equal(upgraded.characters['char-kiri'].category, 'character');
    assert.equal(upgraded.characters['char-kiri'].desc, undefined);

    const upgradedAnchor = upgraded.anchors['char-kiri'];
    assert.equal(upgradedAnchor.mimeType, 'audio/wav');
    assert.equal(upgradedAnchor.exactClone, true);
    assert.equal(upgradedAnchor.sizeBytes, wavBytes.byteLength);
    assert.ok(upgradedAnchor.sha256);

    const checkAfter = await detectStorageMigrationsNeeded({ dataDir });
    assert.equal(checkAfter.catalogNeeded, false);

    const store = createStorageStore({ dataDir, autoMigrate: false });
    await store.init();
    const charactersPage = await store.listCharacters();
    assert.equal(charactersPage.items[0].description, 'A gentle narrative voice for stories');

    const audioPayload = await store.getAnchorAudio('char-kiri');
    assert.ok(audioPayload);
    assert.equal(audioPayload.mimeType, 'audio/wav');
    assert.deepEqual(audioPayload.bytes, Buffer.from(wavBytes));
  });
});

test('migrateCatalogFile correctly migrates legacy array format for characters and anchors', async () => {
  await withTempDataDir(async dataDir => {
    const anchorsDir = path.join(dataDir, 'anchors');
    await mkdir(anchorsDir, { recursive: true });
    const wavBytes = createValidWavBytes([1, 2]);
    await writeFile(path.join(anchorsDir, 'char-arr.audio'), wavBytes);

    const legacyCatalog = {
      characters: [
        { id: 'char-arr', name: 'Array Char', prompt: 'Created as array' },
      ],
      anchors: [
        { characterId: 'char-arr', label: 'Array Anchor', audioFile: 'char-arr.audio', exactClone: 0 },
      ],
    };
    const catalogPath = path.join(dataDir, 'catalog.json');
    await writeFile(catalogPath, JSON.stringify(legacyCatalog));

    const result = await migrateCatalogFile(catalogPath, anchorsDir);
    assert.equal(result.migrated, true);
    assert.equal(result.characterCount, 1);
    assert.equal(result.anchorCount, 1);

    const upgraded = JSON.parse(await readFile(catalogPath, 'utf8'));
    assert.ok(upgraded.characters['char-arr']);
    assert.equal(upgraded.characters['char-arr'].description, 'Created as array');
    assert.ok(upgraded.anchors['char-arr']);
    assert.equal(upgraded.anchors['char-arr'].characterId, 'char-arr');
    assert.equal(upgraded.anchors['char-arr'].exactClone, false);
  });
});

test('upgrades legacy pronunciation glossary to version 1', async () => {
  await withTempDataDir(async dataDir => {
    const glossaryPath = path.join(dataDir, 'glossary.json');
    const legacyRules = [
      { find: 'AI', replace: 'Artificial Intelligence' },
      { source: 'Khmer', replacement: 'ភាសាខ្មែរ' },
    ];
    await writeFile(glossaryPath, JSON.stringify(legacyRules));

    const result = await migrateGlossaryFile(glossaryPath);
    assert.equal(result.migrated, true);
    assert.equal(result.ruleCount, 2);

    const upgraded = JSON.parse(await readFile(glossaryPath, 'utf8'));
    assert.equal(upgraded.version, CURRENT_GLOSSARY_VERSION);
    assert.equal(upgraded.rules.length, 2);
    assert.ok(upgraded.createdAt);
    assert.ok(upgraded.updatedAt);

    const store = createStorageStore({ dataDir, autoMigrate: false });
    await store.init();
    const loaded = await store.getGlossary();
    assert.equal(loaded.rules.length, 2);
    assert.equal(loaded.rules[0].source, 'AI');
  });
});

test('upgrades legacy project documents without losing script, video, or speaker metadata', async () => {
  await withTempDataDir(async dataDir => {
    const projectsDir = path.join(dataDir, 'projects');
    await mkdir(projectsDir, { recursive: true });

    const legacySubtitleDoc = {
      id: TEST_PROJECT_ID_1,
      kind: 'subtitle',
      title: 'Cambodian History Lesson',
      payload: {
        videoFileName: 'history.mp4',
        speakerNames: { 'spk-1': 'Historian', 'spk-2': 'Student' },
        segments: [
          { id: 's1', text: 'Welcome to the lecture.', start: 0, end: 4, speakerId: 'spk-1' },
          { id: 's2', text: 'Thank you teacher.', start: 4.5, end: 6.5, speakerId: 'spk-2' },
        ],
        detectedLanguage: 'en',
        translatedLanguage: 'km',
      },
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    };

    const legacyTtsDoc = {
      id: TEST_PROJECT_ID_2,
      kind: 'tts',
      title: 'Voiceover Chapter 1',
      payload: {
        script: 'Deep in the heart of Angkor, an ancient library awaits.',
        voiceId: 'char-kiri',
      },
      createdAt: '2025-01-02T00:00:00.000Z',
      updatedAt: '2025-01-02T00:00:00.000Z',
    };

    const subPath = path.join(projectsDir, `${TEST_PROJECT_ID_1}.json`);
    const ttsPath = path.join(projectsDir, `${TEST_PROJECT_ID_2}.json`);
    await writeFile(subPath, JSON.stringify(legacySubtitleDoc, null, 2));
    await writeFile(ttsPath, JSON.stringify(legacyTtsDoc, null, 2));

    await migrateSingleProjectFile(subPath);
    await migrateSingleProjectFile(ttsPath);

    const store = createStorageStore({ dataDir, autoMigrate: false });
    await store.init();

    const subProject = await store.getProject(TEST_PROJECT_ID_1);
    assert.equal(subProject.schemaVersion, CURRENT_PROJECT_SCHEMA_VERSION);
    assert.equal(subProject.type, 'subtitles');
    assert.equal(subProject.name, 'Cambodian History Lesson');
    assert.equal(subProject.settings.videoFileName, 'history.mp4');
    assert.equal(subProject.settings.speakerNames['spk-1'], 'Historian');
    assert.equal(subProject.segments.length, 2);
    assert.equal(subProject.sourceLanguage, 'en');
    assert.equal(subProject.targetLanguage, 'km');

    const ttsProject = await store.getProject(TEST_PROJECT_ID_2);
    assert.equal(ttsProject.schemaVersion, CURRENT_PROJECT_SCHEMA_VERSION);
    assert.equal(ttsProject.type, 'tts');
    assert.equal(ttsProject.name, 'Voiceover Chapter 1');
    assert.equal(ttsProject.settings.script, 'Deep in the heart of Angkor, an ancient library awaits.');
    assert.equal(ttsProject.settings.voiceId, 'char-kiri');
    assert.equal(ttsProject.segments[0].text, 'Deep in the heart of Angkor, an ancient library awaits.');
  });
});

test('findLegacyProjectFiles ignores non-UUID json files in projects directory', async () => {
  await withTempDataDir(async dataDir => {
    const projectsDir = path.join(dataDir, 'projects');
    await mkdir(projectsDir, { recursive: true });
    await writeFile(path.join(projectsDir, 'notes.json'), JSON.stringify({ notes: 'scratchpad' }));

    const check = await detectStorageMigrationsNeeded({ dataDir });
    assert.equal(check.projectsNeeded, false);
    assert.deepEqual(check.legacyProjectIds, []);
  });
});

test('runStorageMigrations creates pre-migration backup and executes automatic atomic rollback on failure', async () => {
  await withTempDataDir(async dataDir => {
    const originalCatalog = JSON.stringify({ version: 0, characters: { c1: { name: 'Original', desc: 'DoNotLose' } } });
    await writeFile(path.join(dataDir, 'catalog.json'), originalCatalog);

    let caughtError = null;
    try {
      await runStorageMigrations({
        dataDir,
        customSteps: async ctx => {
          await migrateCatalogFile(ctx.catalogPath, ctx.anchorsDir);
          throw new Error('Simulated IO error during migration step 2');
        },
      });
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError instanceof StorageError);
    assert.match(caughtError.message, /Storage migration failed: Simulated IO error/);
    assert.match(caughtError.message, /Successfully rolled back/);

    const diskCatalog = await readFile(path.join(dataDir, 'catalog.json'), 'utf8');
    assert.equal(diskCatalog, originalCatalog);

    const backupEntries = await readdir(path.join(dataDir, '.backup'));
    assert.ok(backupEntries.length >= 1);
  });
});

test('verifyStorageIntegrity detects corrupted JSON, invalid magic bytes, and checksum mismatches', async () => {
  await withTempDataDir(async dataDir => {
    const anchorsDir = path.join(dataDir, 'anchors');
    await mkdir(anchorsDir, { recursive: true });

    const catalogWithMissingAudio = {
      version: 1,
      characters: { c1: { id: 'c1', name: 'Test' } },
      anchors: {
        c1: {
          characterId: 'c1',
          audioFile: 'fake.audio',
          sha256: '0000000000000000000000000000000000000000000000000000000000000000',
        },
      },
    };
    await writeFile(path.join(dataDir, 'catalog.json'), JSON.stringify(catalogWithMissingAudio));

    const missingReport = await verifyStorageIntegrity({ dataDir });
    assert.equal(missingReport.valid, false);
    assert.ok(missingReport.issues[0].includes('missing audio binary file'));

    await writeFile(path.join(anchorsDir, 'fake.audio'), Buffer.from('NOT_A_REAL_WAV_HEADER'));
    const invalidMagicReport = await verifyStorageIntegrity({ dataDir });
    assert.equal(invalidMagicReport.valid, false);
    assert.ok(invalidMagicReport.issues[0].includes('valid audio magic bytes'));

    const wavBytes = createValidWavBytes([1, 2]);
    await writeFile(path.join(anchorsDir, 'fake.audio'), wavBytes);
    const checksumReport = await verifyStorageIntegrity({ dataDir });
    assert.equal(checksumReport.valid, false);
    assert.ok(checksumReport.issues[0].includes('checksum mismatch'));

    await writeFile(path.join(dataDir, 'catalog.json'), '{ invalid JSON syntax');
    const corruptCatalogReport = await verifyStorageIntegrity({ dataDir });
    assert.equal(corruptCatalogReport.valid, false);
    assert.ok(corruptCatalogReport.issues[0].includes('Catalog corruption'));
  });
});

test('createStorageStore automatically runs migrations on init with autoMigrate enabled and is idempotent', async () => {
  await withTempDataDir(async dataDir => {
    const legacyGlossary = [{ find: 'MLX', replace: 'Apple MLX Framework' }];
    await writeFile(path.join(dataDir, 'glossary.json'), JSON.stringify(legacyGlossary));

    const store = createStorageStore({ dataDir, autoMigrate: true });
    await store.init();

    const diskGlossary = JSON.parse(await readFile(path.join(dataDir, 'glossary.json'), 'utf8'));
    assert.equal(diskGlossary.version, CURRENT_GLOSSARY_VERSION);
    assert.equal(diskGlossary.rules[0].source, 'MLX');

    const backupEntries1 = await readdir(path.join(dataDir, '.backup'));
    assert.equal(backupEntries1.length, 1);

    await store.upsertCharacter('char-1', { name: 'Char 1', category: 'female', description: 'desc 1' });
    await store.upsertCharacter('char-2', { name: 'Char 2', category: 'male', description: 'desc 2' });

    const backupEntries2 = await readdir(path.join(dataDir, '.backup'));
    assert.equal(backupEntries2.length, 1);
  });
});
