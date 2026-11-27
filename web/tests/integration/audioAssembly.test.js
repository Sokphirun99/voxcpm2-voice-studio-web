import test from 'node:test';
import assert from 'node:assert/strict';
import { SynthesisError, ValidationError } from '../../src/domain/errors.js';
import { createEditableSegment } from '../../src/domain/projectSegments.js';
import { createSegmentTake } from '../../src/domain/projects.js';
import { createSynthesizeSpeechUseCase } from '../../src/domain/useCases.js';
import { inspectWavBuffer, readWavDurationSeconds } from '../../src/domain/wavCodec.js';

function makeWav(sampleRate, durationSec, amplitude) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = 2;
  const byteRate = sampleRate * blockAlign;
  const frameCount = Math.round(sampleRate * durationSec);
  const dataSize = frameCount * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const write = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  write(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let f = 0; f < frameCount; f++) view.setInt16(44 + f * 2, amplitude, true);
  return new Blob([buffer], { type: 'audio/wav' });
}

test('Audio assembly integration: assembles selected takes in exact segment order with deliberate pauses (R2-08)', async () => {
  const useCase = createSynthesizeSpeechUseCase({
    speechGateway: { async uploadReferenceAudio() {}, async synthesize() {} },
  });

  const rate = 48000;
  const take1A = createSegmentTake({ id: 't1a', duration: 0.2, blob: makeWav(rate, 0.2, 500), isSelected: false });
  const take1B = createSegmentTake({ id: 't1b', duration: 0.3, blob: makeWav(rate, 0.3, 1500), isSelected: true });
  const take2A = createSegmentTake({ id: 't2a', duration: 0.4, blob: makeWav(rate, 0.4, 2500), isSelected: true });
  const take3A = createSegmentTake({ id: 't3a', duration: 0.25, blob: makeWav(rate, 0.25, 3500), isSelected: true });

  const seg1 = createEditableSegment({ id: 's1', text: 'សេចក្តីផ្តើម', pauseDuration: 0.5, takes: [take1A, take1B] });
  const seg2 = createEditableSegment({ id: 's2', text: 'ខ្លឹមសារសំខាន់', pauseDuration: 0.3, takes: [take2A] });
  const seg3 = createEditableSegment({ id: 's3', text: 'សេចក្តីសន្និដ្ឋាន', pauseDuration: 1.0, takes: [take3A] });

  const result = await useCase.assembleAudioNarration({
    segments: [seg1, seg2, seg3],
    projectTitle: 'Khmer Narration Project',
    options: { defaultPauseSeconds: 0.2 },
  });

  assert.ok(result.recording);
  assert.equal(result.recording.isAssembled, true);
  assert.equal(result.recording.isNarration, true);
  assert.equal(result.filename, 'khmer-narration-project-narration.wav');
  assert.equal(result.recording.chunks.length, 3);

  // Take 1B (selected) must be used, not 1A
  assert.equal(result.recording.chunks[0].takeId, 't1b');
  assert.equal(result.recording.chunks[0].pauseAfterMs, 500);
  assert.equal(result.recording.chunks[1].takeId, 't2a');
  assert.equal(result.recording.chunks[1].pauseAfterMs, 300);
  assert.equal(result.recording.chunks[2].takeId, 't3a');

  // Verify full assembled duration: take1B(0.3) + pause1(0.5) + take2A(0.4) + pause2(0.3) + take3A(0.25) = 1.75s
  const rawBytes = await result.blob.arrayBuffer();
  const info = inspectWavBuffer(rawBytes);
  assert.equal(info.sampleRate, rate);
  const totalDuration = readWavDurationSeconds(rawBytes);
  assert.equal(Math.round(totalDuration * 100) / 100, 1.75);

  // Check that the deliberate 500ms pause between segment 1 and 2 contains zero-byte PCM silence
  const pauseStart = info.dataOffset + Math.round(0.3 * rate) * 2;
  const pauseSlice = new Uint8Array(rawBytes, pauseStart, Math.round(0.5 * rate) * 2);
  assert.ok(pauseSlice.every(b => b === 0), 'Deliberate pause slice should be pure PCM silence');
});

test('Audio assembly integration: guards against accidental omissions across segments (R2-08)', async () => {
  const useCase = createSynthesizeSpeechUseCase({
    speechGateway: { async uploadReferenceAudio() {}, async synthesize() {} },
  });

  const rate = 48000;
  const take1 = createSegmentTake({ id: 't1', duration: 0.2, blob: makeWav(rate, 0.2, 500), isSelected: true });
  const take3 = createSegmentTake({ id: 't3', duration: 0.2, blob: makeWav(rate, 0.2, 500), isSelected: true });

  const seg1 = createEditableSegment({ id: 's1', text: 'ផ្នែកទីមួយ', takes: [take1] });
  const seg2Missing = createEditableSegment({ id: 's2', text: 'ផ្នែកទីពីរគ្មានសំឡេង', takes: [] });
  const seg3 = createEditableSegment({ id: 's3', text: 'ផ្នែកទីបី', takes: [take3] });
  const seg4Missing = createEditableSegment({ id: 's4', text: 'ផ្នែកទីបួនគ្មានសំឡេង', takes: [] });

  // Single missing take
  await assert.rejects(
    () => useCase.assembleAudioNarration({ segments: [seg1, seg2Missing, seg3] }),
    err => {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.code, 'MISSING_SEGMENT_TAKE');
      assert.ok(err.message.includes('Segment #2 has no audio take. Generate all segments before assembling narration.'));
      return true;
    }
  );

  // Multiple missing takes
  await assert.rejects(
    () => useCase.assembleAudioNarration({ segments: [seg1, seg2Missing, seg3, seg4Missing] }),
    err => {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.code, 'MISSING_SEGMENT_TAKE');
      assert.ok(err.message.includes('Segments #2, #4 have no audio takes. Generate all segments before assembling narration.'));
      return true;
    }
  );

  // Blank segment preceding a missing take segment preserves accurate 1-based editor index
  const segBlankLead = createEditableSegment({ id: 's0-blank', text: '   ', takes: [] });
  await assert.rejects(
    () => useCase.assembleAudioNarration({ segments: [segBlankLead, seg1, seg2Missing] }),
    err => {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.code, 'MISSING_SEGMENT_TAKE');
      assert.ok(err.message.includes('Segment #3 has no audio take. Generate all segments before assembling narration.'));
      return true;
    }
  );
});

test('Audio assembly integration: enforces sample-rate and bit-depth validation (R2-08)', async () => {
  const useCase = createSynthesizeSpeechUseCase({
    speechGateway: { async uploadReferenceAudio() {}, async synthesize() {} },
  });

  const take48k = createSegmentTake({ id: 't48', duration: 0.2, blob: makeWav(48000, 0.2, 500), isSelected: true });
  const take24k = createSegmentTake({ id: 't24', duration: 0.2, blob: makeWav(24000, 0.2, 500), isSelected: true });

  const seg1 = createEditableSegment({ id: 's1', text: 'សំឡេង 48kHz', takes: [take48k] });
  const seg2 = createEditableSegment({ id: 's2', text: 'សំឡេង 24kHz ខុសកូដ', takes: [take24k] });

  await assert.rejects(
    () => useCase.assembleAudioNarration({ segments: [seg1, seg2] }),
    err => {
      assert.ok(err instanceof SynthesisError);
      assert.equal(err.code, 'WAV_FORMAT_MISMATCH');
      assert.ok(err.message.includes('Segment #2 has mismatched sample rate: expected 48000 Hz, received 24000 Hz.'));
      return true;
    }
  );
});
