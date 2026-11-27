import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DUB_AUDIO_MODE,
  DEFAULT_TIME_ALIGNED_SUFFIX,
  DUB_AUDIO_MODE_OPTIONS,
  SUBTITLE_VOICEOVER_GAP_OPTIONS,
  SUBTITLE_VOICEOVER_PAUSE_MS,
  assembleTimelineAlignedVoiceover,
  buildCombinedVoiceoverBlob,
  buildDubDownloadFilename,
  buildDubExportClips,
  buildSubtitleSpeechSignature,
  buildSubtitleSynthesisCommand,
  buildTimeAlignedDubDownloadFilename,
  buildVoiceoverDownloadFilename,
  formatSubtitleVoiceoverGapLabel,
  isKhmerScriptText,
  normalizeDubAudioMode,
  normalizeSubtitleVoiceoverGapMs,
  resolveSubtitleSpeechText,
  selectOrderedSegments,
} from '../../src/domain/subtitleTts.js';
import { inspectWavBuffer, readWavDurationSeconds } from '../../src/domain/wavCodec.js';

function createPcmWavBlob(durationMs = 100, sampleRate = 16000) {
  const numSamples = Math.round((sampleRate * durationMs) / 1000);
  const dataSize = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeTag = (off, tag) => { for (let i = 0; i < 4; i++) view.setUint8(off + i, tag.charCodeAt(i)); };
  writeTag(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeTag(8, 'WAVE');
  writeTag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeTag(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < numSamples; i++) {
    view.setInt16(44 + i * 2, i % 2 === 0 ? 4000 : -4000, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

test('subtitleTts resolves active speech text, Khmer auto-formatting, signatures, and ordered selections', () => {
  assert.equal(isKhmerScriptText('សួស្តីកម្ពុជា'), true);
  assert.equal(isKhmerScriptText('Hello world'), false);
  assert.equal(isKhmerScriptText(''), false);

  const cue = { id: 'seg-1', text: 'Hello world', translatedText: 'សួស្តីពិភពលោក' };
  assert.equal(resolveSubtitleSpeechText(cue, false), 'Hello world');
  assert.equal(resolveSubtitleSpeechText(cue, true), 'សួស្តីពិភពលោក');
  assert.equal(resolveSubtitleSpeechText({ id: 'seg-2', text: 'Only original', translatedText: '' }, true), '');

  const sigA = buildSubtitleSpeechSignature({ text: 'Hello', characterId: 'char-nisa', anchorTag: '' });
  const sigB = buildSubtitleSpeechSignature({ text: 'Hello', characterId: 'char-sovath', anchorTag: '' });
  assert.notEqual(sigA, sigB);

  const ordered = selectOrderedSegments(
    [{ id: 'seg-1' }, { id: 'seg-2' }, { id: 'seg-3' }],
    ['seg-3', 'missing-id', 'seg-1']
  );
  assert.deepEqual(ordered.map(s => s.id), ['seg-1', 'seg-3']);

  const kmCmd = buildSubtitleSynthesisCommand({
    text: 'សួស្តី ២០២៦',
    character: { id: 'char-nisa', name: 'Nisa', defaultSeed: 12345 },
  });
  assert.equal(kmCmd.autoFormatKhmer, true);
  assert.equal(kmCmd.seed, 12345);

  const enCmd = buildSubtitleSynthesisCommand({
    text: 'Good evening.',
    character: { id: 'char-nisa', name: 'Nisa', defaultSeed: 12345 },
    anchor: { blob: new Blob(['x']), exactClone: false },
  });
  assert.equal(enCmd.autoFormatKhmer, false);
  assert.equal(enCmd.seed, '');

  assert.equal(buildVoiceoverDownloadFilename({ name: 'clip.mp4' }, '-frame-01'), 'clip-frame-01.wav');
  assert.equal(buildVoiceoverDownloadFilename(null, '-voiceover'), 'subtitle-voiceover.wav');
});

test('buildCombinedVoiceoverBlob handles empty, single, and exact multi-frame PCM WAV durations across all gap presets', async () => {
  assert.equal(await buildCombinedVoiceoverBlob([]), null);
  assert.equal(SUBTITLE_VOICEOVER_PAUSE_MS, 200);
  assert.deepEqual(
    SUBTITLE_VOICEOVER_GAP_OPTIONS.map(option => [option.ms, option.label]),
    [[100, '0.1s'], [200, '0.2s'], [500, '0.5s'], [1000, '1.0s']]
  );
  assert.equal(normalizeSubtitleVoiceoverGapMs(100), 100);
  assert.equal(normalizeSubtitleVoiceoverGapMs('500'), 500);
  assert.equal(normalizeSubtitleVoiceoverGapMs(1000), 1000);
  assert.equal(normalizeSubtitleVoiceoverGapMs(999), 200);
  assert.equal(normalizeSubtitleVoiceoverGapMs('bad'), 200);
  assert.equal(formatSubtitleVoiceoverGapLabel(1000), '1.0s');
  assert.equal(formatSubtitleVoiceoverGapLabel(null), '0.2s');

  const clip1 = createPcmWavBlob(200);
  const clip2 = createPcmWavBlob(300);
  const clip3 = createPcmWavBlob(250);
  const single = await buildCombinedVoiceoverBlob([clip1]);
  assert.equal(single.type, 'audio/wav');
  assert.equal(readWavDurationSeconds(await single.arrayBuffer()), 0.2);

  // Default pause (omitted arg) must equal 200ms (0.2s) between each pair of clips.
  const defaultCombined = await buildCombinedVoiceoverBlob([clip1, clip2, clip3]);
  assert.equal(readWavDurationSeconds(await defaultCombined.arrayBuffer()), (200 + 200 + 300 + 200 + 250) / 1000);

  // Verify exact PCM WAV duration and byte size for every gap selector preset (0.1s, 0.2s, 0.5s, 1.0s).
  for (const { ms } of SUBTITLE_VOICEOVER_GAP_OPTIONS) {
    const combined = await buildCombinedVoiceoverBlob([clip1, clip2, clip3], ms);
    const buffer = await combined.arrayBuffer();
    const info = inspectWavBuffer(buffer);
    const expectedSeconds = (200 + 300 + 250 + ms * 2) / 1000;
    assert.equal(combined.type, 'audio/wav');
    assert.equal(readWavDurationSeconds(buffer), expectedSeconds);
    assert.equal(info.dataSize, Math.round(expectedSeconds * 16000) * 2);
  }
});

test('subtitleTts normalizes dub audio modes, collects ordered dub clips, and formats dubbed filenames', () => {
  assert.equal(DEFAULT_DUB_AUDIO_MODE, 'duck');
  assert.deepEqual(
    DUB_AUDIO_MODE_OPTIONS.map(option => [option.id, option.label]),
    [['duck', 'Duck (-16 dB)'], ['mute', 'Mute original'], ['keep', 'Keep original']]
  );
  assert.equal(normalizeDubAudioMode('mute'), 'mute');
  assert.equal(normalizeDubAudioMode(' KEEP '), 'keep');
  assert.equal(normalizeDubAudioMode('loud'), 'duck');
  assert.equal(buildDubDownloadFilename({ name: 'interview.mov' }), 'interview-dubbed.mp4');
  assert.equal(buildDubDownloadFilename(null), 'subtitle-dubbed.mp4');

  const blobA = createPcmWavBlob(100);
  const blobB = createPcmWavBlob(100);
  const segments = [
    { id: 'seg-1', start: 0.2, end: 1.4 },
    { id: 'seg-2', start: 2.0, end: 3.1 },
    { id: 'seg-3', start: 3.5, end: 4.5 },
  ];
  const clips = { 'seg-1': { blob: blobA }, 'seg-3': { blob: blobB } };
  assert.deepEqual(
    buildDubExportClips(segments, ['seg-3'], clips).map(c => [c.segmentId, c.start, c.end]),
    [['seg-3', 3.5, 4.5]]
  );
  assert.deepEqual(
    buildDubExportClips(segments, [], clips).map(c => [c.segmentId, c.start, c.end]),
    [['seg-1', 0.2, 1.4], ['seg-3', 3.5, 4.5]]
  );

  assert.equal(buildTimeAlignedDubDownloadFilename({ name: 'interview.mp4' }), 'interview-time-aligned-dub.wav');
  assert.equal(buildTimeAlignedDubDownloadFilename(null), 'subtitle-time-aligned-dub.wav');
});

test('assembleTimelineAlignedVoiceover synthesizes initial silence padding, exact sample timestamps, and trailing silence', async () => {
  const sampleRate = 16000;
  // Clip 1: 500ms (8000 frames)
  const clip1 = createPcmWavBlob(500, sampleRate);
  // Clip 2: 400ms (6400 frames)
  const clip2 = createPcmWavBlob(400, sampleRate);

  const segments = [
    { id: 'cue-1', start: 1.0, end: 2.0 },
    { id: 'cue-2', start: 2.5, end: 3.5 },
  ];
  const segmentClips = {
    'cue-1': { blob: clip1 },
    'cue-2': { blob: clip2 },
  };

  const res = await assembleTimelineAlignedVoiceover({
    segments,
    segmentClips,
    totalDuration: 4.0,
    sampleRate,
  });

  assert.ok(res.blob);
  assert.equal(res.clipCount, 2);
  assert.equal(res.duration, 4.0);
  assert.equal(res.warnings.length, 0);

  const buffer = await res.blob.arrayBuffer();
  const info = inspectWavBuffer(buffer);
  assert.equal(info.sampleRate, sampleRate);
  assert.equal(info.numChannels, 1);
  assert.equal(info.dataSize, 4.0 * sampleRate * 2);

  const view = new DataView(buffer, info.dataOffset, info.dataSize);

  // 1. Initial silence: [0.0s .. 1.0s) -> frames 0 to 15999 must all be 0
  for (let i = 0; i < 16000; i += 200) {
    assert.equal(view.getInt16(i * 2, true), 0, `Initial sample at frame ${i} must be silence 0`);
  }

  // 2. Pre-clip boundary at frame 15999 is silence; clip 1 audio is active after 5ms edge fade (frame 16100)
  assert.equal(view.getInt16(15999 * 2, true), 0, 'Frame 15999 before clip 1 must be silence');
  assert.notEqual(view.getInt16(16100 * 2, true), 0, 'Frame 16100 must be active clip 1 audio');

  // 3. Inter-clip silence: Clip 1 ends at 1.5s (frame 24000). Cue 2 starts at 2.5s (frame 40000).
  // Frames between 24000 and 39999 must be silence (0)
  for (let i = 24000; i < 40000; i += 500) {
    assert.equal(view.getInt16(i * 2, true), 0, `Inter-clip sample at frame ${i} must be silence 0`);
  }

  // 4. Pre-clip boundary at frame 39999 is silence; clip 2 audio is active after 5ms edge fade (frame 40100)
  assert.equal(view.getInt16(39999 * 2, true), 0, 'Frame 39999 before clip 2 must be silence');
  assert.notEqual(view.getInt16(40100 * 2, true), 0, 'Frame 40100 must be active clip 2 audio');

  // 5. Trailing silence: Clip 2 ends at 2.9s (frame 46400). Total duration is 4.0s (frame 64000).
  for (let i = 46400; i < 64000; i += 500) {
    assert.equal(view.getInt16(i * 2, true), 0, `Trailing sample at frame ${i} must be silence 0`);
  }
});

test('assembleTimelineAlignedVoiceover clamps overflown clips without shifting downstream clips out of sync', async () => {
  const sampleRate = 16000;
  // Window between cue-1 and cue-2 is 2.0s - 1.0s = 1.0s (16000 frames).
  // Clip 1 is 1500ms (1.5s = 24000 frames) -> exceeds window by 0.5s!
  const clip1 = createPcmWavBlob(1500, sampleRate);
  const clip2 = createPcmWavBlob(500, sampleRate);

  const segments = [
    { id: 'cue-1', start: 1.0, end: 1.8 },
    { id: 'cue-2', start: 2.0, end: 3.0 },
  ];
  const segmentClips = {
    'cue-1': { blob: clip1 },
    'cue-2': { blob: clip2 },
  };

  const res = await assembleTimelineAlignedVoiceover({
    segments,
    segmentClips,
    totalDuration: 3.0,
    sampleRate,
  });

  assert.equal(res.warnings.length, 1);
  assert.equal(res.warnings[0].segmentId, 'cue-1');
  assert.equal(res.warnings[0].requestedDuration, 1.5);
  assert.equal(res.warnings[0].maxDuration, 1.0);

  const buffer = await res.blob.arrayBuffer();
  const info = inspectWavBuffer(buffer);
  const view = new DataView(buffer, info.dataOffset, info.dataSize);

  // Clip 2 MUST still start at exactly 2.0s (active audio at frame 32100 after 5ms fade), not pushed down
  assert.equal(view.getInt16(31999 * 2, true), 0, 'Frame 31999 at boundary cutoff must be 0');
  assert.notEqual(view.getInt16(32100 * 2, true), 0, 'Clip 2 must begin at exact timestamp 2.0s (frame 32100 active)');
  assert.equal(readWavDurationSeconds(buffer), 3.0);
});

test('assembleTimelineAlignedVoiceover validates sample rates, handles empty clips, and supports audio mastering', async () => {
  // Empty input
  const emptyRes = await assembleTimelineAlignedVoiceover({ segments: [], segmentClips: {} });
  assert.equal(emptyRes.blob, null);
  assert.equal(emptyRes.duration, 0);

  // Mismatched sample rates
  const clip16k = createPcmWavBlob(200, 16000);
  const clip48k = createPcmWavBlob(200, 48000);
  const segments = [
    { id: 'cue-1', start: 0, end: 1 },
    { id: 'cue-2', start: 1, end: 2 },
  ];
  await assert.rejects(
    () => assembleTimelineAlignedVoiceover({
      segments,
      segmentClips: { 'cue-1': { blob: clip16k }, 'cue-2': { blob: clip48k } },
    }),
    err => err.code === 'WAV_FORMAT_MISMATCH'
  );

  // Explicit sample rate check
  await assert.rejects(
    () => assembleTimelineAlignedVoiceover({
      segments,
      segmentClips: { 'cue-1': { blob: clip16k } },
      sampleRate: 24000,
    }),
    err => err.code === 'WAV_FORMAT_MISMATCH'
  );

  // Audio mastering delegation
  let masteredCalled = false;
  const mockMaster = {
    masterWav: async blob => {
      masteredCalled = true;
      return { blob, mastered: true };
    },
  };
  const masterRes = await assembleTimelineAlignedVoiceover({
    segments: [{ id: 'cue-1', start: 0.5, end: 1.5 }],
    segmentClips: { 'cue-1': { blob: clip16k } },
    audioMaster: mockMaster,
  });
  assert.equal(masteredCalled, true);
  assert.equal(masterRes.mastered, true);

  // Audio mastering exception falls back safely to unmastered blob
  const failingMaster = {
    masterWav: async () => {
      throw new Error('Mastering backend offline');
    },
  };
  const fallbackRes = await assembleTimelineAlignedVoiceover({
    segments: [{ id: 'cue-1', start: 0.5, end: 1.5 }],
    segmentClips: { 'cue-1': { blob: clip16k } },
    audioMaster: failingMaster,
  });
  assert.ok(fallbackRes.blob);
  assert.equal(fallbackRes.mastered, false);
});

test('assembleTimelineAlignedVoiceover handles boundary edge cases: 0.0s start, sub-millisecond precision, and inverted timestamps', async () => {
  const sampleRate = 16000;
  const clip1 = createPcmWavBlob(300, sampleRate);
  const clip2 = createPcmWavBlob(200, sampleRate);

  // Cue 1 starts at exact 0.0s, Cue 2 starts at 0.0001s (rounds to 2 frames at 16kHz)
  // Cue 1 will be clamped to 2 frames because Cue 2 immediately follows
  const segments = [
    { id: 'c-zero', start: 0.0, end: -1 }, // inverted end < start
    { id: 'c-subms', start: 0.5, end: 0.8 },
  ];
  const segmentClips = {
    'c-zero': { blob: clip1 },
    'c-subms': { blob: clip2 },
  };

  const res = await assembleTimelineAlignedVoiceover({
    segments,
    segmentClips,
    totalDuration: 1.0,
    sampleRate,
  });

  assert.ok(res.blob);
  assert.equal(res.clipCount, 2);
  assert.equal(res.duration, 1.0);

  const buffer = await res.blob.arrayBuffer();
  const info = inspectWavBuffer(buffer);
  const view = new DataView(buffer, info.dataOffset, info.dataSize);

  // Frame 100 must be active audio (since Cue 1 starts at 0.0s, active after 5ms fade)
  assert.notEqual(view.getInt16(100 * 2, true), 0, 'Frame 100 must have active audio from 0.0s start');

  // Silence before Cue 2: Cue 1 ends at 0.3s (frame 4800). Cue 2 starts at 0.5s (frame 8000).
  for (let f = 4800; f < 8000; f += 200) {
    assert.equal(view.getInt16(f * 2, true), 0, `Frame ${f} must be silence between cues`);
  }
});

test('assembleTimelineAlignedVoiceover strictDurationCheck rejects mismatches unless spill-approved, and buildDubExportClips marks approved spills', async () => {
  const sampleRate = 16000;
  const clip1 = createPcmWavBlob(1500, sampleRate); // 1.5s
  const clip2 = createPcmWavBlob(500, sampleRate);  // 0.5s
  const segments = [
    { id: 'cue-1', start: 0.0, end: 1.0, text: 'Line 1' }, // cue 1s, gap until 2s!
    { id: 'cue-2', start: 2.0, end: 3.0, text: 'Line 2' },
  ];
  const segmentClips = {
    'cue-1': { blob: clip1, signature: 'sig-1', durationSeconds: 1.5 },
    'cue-2': { blob: clip2, signature: 'sig-2', durationSeconds: 0.5 },
  };

  // Without spill approval, strictDurationCheck throws DURATION_MISMATCH
  await assert.rejects(
    () => assembleTimelineAlignedVoiceover({
      segments,
      segmentClips,
      totalDuration: 3.5,
      sampleRate,
      strictDurationCheck: true,
    }),
    err => err.code === 'DURATION_MISMATCH' && /Cue #1 \(\+0\.50s\)/.test(err.message)
  );

  // With valid spill approval (cue-1 fits before cue-2 at 2.0s), strictDurationCheck succeeds without trimming
  const spillApprovals = {
    'cue-1': {
      segmentId: 'cue-1',
      clipSignature: 'sig-1',
      clipDuration: 1.5,
      cueStart: 0.0,
      cueEnd: 1.0,
    },
  };
  const aligned = await assembleTimelineAlignedVoiceover({
    segments,
    segmentClips,
    totalDuration: 3.5,
    sampleRate,
    strictDurationCheck: true,
    spillApprovals,
  });
  assert.ok(aligned.blob);
  assert.equal(aligned.mismatches.length, 0);
  assert.equal(aligned.warnings.length, 0);

  const dubClips = buildDubExportClips(segments, [], segmentClips, { spillApprovals, mediaDuration: 3.5 });
  assert.equal(dubClips[0].allowOverflow, true);
  assert.equal(dubClips[1].allowOverflow, undefined);

  // If mediaDuration shrinks below clip1 end (1.5s > 1.3s), allowOverflow is automatically revoked
  const tightDubClips = buildDubExportClips(segments, [], segmentClips, { spillApprovals, mediaDuration: 1.3 });
  assert.equal(tightDubClips[0].allowOverflow, undefined);
});

test('assembleTimelineAlignedVoiceover preserves full cue numbering and ungenerated neighbor collision checks', async () => {
  const sampleRate = 16000;
  const clip1 = createPcmWavBlob(1500, sampleRate); // 1.5s -> collides with ungenerated cue-2 at 1.2s
  const clip3 = createPcmWavBlob(1800, sampleRate); // 1.8s -> Cue #3 (2.5-3.5s -> +0.80s)
  const segments = [
    { id: 'cue-1', start: 0.0, end: 1.0 },
    { id: 'cue-2', start: 1.2, end: 2.0 }, // no generated clip yet
    { id: 'cue-3', start: 2.5, end: 3.5 },
  ];
  const segmentClips = {
    'cue-1': { blob: clip1, signature: 's1' },
    'cue-3': { blob: clip3, signature: 's3' },
  };

  // Selecting only cue-3 reports Cue #3 (not Cue #1)
  await assert.rejects(
    () => assembleTimelineAlignedVoiceover({
      segments,
      segmentClips,
      selectedIds: ['cue-3'],
      totalDuration: 5.0,
      sampleRate,
      strictDurationCheck: true,
    }),
    err => err.code === 'DURATION_MISMATCH' && /Cue #3 \(\+0\.80s\)/.test(err.message)
  );

  // Spill approval on cue-1 is rejected when ungenerated cue-2 starts at 1.2s (< 1.5s)
  await assert.rejects(
    () => assembleTimelineAlignedVoiceover({
      segments,
      segmentClips,
      selectedIds: ['cue-1'],
      totalDuration: 5.0,
      sampleRate,
      strictDurationCheck: true,
      spillApprovals: {
        'cue-1': { segmentId: 'cue-1', clipSignature: 's1', clipDuration: 1.5, cueStart: 0.0, cueEnd: 1.0 },
      },
    }),
    err => err.code === 'DURATION_MISMATCH' && /Cue #1/.test(err.message)
  );
});

test('assembleTimelineAlignedVoiceover honors spill approvals on real speech WAVs with edge silence and skips clamping warnings within 5ms tolerance', async () => {
  const sampleRate = 16000;
  // Build 2.15s WAV with 100ms head silence + 1.80s active speech + 250ms tail silence (prepareCleanPcmSlice trims to ~1.925s)
  const totalSamples = Math.round(sampleRate * 2.15);
  const dataSize = totalSamples * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeTag = (off, tag) => { for (let i = 0; i < 4; i++) view.setUint8(off + i, tag.charCodeAt(i)); };
  writeTag(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeTag(8, 'WAVE'); writeTag(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); writeTag(36, 'data'); view.setUint32(40, dataSize, true);
  const activeStart = Math.round(sampleRate * 0.1);
  const activeEnd = Math.round(sampleRate * 1.9);
  for (let i = activeStart; i < activeEnd; i++) {
    view.setInt16(44 + i * 2, i % 2 === 0 ? 9000 : -9000, true);
  }
  const paddedWav = new Blob([buf], { type: 'audio/wav' });
  const tolWav = createPcmWavBlob(1003, sampleRate); // 1.003s in 1.000s window (+3ms <= 5ms tolerance)

  const segments = [
    { id: 'cue-1', start: 0.0, end: 1.5 },
    { id: 'cue-2', start: 3.0, end: 4.0 },
  ];
  const segmentClips = {
    'cue-1': { blob: paddedWav, signature: 'sig-padded', durationSeconds: 2.15 },
    'cue-2': { blob: tolWav, signature: 'sig-tol', durationSeconds: 1.003 },
  };
  const spillApprovals = {
    'cue-1': { segmentId: 'cue-1', clipSignature: 'sig-padded', clipDuration: 2.15, cueStart: 0.0, cueEnd: 1.5, allocatedDuration: 1.5 },
  };

  const aligned = await assembleTimelineAlignedVoiceover({
    segments,
    segmentClips,
    totalDuration: 4.0,
    sampleRate,
    strictDurationCheck: true,
    spillApprovals,
  });
  assert.ok(aligned.blob);
  assert.equal(aligned.mismatches.length, 0, 'Padded WAV must not invalidate spill approval after silence trimming');
  assert.equal(aligned.warnings.length, 0, '3ms rounding excess must not emit spurious clamping warning');
});
