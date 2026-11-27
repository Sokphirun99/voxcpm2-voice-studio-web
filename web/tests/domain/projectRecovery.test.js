/**
 * @fileoverview Pure domain tests for project recovery, draft comparison, and referenced asset integrity.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECOVERY_WORKSPACES,
  MISSING_ASSET_WARNING_TEXT,
  assertRecoveryWorkspace,
  formatDraftRecoveryTimestamp,
  buildDraftRecoveryPrompt,
  buildProjectDraft,
  shouldOfferDraftRecovery,
  collectReferencedAssets,
  assessAssetIntegrity,
  relinkProjectAsset,
} from '../../src/domain/projectRecovery.js';
import { ValidationError } from '../../src/domain/errors.js';

test('assertRecoveryWorkspace validates and normalizes workspace strings', () => {
  assert.equal(assertRecoveryWorkspace('tts'), 'tts');
  assert.equal(assertRecoveryWorkspace('subtitles'), 'subtitles');
  assert.equal(assertRecoveryWorkspace('subtitle'), 'subtitles');
  assert.equal(assertRecoveryWorkspace('dubbing'), 'dubbing');
  assert.throws(() => assertRecoveryWorkspace('invalid'), ValidationError);
  assert.throws(() => assertRecoveryWorkspace(''), ValidationError);
});

test('buildDraftRecoveryPrompt generates human-readable recovery prompt', () => {
  const ts = '2026-11-21T10:30:00.000Z';
  const prompt = buildDraftRecoveryPrompt(ts);
  assert.ok(prompt.startsWith('Unsaved draft recovered from '));
  assert.ok(prompt.endsWith('. Restore or Discard?'));

  const fallback = buildDraftRecoveryPrompt(null);
  assert.equal(fallback, 'Unsaved draft recovered from earlier session. Restore or Discard?');
});

test('buildProjectDraft freezes validated draft records', () => {
  const draft = buildProjectDraft({
    projectId: '11111111-1111-1111-1111-111111111111',
    workspace: 'tts',
    snapshot: { script: 'Hello world' },
    revision: 2,
  });
  assert.equal(draft.projectId, '11111111-1111-1111-1111-111111111111');
  assert.equal(draft.workspace, 'tts');
  assert.equal(draft.revision, 2);
  assert.ok(Object.isFrozen(draft));
  assert.throws(() => buildProjectDraft({ workspace: 'tts', snapshot: null }), ValidationError);
});

test('shouldOfferDraftRecovery detects unsaved draft after abrupt crash', () => {
  const draftTime = '2026-11-21T12:00:00.000Z';
  const savedTime = '2026-11-21T11:00:00.000Z';

  // 1. New draft without confirmed project
  const newTtsDraft = {
    workspace: 'tts',
    snapshot: { script: 'Unsaved script content' },
    timestamp: draftTime,
  };
  assert.equal(shouldOfferDraftRecovery({ draft: newTtsDraft, confirmedProject: null }), true);

  // 2. Empty draft without content
  const emptyDraft = {
    workspace: 'tts',
    snapshot: { script: '   ' },
    timestamp: draftTime,
  };
  assert.equal(shouldOfferDraftRecovery({ draft: emptyDraft, confirmedProject: null }), false);

  // 3. Draft is older than saved project -> false
  const oldDraft = {
    workspace: 'tts',
    snapshot: { script: 'Older text' },
    timestamp: '2026-11-21T10:00:00.000Z',
    revision: 1,
  };
  const confirmed = {
    revision: 1,
    updatedAt: savedTime,
    payload: { script: 'Saved text' },
  };
  assert.equal(shouldOfferDraftRecovery({ draft: oldDraft, confirmedProject: confirmed }), false);

  // 4. Draft is newer with modified content -> true
  const newerDraft = {
    workspace: 'tts',
    snapshot: { payload: { script: 'Modified uncommitted text' } },
    timestamp: draftTime,
    revision: 1,
  };
  assert.equal(shouldOfferDraftRecovery({ draft: newerDraft, confirmedProject: confirmed }), true);

  // 5. Draft is newer but has identical content -> false
  const identicalDraft = {
    workspace: 'tts',
    snapshot: { payload: { script: 'Saved text' } },
    timestamp: draftTime,
    revision: 1,
  };
  assert.equal(shouldOfferDraftRecovery({ draft: identicalDraft, confirmedProject: confirmed }), false);
});

test('collectReferencedAssets collects source, take, and settings asset references', () => {
  const sourceAssetId = '22222222-2222-2222-2222-222222222222';
  const takeAssetId = '33333333-3333-3333-3333-333333333333';
  const project = {
    id: '11111111-1111-1111-1111-111111111111',
    sourceAssetId,
    sourceAsset: { id: sourceAssetId, fileName: 'raw.mp4', kind: 'video' },
    segments: [
      {
        id: 'seg-1',
        text: 'Segment text',
        takes: [
          { id: 'take-1', audioAssetId: takeAssetId, duration: 2.5 },
          { id: 'take-2', audioAssetId: null, duration: 1.0 },
        ],
      },
    ],
  };

  const refs = collectReferencedAssets(project);
  assert.equal(refs.length, 2);
  assert.equal(refs[0].assetId, sourceAssetId);
  assert.equal(refs[0].location, 'sourceAsset');
  assert.equal(refs[1].assetId, takeAssetId);
  assert.equal(refs[1].location, 'segmentTake');
  assert.equal(refs[1].segmentId, 'seg-1');
});

test('assessAssetIntegrity reports missing assets with actionable warning', () => {
  const sourceAssetId = '22222222-2222-2222-2222-222222222222';
  const takeAssetId = '33333333-3333-3333-3333-333333333333';
  const project = {
    sourceAssetId,
    segments: [
      { id: 'seg-1', takes: [{ id: 'take-1', audioAssetId: takeAssetId }] },
    ],
  };

  // Case 1: All assets intact
  const allPresent = {
    [sourceAssetId]: { exists: true },
    [takeAssetId]: { exists: true },
  };
  const intactReport = assessAssetIntegrity(project, allPresent);
  assert.equal(intactReport.isIntact, true);
  assert.equal(intactReport.missingAssets.length, 0);
  assert.equal(intactReport.warningMessage, '');

  // Case 2: Source asset missing
  const missingSource = {
    [sourceAssetId]: { exists: false },
    [takeAssetId]: { exists: true },
  };
  const missingReport = assessAssetIntegrity(project, missingSource);
  assert.equal(missingReport.isIntact, false);
  assert.equal(missingReport.missingAssets.length, 1);
  assert.equal(missingReport.missingAssets[0].assetId, sourceAssetId);
  assert.equal(missingReport.warningMessage, MISSING_ASSET_WARNING_TEXT);
});

test('relinkProjectAsset replaces asset reference without corrupting other project data', () => {
  const oldSourceId = '22222222-2222-2222-2222-222222222222';
  const newSourceId = '44444444-4444-4444-4444-444444444444';
  const takeAssetId = '33333333-3333-3333-3333-333333333333';
  const project = {
    id: '11111111-1111-1111-1111-111111111111',
    title: 'Dubbing project',
    sourceAssetId: oldSourceId,
    sourceAsset: { id: oldSourceId, fileName: 'old.mp4', kind: 'video', sizeBytes: 100 },
    segments: [
      { id: 'seg-1', text: 'Text 1', takes: [{ id: 'take-1', audioAssetId: takeAssetId }] },
    ],
  };

  const newAsset = { id: newSourceId, fileName: 'relinked.mp4', kind: 'video', sizeBytes: 200 };
  const updated = relinkProjectAsset(project, oldSourceId, newAsset);

  assert.equal(updated.sourceAssetId, newSourceId);
  assert.equal(updated.sourceAsset.id, newSourceId);
  assert.equal(updated.sourceAsset.fileName, 'relinked.mp4');
  // Unrelated takes must stay intact
  assert.equal(updated.segments[0].takes[0].audioAssetId, takeAssetId);
  assert.equal(updated.title, 'Dubbing project');
  assert.ok(Object.isFrozen(updated));
});

test('relinkProjectAsset relinks settings referenceAudio, videoAsset, and payload segments without corruption', () => {
  const oldRefAudioId = '22222222-2222-2222-2222-222222222222';
  const newRefAudioId = '55555555-5555-5555-5555-555555555555';
  const oldTakeId = '33333333-3333-3333-3333-333333333333';
  const newTakeId = '66666666-6666-6666-6666-666666666666';

  const project = {
    id: '11111111-1111-1111-1111-111111111111',
    settings: {
      referenceAudioAssetId: oldRefAudioId,
      videoAssetId: '77777777-7777-7777-7777-777777777777',
    },
    payload: {
      referenceAudioAssetId: oldRefAudioId,
      segments: [
        { id: 'seg-1', takes: [{ id: 'take-1', audioAssetId: oldTakeId }] },
      ],
    },
  };

  const relinkedSettings = relinkProjectAsset(project, oldRefAudioId, { id: newRefAudioId });
  assert.equal(relinkedSettings.settings.referenceAudioAssetId, newRefAudioId);
  assert.equal(relinkedSettings.payload.referenceAudioAssetId, newRefAudioId);
  assert.equal(relinkedSettings.settings.videoAssetId, '77777777-7777-7777-7777-777777777777');
  // top-level segments must remain undefined if it was undefined
  assert.equal(relinkedSettings.segments, undefined);

  const relinkedTake = relinkProjectAsset(project, oldTakeId, { id: newTakeId });
  assert.equal(relinkedTake.payload.segments[0].takes[0].audioAssetId, newTakeId);
  assert.equal(relinkedTake.segments, undefined);
});
