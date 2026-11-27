import test from 'node:test';
import assert from 'node:assert/strict';
import { ValidationError } from '../../src/domain/errors.js';
import { createSegmentTake } from '../../src/domain/projects.js';
import {
  SEGMENT_STATUSES,
  DEFAULT_SEGMENT_STATUS,
  splitGraphemeClusters,
  countGraphemeClusters,
  sliceGraphemeClusters,
  isGraphemeClusterIntact,
  assertSegmentStatus,
  computeSegmentStatus,
  isSegmentOutdated,
  isSegmentReady,
  createEditableSegment,
  updateSegmentContent,
  updateSegmentInList,
  computeLcsMatches,
  reconcileScriptToSegments,
  scriptToSegments,
  segmentsToScript,
  attachTakesToSegments,
  attachTakeToSegment,
  selectSegmentTake,
  removeSegmentTake,
  getSegmentTake,
  selectSegmentTakeInList,
  removeSegmentTakeInList,
  getSegmentActiveTake,
  hasSegmentAudio,
  findSegmentById,
  snapToGraphemeBoundary,
  splitSegment,
  splitSegmentInList,
  mergeAdjacentSegments,
  mergeSegments,
  reorderSegments,
  moveSegmentUp,
  moveSegmentDown,
  insertSegment,
  deleteSegment,
  assignSegmentVoice,
  assignSegmentVoiceInList,
  isMultiSpeakerScript,
  getScriptVoiceIds,
  isTakeOutdated,
  cycleSegmentTake,
  cycleSegmentTakeInList,
} from '../../src/domain/projectSegments.js';

test('Khmer grapheme integrity: splitGraphemeClusters preserves complex clusters without corruption', () => {
  const words = [
    'ខ្ញុំ', // khnhom (kh + coeng + nh + om)
    'កម្ពុជា', // kampuchea (k + m + coeng + p + u + ch + a)
    'សង្គ្រាម', // sangkream (s + ng + coeng + k + coeng + r + a + m)
    'កាត់', // kat (k + a + t + bantoc)
    'ព័ត៌មាន', // poadamean (p + samyok sanya + t + robat + m + a + n)
    'ធម៌', // thoam (th + m + robat)
    'ជ័យ', // chey (ch + samyok sanya + y)
    'ប៉ា', // pa (b + triisap + a)
    'ទូរទស្សន៍', // turotuoh (with toandakhiat)
  ];

  for (const word of words) {
    const clusters = splitGraphemeClusters(word);
    assert.equal(clusters.join(''), word, `Rejoined clusters should exactly equal original for ${word}`);
    // Verify no cluster starts with an unattached combining mark or coeng
    for (const cluster of clusters) {
      assert.ok(isGraphemeClusterIntact(cluster), `Cluster ${cluster} from ${word} must be intact`);
    }
  }
});

test('Khmer grapheme integrity: sliceGraphemeClusters slices at grapheme boundaries', () => {
  const text = 'សួស្តីកម្ពុជា';
  const slicedFirstTwo = sliceGraphemeClusters(text, 0, 2);
  assert.equal(slicedFirstTwo, 'សួស្តី');
  assert.ok(isGraphemeClusterIntact(slicedFirstTwo));

  const count = countGraphemeClusters(text);
  assert.equal(count, 5); // សួ (1), ស្តី (2), ក (3), ម្ពុ (4), ជា (5)
});

test('Khmer grapheme integrity: isGraphemeClusterIntact flags broken clusters', () => {
  assert.equal(isGraphemeClusterIntact('សួស្តី'), true);
  assert.equal(isGraphemeClusterIntact(''), true);
  // Unattached coeng at end of string
  assert.equal(isGraphemeClusterIntact('ក\u17D2'), false);
  // Unattached coeng followed by space
  assert.equal(isGraphemeClusterIntact('ក\u17D2 '), false);
  // Unattached coeng followed by punctuation
  assert.equal(isGraphemeClusterIntact('ក\u17D2។'), false);
  // Isolated vowel at beginning
  assert.equal(isGraphemeClusterIntact('\u17B6ក'), false);
  // Isolated vowel after space
  assert.equal(isGraphemeClusterIntact(' \u17B6ក'), false);
  // Isolated bantoc
  assert.equal(isGraphemeClusterIntact('\u17CB'), false);
  // Non-string
  assert.equal(isGraphemeClusterIntact(null), false);
});

test('Segment status: assertSegmentStatus validates supported statuses', () => {
  for (const status of SEGMENT_STATUSES) {
    assert.equal(assertSegmentStatus(status), status);
    assert.equal(assertSegmentStatus(` ${status.toUpperCase()} `), status);
  }
  assert.throws(() => assertSegmentStatus('invalid'), ValidationError);
  assert.throws(() => assertSegmentStatus(''), ValidationError);
  assert.throws(() => assertSegmentStatus(null), ValidationError);
});

test('Segment status lifecycle: computeSegmentStatus evaluates draft, ready, outdated, and error', () => {
  // 1. Newly created segment without takes -> draft
  const segDraft = createEditableSegment({ id: 'seg-1', text: 'សួស្តី' });
  assert.equal(segDraft.status, 'draft');
  assert.equal(isSegmentReady(segDraft), false);
  assert.equal(isSegmentOutdated(segDraft), false);

  // 2. Segment with matching take -> ready
  const take = createSegmentTake({
    id: 'take-1',
    duration: 1.5,
    isSelected: true,
    settings: { text: 'សួស្តី', voiceId: 'char-1' },
  });
  const segReady = createEditableSegment({
    id: 'seg-1',
    text: 'សួស្តី',
    voiceId: 'char-1',
    takes: [take],
  });
  assert.equal(segReady.status, 'ready');
  assert.equal(isSegmentReady(segReady), true);
  assert.equal(isSegmentOutdated(segReady), false);

  // 3. Text edited -> outdated
  const segTextEdited = updateSegmentContent(segReady, { text: 'សួស្តីអ្នកទាំងអស់គ្នា' });
  assert.equal(segTextEdited.status, 'outdated');
  assert.equal(isSegmentOutdated(segTextEdited), true);
  assert.equal(isSegmentReady(segTextEdited), false);

  // 4. Text edited back -> ready
  const segTextReverted = updateSegmentContent(segTextEdited, { text: 'សួស្តី' });
  assert.equal(segTextReverted.status, 'ready');
  assert.equal(isSegmentReady(segTextReverted), true);

  // 5. Voice changed -> outdated
  const segVoiceEdited = updateSegmentContent(segReady, { voiceId: 'char-2' });
  assert.equal(segVoiceEdited.status, 'outdated');

  // 6. Error status preserved
  const segError = updateSegmentContent(segReady, { status: 'error' });
  assert.equal(segError.status, 'error');
});

test('Segment editing: updateSegmentContent preserves stable UUID and take history', () => {
  const take = createSegmentTake({ id: 't-1', duration: 2.0 });
  const seg = createEditableSegment({
    id: 'stable-uuid-1',
    text: 'Phrase A',
    voiceId: 'voice-1',
    pauseDuration: 0.5,
    takes: [take],
  });

  const updated = updateSegmentContent(seg, { text: 'Phrase B', pauseDuration: 1.0 });
  assert.equal(updated.id, 'stable-uuid-1');
  assert.equal(updated.text, 'Phrase B');
  assert.equal(updated.voiceId, 'voice-1');
  assert.equal(updated.pauseDuration, 1.0);
  assert.equal(updated.takes.length, 1);
  assert.equal(updated.takes[0].id, 't-1');
  assert.equal(updated.status, 'outdated');
  assert.ok(Object.isFrozen(updated));
});

test('Segment editing: updateSegmentInList preserves other segments strictly unchanged by reference', () => {
  const seg1 = createEditableSegment({ id: 'seg-1', text: 'Sentence 1.' });
  const seg2 = createEditableSegment({ id: 'seg-2', text: 'Sentence 2.' });
  const seg3 = createEditableSegment({ id: 'seg-3', text: 'Sentence 3.' });
  const list = [seg1, seg2, seg3];

  const updatedList = updateSegmentInList(list, 'seg-2', { text: 'Sentence 2 edited.' });
  assert.equal(updatedList.length, 3);
  // seg1 and seg3 must remain strictly identical object references
  assert.equal(updatedList[0], seg1);
  assert.equal(updatedList[2], seg3);
  // seg2 is updated in place
  assert.notEqual(updatedList[1], seg2);
  assert.equal(updatedList[1].id, 'seg-2');
  assert.equal(updatedList[1].text, 'Sentence 2 edited.');
});

test('Reconciliation: reconcileScriptToSegments handles empty and single-line scripts', () => {
  assert.deepEqual(reconcileScriptToSegments([], ''), []);
  assert.deepEqual(reconcileScriptToSegments([], '   '), []);

  const segments = reconcileScriptToSegments([], 'សួស្តីអ្នកទាំងអស់គ្នា។', { defaultVoiceId: 'char-1' });
  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, 'សួស្តីអ្នកទាំងអស់គ្នា។');
  assert.equal(segments[0].voiceId, 'char-1');
  assert.equal(segments[0].status, 'draft');
  assert.ok(segments[0].id.length > 0);
});

test('Reconciliation: parses pause tags into pauseDuration in seconds', () => {
  const script = 'ជំហានទីមួយ។ [pause 0.8s] ជំហានទីពីរ។ [pause 500ms] ជំហានទីបី។';
  const segments = reconcileScriptToSegments([], script);
  assert.equal(segments.length, 3);
  assert.equal(segments[0].text, 'ជំហានទីមួយ។');
  assert.equal(segments[0].pauseDuration, 0.8);
  assert.equal(segments[1].text, 'ជំហានទីពីរ។');
  assert.equal(segments[1].pauseDuration, 0.5);
  assert.equal(segments[2].text, 'ជំហានទីបី។');
  assert.equal(segments[2].pauseDuration, null);
});

test('Reconciliation: editing one segment preserves unrelated segment IDs and object references', () => {
  const initialScript = 'ផ្នែកទី១។\nផ្នែកទី២។\nផ្នែកទី៣។';
  const initialSegments = reconcileScriptToSegments([], initialScript);
  assert.equal(initialSegments.length, 3);
  const id1 = initialSegments[0].id;
  const id2 = initialSegments[1].id;
  const id3 = initialSegments[2].id;

  // Add a take to segment 2 so we can verify status becomes outdated
  const take2 = createSegmentTake({
    id: 'take-seg-2',
    duration: 1.0,
    isSelected: true,
    settings: { text: 'ផ្នែកទី២។' },
  });
  const segmentsWithTake = updateSegmentInList(initialSegments, id2, {
    takes: [take2],
    status: 'ready',
  });
  assert.equal(segmentsWithTake[1].status, 'ready');

  // Now user edits only segment 2 in the raw script
  const editedScript = 'ផ្នែកទី១។\nផ្នែកទី២បានកែប្រែ។\nផ្នែកទី៣។';
  const reconciled = reconcileScriptToSegments(segmentsWithTake, editedScript);

  assert.equal(reconciled.length, 3);
  // Segments 1 and 3 are completely unchanged with same object references
  assert.equal(reconciled[0], segmentsWithTake[0]);
  assert.equal(reconciled[2], segmentsWithTake[2]);
  assert.equal(reconciled[0].id, id1);
  assert.equal(reconciled[2].id, id3);

  // Segment 2 kept its stable ID and take history, but text updated and marked outdated
  assert.equal(reconciled[1].id, id2);
  assert.equal(reconciled[1].text, 'ផ្នែកទី២បានកែប្រែ។');
  assert.equal(reconciled[1].takes.length, 1);
  assert.equal(reconciled[1].status, 'outdated');
});

test('Reconciliation: appending new text keeps existing segments untouched', () => {
  const baseScript = 'កថាខណ្ឌទីមួយ។\nកថាខណ្ឌទីពីរ។';
  const baseSegments = reconcileScriptToSegments([], baseScript);
  assert.equal(baseSegments.length, 2);

  const extendedScript = 'កថាខណ្ឌទីមួយ។\nកថាខណ្ឌទីពីរ។\nកថាខណ្ឌទីបីថ្មី។';
  const reconciled = reconcileScriptToSegments(baseSegments, extendedScript);

  assert.equal(reconciled.length, 3);
  assert.equal(reconciled[0], baseSegments[0]);
  assert.equal(reconciled[1], baseSegments[1]);
  assert.equal(reconciled[2].text, 'កថាខណ្ឌទីបីថ្មី។');
  assert.equal(reconciled[2].status, 'draft');
  assert.notEqual(reconciled[2].id, baseSegments[0].id);
  assert.notEqual(reconciled[2].id, baseSegments[1].id);
});

test('Reconciliation: deleting a sentence drops only the deleted segment', () => {
  const initialScript = 'ប្រយោគក។\nប្រយោគខ។\nប្រយោគគ។';
  const initialSegments = reconcileScriptToSegments([], initialScript);

  // Delete middle sentence
  const reducedScript = 'ប្រយោគក។\nប្រយោគគ។';
  const reconciled = reconcileScriptToSegments(initialSegments, reducedScript);

  assert.equal(reconciled.length, 2);
  assert.equal(reconciled[0], initialSegments[0]);
  assert.equal(reconciled[1], initialSegments[2]);
});

test('Reconciliation & Serialization: segmentsToScript roundtrip with pauses', () => {
  const seg1 = createEditableSegment({ id: 's1', text: 'ឃ្លាទីមួយ។', pauseDuration: 0.6 });
  const seg2 = createEditableSegment({ id: 's2', text: 'ឃ្លាទីពីរ។', pauseDuration: null });
  const scriptText = segmentsToScript([seg1, seg2]);
  assert.equal(scriptText, 'ឃ្លាទីមួយ។ [pause 0.6s]\nឃ្លាទីពីរ។');

  const roundtrip = reconcileScriptToSegments([seg1, seg2], scriptText);
  assert.equal(roundtrip.length, 2);
  assert.equal(roundtrip[0].id, 's1');
  assert.equal(roundtrip[0].pauseDuration, 0.6);
  assert.equal(roundtrip[1].id, 's2');
});

test('Edge cases: grapheme functions handle empty, null, and non-string inputs safely', () => {
  assert.deepEqual(splitGraphemeClusters(''), []);
  assert.deepEqual(splitGraphemeClusters(null), []);
  assert.equal(countGraphemeClusters(''), 0);
  assert.equal(countGraphemeClusters(null), 0);
  assert.equal(sliceGraphemeClusters('', 0, 5), '');
  assert.equal(sliceGraphemeClusters(null, 0, 5), '');
  assert.equal(computeSegmentStatus(null), DEFAULT_SEGMENT_STATUS);
  assert.equal(updateSegmentInList([], 'non-existent', {}).length, 0);
  assert.equal(updateSegmentInList(null, 'id', {}).length, 0);
  assert.equal(segmentsToScript([]), '');
  assert.equal(segmentsToScript(null), '');
});

test('Edge cases: computeSegmentStatus handles multi-take selection and fallback', () => {
  const take1 = createSegmentTake({
    id: 't1',
    isSelected: false,
    settings: { text: 'Old text', voiceId: 'v1' },
  });
  const take2 = createSegmentTake({
    id: 't2',
    isSelected: true,
    settings: { text: 'Current text', voiceId: 'v1' },
  });
  const seg = createEditableSegment({
    id: 's-multi',
    text: 'Current text',
    voiceId: 'v1',
    takes: [take1, take2],
  });
  // Active take is take2 which matches text -> ready
  assert.equal(computeSegmentStatus(seg), 'ready');

  // Change selection to take1 which has 'Old text' -> outdated
  const take2Unselected = { ...take2, isSelected: false };
  const take1Selected = { ...take1, isSelected: true };
  const segSwitched = updateSegmentContent(seg, { takes: [take1Selected, take2Unselected] });
  assert.equal(computeSegmentStatus(segSwitched), 'outdated');
});

test('Edge cases: updateSegmentContent rejects null or invalid segments', () => {
  assert.throws(() => updateSegmentContent(null, { text: 'abc' }), ValidationError);
  assert.throws(() => updateSegmentContent({}, { text: 'abc' }), ValidationError);
  assert.throws(() => updateSegmentContent({ text: 'no id' }, { text: 'abc' }), ValidationError);
});

test('scriptToSegments converts raw script into editable ProjectSegment records', () => {
  const segments = scriptToSegments('ប្រយោគទីមួយ។ [pause 1s] ប្រយោគទីពីរ។', { defaultVoiceId: 'char-1' });
  assert.equal(segments.length, 2);
  assert.equal(segments[0].text, 'ប្រយោគទីមួយ។');
  assert.equal(segments[0].pauseDuration, 1.0);
  assert.equal(segments[0].voiceId, 'char-1');
  assert.equal(segments[0].status, 'draft');
  assert.equal(segments[1].text, 'ប្រយោគទីពីរ។');
  assert.equal(segments[1].pauseDuration, null);
  assert.equal(segments[1].status, 'draft');
  assert.deepEqual(scriptToSegments(''), []);
  assert.deepEqual(scriptToSegments('   '), []);
});

test('attachTakesToSegments links generated recording chunks and marks segments ready', () => {
  const seg1 = createEditableSegment({ id: 's1', text: 'ផ្នែកទី១។' });
  const seg2 = createEditableSegment({ id: 's2', text: 'ផ្នែកទី២។' });
  const initial = [seg1, seg2];

  assert.equal(initial[0].status, 'draft');
  assert.equal(initial[1].status, 'draft');

  const mockRecording = {
    id: 'rec-123',
    characterId: 'voice-a',
    duration: 3.5,
    seed: 9999,
    chunks: [
      { text: 'ផ្នែកទី១។', durationSeconds: 1.8, seed: 9999 },
      { text: 'ផ្នែកទី២។', durationSeconds: 1.7, seed: 9999 },
    ],
  };

  const attached = attachTakesToSegments(initial, mockRecording, { voiceId: 'voice-a' });
  assert.equal(attached.length, 2);
  assert.equal(attached[0].status, 'ready');
  assert.equal(attached[1].status, 'ready');
  assert.equal(attached[0].takes.length, 1);
  assert.equal(attached[0].takes[0].settings.text, 'ផ្នែកទី១។');
  assert.equal(attached[0].takes[0].settings.voiceId, 'voice-a');
  assert.equal(attached[0].takes[0].settings.seed, 9999);
  assert.equal(attached[1].takes.length, 1);
  assert.equal(attached[1].takes[0].settings.text, 'ផ្នែកទី២។');

  // Verify that subsequent text edit marks only edited segment outdated
  const edited = updateSegmentInList(attached, 's1', { text: 'ផ្នែកទី១កែសម្រួល។' });
  assert.equal(edited[0].status, 'outdated');
  assert.equal(edited[1].status, 'ready');

  // Edge cases
  assert.deepEqual(attachTakesToSegments([], mockRecording), []);
  assert.equal(attachTakesToSegments(initial, null), initial);
});

test('snapToGraphemeBoundary: snaps cursor safely outside Khmer combining characters and coeng', () => {
  // Empty, null, non-string, negative, out of bounds
  assert.equal(snapToGraphemeBoundary('', 3), 0);
  assert.equal(snapToGraphemeBoundary(null, 2), 0);
  assert.equal(snapToGraphemeBoundary('abc', -1), 0);
  assert.equal(snapToGraphemeBoundary('abc', 10), 3);

  // Khmer: កម្ពុជា has safe boundaries at 0, 1, 5, 7
  const word = 'កម្ពុជា';
  assert.equal(snapToGraphemeBoundary(word, 0), 0);
  assert.equal(snapToGraphemeBoundary(word, 1), 1);
  assert.equal(snapToGraphemeBoundary(word, 2), 1); // inside ម្ពុ -> snaps to 1
  assert.equal(snapToGraphemeBoundary(word, 3), 1); // inside ម្ពុ -> snaps to 1
  assert.equal(snapToGraphemeBoundary(word, 4), 5); // closer to 5 -> snaps to 5
  assert.equal(snapToGraphemeBoundary(word, 5), 5);
  assert.equal(snapToGraphemeBoundary(word, 6), 5); // inside ជា -> snaps to 5
  assert.equal(snapToGraphemeBoundary(word, 7), 7);

  // For every snapped offset, both halves must remain intact
  for (let i = 0; i <= word.length; i += 1) {
    const safe = snapToGraphemeBoundary(word, i);
    const left = word.slice(0, safe);
    const right = word.slice(safe);
    assert.ok(isGraphemeClusterIntact(left), `Left "${left}" must be intact for raw ${i}`);
    assert.ok(isGraphemeClusterIntact(right), `Right "${right}" must be intact for raw ${i}`);
  }
});

test('splitSegment: splits segment, snaps to grapheme boundary, invalidates takes, and resets status to draft', () => {
  const take = createSegmentTake({ id: 't1', duration: 2.0, isSelected: true, settings: { text: 'កម្ពុជា' } });
  const seg = createEditableSegment({
    id: 'seg-orig',
    text: 'កម្ពុជា',
    voiceId: 'char-1',
    speaker: 'Speaker 1',
    pauseDuration: 1.2,
    takes: [take],
    status: 'ready',
  });

  // Attempt to split at offset 3 (inside sub-consonant cluster ម្ពុ)
  const [seg1, seg2] = splitSegment(seg, 3);

  // 1. First half keeps original ID; second half gets a new unique ID
  assert.equal(seg1.id, 'seg-orig');
  assert.notEqual(seg2.id, 'seg-orig');
  assert.ok(seg2.id.length > 5);

  // 2. Both halves snapped cleanly to safe boundary
  assert.equal(seg1.text, 'ក');
  assert.equal(seg2.text, 'ម្ពុជា');
  assert.ok(isGraphemeClusterIntact(seg1.text));
  assert.ok(isGraphemeClusterIntact(seg2.text));

  // 3. Takes are invalidated on both halves (transition to draft)
  assert.equal(seg1.status, 'draft');
  assert.equal(seg2.status, 'draft');
  assert.equal(seg1.takes.length, 0);
  assert.equal(seg2.takes.length, 0);

  // 4. Voice and speaker are preserved
  assert.equal(seg1.voiceId, 'char-1');
  assert.equal(seg2.voiceId, 'char-1');
  assert.equal(seg1.speaker, 'Speaker 1');
  assert.equal(seg2.speaker, 'Speaker 1');

  // 5. Pause duration: original pause goes to the trailing half (seg2)
  assert.equal(seg1.pauseDuration, null);
  assert.equal(seg2.pauseDuration, 1.2);

  // 6. Validation error on invalid segment
  assert.throws(() => splitSegment(null, 1), ValidationError);
  assert.throws(() => splitSegment({}, 1), ValidationError);
});

test('splitSegment: defaults offset to text midpoint when omitted and avoids empty halves', () => {
  const seg = createEditableSegment({
    id: 'seg-mid',
    text: 'សួស្តីអ្នកទាំងអស់គ្នា។',
  });
  const [first, second] = splitSegment(seg);
  assert.equal(first.id, 'seg-mid');
  assert.notEqual(second.id, 'seg-mid');
  assert.ok(first.text.length > 0, 'First half must not be empty');
  assert.ok(second.text.length > 0, 'Second half must not be empty');
  assert.ok(isGraphemeClusterIntact(first.text));
  assert.ok(isGraphemeClusterIntact(second.text));
});

test('splitSegmentInList: splits target segment and preserves all other segments unchanged', () => {
  const take1 = createSegmentTake({ id: 't1', duration: 1.0 });
  const take3 = createSegmentTake({ id: 't3', duration: 1.0 });
  const s1 = createEditableSegment({ id: 's1', text: 'ប្រយោគមួយ។', takes: [take1], status: 'ready' });
  const s2 = createEditableSegment({ id: 's2', text: 'ប្រយោគពីរ។ ប្រយោគបី។', status: 'ready' });
  const s3 = createEditableSegment({ id: 's3', text: 'ប្រយោគបួន។', takes: [take3], status: 'ready' });
  const list = [s1, s2, s3];

  const splitList = splitSegmentInList(list, 's2', 11);
  assert.equal(splitList.length, 4);

  // s1 and s3 must be strictly identical object references
  assert.equal(splitList[0], s1);
  assert.equal(splitList[3], s3);

  // s2 was split into two draft segments
  assert.equal(splitList[1].id, 's2');
  assert.equal(splitList[1].text, 'ប្រយោគពីរ។');
  assert.equal(splitList[1].status, 'draft');
  assert.equal(splitList[2].text, 'ប្រយោគបី។');
  assert.equal(splitList[2].status, 'draft');

  // Edge cases: non-existent id or invalid list
  assert.equal(splitSegmentInList(list, 'non-existent', 5).length, 3);
  assert.deepEqual(splitSegmentInList(null, 's2', 5), []);
});

test('mergeAdjacentSegments: joins text naturally with spaces and pauses, and invalidates takes', () => {
  const takeA = createSegmentTake({ id: 'tA', duration: 1.5 });
  const takeB = createSegmentTake({ id: 'tB', duration: 2.0 });

  // 1. Natural space join without pauses
  const segA = createEditableSegment({ id: 'sA', text: 'ជំហានទីមួយ។', voiceId: 'v1', takes: [takeA], status: 'ready' });
  const segB = createEditableSegment({ id: 'sB', text: 'ជំហានទីពីរ។', voiceId: 'v1', takes: [takeB], status: 'ready', pauseDuration: 0.6 });

  const merged = mergeAdjacentSegments(segA, segB);
  assert.equal(merged.id, 'sA'); // preserves stable ID of first segment
  assert.equal(merged.text, 'ជំហានទីមួយ។ ជំហានទីពីរ។');
  assert.equal(merged.status, 'draft');
  assert.equal(merged.takes.length, 0); // takes invalidated
  assert.equal(merged.voiceId, 'v1');
  assert.equal(merged.pauseDuration, 0.6); // inherits trailing pause

  // 2. Joining with inline pause tag when first segment had pauseDuration > 0
  const segWithPause = createEditableSegment({ id: 'sP', text: 'ផ្នែកទី១', pauseDuration: 0.8 });
  const segTrailing = createEditableSegment({ id: 'sT', text: 'ផ្នែកទី២', pauseDuration: 1.0 });
  const mergedWithPause = mergeAdjacentSegments(segWithPause, segTrailing);
  assert.equal(mergedWithPause.text, 'ផ្នែកទី១ [pause 0.8s] ផ្នែកទី២');
  assert.equal(mergedWithPause.pauseDuration, 1.0);

  // 3. Joining when texts already have spaces
  const segSpaced = createEditableSegment({ id: 's1', text: 'សួស្តី ' });
  const segNext = createEditableSegment({ id: 's2', text: 'កម្ពុជា' });
  assert.equal(mergeAdjacentSegments(segSpaced, segNext).text, 'សួស្តី កម្ពុជា');

  // 4. Joining when one text is empty
  const segEmpty = createEditableSegment({ id: 'sE', text: '' });
  assert.equal(mergeAdjacentSegments(segEmpty, segNext).text, 'កម្ពុជា');
  assert.equal(mergeAdjacentSegments(segNext, segEmpty).text, 'កម្ពុជា');

  // 5. Validation errors
  assert.throws(() => mergeAdjacentSegments(null, segB), ValidationError);
  assert.throws(() => mergeAdjacentSegments(segA, null), ValidationError);
});

test('mergeSegments: merges segment at index or ID with successor in array', () => {
  const s1 = createEditableSegment({ id: 's1', text: 'មួយ' });
  const s2 = createEditableSegment({ id: 's2', text: 'ពីរ' });
  const s3 = createEditableSegment({ id: 's3', text: 'បី' });
  const list = [s1, s2, s3];

  // Merge by index (index 1 with index 2)
  const mergedByIndex = mergeSegments(list, 1);
  assert.equal(mergedByIndex.length, 2);
  assert.equal(mergedByIndex[0], s1); // s1 untouched
  assert.equal(mergedByIndex[1].id, 's2');
  assert.equal(mergedByIndex[1].text, 'ពីរ បី');

  // Merge by ID
  const mergedById = mergeSegments(list, 's1');
  assert.equal(mergedById.length, 2);
  assert.equal(mergedById[0].text, 'មួយ ពីរ');
  assert.equal(mergedById[1], s3); // s3 untouched

  // Boundary: cannot merge last item
  const mergedAtEnd = mergeSegments(list, 2);
  assert.equal(mergedAtEnd.length, 3);
  assert.equal(mergedAtEnd[2], s3);

  // Boundary: out of bounds or empty
  assert.equal(mergeSegments(list, -1).length, 3);
  assert.equal(mergeSegments(list, 99).length, 3);
  assert.deepEqual(mergeSegments([], 0), []);
  assert.deepEqual(mergeSegments(null, 0), []);
});

test('reorderSegments: moves segment between positions preserving IDs and takes intact', () => {
  const take1 = createSegmentTake({ id: 't1', duration: 1.0, isSelected: true, settings: { text: 'A' } });
  const take2 = createSegmentTake({ id: 't2', duration: 2.0, isSelected: true, settings: { text: 'B' } });
  const take3 = createSegmentTake({ id: 't3', duration: 3.0, isSelected: true, settings: { text: 'C' } });

  const s1 = createEditableSegment({ id: 's1', text: 'A', takes: [take1], status: 'ready' });
  const s2 = createEditableSegment({ id: 's2', text: 'B', takes: [take2], status: 'ready' });
  const s3 = createEditableSegment({ id: 's3', text: 'C', takes: [take3], status: 'ready' });
  const initial = [s1, s2, s3];

  // Move s3 (index 2) to top (index 0)
  const reordered = reorderSegments(initial, 2, 0);
  assert.equal(reordered.length, 3);
  assert.equal(reordered[0].id, 's3');
  assert.equal(reordered[1].id, 's1');
  assert.equal(reordered[2].id, 's2');

  // Takes and statuses must remain intact without invalidation
  assert.equal(reordered[0], s3);
  assert.equal(reordered[1], s1);
  assert.equal(reordered[2], s2);
  assert.equal(reordered[0].takes[0].id, 't3');
  assert.equal(reordered[0].status, 'ready');

  // Boundary: same index returns shallow copy
  assert.deepEqual(reorderSegments(initial, 1, 1), initial);
  // Boundary: out of bounds indices
  assert.deepEqual(reorderSegments(initial, -1, 1), initial);
  assert.deepEqual(reorderSegments(initial, 1, 99), initial);
  assert.deepEqual(reorderSegments(null, 0, 1), []);
  assert.deepEqual(reorderSegments(initial, 0, undefined), initial);
  assert.deepEqual(reorderSegments(initial, NaN, 1), initial);
  assert.deepEqual(reorderSegments(initial, 0.5, 1), initial);
});

test('moveSegmentUp and moveSegmentDown: step segments by index or ID', () => {
  const s1 = createEditableSegment({ id: 's1', text: 'First' });
  const s2 = createEditableSegment({ id: 's2', text: 'Second' });
  const s3 = createEditableSegment({ id: 's3', text: 'Third' });
  const list = [s1, s2, s3];

  // Move down by ID
  const movedDown = moveSegmentDown(list, 's1');
  assert.equal(movedDown[0].id, 's2');
  assert.equal(movedDown[1].id, 's1');
  assert.equal(movedDown[2].id, 's3');

  // Move up by index
  const movedUp = moveSegmentUp(movedDown, 1);
  assert.equal(movedUp[0].id, 's1');
  assert.equal(movedUp[1].id, 's2');

  // Boundary: moving up from index 0 is a no-op
  const noUp = moveSegmentUp(list, 's1');
  assert.deepEqual(noUp, list);

  // Boundary: moving down from last index is a no-op
  const noDown = moveSegmentDown(list, 's3');
  assert.deepEqual(noDown, list);
});

test('insertSegment: inserts new draft segment with stable UUID at specified index', () => {
  const s1 = createEditableSegment({ id: 's1', text: 'First' });
  const s2 = createEditableSegment({ id: 's2', text: 'Second' });
  const list = [s1, s2];

  // Insert between s1 and s2
  const inserted = insertSegment(list, 1, { text: 'Middle', voiceId: 'v1' });
  assert.equal(inserted.length, 3);
  assert.equal(inserted[0], s1);
  assert.equal(inserted[1].text, 'Middle');
  assert.equal(inserted[1].voiceId, 'v1');
  assert.equal(inserted[1].status, 'draft');
  assert.equal(inserted[1].takes.length, 0);
  assert.ok(inserted[1].id.length > 5);
  assert.equal(inserted[2], s2);

  // Append at end
  const appended = insertSegment(list, undefined, { text: 'End' });
  assert.equal(appended.length, 3);
  assert.equal(appended[2].text, 'End');

  // Empty list
  assert.deepEqual(insertSegment(null, 0), []);
});

test('deleteSegment: removes segment by ID while preserving remaining segments intact', () => {
  const take1 = createSegmentTake({ id: 't1', duration: 1.0 });
  const take3 = createSegmentTake({ id: 't3', duration: 1.0 });
  const s1 = createEditableSegment({ id: 's1', text: 'One', takes: [take1] });
  const s2 = createEditableSegment({ id: 's2', text: 'Two' });
  const s3 = createEditableSegment({ id: 's3', text: 'Three', takes: [take3] });
  const list = [s1, s2, s3];

  const deleted = deleteSegment(list, 's2');
  assert.equal(deleted.length, 2);
  assert.equal(deleted[0], s1); // object reference preserved
  assert.equal(deleted[1], s3); // object reference preserved
  assert.equal(deleted[0].takes.length, 1);
  assert.equal(deleted[1].takes.length, 1);

  // Not found returns shallow copy
  assert.equal(deleteSegment(list, 'non-existent').length, 3);
  assert.deepEqual(deleteSegment(null, 's1'), []);
});

test('attachTakeToSegment: attaches new take to selected segment while preserving all other segments intact', () => {
  const takeA = createSegmentTake({ id: 'take-a', duration: 1.5, isSelected: true });
  const takeC = createSegmentTake({ id: 'take-c', duration: 2.2, isSelected: true });
  const seg1 = createEditableSegment({ id: 'seg-1', text: 'Sentence 1', takes: [takeA], status: 'ready' });
  const seg2 = createEditableSegment({ id: 'seg-2', text: 'Sentence 2', status: 'draft', takes: [] });
  const seg3 = createEditableSegment({ id: 'seg-3', text: 'Sentence 3', takes: [takeC], status: 'ready' });
  const list = [seg1, seg2, seg3];

  const recording = {
    id: 'rec-99',
    characterId: 'char-kiri',
    seed: 42,
    audioDurationSeconds: 3.1,
    blob: { size: 1024, type: 'audio/wav' },
  };

  const updated = attachTakeToSegment(list, 'seg-2', recording, { voiceId: 'char-kiri' });

  assert.equal(updated.length, 3);
  assert.equal(updated[0], seg1);
  assert.equal(updated[2], seg3);
  assert.notEqual(updated[1], seg2);
  assert.equal(updated[1].id, 'seg-2');
  assert.equal(updated[1].text, 'Sentence 2');
  assert.equal(updated[1].status, 'ready');
  assert.equal(updated[1].voiceId, 'char-kiri');
  assert.equal(updated[1].takes.length, 1);
  assert.equal(updated[1].takes[0].isSelected, true);
  assert.equal(updated[1].takes[0].duration, 3.1);
  assert.equal(updated[1].takes[0].settings.seed, 42);

  const recording2 = { id: 'rec-100', seed: 43, audioDurationSeconds: 3.4 };
  const updatedAgain = attachTakeToSegment(updated, 'seg-2', recording2);
  assert.equal(updatedAgain[1].takes.length, 2);
  assert.equal(updatedAgain[1].takes[0].isSelected, false);
  assert.equal(updatedAgain[1].takes[1].isSelected, true);
  assert.equal(updatedAgain[1].takes[1].settings.seed, 43);

  assert.deepEqual(attachTakeToSegment(list, 'nonexistent', recording), list);
  assert.deepEqual(attachTakeToSegment(list, 'seg-2', null), list);
  assert.deepEqual(attachTakeToSegment(null, 'seg-2', recording), []);
});

test('getSegmentActiveTake & hasSegmentAudio & findSegmentById: resolve active take and audio readiness', () => {
  const take1 = createSegmentTake({ id: 't1', duration: 1.0, isSelected: false });
  const take2 = createSegmentTake({
    id: 't2',
    duration: 2.0,
    isSelected: true,
    audioUrl: 'blob:http://localhost/test-take-2',
  });
  const segWithTakes = createEditableSegment({ id: 's1', text: 'Hi', takes: [take1, take2] });
  const segNoTakes = createEditableSegment({ id: 's2', text: 'Empty', takes: [] });

  assert.equal(getSegmentActiveTake(segWithTakes)?.id, 't2');
  assert.equal(getSegmentActiveTake(segNoTakes), null);
  assert.equal(getSegmentActiveTake(null), null);

  assert.equal(hasSegmentAudio(segWithTakes), true);
  assert.equal(hasSegmentAudio(segNoTakes), false);
  assert.equal(hasSegmentAudio(null), false);

  const list = [segWithTakes, segNoTakes];
  assert.equal(findSegmentById(list, 's1'), segWithTakes);
  assert.equal(findSegmentById(list, 's2'), segNoTakes);
  assert.equal(findSegmentById(list, 's3'), null);
  assert.equal(findSegmentById(null, 's1'), null);
});

test('selectSegmentTake: switches selected take and demotes other takes', () => {
  const take1 = createSegmentTake({ id: 't1', duration: 1.0, isSelected: true });
  const take2 = createSegmentTake({ id: 't2', duration: 2.0, isSelected: false });
  const seg = createEditableSegment({ id: 's1', text: 'Hi', takes: [take1, take2], status: 'ready' });

  const updated = selectSegmentTake(seg, 't2');
  assert.equal(updated.takes[0].isSelected, false);
  assert.equal(updated.takes[1].isSelected, true);
  assert.equal(updated.status, 'ready');

  const unchanged = selectSegmentTake(seg, 'nonexistent');
  assert.equal(unchanged, seg);
});

test('removeSegmentTake: deletes take and re-elects remaining take or reverts to draft', () => {
  const take1 = createSegmentTake({ id: 't1', duration: 1.0, isSelected: false });
  const take2 = createSegmentTake({ id: 't2', duration: 2.0, isSelected: true });
  const seg = createEditableSegment({ id: 's1', text: 'Hi', takes: [take1, take2], status: 'ready' });

  const afterRemoveSelected = removeSegmentTake(seg, 't2');
  assert.equal(afterRemoveSelected.takes.length, 1);
  assert.equal(afterRemoveSelected.takes[0].id, 't1');
  assert.equal(afterRemoveSelected.takes[0].isSelected, true);
  assert.equal(afterRemoveSelected.status, 'ready');

  const afterRemoveAll = removeSegmentTake(afterRemoveSelected, 't1');
  assert.equal(afterRemoveAll.takes.length, 0);
  assert.equal(afterRemoveAll.status, 'draft');
});

test('attachTakeToSegment: preserves durable audioAssetId and generation settings', () => {
  const seg = createEditableSegment({ id: 'seg-meta', text: 'Sentence with metadata', status: 'draft' });
  const recording = { id: 'rec-meta', seed: 777, audioDurationSeconds: 2.5 };
  const validAssetId = '12345678-1234-4234-8234-123456789abc';
  const options = {
    voiceId: 'char-meta',
    audioAssetId: validAssetId,
    anchorVersion: 3,
    guidance: 2.5,
    steps: 12,
    styleMode: 'custom',
    customStyle: 'whisper softly',
  };

  const [updated] = attachTakeToSegment([seg], 'seg-meta', recording, options);
  const take = updated.takes[0];
  assert.equal(take.audioAssetId, validAssetId);
  assert.equal(take.settings.anchorVersion, 3);
  assert.equal(take.settings.guidance, 2.5);
  assert.equal(take.settings.steps, 12);
  assert.equal(take.settings.styleMode, 'custom');
  assert.equal(take.settings.customStyle, 'whisper softly');
});

test('getSegmentTake: retrieves take by ID or returns null if absent', () => {
  const take1 = createSegmentTake({ id: 't-alpha', duration: 1.2 });
  const seg = createEditableSegment({ id: 's-get', text: 'Text', takes: [take1] });

  assert.equal(getSegmentTake(seg, 't-alpha')?.id, 't-alpha');
  assert.equal(getSegmentTake(seg, 'nonexistent'), null);
  assert.equal(getSegmentTake(null, 't-alpha'), null);
});

test('selectSegmentTakeInList & removeSegmentTakeInList: mutate target segment within list immutably', () => {
  const takeA1 = createSegmentTake({ id: 't-a1', duration: 1.0, isSelected: true });
  const takeA2 = createSegmentTake({ id: 't-a2', duration: 1.5, isSelected: false });
  const segA = createEditableSegment({ id: 'seg-a', text: 'Sentence A', takes: [takeA1, takeA2], status: 'ready' });
  const segB = createEditableSegment({ id: 'seg-b', text: 'Sentence B', status: 'draft', takes: [] });
  const list = [segA, segB];

  // 1. Select Take A2
  const selectedList = selectSegmentTakeInList(list, 'seg-a', 't-a2');
  assert.equal(selectedList.length, 2);
  assert.equal(selectedList[1], segB);
  assert.equal(selectedList[0].takes[0].isSelected, false);
  assert.equal(selectedList[0].takes[1].isSelected, true);

  // 2. Remove Take A2
  const removedList = removeSegmentTakeInList(selectedList, 'seg-a', 't-a2');
  assert.equal(removedList[0].takes.length, 1);
  assert.equal(removedList[0].takes[0].id, 't-a1');
  assert.equal(removedList[0].takes[0].isSelected, true);

  // 3. Null / edge checks
  assert.deepEqual(selectSegmentTakeInList(null, 'seg-a', 't-a1'), []);
  assert.deepEqual(removeSegmentTakeInList(null, 'seg-a', 't-a1'), []);
});

test('assignSegmentVoice: assigns voiceId, speakerId, speakerName and marks status outdated if takes exist', () => {
  const segFresh = createEditableSegment({ id: 's-fresh', text: 'Sentence fresh', voiceId: 'char-old' });
  const updatedFresh = assignSegmentVoice(segFresh, 'char-new', 'Sophea');
  assert.equal(updatedFresh.voiceId, 'char-new');
  assert.equal(updatedFresh.speakerId, 'char-new');
  assert.equal(updatedFresh.speakerName, 'Sophea');
  assert.equal(updatedFresh.status, 'draft');

  // Segment with existing take recorded under 'char-old'
  const takeOld = createSegmentTake({ id: 't-old', duration: 1.5, settings: { voiceId: 'char-old' } });
  const segWithTake = createEditableSegment({
    id: 's-take',
    text: 'Sentence with take',
    voiceId: 'char-old',
    takes: [takeOld],
    status: 'ready',
  });

  const updatedOutdated = assignSegmentVoice(segWithTake, 'char-kiri', 'Kiri');
  assert.equal(updatedOutdated.voiceId, 'char-kiri');
  assert.equal(updatedOutdated.speakerName, 'Kiri');
  assert.equal(updatedOutdated.status, 'outdated');

  // Re-assigning back to the voice recorded in the take restores status to ready
  const restored = assignSegmentVoice(updatedOutdated, 'char-old');
  assert.equal(restored.status, 'ready');

  // Validation errors
  assert.throws(() => assignSegmentVoice(null, 'char-1'), ValidationError);
  assert.throws(() => assignSegmentVoice(segFresh, ''), ValidationError);
  assert.throws(() => assignSegmentVoice(segFresh, '   '), ValidationError);
});

test('assignSegmentVoiceInList: updates target segment and leaves others unchanged', () => {
  const seg1 = createEditableSegment({ id: 's1', text: 'Text 1', voiceId: 'char-nisa' });
  const seg2 = createEditableSegment({ id: 's2', text: 'Text 2', voiceId: 'char-nisa' });
  const list = [seg1, seg2];

  const updated = assignSegmentVoiceInList(list, 's2', 'char-kiri', 'Kiri');
  assert.equal(updated.length, 2);
  assert.equal(updated[0], seg1);
  assert.equal(updated[1].voiceId, 'char-kiri');
  assert.equal(updated[1].speakerName, 'Kiri');

  // Edge cases
  assert.deepEqual(assignSegmentVoiceInList(null, 's2', 'char-kiri'), []);
  assert.deepEqual(assignSegmentVoiceInList(list, 'nonexistent', 'char-kiri'), list);
  assert.deepEqual(assignSegmentVoiceInList(list, 's2', ''), list);
});

test('isMultiSpeakerScript: correctly identifies single vs multi-speaker scripts', () => {
  const s1 = createEditableSegment({ id: 's1', text: 'Text 1', voiceId: 'char-nisa' });
  const s2 = createEditableSegment({ id: 's2', text: 'Text 2', voiceId: 'char-nisa' });
  const s3 = createEditableSegment({ id: 's3', text: 'Text 3', voiceId: 'char-kiri' });
  const sUnassigned = createEditableSegment({ id: 's4', text: 'Text 4', voiceId: null });

  assert.equal(isMultiSpeakerScript([s1]), false);
  assert.equal(isMultiSpeakerScript([s1, s2]), false);
  assert.equal(isMultiSpeakerScript([s1, s3]), true);
  assert.equal(isMultiSpeakerScript([s1, sUnassigned], 'char-kiri'), true);
  assert.equal(isMultiSpeakerScript([s1, sUnassigned], 'char-nisa'), false);
  assert.equal(isMultiSpeakerScript([]), false);
  assert.equal(isMultiSpeakerScript(null), false);
});

test('getScriptVoiceIds: returns unique voice IDs in order of segment appearance', () => {
  const s1 = createEditableSegment({ id: 's1', text: 'T1', voiceId: 'voice-a' });
  const s2 = createEditableSegment({ id: 's2', text: 'T2', voiceId: 'voice-b' });
  const s3 = createEditableSegment({ id: 's3', text: 'T3', voiceId: 'voice-a' });
  const s4 = createEditableSegment({ id: 's4', text: 'T4', voiceId: null });

  assert.deepEqual(getScriptVoiceIds([s1, s2, s3]), ['voice-a', 'voice-b']);
  assert.deepEqual(getScriptVoiceIds([s1, s4], 'voice-c'), ['voice-a', 'voice-c']);
  assert.deepEqual(getScriptVoiceIds([]), []);
  assert.deepEqual(getScriptVoiceIds(null), []);
});

test('isTakeOutdated: flags outdated take when text or voice changed, returns false when identical', () => {
  const take1 = createSegmentTake({
    id: 'take-1',
    duration: 1.2,
    isSelected: true,
    settings: { text: 'សួស្តី', voiceId: 'char-1' },
  });
  const segCurrent = createEditableSegment({
    id: 'seg-1',
    text: 'សួស្តី',
    voiceId: 'char-1',
    takes: [take1],
  });

  // Up to date
  assert.equal(isTakeOutdated(take1, segCurrent), false);

  // Text differs
  const segTextEdited = createEditableSegment({
    id: 'seg-1',
    text: 'សួស្តីលោកគ្រូ',
    voiceId: 'char-1',
    takes: [take1],
  });
  assert.equal(isTakeOutdated(take1, segTextEdited), true);

  // Voice differs
  const segVoiceEdited = createEditableSegment({
    id: 'seg-1',
    text: 'សួស្តី',
    voiceId: 'char-2',
    takes: [take1],
  });
  assert.equal(isTakeOutdated(take1, segVoiceEdited), true);

  // Fallback checks on take.text / take.voiceId directly
  const takeDirect = { id: 't2', text: 'ចាស់', voiceId: 'v1' };
  assert.equal(isTakeOutdated(takeDirect, { text: 'ថ្មី', voiceId: 'v1' }), true);
  assert.equal(isTakeOutdated(takeDirect, { text: 'ចាស់', voiceId: 'v2' }), true);
  assert.equal(isTakeOutdated(takeDirect, { text: 'ចាស់', voiceId: 'v1' }), false);

  // Voice reset to default (null) or set from null to custom voice
  const takeWithVoice = createSegmentTake({ id: 't-v', settings: { text: 'សួស្តី', voiceId: 'char-1' } });
  const segVoiceReset = createEditableSegment({ id: 'seg-reset', text: 'សួស្តី', voiceId: null, takes: [takeWithVoice] });
  assert.equal(isTakeOutdated(takeWithVoice, segVoiceReset), true, 'Take should be outdated when segment voice reset to null');

  const takeWithDefaultVoice = createSegmentTake({ id: 't-def', settings: { text: 'សួស្តី', voiceId: null } });
  const segVoiceAssigned = createEditableSegment({ id: 'seg-assigned', text: 'សួស្តី', voiceId: 'char-2', takes: [takeWithDefaultVoice] });
  assert.equal(isTakeOutdated(takeWithDefaultVoice, segVoiceAssigned), true, 'Take should be outdated when segment assigned custom voice');

  const segVoiceBothNull = createEditableSegment({ id: 'seg-null', text: 'សួស្តី', voiceId: null, takes: [takeWithDefaultVoice] });
  assert.equal(isTakeOutdated(takeWithDefaultVoice, segVoiceBothNull), false, 'Take should not be outdated when both voiceIds are null');

  // Edge cases: null/undefined
  assert.equal(isTakeOutdated(null, segCurrent), false);
  assert.equal(isTakeOutdated(take1, null), false);
});

test('cycleSegmentTake: cycles active take forward and backward with wrapping (R2-09)', () => {
  const take1 = createSegmentTake({ id: 't-1', duration: 1.0, isSelected: true });
  const take2 = createSegmentTake({ id: 't-2', duration: 1.5, isSelected: false });
  const take3 = createSegmentTake({ id: 't-3', duration: 2.0, isSelected: false });

  const seg3Takes = createEditableSegment({
    id: 's-multi',
    text: 'អត្ថបទ',
    takes: [take1, take2, take3],
  });

  // Forward (+1): t-1 -> t-2
  const stepped1 = cycleSegmentTake(seg3Takes, 1);
  assert.equal(getSegmentActiveTake(stepped1).id, 't-2');

  // Forward (+1) again: t-2 -> t-3
  const stepped2 = cycleSegmentTake(stepped1, 1);
  assert.equal(getSegmentActiveTake(stepped2).id, 't-3');

  // Forward (+1) wraps: t-3 -> t-1
  const stepped3 = cycleSegmentTake(stepped2, 1);
  assert.equal(getSegmentActiveTake(stepped3).id, 't-1');

  // Backward (-1): t-1 -> t-3
  const steppedBack = cycleSegmentTake(seg3Takes, -1);
  assert.equal(getSegmentActiveTake(steppedBack).id, 't-3');

  // Large negative steps wrap safely without negative index crashes
  // -4 on length 3 from index 0: (0 + (-4 % 3) + 3) % 3 = (0 - 1 + 3) % 3 = 2 -> t-3
  assert.equal(getSegmentActiveTake(cycleSegmentTake(seg3Takes, -4)).id, 't-3');
  // -5 on length 3 from index 0: (0 + (-5 % 3) + 3) % 3 = (0 - 2 + 3) % 3 = 1 -> t-2
  assert.equal(getSegmentActiveTake(cycleSegmentTake(seg3Takes, -5)).id, 't-2');
  // -10 on length 3 from index 0: -10 % 3 = -1 -> (0 - 1 + 3) % 3 = 2 -> t-3
  assert.equal(getSegmentActiveTake(cycleSegmentTake(seg3Takes, -10)).id, 't-3');

  // Single take segment returns unchanged
  const segSingle = createEditableSegment({ id: 's-single', text: 'តែមួយ', takes: [take1] });
  assert.equal(cycleSegmentTake(segSingle, 1), segSingle);

  // Edge cases
  assert.equal(cycleSegmentTake(null, 1), null);
});

test('cycleSegmentTakeInList: updates target segment and leaves others untouched (R2-09)', () => {
  const takeA1 = createSegmentTake({ id: 'ta-1', isSelected: true });
  const takeA2 = createSegmentTake({ id: 'ta-2', isSelected: false });
  const segA = createEditableSegment({ id: 's-a', text: 'Seg A', takes: [takeA1, takeA2] });

  const takeB1 = createSegmentTake({ id: 'tb-1', isSelected: true });
  const segB = createEditableSegment({ id: 's-b', text: 'Seg B', takes: [takeB1] });

  const list = [segA, segB];
  const cycledList = cycleSegmentTakeInList(list, 's-a', 1);

  assert.equal(getSegmentActiveTake(cycledList[0]).id, 'ta-2');
  assert.equal(cycledList[1], segB);

  // Non-matching segmentId returns shallow copy
  assert.deepEqual(cycleSegmentTakeInList(list, 'nonexistent', 1), list);
  assert.deepEqual(cycleSegmentTakeInList(null, 's-a', 1), []);
});

test('selectSegmentTake and removeSegmentTake: compute segment status dynamically (R2-10)', () => {
  const takeOld = createSegmentTake({ id: 'take-old', settings: { text: 'អត្ថបទចាស់', voiceId: 'char-1' }, isSelected: false });
  const takeCurrent = createSegmentTake({ id: 'take-curr', settings: { text: 'អត្ថបទថ្មី', voiceId: 'char-1' }, isSelected: true });

  const segment = createEditableSegment({
    id: 'seg-10',
    text: 'អត្ថបទថ្មី',
    voiceId: 'char-1',
    takes: [takeOld, takeCurrent],
  });

  // Currently takeCurrent is selected, status is ready
  assert.equal(segment.status, 'ready');

  // Switch to takeOld: takeOld has text 'អត្ថបទចាស់' which does NOT match 'អត្ថបទថ្មី'
  const switchedToOld = selectSegmentTake(segment, 'take-old');
  assert.equal(switchedToOld.status, 'outdated', 'Status should be outdated when selecting an outdated take');

  // Switch back to takeCurrent: matches current text
  const switchedBack = selectSegmentTake(switchedToOld, 'take-curr');
  assert.equal(switchedBack.status, 'ready', 'Status should return to ready when selecting an up-to-date take');

  // Remove the current take: only takeOld remains, so status must be outdated
  const removedCurrent = removeSegmentTake(switchedBack, 'take-curr');
  assert.equal(removedCurrent.takes.length, 1);
  assert.equal(removedCurrent.status, 'outdated', 'Status should be outdated when only outdated take remains');

  // Remove the remaining take: 0 takes left, status must be draft
  const removedAll = removeSegmentTake(removedCurrent, 'take-old');
  assert.equal(removedAll.takes.length, 0);
  assert.equal(removedAll.status, 'draft', 'Status should be draft when all takes are deleted');
});





test('isTakeOutdated and computeSegmentStatus detect Stage 3 pronunciationSignature changes without breaking legacy checks', () => {
  const baseSegment = createEditableSegment({
    id: 'seg-pron',
    text: 'Test VoxCPM2 output',
    voiceId: 'char-nisa',
  });
  const withTake = attachTakeToSegment([baseSegment], 'seg-pron', {
    id: 'take-pron-1',
    blob: new Blob(['wav']),
    duration: 1.5,
  }, {
    voiceId: 'char-nisa',
    pronunciationSignature: 'sig-v1',
  })[0];

  const activeTake = getSegmentActiveTake(withTake);
  assert.equal(isTakeOutdated(activeTake, withTake, { pronunciationSignature: 'sig-v1' }), false);
  assert.equal(computeSegmentStatus(withTake, { pronunciationSignature: 'sig-v1' }), 'ready');

  // Pronunciation rule change invalidates the take
  assert.equal(isTakeOutdated(activeTake, withTake, { pronunciationSignature: 'sig-v2' }), true);
  assert.equal(computeSegmentStatus(withTake, { pronunciationSignature: 'sig-v2' }), 'outdated');

  // Legacy callers omitting pronunciationSignature remain unaffected
  assert.equal(isTakeOutdated(activeTake, withTake), false);
  assert.equal(computeSegmentStatus(withTake), 'ready');

  // Legacy take generated before rules existed becomes outdated once rules apply, stays ready if rules are empty
  const legacyTake = createSegmentTake({ id: 'take-legacy', settings: { text: 'Test VoxCPM2 output', voiceId: 'char-nisa' }, isSelected: true });
  const legacySeg = createEditableSegment({ id: 'seg-legacy', text: 'Test VoxCPM2 output', voiceId: 'char-nisa', takes: [legacyTake] });
  assert.equal(computeSegmentStatus(legacySeg, { pronunciationSignature: '' }), 'ready');
  assert.equal(computeSegmentStatus(legacySeg, { pronunciationSignature: 'sig-v2' }), 'outdated');
});
