/**
 * @fileoverview Unit tests for R3-07 persistent batch job domain entities, lifecycle state machine, bounded queue eviction, and TTS batch builders.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError, ValidationError } from '../../src/domain/errors.js';
import {
  DEFAULT_MAX_RETRIES,
  JOB_STATUS,
  MAX_JOB_ITEMS,
  applyJobLifecycleAction,
  assertActiveQueueCapacity,
  assertJobId,
  assertJobTitle,
  assertJobType,
  buildReadyJobArtifacts,
  buildTtsBatchJobItems,
  buildTtsBatchJobSpec,
  canTransitionJobStatus,
  completeProductionJob,
  createProductionJob,
  createQueuedProductionJob,
  evaluateQueueAdmission,
  failProductionJob,
  finalizeCancelledProductionJob,
  getPendingJobItems,
  hasCompletedItemArtifact,
  isJobWorkerStale,
  markJobInterrupted,
  markJobItemCompleted,
  markJobItemFailed,
  markJobItemRunning,
  mergeUpdatedTakesIntoSegments,
  requestCancelProductionJob,
  retryProductionJob,
  selectEvictableJobs,
  summarizeJobs,
  touchJobHeartbeat,
  transitionToPreparing,
  transitionToRunning,
} from '../../src/domain/productionJobs.js';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const PROJ_ID = '22222222-2222-4222-8222-222222222222';
const ASSET_ID_1 = '33333333-3333-4333-8333-333333333333';
const ASSET_ID_2 = '44444444-4444-4444-8444-444444444444';

test('createProductionJob validates required fields, bounds, and defaults cleanly', () => {
  assert.throws(() => createProductionJob(null), ValidationError);
  assert.throws(() => createProductionJob({ type: 'unknown', title: 'X' }), ValidationError);
  assert.throws(() => createProductionJob({ type: 'tts_batch', title: '   ' }), ValidationError);
  assert.throws(() => assertJobId('../bad'), ValidationError);
  assert.throws(() => assertJobTitle('a'.repeat(201)), ValidationError);
  assert.throws(() => assertJobType('bogus'), ValidationError);
  assert.throws(
    () => createProductionJob({ type: 'tts_batch', title: 'Huge', items: Array.from({ length: MAX_JOB_ITEMS + 1 }, (_, i) => ({ itemId: `i-${i}` })) }),
    err => err instanceof ValidationError && err.code === 'TOO_MANY_JOB_ITEMS'
  );

  const job = createProductionJob({
    id: JOB_ID,
    projectId: PROJ_ID,
    type: 'tts_batch',
    title: '  Khmer Narration Batch  ',
    items: [
      { itemId: 'seg-1', segmentId: 'seg-1', label: 'Segment #1', status: 'completed', outputAssetId: ASSET_ID_1 },
      { itemId: 'seg-2', segmentId: 'seg-2', label: 'Segment #2' },
    ],
  });
  assert.equal(job.id, JOB_ID);
  assert.equal(job.projectId, PROJ_ID);
  assert.equal(job.title, 'Khmer Narration Batch');
  assert.equal(job.status, JOB_STATUS.QUEUED);
  assert.equal(job.progress.completed, 1);
  assert.equal(job.progress.total, 2);
  assert.equal(job.progress.percent, 50);
  assert.equal(Object.isFrozen(job), true);
  assert.equal(Object.isFrozen(job.items), true);
});

test('full lifecycle transitions: queued -> preparing -> running -> completed and invalid transitions throw ConflictError', () => {
  let job = createProductionJob({
    id: JOB_ID,
    type: 'tts_batch',
    title: 'Doc batch',
    items: [{ itemId: 's1', segmentId: 's1', label: 'Seg 1' }],
  });
  assert.equal(canTransitionJobStatus(JOB_STATUS.QUEUED, JOB_STATUS.PREPARING), true);
  assert.equal(canTransitionJobStatus(JOB_STATUS.COMPLETED, JOB_STATUS.QUEUED), false);

  job = transitionToPreparing(job, { workerSessionId: 'tab-1' });
  assert.equal(job.status, JOB_STATUS.PREPARING);
  assert.equal(job.revision, 2);

  job = transitionToRunning(job, { workerSessionId: 'tab-1' });
  assert.equal(job.status, JOB_STATUS.RUNNING);

  job = markJobItemRunning(job, 's1', { workerSessionId: 'tab-1' });
  assert.equal(job.items[0].status, 'running');
  assert.equal(job.items[0].attemptCount, 1);
  assert.equal(job.progress.currentItemId, 's1');

  job = touchJobHeartbeat(job, { workerSessionId: 'tab-1' });
  assert.ok(job.lastHeartbeatAt);

  job = markJobItemCompleted(job, { itemId: 's1', outputAssetId: ASSET_ID_1, takeId: 'take-1', durationSeconds: 2.5 });
  assert.equal(job.items[0].status, 'completed');
  assert.equal(job.artifacts.length, 1);

  // Idempotent item completion deduplicates artifacts without duplicating entries
  job = markJobItemCompleted(job, { itemId: 's1', outputAssetId: ASSET_ID_1, takeId: 'take-1', durationSeconds: 2.5 });
  assert.equal(job.artifacts.length, 1);

  job = completeProductionJob(job);
  assert.equal(job.status, JOB_STATUS.COMPLETED);
  assert.equal(job.progress.percent, 100);

  assert.throws(() => transitionToRunning(job), ConflictError);
  assert.throws(() => retryProductionJob(job), ConflictError);
  assert.throws(() => requestCancelProductionJob(job), ConflictError);
  assert.throws(() => applyJobLifecycleAction(job, { action: 'unknown' }), ValidationError);
});

test('failure, interruption, and cancellation preserve completed items/artifacts and retry resumes only unfinished items', () => {
  let job = createProductionJob({
    id: JOB_ID,
    type: 'subtitle_voiceover',
    title: 'Subtitle Batch',
    items: [
      { itemId: 'c1', segmentId: 'c1', label: 'Cue #1' },
      { itemId: 'c2', segmentId: 'c2', label: 'Cue #2' },
      { itemId: 'c3', segmentId: 'c3', label: 'Cue #3' },
    ],
  });
  job = transitionToPreparing(job, { workerSessionId: 'w1' });
  job = transitionToRunning(job, { workerSessionId: 'w1' });
  job = markJobItemRunning(job, 'c1', { workerSessionId: 'w1' });
  job = markJobItemCompleted(job, { itemId: 'c1', outputAssetId: ASSET_ID_1, takeId: 't1', durationSeconds: 1.2 });
  job = markJobItemRunning(job, 'c2', { workerSessionId: 'w1' });
  job = markJobItemFailed(job, { itemId: 'c2', error: 'Engine timeout' });
  job = failProductionJob(job, { code: 'ENGINE_TIMEOUT', message: 'Engine timeout', itemId: 'c2' });

  assert.equal(job.status, JOB_STATUS.FAILED);
  assert.equal(job.items[0].status, 'completed');
  assert.equal(job.items[1].status, 'failed');
  assert.equal(job.artifacts.length, 1);
  assert.equal(hasCompletedItemArtifact(job, 'c1'), true);
  assert.equal(hasCompletedItemArtifact(job, 'c2'), false);

  // Retry resets ONLY c2 & c3, preserves c1 and its artifact
  job = retryProductionJob(job);
  assert.equal(job.status, JOB_STATUS.QUEUED);
  assert.equal(job.retryCount, 1);
  assert.equal(job.attempt, 2);
  assert.equal(job.items[0].status, 'completed');
  assert.equal(job.items[1].status, 'pending');
  assert.equal(job.items[2].status, 'pending');
  assert.equal(job.artifacts.length, 1);
  assert.deepEqual(getPendingJobItems(job).map(i => i.itemId), ['c2', 'c3']);

  // Interrupted mid-run preserves c1 + c2 once completed
  job = transitionToPreparing(job, { workerSessionId: 'w2' });
  job = transitionToRunning(job, { workerSessionId: 'w2' });
  job = markJobItemRunning(job, 'c2', { workerSessionId: 'w2' });
  job = markJobItemCompleted(job, { itemId: 'c2', outputAssetId: ASSET_ID_2, takeId: 't2' });
  job = markJobItemRunning(job, 'c3', { workerSessionId: 'w2' });
  job = markJobInterrupted(job);

  assert.equal(job.status, JOB_STATUS.INTERRUPTED);
  assert.equal(job.items[0].status, 'completed');
  assert.equal(job.items[1].status, 'completed');
  assert.equal(job.items[2].status, 'interrupted');
  assert.equal(job.artifacts.length, 2);

  // Retry interrupted -> queued, only c3 pending
  job = retryProductionJob(job);
  assert.equal(job.status, JOB_STATUS.QUEUED);
  assert.equal(job.retryCount, 2);
  assert.deepEqual(getPendingJobItems(job).map(i => i.itemId), ['c3']);

  // Cancel flow: running -> cancel_requested -> cancelled preserves completed items
  job = transitionToRunning(job, { workerSessionId: 'w3' });
  job = requestCancelProductionJob(job);
  assert.equal(job.status, JOB_STATUS.CANCEL_REQUESTED);
  job = finalizeCancelledProductionJob(job);
  assert.equal(job.status, JOB_STATUS.CANCELLED);
  assert.equal(job.items[0].status, 'completed');
  assert.equal(job.items[1].status, 'completed');
  assert.equal(job.items[2].status, 'cancelled');
  assert.equal(job.artifacts.length, 2);

  // Exhaust max retries
  job = retryProductionJob(job); // retryCount = 3 == DEFAULT_MAX_RETRIES
  assert.equal(job.retryCount, DEFAULT_MAX_RETRIES);
  job = failProductionJob(job, { message: 'Boom' });
  assert.throws(() => retryProductionJob(job), err => err instanceof ValidationError && err.code === 'MAX_RETRIES_EXCEEDED');
});

test('bounded queue admission & eviction preserve active and interrupted jobs while pruning oldest history', () => {
  const makeJob = (suffix, status, ts) => createProductionJob({
    id: `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`,
    type: 'tts_batch',
    title: `Job ${suffix}`,
    status,
    createdAt: ts,
    updatedAt: ts,
  });

  const jobs = [
    makeJob(1, JOB_STATUS.FAILED, '2026-01-01T00:00:00Z'),
    makeJob(2, JOB_STATUS.COMPLETED, '2026-01-02T00:00:00Z'),
    makeJob(3, JOB_STATUS.INTERRUPTED, '2026-01-03T00:00:00Z'),
    makeJob(4, JOB_STATUS.RUNNING, '2026-01-04T00:00:00Z'),
  ];
  const eviction = selectEvictableJobs(jobs, 4);
  assert.equal(eviction.canAdmit, true);
  // Completed is evicted before failed; interrupted and running are never evicted
  assert.deepEqual(eviction.evictIds, [jobs[1].id]);

  // Active limit blocks new enqueue
  assert.throws(
    () => evaluateQueueAdmission([makeJob(1, JOB_STATUS.QUEUED, '2026-01-01T00:00:00Z')], { maxJobs: 10, maxActiveJobs: 1 }),
    err => err instanceof ValidationError && err.code === 'JOB_QUEUE_FULL'
  );

  // Interrupted jobs filling maxJobs block admission rather than being evicted
  assert.throws(
    () => evaluateQueueAdmission([makeJob(1, JOB_STATUS.INTERRUPTED, '2026-01-01T00:00:00Z'), makeJob(2, JOB_STATUS.INTERRUPTED, '2026-01-02T00:00:00Z')], { maxJobs: 2, maxActiveJobs: 10 }),
    err => err instanceof ValidationError && err.code === 'JOB_QUEUE_FULL'
  );

  const summary = summarizeJobs(jobs);
  assert.equal(summary.total, 4);
  assert.equal(summary.active, 1);
  assert.equal(summary.interrupted, 1);
});

test('isJobWorkerStale detects dead previous tab sessions and stale heartbeats accurately', () => {
  const now = Date.parse('2026-11-25T12:01:00Z');
  const job = createProductionJob({
    id: JOB_ID,
    type: 'tts_batch',
    title: 'Worker check',
    status: JOB_STATUS.RUNNING,
    workerSessionId: 'tab-old',
    lastHeartbeatAt: '2026-11-25T12:00:00Z',
  });
  assert.equal(isJobWorkerStale(job, { currentSessionId: 'tab-old', nowMs: now }), false);
  assert.equal(isJobWorkerStale(job, { currentSessionId: 'tab-new', previousSessionId: 'tab-old', nowMs: Date.parse('2026-11-25T12:00:05Z') }), true);
  assert.equal(isJobWorkerStale(job, { currentSessionId: 'tab-other', nowMs: now }), true);
  assert.equal(isJobWorkerStale({ ...job, status: JOB_STATUS.QUEUED }, { currentSessionId: 'tab-other', nowMs: now }), false);
});

test('TTS batch builders keep terminology once in job metadata, skip ready segments, and merge dirty takes safely', () => {
  const seg1 = {
    id: 'seg-1',
    text: 'Hello',
    voiceId: 'char-nisa',
    status: 'ready',
    takes: [{ id: 'take-1', text: 'Hello', voiceId: 'char-nisa', audioAssetId: ASSET_ID_1, duration: 1.5, isSelected: true, settings: { pronunciationSignature: 'sig-1', seed: 42 } }],
  };
  const seg2 = { id: 'seg-2', text: 'World', voiceId: 'char-sovath', status: 'draft', takes: [] };
  const items = buildTtsBatchJobItems({ segments: [seg1, seg2, { id: 'empty', text: '   ' }], defaultVoiceId: 'char-nisa', pronunciationSignature: 'sig-1' });
  assert.equal(items.length, 2);
  assert.equal(items[0].status, 'completed');
  assert.equal(items[0].outputAssetId, ASSET_ID_1);
  assert.equal(items[1].status, 'pending');
  assert.equal(items[1].metadata.voiceId, 'char-sovath');

  const artifacts = buildReadyJobArtifacts(items);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].assetId, ASSET_ID_1);

  const spec = buildTtsBatchJobSpec({
    projectId: PROJ_ID,
    projectTitle: 'My Script',
    activeCharacter: { id: 'char-nisa' },
    items,
    options: { guidance: 2, steps: 10 },
    terminology: [{ id: 't1', term: 'API', pronunciation: 'ay-pee-eye' }],
    pronunciationSignature: 'sig-1',
  });
  assert.equal(spec.metadata.options.terminology.length, 1);
  assert.equal(spec.metadata.options.pronunciationSignature, 'sig-1');
  assert.equal(spec.items[0].metadata.options, undefined);

  const merged = mergeUpdatedTakesIntoSegments(
    [{ id: 'seg-2', text: 'Edited local text', takes: [] }],
    [{ id: 'seg-2', text: 'World', takes: [{ id: 'take-new', audioAssetId: ASSET_ID_2, isSelected: true }], activeTakeId: 'take-new' }]
  );
  assert.equal(merged[0].text, 'Edited local text');
  assert.equal(merged[0].takes.length, 1);
  assert.equal(merged[0].activeTakeId, 'take-new');
});

test('createProductionJob rejects duplicate itemIds, completeProductionJob blocks failed items, and assertActiveQueueCapacity enforces cap', () => {
  assert.throws(
    () => createProductionJob({
      type: 'tts_batch',
      title: 'Duplicate items',
      items: [
        { itemId: 'dup-1', label: 'A' },
        { itemId: 'dup-1', label: 'B' },
      ],
    }),
    err => err instanceof ValidationError && err.code === 'DUPLICATE_JOB_ITEM_ID'
  );

  let job = createProductionJob({
    id: JOB_ID,
    type: 'tts_batch',
    title: 'Partial Failure',
    items: [
      { itemId: 'seg-1', label: 'Seg 1' },
      { itemId: 'seg-2', label: 'Seg 2' },
    ],
  });
  job = transitionToPreparing(job);
  job = transitionToRunning(job);
  job = markJobItemCompleted(job, { itemId: 'seg-1', outputAssetId: ASSET_ID_1 });
  job = markJobItemFailed(job, { itemId: 'seg-2', error: 'Boom' });
  assert.throws(() => completeProductionJob(job), ConflictError);

  const interruptedItemJob = createProductionJob({
    id: JOB_ID,
    type: 'tts_batch',
    title: 'Interrupted Item Guard',
    status: JOB_STATUS.RUNNING,
    items: [
      { itemId: 'seg-1', label: 'Seg 1', status: 'completed' },
      { itemId: 'seg-2', label: 'Seg 2', status: 'interrupted' },
    ],
  });
  assert.throws(() => completeProductionJob(interruptedItemJob), ConflictError);

  const cancelledItemJob = createProductionJob({
    id: JOB_ID,
    type: 'tts_batch',
    title: 'Cancelled Item Guard',
    status: JOB_STATUS.RUNNING,
    items: [
      { itemId: 'seg-1', label: 'Seg 1', status: 'completed' },
      { itemId: 'seg-2', label: 'Seg 2', status: 'cancelled' },
    ],
  });
  assert.throws(() => completeProductionJob(cancelledItemJob), ConflictError);

  assert.throws(
    () => assertActiveQueueCapacity([job], 1),
    err => err instanceof ValidationError && err.code === 'JOB_QUEUE_FULL'
  );
  assert.doesNotThrow(() => assertActiveQueueCapacity([{ ...job, status: JOB_STATUS.INTERRUPTED }], 1));
});

test('createQueuedProductionJob strips spoofed lifecycle fields, worker ownership guards prevent hijacking, and mergeUpdatedTakesIntoSegments promotes new selected take', () => {
  const sanitized = createQueuedProductionJob({
    id: JOB_ID,
    type: 'tts_batch',
    title: 'Fresh Job',
    status: JOB_STATUS.COMPLETED,
    revision: 99,
    attempt: 7,
    retryCount: 5,
    workerSessionId: 'spoof-tab',
    deletedAt: '2026-01-01T00:00:00Z',
    error: { code: 'OLD', message: 'Old error' },
  });
  assert.equal(sanitized.status, JOB_STATUS.QUEUED);
  assert.equal(sanitized.revision, 1);
  assert.equal(sanitized.attempt, 1);
  assert.equal(sanitized.retryCount, 0);
  assert.equal(sanitized.workerSessionId, null);
  assert.equal(sanitized.deletedAt, null);
  assert.equal(sanitized.error, null);

  // Heartbeat rejected on queued job and when workerSessionId mismatches owner
  assert.throws(() => touchJobHeartbeat(sanitized, { workerSessionId: 'tab-a' }), ConflictError);
  const owned = transitionToPreparing(
    createProductionJob({ id: JOB_ID, type: 'tts_batch', title: 'Owned', items: [{ itemId: 's1', label: 'S1' }] }),
    { workerSessionId: 'tab-a' }
  );
  assert.throws(
    () => touchJobHeartbeat(owned, { workerSessionId: 'tab-b' }),
    err => err instanceof ConflictError && err.code === 'WORKER_SESSION_MISMATCH'
  );
  assert.throws(
    () => transitionToRunning(owned, { workerSessionId: 'tab-b' }),
    err => err instanceof ConflictError && err.code === 'WORKER_SESSION_MISMATCH'
  );
  assert.throws(
    () => markJobItemRunning(owned, 's1', { workerSessionId: 'tab-b' }),
    err => err instanceof ConflictError && err.code === 'WORKER_SESSION_MISMATCH'
  );

  // Explicit empty pronunciationSignature is preserved in buildTtsBatchJobSpec
  const spec = buildTtsBatchJobSpec({
    projectId: PROJ_ID,
    projectTitle: 'Empty Sig',
    items: [],
    pronunciationSignature: '',
  });
  assert.equal(spec.metadata.options.pronunciationSignature, '');

  // mergeUpdatedTakesIntoSegments demotes old selected take and updates segment status
  const merged = mergeUpdatedTakesIntoSegments(
    [{
      id: 'seg-1',
      text: 'Hello',
      voiceId: 'char-nisa',
      status: 'outdated',
      takes: [{ id: 'take-old', text: 'Old', voiceId: 'char-nisa', audioAssetId: ASSET_ID_1, isSelected: true }],
    }],
    [{
      id: 'seg-1',
      text: 'Hello',
      voiceId: 'char-nisa',
      status: 'ready',
      takes: [
        { id: 'take-old', text: 'Old', voiceId: 'char-nisa', audioAssetId: ASSET_ID_1, isSelected: false },
        { id: 'take-new', text: 'Hello', voiceId: 'char-nisa', audioAssetId: ASSET_ID_2, isSelected: true },
      ],
      activeTakeId: 'take-new',
    }]
  );
  assert.equal(merged[0].takes.length, 2);
  assert.equal(merged[0].takes[0].isSelected, false);
  assert.equal(merged[0].takes[1].isSelected, true);
  assert.equal(merged[0].status, 'ready');
});
