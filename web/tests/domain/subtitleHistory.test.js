/**
 * @fileoverview Unit tests for pure domain subtitle Undo/Redo history stack and take reconciliation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearSubtitleHistoryCoalesce,
  createEmptySubtitleHistory,
  createSubtitleHistorySnapshot,
  pushSubtitleHistoryEntry,
  redoSubtitleHistory,
  restoreSubtitleSnapshotTakes,
  undoSubtitleHistory,
} from '../../src/domain/subtitleHistory.js';

test('subtitleHistory records edits, ignores no-ops, clears redo on new edit, and bounds stack size', () => {
  const empty = createEmptySubtitleHistory();
  assert.deepEqual(empty.past, []);
  assert.deepEqual(empty.future, []);

  const s0 = createSubtitleHistorySnapshot({ segments: [{ id: 'c1', text: 'One' }], hasTranslation: false, translatedLanguage: '' });
  assert.equal(pushSubtitleHistoryEntry(empty, s0, s0), empty);

  const s1 = createSubtitleHistorySnapshot({ segments: [{ id: 'c1', text: 'Two' }], hasTranslation: false, translatedLanguage: '' });
  const s2 = createSubtitleHistorySnapshot({ segments: [{ id: 'c1', text: 'Three' }], hasTranslation: true, translatedLanguage: 'khm_Khmr' });

  let history = pushSubtitleHistoryEntry(empty, s0, s1, { maxEntries: 2 });
  history = pushSubtitleHistoryEntry(history, s1, s2, { maxEntries: 2 });
  assert.equal(history.past.length, 2);

  const s3 = createSubtitleHistorySnapshot({ segments: [{ id: 'c1', text: 'Four' }], hasTranslation: true, translatedLanguage: 'khm_Khmr' });
  history = pushSubtitleHistoryEntry(history, s2, s3, { maxEntries: 2 });
  assert.equal(history.past.length, 2);
  assert.equal(history.past[0].segments[0].text, 'Two');

  const undone = undoSubtitleHistory(history, s3);
  assert.equal(undone.applied, true);
  assert.equal(undone.snapshot.segments[0].text, 'Three');
  assert.equal(undone.history.future.length, 1);

  // New edit clears Redo stack
  const s4 = createSubtitleHistorySnapshot({ segments: [{ id: 'c1', text: 'Branch' }], hasTranslation: true, translatedLanguage: 'khm_Khmr' });
  const branched = pushSubtitleHistoryEntry(undone.history, undone.snapshot, s4);
  assert.equal(branched.future.length, 0);

  // Empty Undo/Redo returns applied: false
  assert.equal(undoSubtitleHistory(empty, s0).applied, false);
  assert.equal(redoSubtitleHistory(empty, s0).applied, false);
});

test('subtitleHistory coalesces typing bursts within window and breaks on blur or different keys', () => {
  const s0 = { segments: [{ id: 'c1', text: 'A' }], hasTranslation: false, translatedLanguage: '' };
  const s1 = { segments: [{ id: 'c1', text: 'AB' }], hasTranslation: false, translatedLanguage: '' };
  const s2 = { segments: [{ id: 'c1', text: 'ABC' }], hasTranslation: false, translatedLanguage: '' };
  const s3 = { segments: [{ id: 'c1', text: 'ABCD' }], hasTranslation: false, translatedLanguage: '' };

  let history = pushSubtitleHistoryEntry(createEmptySubtitleHistory(), s0, s1, { coalesceKey: 'text:c1', now: 1000 });
  history = pushSubtitleHistoryEntry(history, s1, s2, { coalesceKey: 'text:c1', now: 1400, coalesceWindowMs: 800 });
  assert.equal(history.past.length, 1);
  assert.equal(history.past[0].segments[0].text, 'A');

  // Breaking coalesce boundary forces a new undo entry even within 800ms
  history = clearSubtitleHistoryCoalesce(history);
  history = pushSubtitleHistoryEntry(history, s2, s3, { coalesceKey: 'text:c1', now: 1500, coalesceWindowMs: 800 });
  assert.equal(history.past.length, 2);
  assert.equal(history.past[1].segments[0].text, 'ABC');

  const undo1 = undoSubtitleHistory(history, s3);
  assert.equal(undo1.snapshot.segments[0].text, 'ABC');
  const redo1 = redoSubtitleHistory(undo1.history, undo1.snapshot);
  assert.equal(redo1.applied, true);
  assert.equal(redo1.snapshot.segments[0].text, 'ABCD');
});

test('restoreSubtitleSnapshotTakes preserves live audio takes on existing cues and restores snapshot takes for resurrected cues', () => {
  const liveTakes = [{ id: 'take-2', audioAssetId: 'asset-2', isSelected: true }];
  const snapTakes = [{ id: 'take-1', audioAssetId: 'asset-1', isSelected: true }];
  const restored = restoreSubtitleSnapshotTakes(
    [
      { id: 'c1', text: 'Edited back', takes: snapTakes, voiceId: 'v1', status: 'ready' },
      { id: 'c2', text: 'Resurrected cue', takes: snapTakes, voiceId: 'v1', status: 'ready' },
    ],
    [
      { id: 'c1', text: 'Edited', takes: liveTakes, voiceId: 'v2', status: 'ready' },
    ]
  );

  assert.equal(restored[0].takes, liveTakes);
  assert.equal(restored[0].voiceId, 'v2');
  assert.equal(restored[1].takes, snapTakes);
  assert.equal(restored[1].voiceId, 'v1');
});

test('restoreSubtitleSnapshotTakes does not clobber voiceId edits or inject takes when neither side has takes', () => {
  const snapSeg = { id: 'c1', text: 'Original', voiceId: 'v1' };
  const liveSeg = { id: 'c1', text: 'Edited', voiceId: 'v2' };
  const restored = restoreSubtitleSnapshotTakes([snapSeg], [liveSeg]);
  assert.equal(restored[0], snapSeg);
  assert.equal(restored[0].voiceId, 'v1');
  assert.equal('takes' in restored[0], false);
});
