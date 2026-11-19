import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCombinedVoiceoverBlob,
  buildSubtitleSpeechSignature,
  buildSubtitleSynthesisCommand,
  buildVoiceoverDownloadFilename,
  isKhmerScriptText,
  resolveSubtitleSpeechText,
  selectOrderedSegments,
} from '../../src/domain/subtitleTts.js';
import { readWavDurationSeconds } from '../../src/domain/wavCodec.js';

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
    view.setInt16(44 + i * 2, Math.round(Math.sin(i / 8) * 12000), true);
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

test('buildCombinedVoiceoverBlob handles empty, single, and stitched multi-frame PCM WAV clips cleanly', async () => {
  assert.equal(await buildCombinedVoiceoverBlob([]), null);

  const clip1 = createPcmWavBlob(120);
  const clip2 = createPcmWavBlob(120);
  const single = await buildCombinedVoiceoverBlob([clip1]);
  assert.equal(single.type, 'audio/wav');

  const combined = await buildCombinedVoiceoverBlob([clip1, clip2], 200);
  assert.equal(combined.type, 'audio/wav');
  const duration = readWavDurationSeconds(await combined.arrayBuffer());
  assert.ok(duration > 0.35 && duration < 0.6, `Expected combined WAV duration ~0.44s, got ${duration}`);
});
