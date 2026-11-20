import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DUB_AUDIO_MODE,
  DUB_AUDIO_MODE_OPTIONS,
  SUBTITLE_VOICEOVER_GAP_OPTIONS,
  SUBTITLE_VOICEOVER_PAUSE_MS,
  buildCombinedVoiceoverBlob,
  buildDubDownloadFilename,
  buildDubExportClips,
  buildSubtitleSpeechSignature,
  buildSubtitleSynthesisCommand,
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
});
