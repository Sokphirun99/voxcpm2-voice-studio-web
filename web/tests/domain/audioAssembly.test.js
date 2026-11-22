import test from 'node:test';
import assert from 'node:assert/strict';
import { SynthesisError, ValidationError } from '../../src/domain/errors.js';
import { createEditableSegment } from '../../src/domain/projectSegments.js';
import { createSegmentTake } from '../../src/domain/projects.js';
import {
  assembleAudioNarration,
  assertCompleteSegments,
  assertMatchingWaveFormats,
  assertPcmFormat,
  buildAssemblyEntry,
  DEFAULT_ASSEMBLY_PAUSE_SECONDS,
  DEFAULT_NARRATION_FILENAME,
  findOmittedSegmentIndices,
  formatNarrationExportFilename,
  resolveTakeAudioBlob,
  validateAssemblyTakeFormats,
} from '../../src/domain/audioAssembly.js';
import { inspectWavBuffer, readWavDurationSeconds } from '../../src/domain/wavCodec.js';

function makeWavBlob({ sampleRate = 48000, numChannels = 1, bitsPerSample = 16, samples = [200, -200, 400, -400] } = {}) {
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * 2;
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
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  write(36, 'data');
  view.setUint32(40, dataSize, true);
  samples.forEach((v, idx) => view.setInt16(44 + idx * 2, v, true));
  return new Blob([buffer], { type: 'audio/wav' });
}

test('findOmittedSegmentIndices detects segments missing takes or audio assets', () => {
  const segComplete = createEditableSegment({
    id: 's1',
    text: 'ជំរាបសួរ',
    takes: [createSegmentTake({ id: 't1', duration: 1.0, blob: makeWavBlob() })],
  });
  const segNoTake = createEditableSegment({
    id: 's2',
    text: 'អត្ថបទទីពីរ',
    takes: [],
  });
  const segEmptyTake = createEditableSegment({
    id: 's3',
    text: 'អត្ថបទទីបី',
    takes: [createSegmentTake({ id: 't3', duration: 1.0 })],
  });
  const segBlankText = createEditableSegment({
    id: 's4',
    text: '   ',
    takes: [],
  });

  const omitted = findOmittedSegmentIndices([segComplete, segNoTake, segBlankText]);
  assert.deepEqual(omitted, [2]);
  assert.deepEqual(findOmittedSegmentIndices([segComplete]), []);
  assert.deepEqual(findOmittedSegmentIndices(null), []);
});

test('assertCompleteSegments guards against accidental omissions with descriptive error messages', () => {
  assert.throws(
    () => assertCompleteSegments([]),
    err => err instanceof ValidationError && err.code === 'EMPTY_SEGMENTS'
  );
  assert.throws(
    () => assertCompleteSegments([createEditableSegment({ id: 's0', text: '' })]),
    err => err instanceof ValidationError && err.code === 'EMPTY_SEGMENTS'
  );

  const take1 = createSegmentTake({ id: 't1', duration: 1.0, blob: makeWavBlob() });
  const seg1 = createEditableSegment({ id: 's1', text: 'ផ្នែកទីមួយ', takes: [take1] });
  const seg2NoTake = createEditableSegment({ id: 's2', text: 'ផ្នែកទីពីរ', takes: [] });
  const seg3NoTake = createEditableSegment({ id: 's3', text: 'ផ្នែកទីបី', takes: [] });

  assert.throws(
    () => assertCompleteSegments([seg1, seg2NoTake]),
    err => err instanceof ValidationError && err.code === 'MISSING_SEGMENT_TAKE' && err.message.includes('Segment #2')
  );

  assert.throws(
    () => assertCompleteSegments([seg1, seg2NoTake, seg3NoTake]),
    err => err instanceof ValidationError && err.code === 'MISSING_SEGMENT_TAKE' && err.message.includes('Segments #2, #3')
  );

  // Blank segment preceding a missing take segment preserves accurate original 1-based index
  const segBlankLead = createEditableSegment({ id: 's-blank', text: '   ', takes: [] });
  assert.throws(
    () => assertCompleteSegments([segBlankLead, seg2NoTake]),
    err => err instanceof ValidationError && err.code === 'MISSING_SEGMENT_TAKE' && err.message.includes('Segment #2')
  );

  const valid = assertCompleteSegments([seg1]);
  assert.equal(valid.length, 1);
});

test('assertPcmFormat validates PCM encoding and bit depth', () => {
  assert.doesNotThrow(() => assertPcmFormat({ audioFormat: 1, bitsPerSample: 16 }, 0));

  assert.throws(
    () => assertPcmFormat({ audioFormat: 3, bitsPerSample: 32 }, 0),
    err => err instanceof SynthesisError && err.code === 'WAV_FORMAT_MISMATCH' && err.message.includes('Segment #1 is not PCM')
  );

  assert.throws(
    () => assertPcmFormat({ audioFormat: 1, bitsPerSample: 24 }, 1),
    err => err instanceof SynthesisError && err.code === 'WAV_FORMAT_MISMATCH' && err.message.includes('expected 16-bit PCM, got 24-bit')
  );
});

test('assertMatchingWaveFormats catches sample rate and channel mismatches', () => {
  const base = { audioFormat: 1, sampleRate: 48000, numChannels: 1, bitsPerSample: 16 };
  const matching = { audioFormat: 1, sampleRate: 48000, numChannels: 1, bitsPerSample: 16 };
  const diffRate = { audioFormat: 1, sampleRate: 24000, numChannels: 1, bitsPerSample: 16 };
  const diffChan = { audioFormat: 1, sampleRate: 48000, numChannels: 2, bitsPerSample: 16 };

  assert.doesNotThrow(() => assertMatchingWaveFormats(base, matching, 1));

  assert.throws(
    () => assertMatchingWaveFormats(base, diffRate, 1),
    err => err instanceof SynthesisError && err.code === 'WAV_FORMAT_MISMATCH' && err.message.includes('expected 48000 Hz, received 24000 Hz')
  );

  assert.throws(
    () => assertMatchingWaveFormats(base, diffChan, 2),
    err => err instanceof SynthesisError && err.code === 'WAV_FORMAT_MISMATCH' && err.message.includes('expected 1, received 2')
  );
});

test('resolveTakeAudioBlob handles direct blobs, assetFetcher, and audioUrl', async () => {
  const sampleBlob = makeWavBlob();
  const directTake = createSegmentTake({ id: 't1', duration: 1.0, blob: sampleBlob });
  assert.equal(await resolveTakeAudioBlob(directTake, null), sampleBlob);

  const assetTake = createSegmentTake({ id: 't2', duration: 1.0, audioAssetId: '00000000-0000-4000-8000-000000000001' });
  const fetcher = async id => (id === '00000000-0000-4000-8000-000000000001' ? { bytes: new Uint8Array([1, 2, 3]) } : null);
  const fetched = await resolveTakeAudioBlob(assetTake, fetcher);
  assert.ok(fetched instanceof Blob);

  const emptyTake = createSegmentTake({ id: 't3', duration: 1.0 });
  assert.equal(await resolveTakeAudioBlob(emptyTake, null), null);
});

test('formatNarrationExportFilename generates sanitized kebab-case names and supports Unicode titles', () => {
  assert.equal(formatNarrationExportFilename('My Khmer Story!'), 'my-khmer-story-narration.wav');
  assert.equal(formatNarrationExportFilename('  Episode #01 — Intro  '), 'episode-01-intro-narration.wav');
  assert.equal(formatNarrationExportFilename('រឿងនិទានខ្មែរ'), 'រឿងនិទានខ្មែរ-narration.wav');
  assert.equal(formatNarrationExportFilename(''), DEFAULT_NARRATION_FILENAME);
  assert.equal(formatNarrationExportFilename(null), DEFAULT_NARRATION_FILENAME);
});

test('buildAssemblyEntry and validateAssemblyTakeFormats validate ordering and formats', async () => {
  const blob48k = makeWavBlob({ sampleRate: 48000, samples: new Array(4800).fill(500) });
  const blob16k = makeWavBlob({ sampleRate: 16000, samples: new Array(1600).fill(500) });

  const takeA = createSegmentTake({ id: 'ta', duration: 0.1, blob: blob48k });
  const segA = createEditableSegment({ id: 'sa', text: 'ឃ្លាទីមួយ', pauseDuration: 0.4, takes: [takeA] });

  const entry = await buildAssemblyEntry({ seg: segA, idx: 0, defaultPauseSeconds: DEFAULT_ASSEMBLY_PAUSE_SECONDS });
  assert.equal(entry.pauseAfterMs, 400);
  assert.equal(entry.text, 'ឃ្លាទីមួយ');

  const validEntries = [entry, entry];
  await assert.doesNotReject(() => validateAssemblyTakeFormats(validEntries));

  const takeBad = createSegmentTake({ id: 'tbad', duration: 0.1, blob: blob16k });
  const segBad = createEditableSegment({ id: 'sbad', text: 'ឃ្លាទីពីរ', takes: [takeBad] });
  const badEntry = await buildAssemblyEntry({ seg: segBad, idx: 1, defaultPauseSeconds: DEFAULT_ASSEMBLY_PAUSE_SECONDS });

  await assert.rejects(
    () => validateAssemblyTakeFormats([entry, badEntry]),
    err => err instanceof SynthesisError && err.code === 'WAV_FORMAT_MISMATCH' && err.message.includes('Segment #2')
  );
});

test('assembleAudioNarration executes full assembly with calibrated pauses, micro-fades, and narration metadata', async () => {
  const sampleRate = 48000;
  const clip1 = makeWavBlob({ sampleRate, samples: new Array(sampleRate * 0.2).fill(1500) });
  const clip2 = makeWavBlob({ sampleRate, samples: new Array(sampleRate * 0.3).fill(2500) });

  const take1 = createSegmentTake({ id: 't1', duration: 0.2, blob: clip1, isSelected: true });
  const take2 = createSegmentTake({ id: 't2', duration: 0.3, blob: clip2, isSelected: true });

  const seg1 = createEditableSegment({ id: 's1', text: 'សួស្តីកម្ពុជា', pauseDuration: 0.5, takes: [take1] });
  const seg2 = createEditableSegment({ id: 's2', text: 'រាត្រីសួស្តី', takes: [take2] });

  let masteredCalled = false;
  const mockMaster = {
    async masterWav(blob) {
      masteredCalled = true;
      return { blob, mastered: true };
    },
  };

  const result = await assembleAudioNarration({
    segments: [seg1, seg2],
    character: { id: 'char-kiri', name: 'Kiri' },
    projectTitle: 'Story Demo',
    options: { defaultPauseSeconds: 0.25 },
    audioMaster: mockMaster,
  });

  assert.ok(result.recording);
  assert.equal(result.recording.isAssembled, true);
  assert.equal(result.recording.isNarration, true);
  assert.equal(result.recording.isRestitched, true);
  assert.equal(result.recording.characterName, 'Kiri');
  assert.equal(result.filename, 'story-demo-narration.wav');
  assert.equal(result.recording.filename, 'story-demo-narration.wav');
  assert.equal(masteredCalled, true);
  assert.equal(result.recording.mastered, true);

  // Check timing: clip1 (0.2s) + pause1 (0.5s) + clip2 (0.3s) = 1.0s
  const duration = readWavDurationSeconds(await result.blob.arrayBuffer());
  assert.equal(Math.round(duration * 10) / 10, 1.0);
  assert.equal(result.recording.chunks.length, 2);
  assert.equal(result.recording.chunks[0].pauseAfterMs, 500);
});
