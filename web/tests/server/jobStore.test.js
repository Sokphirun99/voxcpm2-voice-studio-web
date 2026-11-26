/**
 * @fileoverview Unit and crash-recovery tests for persistent server `jobStore` and storage integrity/backup integration.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConflictError, StorageError, ValidationError } from '../../src/domain/errors.js';
import { JOB_STATUS } from '../../src/domain/productionJobs.js';
import { createJobStore, assertSafeJobId, resolveSafeJobPath } from '../../server/jobStore.js';
import { createStorageBackup, rollbackStorageBackup, verifyStorageIntegrity } from '../../server/storageMigration.js';

const JOB_ID_1 = '11111111-1111-4111-8111-111111111111';
const JOB_ID_2 = '22222222-2222-4222-8222-222222222222';
const JOB_ID_3 = '33333333-3333-4333-8333-333333333333';
const ASSET_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function withTempJobsDir(fn, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'voxcpm-jobstore-test-'));
  const jobsDir = path.join(dataDir, 'jobs');
  const store = createJobStore({ jobsDir, dataDir, ...options });
  await store.init();
  try {
    return await fn({ store, jobsDir, dataDir });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('jobStore persists jobs atomically, blocks path traversal, and cleans leftover temp files on boot', async () => {
  await withTempJobsDir(async ({ store, jobsDir }) => {
    assert.throws(() => assertSafeJobId('../evil'), ValidationError);
    assert.throws(() => resolveSafeJobPath(jobsDir, '../evil'), StorageError);

    const created = await store.enqueueJob({
      id: JOB_ID_1,
      type: 'tts_batch',
      title: 'Atomic Save Test',
      items: [{ itemId: 'seg-1', segmentId: 'seg-1', label: 'Segment 1' }],
    });
    assert.equal(created.isCreated, true);
    assert.equal(created.job.status, JOB_STATUS.QUEUED);

    // Simulate leftover crashed .tmp file before restart
    await writeFile(path.join(jobsDir, `${JOB_ID_1}.json.orphaned.tmp`), '{"partial":', 'utf8');
    const restarted = createJobStore({ jobsDir });
    await restarted.init();

    const files = await readdir(jobsDir);
    assert.equal(files.some(name => name.endsWith('.tmp')), false);
    const loaded = await restarted.getJob(JOB_ID_1);
    assert.equal(loaded.title, 'Atomic Save Test');
  });
});

test('jobStore automatically marks in-flight jobs interrupted on restart while preserving completed items and queued jobs', async () => {
  await withTempJobsDir(async ({ store, jobsDir }) => {
    await store.enqueueJob({
      id: JOB_ID_1,
      type: 'tts_batch',
      title: 'Running At Crash',
      items: [
        { itemId: 'seg-1', segmentId: 'seg-1', label: 'Seg 1' },
        { itemId: 'seg-2', segmentId: 'seg-2', label: 'Seg 2' },
      ],
    });
    await store.updateJob(JOB_ID_1, { action: 'prepare', workerSessionId: 'sess-1' });
    await store.updateJob(JOB_ID_1, { action: 'start', workerSessionId: 'sess-1' });
    await store.updateJob(JOB_ID_1, { action: 'item_start', itemId: 'seg-1', workerSessionId: 'sess-1' });
    await store.updateJob(JOB_ID_1, { action: 'item_complete', itemId: 'seg-1', outputAssetId: ASSET_1, takeId: 'take-1' });
    await store.updateJob(JOB_ID_1, { action: 'item_start', itemId: 'seg-2', workerSessionId: 'sess-1' });

    await store.enqueueJob({ id: JOB_ID_2, type: 'video_burn', title: 'Still Queued' });
    await store.enqueueJob({ id: JOB_ID_3, type: 'video_dub', title: 'Already Completed' });
    await store.updateJob(JOB_ID_3, { action: 'prepare' });
    await store.updateJob(JOB_ID_3, { action: 'complete' });

    // Simulate service restart with a brand new store instance pointing at same disk dir
    const restarted = createJobStore({ jobsDir });
    await restarted.init();

    const recovered = await restarted.getJob(JOB_ID_1);
    assert.equal(recovered.status, JOB_STATUS.INTERRUPTED);
    assert.equal(recovered.items[0].status, 'completed');
    assert.equal(recovered.items[0].outputAssetId, ASSET_1);
    assert.equal(recovered.items[1].status, 'interrupted');
    assert.equal(recovered.artifacts.length, 1);

    // Retry only resets unfinished seg-2 and preserves seg-1 + artifact
    const retried = (await restarted.retryJob(JOB_ID_1)).job;
    assert.equal(retried.status, JOB_STATUS.QUEUED);
    assert.equal(retried.items[0].status, 'completed');
    assert.equal(retried.items[1].status, 'pending');
    assert.equal(retried.artifacts.length, 1);

    assert.equal((await restarted.getJob(JOB_ID_2)).status, JOB_STATUS.QUEUED);
    assert.equal((await restarted.getJob(JOB_ID_3)).status, JOB_STATUS.COMPLETED);
  });
});

test('jobStore enforces bounded active/total limits, eviction priority, revision conflicts, and clearHistory preservation', async () => {
  await withTempJobsDir(async ({ store }) => {
    const j1 = (await store.enqueueJob({ id: JOB_ID_1, type: 'tts_batch', title: 'Job 1' })).job;
    await store.updateJob(JOB_ID_1, { action: 'prepare' });
    await store.updateJob(JOB_ID_1, { action: 'complete' });

    const j2 = (await store.enqueueJob({ id: JOB_ID_2, type: 'tts_batch', title: 'Job 2' })).job;
    await store.updateJob(JOB_ID_2, { action: 'prepare' });
    await store.updateJob(JOB_ID_2, { action: 'interrupt' });

    // Max active limit = 1 rejects 2nd active job
    const j3 = (await store.enqueueJob({ id: JOB_ID_3, type: 'tts_batch', title: 'Job 3 Active' })).job;
    assert.equal(j3.status, JOB_STATUS.QUEUED);
    await assert.rejects(
      () => store.enqueueJob({ type: 'tts_batch', title: 'Blocked Active' }),
      err => err instanceof ValidationError && err.code === 'JOB_QUEUE_FULL'
    );

    // Cancelling j3 opens active slot; admitting new job when maxJobs=3 evicts completed j1, never interrupted j2!
    await store.cancelJob(JOB_ID_3);
    const j4 = await store.enqueueJob({ type: 'tts_batch', title: 'Job 4 Admitted' });
    assert.deepEqual(j4.evictedIds, [j1.id]);
    assert.equal(await store.getJob(j1.id), null);
    assert.ok(await store.getJob(j2.id));

    // Active job cannot be deleted without force
    await assert.rejects(() => store.deleteJob(j4.job.id), ConflictError);

    // Expected revision conflict detection
    const curJ2 = await store.getJob(j2.id);
    await assert.rejects(
      () => store.retryJob(j2.id, { expectedRevision: curJ2.revision + 5 }),
      err => err instanceof ConflictError && err.code === 'REVISION_CONFLICT'
    );

    // Retrying interrupted j2 while maxActiveJobs=1 is saturated by queued j4 MUST throw JOB_QUEUE_FULL
    await assert.rejects(
      () => store.retryJob(j2.id, { expectedRevision: curJ2.revision }),
      err => err instanceof ValidationError && err.code === 'JOB_QUEUE_FULL'
    );

    // clearHistory removes cancelled j3 but keeps queued j4 and interrupted j2
    const cleared = await store.clearHistory();
    assert.equal(cleared.clearedCount, 1);
    assert.equal(await store.getJob(j3.id), null);
    assert.ok(await store.getJob(j2.id));
    assert.ok(await store.getJob(j4.job.id));
  }, { maxJobs: 3, maxActiveJobs: 1 });
});

test('verifyStorageIntegrity detects corrupt job files and createStorageBackup/rollbackStorageBackup preserve jobs/', async () => {
  await withTempJobsDir(async ({ store, jobsDir, dataDir }) => {
    await store.enqueueJob({ id: JOB_ID_1, type: 'tts_batch', title: 'Backup Job' });
    assert.equal((await verifyStorageIntegrity({ dataDir })).valid, true);

    const { backupPath } = await createStorageBackup({ dataDir });
    await writeFile(path.join(jobsDir, `${JOB_ID_1}.json`), '{"broken": true}', 'utf8');
    const brokenReport = await verifyStorageIntegrity({ dataDir });
    assert.equal(brokenReport.valid, false);
    assert.ok(brokenReport.issues.some(msg => msg.includes('Job file corruption')));

    await rollbackStorageBackup({ dataDir, backupPath });
    assert.equal((await verifyStorageIntegrity({ dataDir })).valid, true);
    assert.equal((await store.getJob(JOB_ID_1)).title, 'Backup Job');
  });
});

test('jobStore logs and skips a single corrupted job file across list/enqueue/clearHistory while getJob and verifyStorageIntegrity still report it', async () => {
  const loggedErrors = [];
  const spyLogger = {
    debug() {},
    info() {},
    warn() {},
    error(event, err, meta) { loggedErrors.push({ event, err, meta }); },
  };
  await withTempJobsDir(async ({ store, jobsDir, dataDir }) => {
    await store.enqueueJob({ id: JOB_ID_1, type: 'tts_batch', title: 'Healthy Job' });
    await store.updateJob(JOB_ID_1, { action: 'prepare' });
    await store.updateJob(JOB_ID_1, { action: 'complete' });

    await writeFile(path.join(jobsDir, `${JOB_ID_2}.json`), '{broken-json', 'utf8');

    const listed = await store.listJobs();
    assert.deepEqual(listed.items.map(j => j.id), [JOB_ID_1]);
    assert.ok(loggedErrors.some(entry => entry.event === 'jobStore.readJobFileSafe' && entry.meta?.jobId === JOB_ID_2));

    const admitted = await store.enqueueJob({ id: JOB_ID_3, type: 'tts_batch', title: 'Admitted Next' });
    assert.equal(admitted.job.id, JOB_ID_3);

    const cleared = await store.clearHistory();
    assert.equal(cleared.clearedCount, 1);
    assert.equal(await store.getJob(JOB_ID_1), null);
    assert.ok(await store.getJob(JOB_ID_3));

    await assert.rejects(() => store.getJob(JOB_ID_2), StorageError);
    const report = await verifyStorageIntegrity({ dataDir });
    assert.equal(report.valid, false);
    assert.ok(report.issues.some(msg => msg.includes(JOB_ID_2)));
  }, { logger: spyLogger });
});
