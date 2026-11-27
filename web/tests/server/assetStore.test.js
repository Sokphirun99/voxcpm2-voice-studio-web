import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StorageError, ValidationError } from '../../src/domain/errors.js';
import {
  createAssetStore,
  assertSafeAssetId,
  resolveSafeAssetPath,
  ASSET_BIN_EXT,
  ASSET_META_EXT,
} from '../../server/assetStore.js';

const TEST_ASSET_ID_1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TEST_ASSET_ID_2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TEST_PROJECT_ID = '11111111-1111-1111-1111-111111111111';

function createDummyAudioBytes() {
  const bytes = new Uint8Array(128);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256;
  return bytes;
}

async function withTempAssetStore(callback, maxAssetBytes) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'voxcpm-asset-test-'));
  const assetsDir = path.join(tempDir, 'assets');
  const store = createAssetStore({ assetsDir, dataDir: tempDir, maxAssetBytes });
  await store.init();
  try {
    return await callback({ store, assetsDir, tempDir });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test('assetStore saves, reads, and persists binary assets across store restart', async () => {
  await withTempAssetStore(async ({ store, assetsDir, tempDir }) => {
    const rawAudio = createDummyAudioBytes();
    const saved = await store.saveAsset({
      id: TEST_ASSET_ID_1,
      fileName: 'interview.wav',
      mimeType: 'audio/wav',
      bytes: rawAudio,
      kind: 'audio',
      projectId: TEST_PROJECT_ID,
    });

    assert.equal(saved.id, TEST_ASSET_ID_1);
    assert.equal(saved.fileName, 'interview.wav');
    assert.equal(saved.sizeBytes, rawAudio.byteLength);
    assert.equal(saved.kind, 'audio');
    assert.ok(saved.sha256);

    const restarted = createAssetStore({ assetsDir, dataDir: tempDir });
    const meta = await restarted.getAsset(TEST_ASSET_ID_1);
    assert.ok(meta);
    assert.equal(meta.id, TEST_ASSET_ID_1);
    assert.equal(meta.fileName, 'interview.wav');

    const binary = await restarted.getAssetBinary(TEST_ASSET_ID_1);
    assert.ok(binary);
    assert.equal(binary.bytes.byteLength, rawAudio.byteLength);
    assert.deepEqual(binary.bytes, rawAudio);
  });
});

test('assetStore rejects path traversal and sanitizes file names', async () => {
  await withTempAssetStore(async ({ store }) => {
    assert.throws(() => assertSafeAssetId('invalid-uuid'), ValidationError);
    assert.throws(() => assertSafeAssetId('../etc/passwd'), ValidationError);

    const rawAudio = createDummyAudioBytes();
    const saved = await store.saveAsset({
      id: TEST_ASSET_ID_1,
      fileName: '../../../etc/passwd.wav',
      mimeType: 'audio/wav',
      bytes: rawAudio,
      kind: 'audio',
    });

    assert.equal(saved.fileName, 'passwd.wav');
  });
});

test('assetStore rejects empty, oversized, or invalid payloads', async () => {
  await withTempAssetStore(async ({ store }) => {
    await assert.rejects(
      async () => store.saveAsset({ id: TEST_ASSET_ID_1, fileName: 'empty.wav', bytes: new Uint8Array(0) }),
      error => error instanceof ValidationError && error.code === 'EMPTY_ASSET_PAYLOAD'
    );

    await assert.rejects(
      async () => store.saveAsset({ id: TEST_ASSET_ID_1, fileName: 'bad.wav', bytes: 'not-bytes' }),
      error => error instanceof ValidationError && error.code === 'INVALID_ASSET_BYTES'
    );

    await assert.rejects(
      async () => store.saveAsset({ id: TEST_ASSET_ID_1, fileName: 'bad.wav', bytes: new Uint8Array(16), kind: 'invalid-kind' }),
      error => error instanceof ValidationError && error.code === 'INVALID_ASSET_KIND'
    );
  }, 64);
});

test('assetStore enforces max size limits', async () => {
  await withTempAssetStore(async ({ store }) => {
    await assert.rejects(
      async () => store.saveAsset({ id: TEST_ASSET_ID_1, fileName: 'oversized.wav', bytes: createDummyAudioBytes() }),
      error => error instanceof ValidationError && error.code === 'ASSET_TOO_LARGE'
    );
  }, 10);
});

test('assetStore cleans up orphaned binary if metadata write fails', async () => {
  await withTempAssetStore(async ({ store, assetsDir }) => {
    const metaPath = resolveSafeAssetPath(assetsDir, `${TEST_ASSET_ID_1}${ASSET_META_EXT}`);
    await mkdir(metaPath);

    await assert.rejects(
      async () => {
        await store.saveAsset({
          id: TEST_ASSET_ID_1,
          fileName: 'fail.wav',
          mimeType: 'audio/wav',
          bytes: createDummyAudioBytes(),
          kind: 'audio',
        });
      }
    );

    const binPath = resolveSafeAssetPath(assetsDir, `${TEST_ASSET_ID_1}${ASSET_BIN_EXT}`);
    await assert.rejects(async () => readFile(binPath), error => error.code === 'ENOENT');
  });
});

test('assetStore soft deletes, hard deletes, and purges expired assets', async () => {
  await withTempAssetStore(async ({ store }) => {
    const rawAudio = createDummyAudioBytes();
    await store.saveAsset({
      id: TEST_ASSET_ID_1,
      fileName: 'clip1.mp4',
      mimeType: 'video/mp4',
      bytes: rawAudio,
      kind: 'video',
      projectId: TEST_PROJECT_ID,
    });
    await store.saveAsset({
      id: TEST_ASSET_ID_2,
      fileName: 'clip2.wav',
      mimeType: 'audio/wav',
      bytes: rawAudio,
      kind: 'audio',
    });

    const list1 = await store.listAssets({ projectId: TEST_PROJECT_ID });
    assert.equal(list1.total, 1);
    assert.equal(list1.items[0].id, TEST_ASSET_ID_1);

    const softDeleted = await store.deleteAsset(TEST_ASSET_ID_1);
    assert.equal(softDeleted, true);
    assert.equal(await store.getAsset(TEST_ASSET_ID_1), null);

    const activeList = await store.listAssets();
    assert.equal(activeList.total, 1);
    assert.equal(activeList.items[0].id, TEST_ASSET_ID_2);

    const purged = await store.purgeDeletedAssets({ olderThanMs: 0 });
    assert.equal(purged, 1);

    const hardDeleted = await store.deleteAsset(TEST_ASSET_ID_2, { hard: true });
    assert.equal(hardDeleted, true);
    assert.equal(await store.getAsset(TEST_ASSET_ID_2), null);
  });
});

test('assetStore validates projectId and throws INVALID_PROJECT_ID when invalid', async () => {
  await withTempAssetStore(async ({ store }) => {
    await assert.rejects(
      async () =>
        store.saveAsset({
          id: TEST_ASSET_ID_1,
          fileName: 'audio.wav',
          bytes: createDummyAudioBytes(),
          projectId: 'invalid-project-uuid',
        }),
      error => error instanceof ValidationError && error.code === 'INVALID_PROJECT_ID'
    );
  });
});

test('assetStore throws StorageError when metadata exists but binary file is missing', async () => {
  await withTempAssetStore(async ({ store, assetsDir }) => {
    await store.saveAsset({
      id: TEST_ASSET_ID_1,
      fileName: 'test.wav',
      bytes: createDummyAudioBytes(),
      kind: 'audio',
    });

    const binPath = resolveSafeAssetPath(assetsDir, `${TEST_ASSET_ID_1}${ASSET_BIN_EXT}`);
    await rm(binPath);

    await assert.rejects(
      async () => store.getAssetBinary(TEST_ASSET_ID_1),
      error => error instanceof StorageError && error.message.includes('missing or unreadable')
    );
  });
});

test('assetStore purges orphaned binary and temporary files', async () => {
  await withTempAssetStore(async ({ store, assetsDir }) => {
    const orphanBinPath = resolveSafeAssetPath(assetsDir, `${TEST_ASSET_ID_1}${ASSET_BIN_EXT}`);
    const orphanTmpPath = resolveSafeAssetPath(assetsDir, `stale.${TEST_ASSET_ID_1}.tmp`);
    await writeFile(orphanBinPath, createDummyAudioBytes());
    await writeFile(orphanTmpPath, createDummyAudioBytes());

    const purged = await store.purgeDeletedAssets({ olderThanMs: 0 });
    assert.equal(purged, 2);

    await assert.rejects(async () => readFile(orphanBinPath), error => error.code === 'ENOENT');
    await assert.rejects(async () => readFile(orphanTmpPath), error => error.code === 'ENOENT');
  });
});
