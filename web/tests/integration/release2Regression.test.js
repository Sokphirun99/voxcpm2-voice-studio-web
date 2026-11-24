/**
 * @fileoverview End-to-end regression test suite verifying all 7 Release 2 Exit Criteria (R2-10).
 * Validates Khmer script segmentation, non-breaking grapheme clusters, isolated per-segment
 * regeneration, take history and comparison, outdated take detection on edits, project-specific
 * pronunciation overrides, calibrated audio assembly, and full persistence across service restarts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  PROJECT_SCHEMA_VERSION,
  createProject,
  createProjectSegment,
  createSegmentTake,
  generateProjectId,
} from '../../src/domain/projects.js';

import {
  DEFAULT_PAUSE_SECONDS,
  DEFAULT_SEGMENT_STATUS,
  SEGMENT_STATUSES,
  addSegment,
  assignSegmentVoice,
  assignSegmentVoiceInList,
  attachTakeToSegment,
  attachTakesToSegments,
  computeLcsMatches,
  computeSegmentStatus,
  countGraphemeClusters,
  createEditableSegment,
  cycleSegmentTake,
  deleteSegment,
  findSegmentById,
  getScriptVoiceIds,
  getSegmentActiveTake,
  getSegmentTake,
  hasSegmentAudio,
  insertSegment,
  isGraphemeClusterIntact,
  isMultiSpeakerScript,
  isSegmentOutdated,
  isSegmentReady,
  isTakeOutdated,
  mergeAdjacentSegments,
  mergeSegments,
  moveSegmentDown,
  moveSegmentUp,
  reconcileScriptToSegments,
  removeSegmentTake,
  removeSegmentTakeInList,
  reorderSegments,
  scriptToSegments,
  segmentsToScript,
  selectSegmentTake,
  selectSegmentTakeInList,
  sliceGraphemeClusters,
  snapToGraphemeBoundary,
  splitGraphemeClusters,
  splitSegment,
  splitSegmentInList,
  updateSegmentContent,
  updateSegmentInList,
} from '../../src/domain/projectSegments.js';

import {
  DEFAULT_ASSEMBLY_PAUSE_SECONDS,
  DEFAULT_NARRATION_FILENAME,
  EXPECTED_AUDIO_FORMAT,
  EXPECTED_BITS_PER_SAMPLE,
  assembleAudioNarration,
  assertCompleteSegments,
  assertMatchingWaveFormats,
  assertPcmFormat,
  findOmittedSegmentIndices,
  formatNarrationExportFilename,
} from '../../src/domain/audioAssembly.js';

import {
  applyPronunciationRules,
  normalizeGlossaryRules,
} from '../../src/domain/pronunciationRules.js';

import { BUILT_IN_VOICES } from '../../src/domain/voiceLibrary.js';
import { SynthesisError, ValidationError } from '../../src/domain/errors.js';
import { inspectWavBuffer, readWavDurationSeconds } from '../../src/domain/wavCodec.js';
import { createSynthesizeSpeechUseCase } from '../../src/domain/useCases.js';
import { persistTakeAsset, resolveTakeAudioUrl } from '../../src/data/takeAssetStorage.js';
import { createStorageStore } from '../../server/storageStore.js';
import { verifyStorageIntegrity } from '../../server/storageMigration.js';

const SAMPLE_RATE_HZ = 48000;
const ALT_SAMPLE_RATE_HZ = 44100;
const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_SIZE = 44;
const DEFAULT_AMPLITUDE = 500;
const ALT_AMPLITUDE = 1200;

const DURATION_TINY = 0.1;
const DURATION_SHORT = 0.2;
const DURATION_MEDIUM = 0.3;
const DURATION_LONG = 0.4;
const PAUSE_SHORT = 0.2;
const PAUSE_MEDIUM = 0.5;

const SEED_TAKE_1 = 101;
const SEED_TAKE_2 = 202;
const SEED_TAKE_3 = 303;

const CHAR_NISA = BUILT_IN_VOICES[0];
const CHAR_KIRI = BUILT_IN_VOICES[1];

const KHMER_LONG_SCRIPT =
  'សួស្តីបងប្អូនទាំងអស់គ្នា។ ស្វាគមន៍មកកាន់ស្ទូឌីយោសំឡេងខ្មែរ! [pause 0.5s] យើងនឹងបង្ហាញអំពីការបង្កើតសំឡេង។ សង្ឃឹមថាអ្នកទាំងអស់គ្នានឹងពេញចិត្ត។';
const KHMER_COMPLEX_TEXT = 'ខ្ញុំស្រឡាញ់ភាសាខ្មែរ និងវប្បធម៌ខ្មែរយ៉ាងជ្រាលជ្រៅ។';
const KHMER_SENTENCE_A = 'ផ្នែកទីមួយនៃអត្ថបទ។';
const KHMER_SENTENCE_B = 'ផ្នែកទីពីរនៃអត្ថបទ។';
const KHMER_SENTENCE_C = 'ផ្នែកទីបីនៃអត្ថបទ។';

/**
 * Writes standard 44-byte RIFF/WAVE header fields into a DataView.
 * Inputs: view (DataView), dataSize (number), sampleRate (number).
 * Outputs: none.
 * Side effects: writes header bytes to view.
 * Failure modes: throws RangeError if view buffer is too small.
 * @param {DataView} view - Destination DataView.
 * @param {number} dataSize - Audio payload size in bytes.
 * @param {number} [sampleRate=SAMPLE_RATE_HZ] - Audio sample rate.
 */
function writeWavHeader(view, dataSize, sampleRate = SAMPLE_RATE_HZ) {
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true);
  view.setUint16(32, BYTES_PER_SAMPLE, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
}

/**
 * Generates valid 48kHz mono 16-bit PCM WAV audio Buffer.
 * Inputs: durationSec (number), amplitude (number), sampleRate (number).
 * Outputs: Buffer containing valid WAV audio.
 * Side effects: none.
 * Failure modes: none.
 * @param {number} durationSec - Duration in seconds.
 * @param {number} [amplitude=DEFAULT_AMPLITUDE] - Sample amplitude.
 * @param {number} [sampleRate=SAMPLE_RATE_HZ] - Sample rate.
 * @returns {Buffer} WAV audio buffer.
 */
function createWavBuffer(durationSec, amplitude = DEFAULT_AMPLITUDE, sampleRate = SAMPLE_RATE_HZ) {
  const sampleCount = Math.round(sampleRate * durationSec);
  const dataSize = sampleCount * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(WAV_HEADER_SIZE + dataSize);
  const view = new DataView(buffer);
  writeWavHeader(view, dataSize, sampleRate);
  for (let i = 0; i < sampleCount; i += 1) {
    view.setInt16(WAV_HEADER_SIZE + i * BYTES_PER_SAMPLE, amplitude, true);
  }
  return Buffer.from(buffer);
}

/**
 * Generates valid 48kHz mono 16-bit PCM WAV audio Blob.
 * Inputs: durationSec (number), amplitude (number), sampleRate (number).
 * Outputs: Blob containing valid WAV audio.
 * Side effects: none.
 * Failure modes: none.
 * @param {number} durationSec - Duration in seconds.
 * @param {number} [amplitude=DEFAULT_AMPLITUDE] - Sample amplitude.
 * @param {number} [sampleRate=SAMPLE_RATE_HZ] - Sample rate.
 * @returns {Blob} WAV audio Blob.
 */
function createWavBlob(durationSec, amplitude = DEFAULT_AMPLITUDE, sampleRate = SAMPLE_RATE_HZ) {
  const buf = createWavBuffer(durationSec, amplitude, sampleRate);
  return new Blob([buf], { type: 'audio/wav' });
}

/**
 * Writes RIFF/WAVE header fields supporting arbitrary channel counts and sample rates.
 * Inputs: DataView, format metadata object.
 * Outputs: none.
 * Side effects: writes header bytes into DataView.
 * Failure modes: throws RangeError if view buffer is insufficient.
 * @param {DataView} view - Target DataView.
 * @param {object} meta - Header parameters.
 */
function writeCustomWavHeader(view, { dataSize, sampleRate, numChannels, blockAlign, bitsPerSample }) {
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
}

/**
 * Generates custom PCM WAV Blob supporting arbitrary channels, rates, and bit depths.
 * Inputs: spec ({ durationSec, sampleRate, numChannels, bitsPerSample, amplitude }).
 * Outputs: Blob with audio/wav MIME.
 * Side effects: none.
 * Failure modes: none.
 * @param {object} [spec] - Generation parameters.
 * @returns {Blob} WAV Blob.
 */
function createCustomWavBlob(spec = {}) {
  const { durationSec = DURATION_SHORT, sampleRate = SAMPLE_RATE_HZ, numChannels = 1, bitsPerSample = 16, amplitude = DEFAULT_AMPLITUDE } = spec;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const sampleCount = Math.round(sampleRate * durationSec);
  const dataSize = sampleCount * blockAlign;
  const buffer = new ArrayBuffer(WAV_HEADER_SIZE + dataSize);
  const view = new DataView(buffer);
  writeCustomWavHeader(view, { dataSize, sampleRate, numChannels, blockAlign, bitsPerSample });
  for (let i = 0; i < sampleCount * numChannels; i += 1) {
    view.setInt16(WAV_HEADER_SIZE + i * bytesPerSample, amplitude, true);
  }
  return new Blob([Buffer.from(buffer)], { type: 'audio/wav' });
}

/**
 * Creates temporary directory and initialized StorageStore for test isolation.
 * Inputs: none.
 * Outputs: Promise<{ tempDir: string, store: object }>.
 * Side effects: creates temporary directory on disk.
 * Failure modes: throws on filesystem failure.
 * @returns {Promise<{ tempDir: string, store: object }>} Storage test fixture.
 */
async function createTempStorage() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'r2-regression-'));
  const store = createStorageStore({ dataDir: tempDir });
  await store.init();
  return { tempDir, store };
}

/**
 * Cleans up temporary directory recursively.
 * Inputs: targetDir (string).
 * Outputs: Promise<void>.
 * Side effects: deletes directory from disk.
 * Failure modes: none.
 * @param {string} targetDir - Directory path to remove.
 * @returns {Promise<void>}
 */
async function cleanupTempDir(targetDir) {
  if (targetDir) await rm(targetDir, { recursive: true, force: true });
}

/**
 * Creates a mock SpeechGateway supporting call recording and mock return values.
 * Inputs: audioBlob (Blob), seed (number).
 * Outputs: Mock SpeechGatewayPort implementation.
 * Side effects: tracks uploads and syntheses in arrays.
 * Failure modes: none.
 * @param {Blob} [audioBlob] - Audio blob to return on synthesis.
 * @param {number} [seed=SEED_TAKE_1] - Default seed.
 * @returns {object} Mock SpeechGateway.
 */
function createMockSpeechGateway(audioBlob = null, seed = SEED_TAKE_1) {
  const uploads = [];
  const syntheses = [];
  const blob = audioBlob || createWavBlob(DURATION_SHORT);
  return {
    uploads,
    syntheses,
    async uploadReferenceAudio(params) {
      uploads.push(params);
      return { path: `/tmp/ref-${params.fileName}`, meta: { _type: 'gradio.FileData' } };
    },
    async synthesize(params) {
      syntheses.push(params);
      return { blob, seed: params.seed ?? seed, duration: DURATION_SHORT };
    },
  };
}

/**
 * Creates an in-memory SynthesisCache double for deterministic cache testing.
 * Inputs: none.
 * Outputs: Mock SynthesisCachePort.
 * Side effects: stores clips in an internal Map.
 * Failure modes: none.
 * @returns {object} Mock SynthesisCachePort.
 */
function createMockSynthesisCache() {
  const store = new Map();
  return {
    store,
    computeKey: async spec => `${spec.characterId}:${spec.text}:${spec.seed}:${spec.guidance}`,
    getCachedAudio: async key => store.get(key) || null,
    putCachedAudio: async (key, blob, meta) => {
      store.set(key, { blob, seed: meta.seed });
    },
  };
}

function resolveTakeBlob(spec) {
  if (spec.blob !== undefined) return spec.blob;
  if (spec.audioAssetId) return null;
  return createWavBlob(spec.duration ?? DURATION_SHORT);
}

/**
 * Builds a test SegmentTake entity with standard defaults.
 * Inputs: spec ({ id, duration, isSelected, audioAssetId, seed, voiceId, blob }).
 * Outputs: Frozen SegmentTake entity.
 * Side effects: none.
 * Failure modes: throws ValidationError on invalid spec.
 * @param {object} spec - Take parameters.
 * @returns {Readonly<object>} Frozen take object.
 */
function createTestTake(spec) {
  return createSegmentTake({
    id: spec.id,
    duration: spec.duration ?? DURATION_SHORT,
    isSelected: spec.isSelected ?? false,
    audioAssetId: spec.audioAssetId ?? null,
    blob: resolveTakeBlob(spec),
    settings: {
      seed: spec.seed ?? SEED_TAKE_1,
      voiceId: spec.voiceId ?? CHAR_NISA.id,
      text: spec.text ?? '',
      guidance: 2.0,
      steps: 10,
    },
  });
}

// ============================================================================
// Release 2 Exit Criterion 1: Long scripts split into useful segments without breaking Khmer text.
// ============================================================================

test('Release 2 Criterion 1.1: Long scripts split into useful segments respecting punctuation and pauses', () => {
  const segments = scriptToSegments(KHMER_LONG_SCRIPT);
  assert.equal(segments.length >= 3, true);
  assert.equal(segments[0].text.includes('សួស្តីបងប្អូន'), true);
  assert.equal(segments[1].text.includes('ស្វាគមន៍'), true);
  assert.equal(segments[1].pauseDuration, 0.5);
  for (const seg of segments) {
    assert.equal(typeof seg.id, 'string');
    assert.equal(seg.status, DEFAULT_SEGMENT_STATUS);
    assert.equal(seg.takes.length, 0);
  }
});

test('Release 2 Criterion 1.2: Grapheme cluster integrity is preserved across all split segments', () => {
  const segments = scriptToSegments(KHMER_LONG_SCRIPT);
  for (const seg of segments) {
    assert.equal(isGraphemeClusterIntact(seg.text), true);
    const clusters = splitGraphemeClusters(seg.text);
    assert.equal(clusters.length > 0, true);
    assert.equal(clusters.join(''), seg.text);
  }
});

test('Release 2 Criterion 1.3: snapToGraphemeBoundary reliably prevents splitting within Khmer clusters', () => {
  const text = KHMER_COMPLEX_TEXT;
  for (let offset = 0; offset <= text.length; offset += 1) {
    const safeOffset = snapToGraphemeBoundary(text, offset);
    const prefix = text.slice(0, safeOffset);
    const suffix = text.slice(safeOffset);
    assert.equal(isGraphemeClusterIntact(prefix), true);
    assert.equal(isGraphemeClusterIntact(suffix), true);
  }
});

test('Release 2 Criterion 1.4: Script serialization roundtrip maintains textual fidelity and pause durations', () => {
  const original = scriptToSegments(KHMER_LONG_SCRIPT);
  const serialized = segmentsToScript(original);
  assert.equal(serialized.includes('[pause 0.5s]'), true);
  const roundtripped = scriptToSegments(serialized);
  assert.equal(roundtripped.length, original.length);
  for (let i = 0; i < original.length; i += 1) {
    assert.equal(roundtripped[i].text, original[i].text);
    assert.equal(roundtripped[i].pauseDuration, original[i].pauseDuration);
  }
});

test('Release 2 Criterion 1.5: Reconciling modified scripts preserves stable IDs and takes of untouched segments', () => {
  const seg1 = createEditableSegment({ id: 's1', text: KHMER_SENTENCE_A, takes: [createTestTake({ id: 't1', isSelected: true })] });
  const seg2 = createEditableSegment({ id: 's2', text: KHMER_SENTENCE_B, takes: [createTestTake({ id: 't2', isSelected: true })] });
  const oldSegments = [seg1, seg2];

  const modifiedScript = `${KHMER_SENTENCE_A} ${KHMER_SENTENCE_C}`;
  const reconciled = reconcileScriptToSegments(oldSegments, modifiedScript);

  assert.equal(reconciled.length, 2);
  assert.equal(reconciled[0].id, 's1');
  assert.equal(reconciled[0].takes.length, 1);
  assert.equal(reconciled[0].takes[0].id, 't1');
  assert.equal(reconciled[1].text, KHMER_SENTENCE_C);
});

test('Release 2 Criterion 1.6: Interactive segment operations (split, merge, reorder, delete) maintain segment versioning', () => {
  const take1 = createTestTake({ id: 't1', isSelected: true });
  const seg1 = createEditableSegment({ id: 's1', text: 'ផ្នែកទីមួយ និងផ្នែកទីពីរ', takes: [take1], status: 'ready' });
  const [half1, half2] = splitSegment(seg1, 10);

  assert.equal(half1.id, 's1');
  assert.equal(half1.status, 'draft');
  assert.equal(half1.takes.length, 0);
  assert.equal(half2.status, 'draft');
  assert.equal(isGraphemeClusterIntact(half1.text), true);
  assert.equal(isGraphemeClusterIntact(half2.text), true);

  const merged = mergeAdjacentSegments(half1, half2);
  assert.equal(merged.id, 's1');
  assert.equal(merged.status, 'draft');
  assert.equal(merged.takes.length, 0);
});

test('Release 2 Criterion 1.7: Script splitting handles consecutive Khmer sentence terminators and mixed punctuation without ghost segments', () => {
  const punctuatedScript = 'សួស្តីបងប្អូន។។ ស្វាគមន៍មកកាន់ស្ទូឌីយោ! [pause 0.4s] យើងចាប់ផ្តើម៕';
  const segments = scriptToSegments(punctuatedScript);
  assert.equal(segments.length, 3);
  assert.equal(segments[0].text.includes('សួស្តីបងប្អូន'), true);
  assert.equal(segments[1].text.includes('ស្វាគមន៍'), true);
  assert.equal(segments[1].pauseDuration, 0.4);
  assert.equal(segments[2].text.includes('យើងចាប់ផ្តើម'), true);
  for (const seg of segments) {
    assert.ok(seg.text.trim().length > 0);
    assert.equal(isGraphemeClusterIntact(seg.text), true);
  }
});

test('Release 2 Criterion 1.8: Preserves complex nested Khmer clusters across split, snapping, and merge operations', () => {
  const complexScript = 'ក្រុមការងារសង្គ្រោះបន្ទាន់ និងស្រ្តីខ្មែរនៅកណ្តាលរាជធានីភ្នំពេញ។';
  const seg = createEditableSegment({ id: 's-complex', text: complexScript });
  const mid = Math.floor(complexScript.length / 2);
  const [firstHalf, secondHalf] = splitSegment(seg, mid);

  assert.equal(isGraphemeClusterIntact(firstHalf.text), true);
  assert.equal(isGraphemeClusterIntact(secondHalf.text), true);

  const recombined = mergeAdjacentSegments(firstHalf, secondHalf);
  assert.equal(isGraphemeClusterIntact(recombined.text), true);
  assert.equal(countGraphemeClusters(recombined.text) >= 15, true);
});

// ============================================================================
// Release 2 Exit Criterion 2: Regenerating one segment leaves all unrelated clips intact.
// ============================================================================

test('Release 2 Criterion 2.1: Regenerating one segment updates only the target segment while leaving all others intact', () => {
  const take1 = createTestTake({ id: 'take-1', duration: 0.2, isSelected: true });
  const take2Old = createTestTake({ id: 'take-2-old', duration: 0.3, isSelected: true });
  const take3 = createTestTake({ id: 'take-3', duration: 0.4, isSelected: true });

  const seg1 = createEditableSegment({ id: 'seg-1', text: KHMER_SENTENCE_A, takes: [take1], status: 'ready' });
  const seg2 = createEditableSegment({ id: 'seg-2', text: KHMER_SENTENCE_B, takes: [take2Old], status: 'ready' });
  const seg3 = createEditableSegment({ id: 'seg-3', text: KHMER_SENTENCE_C, takes: [take3], status: 'ready' });

  const originalSegments = [seg1, seg2, seg3];
  const newRecording = { id: 'rec-2-new', duration: 0.35, blob: createWavBlob(0.35, ALT_AMPLITUDE), characterId: CHAR_NISA.id };
  const updatedSegments = attachTakeToSegment(originalSegments, 'seg-2', newRecording);

  assert.equal(updatedSegments.length, 3);
  assert.strictEqual(updatedSegments[0], originalSegments[0]);
  assert.strictEqual(updatedSegments[2], originalSegments[2]);
  assert.notStrictEqual(updatedSegments[1], originalSegments[1]);

  const targetTakes = updatedSegments[1].takes;
  assert.equal(targetTakes.length, 2);
  assert.equal(targetTakes[0].id, 'take-2-old');
  assert.equal(targetTakes[0].isSelected, false);
  assert.equal(targetTakes[1].isSelected, true);
  assert.equal(targetTakes[1].duration, 0.35);
});

test('Release 2 Criterion 2.2: Per-segment synthesis correctly integrates cache reuse on matching input', async () => {
  const gateway = createMockSpeechGateway();
  const cache = createMockSynthesisCache();
  const useCase = createSynthesizeSpeechUseCase({ speechGateway: gateway, synthesisCache: cache });

  const seg = createEditableSegment({ id: 's1', text: KHMER_SENTENCE_A, voiceId: CHAR_NISA.id });
  const first = await useCase.synthesizeSegment({ segment: seg, character: CHAR_NISA, options: { seed: SEED_TAKE_1, guidance: 2.0 } });
  assert.equal(gateway.syntheses.length, 1);
  assert.equal(first.recording.fromCache, false);

  const cached = await useCase.synthesizeSegment({ segment: seg, character: CHAR_NISA, options: { seed: SEED_TAKE_1, guidance: 2.0 } });
  assert.equal(gateway.syntheses.length, 1);
  assert.equal(cached.recording.fromCache, true);

  await useCase.synthesizeSegment({ segment: seg, character: CHAR_NISA, options: { seed: SEED_TAKE_2, guidance: 2.0 } });
  assert.equal(gateway.syntheses.length, 2);
});

test('Release 2 Criterion 2.3: Synthesis failures preserve existing takes and unrelated segment clips', async () => {
  const failingGateway = {
    async uploadReferenceAudio() { return { path: '/tmp/ref.wav', meta: { _type: 'gradio.FileData' } }; },
    async synthesize() { throw new SynthesisError('VoxCPM engine busy', { code: 'ENGINE_BUSY' }); },
  };
  const useCase = createSynthesizeSpeechUseCase({ speechGateway: failingGateway });

  const take1 = createTestTake({ id: 't1', isSelected: true });
  const take2 = createTestTake({ id: 't2', isSelected: true });
  const seg1 = createEditableSegment({ id: 's1', text: KHMER_SENTENCE_A, takes: [take1], status: 'ready' });
  const seg2 = createEditableSegment({ id: 's2', text: KHMER_SENTENCE_B, takes: [take2], status: 'ready' });

  await assert.rejects(
    async () => useCase.synthesizeSegment({ segment: seg2, character: CHAR_NISA }),
    err => err instanceof SynthesisError && err.code === 'ENGINE_BUSY'
  );

  assert.equal(seg1.takes.length, 1);
  assert.equal(seg1.takes[0].isSelected, true);
  assert.equal(seg2.takes.length, 1);
  assert.equal(seg2.takes[0].isSelected, true);
});

test('Release 2 Criterion 2.4: Synthesis with network abort controller preserves pre-existing takes and unaffected segments', async () => {
  const abortingGateway = {
    async uploadReferenceAudio() { return { path: '/tmp/ref.wav', meta: { _type: 'gradio.FileData' } }; },
    async synthesize({ signal }) {
      if (signal?.aborted) throw new DOMException('The user aborted a request.', 'AbortError');
      return new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('The user aborted a request.', 'AbortError')));
      });
    },
  };
  const useCase = createSynthesizeSpeechUseCase({ speechGateway: abortingGateway });

  const take1 = createTestTake({ id: 't1', isSelected: true });
  const take2 = createTestTake({ id: 't2', isSelected: true });
  const seg1 = createEditableSegment({ id: 's1', text: KHMER_SENTENCE_A, takes: [take1], status: 'ready' });
  const seg2 = createEditableSegment({ id: 's2', text: KHMER_SENTENCE_B, takes: [take2], status: 'ready' });

  const controller = new AbortController();
  const synthPromise = useCase.synthesizeSegment({ segment: seg2, character: CHAR_NISA, signal: controller.signal });
  controller.abort();

  await assert.rejects(synthPromise, err => err.name === 'AbortError');
  assert.equal(seg1.takes.length, 1);
  assert.equal(seg2.takes.length, 1);
});

// ============================================================================
// Release 2 Exit Criterion 3: At least two takes can be saved, compared, selected, and reopened.
// ============================================================================

test('Release 2 Criterion 3.1: Multiple takes can be saved, retained in history, compared, and selected', () => {
  const takeA = createTestTake({ id: 'take-a', duration: 1.2, seed: SEED_TAKE_1, isSelected: false });
  const takeB = createTestTake({ id: 'take-b', duration: 1.5, seed: SEED_TAKE_2, isSelected: true });

  const seg = createEditableSegment({ id: 's1', text: KHMER_SENTENCE_A, takes: [takeA, takeB], status: 'ready' });
  assert.equal(seg.takes.length, 2);
  assert.equal(getSegmentActiveTake(seg).id, 'take-b');

  const switchedToA = selectSegmentTake(seg, 'take-a');
  assert.equal(switchedToA.takes[0].isSelected, true);
  assert.equal(switchedToA.takes[1].isSelected, false);
  assert.equal(getSegmentActiveTake(switchedToA).id, 'take-a');

  assert.equal(switchedToA.takes[0].duration, 1.2);
  assert.equal(switchedToA.takes[1].duration, 1.5);
});

test('Release 2 Criterion 3.2: Cycling and pruning takes preserves take history and elects correct active take', () => {
  const takeA = createTestTake({ id: 'take-a', isSelected: true });
  const takeB = createTestTake({ id: 'take-b', isSelected: false });
  const takeC = createTestTake({ id: 'take-c', isSelected: false });
  const seg = createEditableSegment({ id: 's1', text: KHMER_SENTENCE_A, takes: [takeA, takeB, takeC] });

  const cycledForward = cycleSegmentTake(seg, 1);
  assert.equal(getSegmentActiveTake(cycledForward).id, 'take-b');

  const prunedActive = removeSegmentTake(cycledForward, 'take-b');
  assert.equal(prunedActive.takes.length, 2);
  assert.equal(getSegmentActiveTake(prunedActive).id, 'take-c');
});

test('Release 2 Criterion 3.3: Multiple takes per segment survive project save and reload with full settings', async () => {
  const { tempDir, store } = await createTempStorage();
  try {
    const assetA = await store.saveAsset({ bytes: createWavBuffer(1.0), fileName: 'take-a.wav', mimeType: 'audio/wav', kind: 'audio' });
    const assetB = await store.saveAsset({ bytes: createWavBuffer(1.5), fileName: 'take-b.wav', mimeType: 'audio/wav', kind: 'audio' });

    const takeA = createTestTake({ id: 'take-a', audioAssetId: assetA.id, duration: 1.0, isSelected: false, seed: SEED_TAKE_1 });
    const takeB = createTestTake({ id: 'take-b', audioAssetId: assetB.id, duration: 1.5, isSelected: true, seed: SEED_TAKE_2 });
    const seg = createEditableSegment({ id: 's1', text: KHMER_SENTENCE_A, takes: [takeA, takeB], status: 'ready' });

    const projId = generateProjectId();
    const proj = createProject({ id: projId, name: 'Take History Studio', type: 'tts', segments: [seg] });
    await store.upsertProject(projId, proj);

    const reloadedStore = createStorageStore({ dataDir: tempDir });
    await reloadedStore.init();
    const loaded = await reloadedStore.getProject(projId);

    const loadedSeg = loaded.segments[0];
    assert.equal(loadedSeg.takes.length, 2);
    assert.equal(loadedSeg.takes[0].id, 'take-a');
    assert.equal(loadedSeg.takes[0].isSelected, false);
    assert.equal(loadedSeg.takes[1].id, 'take-b');
    assert.equal(loadedSeg.takes[1].isSelected, true);
    assert.equal(resolveTakeAudioUrl(loadedSeg.takes[1]), `/api/v1/assets/${assetB.id}/binary`);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

test('Release 2 Criterion 3.4: Deleting active take re-elects remaining take, and deleting all takes reverts segment to draft', () => {
  const take1 = createTestTake({ id: 't-1', text: KHMER_SENTENCE_A, voiceId: CHAR_NISA.id, isSelected: false });
  const take2 = createTestTake({ id: 't-2', text: KHMER_SENTENCE_A, voiceId: CHAR_NISA.id, isSelected: true });
  const seg = createEditableSegment({ id: 's-take-del', text: KHMER_SENTENCE_A, voiceId: CHAR_NISA.id, takes: [take1, take2], status: 'ready' });

  const prunedActive = removeSegmentTake(seg, 't-2');
  assert.equal(prunedActive.takes.length, 1);
  assert.equal(prunedActive.takes[0].id, 't-1');
  assert.equal(prunedActive.takes[0].isSelected, true);
  assert.equal(prunedActive.status, 'ready');

  const prunedAll = removeSegmentTake(prunedActive, 't-1');
  assert.equal(prunedAll.takes.length, 0);
  assert.equal(prunedAll.status, 'draft');
});

// ============================================================================
// Release 2 Exit Criterion 4: Edited text or voice settings correctly mark previous generated takes as outdated.
// ============================================================================

test('Release 2 Criterion 4.1: Editing segment text marks previous takes as outdated and sets status outdated', () => {
  const take = createTestTake({ id: 't1', text: KHMER_SENTENCE_A, voiceId: CHAR_NISA.id, isSelected: true });
  const seg = createEditableSegment({ id: 's1', text: KHMER_SENTENCE_A, voiceId: CHAR_NISA.id, takes: [take], status: 'ready' });

  assert.equal(isTakeOutdated(take, seg), false);
  assert.equal(computeSegmentStatus(seg), 'ready');
  assert.equal(isSegmentOutdated(seg), false);

  const edited = updateSegmentContent(seg, { text: KHMER_SENTENCE_B });
  assert.equal(isTakeOutdated(take, edited), true);
  assert.equal(computeSegmentStatus(edited), 'outdated');
  assert.equal(isSegmentOutdated(edited), true);
});

test('Release 2 Criterion 4.2: Changing segment voice assignment marks previous takes as outdated', () => {
  const take = createTestTake({ id: 't1', text: KHMER_SENTENCE_A, voiceId: CHAR_NISA.id, isSelected: true });
  const seg = createEditableSegment({ id: 's1', text: KHMER_SENTENCE_A, voiceId: CHAR_NISA.id, takes: [take], status: 'ready' });

  const voiceChanged = assignSegmentVoice(seg, CHAR_KIRI.id, CHAR_KIRI.name);
  assert.equal(voiceChanged.voiceId, CHAR_KIRI.id);
  assert.equal(isTakeOutdated(take, voiceChanged), true);
  assert.equal(computeSegmentStatus(voiceChanged), 'outdated');
  assert.equal(isSegmentOutdated(voiceChanged), true);
});

test('Release 2 Criterion 4.3: Reverting text or voice back to take signature restores ready status', () => {
  const take = createTestTake({ id: 't1', text: KHMER_SENTENCE_A, voiceId: CHAR_NISA.id, isSelected: true });
  const seg = createEditableSegment({ id: 's1', text: KHMER_SENTENCE_A, voiceId: CHAR_NISA.id, takes: [take], status: 'ready' });

  const edited = updateSegmentContent(seg, { text: KHMER_SENTENCE_B });
  assert.equal(isSegmentOutdated(edited), true);

  const restored = updateSegmentContent(edited, { text: KHMER_SENTENCE_A });
  assert.equal(isSegmentOutdated(restored), false);
  assert.equal(computeSegmentStatus(restored), 'ready');
});

test('Release 2 Criterion 4.4: Non-text/voice edits like pauseDuration preserve ready take status', () => {
  const take = createTestTake({ id: 't1', text: KHMER_SENTENCE_A, voiceId: CHAR_NISA.id, isSelected: true });
  const seg = createEditableSegment({ id: 's1', text: KHMER_SENTENCE_A, voiceId: CHAR_NISA.id, takes: [take], status: 'ready' });

  const updatedPause = updateSegmentContent(seg, { pauseDuration: 1.5 });
  assert.equal(updatedPause.pauseDuration, 1.5);
  assert.equal(isTakeOutdated(take, updatedPause), false);
  assert.equal(computeSegmentStatus(updatedPause), 'ready');
});

test('Release 2 Criterion 4.5: Selecting or cycling to an outdated take sets segment status to outdated; selecting up-to-date restores ready', () => {
  const takeOld = createTestTake({ id: 't-old', text: KHMER_SENTENCE_A, voiceId: CHAR_NISA.id, isSelected: false });
  const takeCurrent = createTestTake({ id: 't-curr', text: KHMER_SENTENCE_B, voiceId: CHAR_NISA.id, isSelected: true });
  const seg = createEditableSegment({
    id: 's-toggle',
    text: KHMER_SENTENCE_B,
    voiceId: CHAR_NISA.id,
    takes: [takeOld, takeCurrent],
    status: 'ready',
  });

  assert.equal(seg.status, 'ready');

  const switchedToOld = selectSegmentTake(seg, 't-old');
  assert.equal(switchedToOld.status, 'outdated');
  assert.equal(isTakeOutdated(getSegmentActiveTake(switchedToOld), switchedToOld), true);

  const cycledBack = cycleSegmentTake(switchedToOld, 1);
  assert.equal(cycledBack.status, 'ready');
  assert.equal(getSegmentActiveTake(cycledBack).id, 't-curr');
});

test('Release 2 Criterion 4.6: Deleting an up-to-date take when only an outdated take remains updates segment status to outdated', () => {
  const takeOld = createTestTake({ id: 't-outdated', text: KHMER_SENTENCE_A, voiceId: CHAR_NISA.id, isSelected: false });
  const takeCurrent = createTestTake({ id: 't-valid', text: KHMER_SENTENCE_B, voiceId: CHAR_NISA.id, isSelected: true });
  const seg = createEditableSegment({
    id: 's-prune-outdated',
    text: KHMER_SENTENCE_B,
    voiceId: CHAR_NISA.id,
    takes: [takeOld, takeCurrent],
    status: 'ready',
  });

  const prunedValid = removeSegmentTake(seg, 't-valid');
  assert.equal(prunedValid.takes.length, 1);
  assert.equal(prunedValid.takes[0].id, 't-outdated');
  assert.equal(prunedValid.status, 'outdated');
});

// ============================================================================
// Release 2 Exit Criterion 5: Project-specific pronunciation overrides are applied only where intended.
// ============================================================================

test('Release 2 Criterion 5.1: Pronunciation rules apply literal longest-first term replacement at synthesis time', () => {
  const rules = [
    { id: 'r1', source: 'Voice Studio', replacement: 'ស្ទូឌីយោសំឡេង', enabled: true },
    { id: 'r2', source: 'Voice', replacement: 'សំឡេង', enabled: true },
  ];
  const input = 'Welcome to Voice Studio with clear Voice output';
  const rewritten = applyPronunciationRules(input, rules);
  assert.equal(rewritten, 'Welcome to ស្ទូឌីយោសំឡេង with clear សំឡេង output');
});

test('Release 2 Criterion 5.2: Pronunciation rules strictly respect Latin token boundaries and Khmer cluster edge guards', () => {
  const rules = [
    { id: 'r1', source: 'AI', replacement: 'បញ្ញាសិប្បនិម្មិត', enabled: true },
  ];
  const input = 'Khmer AI Voice model. TRAIN MAIN CLAIM.';
  const rewritten = applyPronunciationRules(input, rules);
  assert.equal(rewritten, 'Khmer បញ្ញាសិប្បនិម្មិត Voice model. TRAIN MAIN CLAIM.');
});

test('Release 2 Criterion 5.3: Pronunciation rules remain isolated to specific project and do not bleed', async () => {
  const rulesProj1 = [{ id: 'r1', source: 'Kiri', replacement: 'គិរី', enabled: true }];
  const rulesProj2 = [{ id: 'r2', source: 'Kiri', replacement: 'គីរី', enabled: true }];

  const gateway1 = createMockSpeechGateway();
  const gateway2 = createMockSpeechGateway();
  const useCase1 = createSynthesizeSpeechUseCase({ speechGateway: gateway1 });
  const useCase2 = createSynthesizeSpeechUseCase({ speechGateway: gateway2 });

  await useCase1.execute({ script: 'Voice of Kiri', character: CHAR_NISA, guidance: 2.0, steps: 10, pronunciationRules: rulesProj1 });
  await useCase2.execute({ script: 'Voice of Kiri', character: CHAR_NISA, guidance: 2.0, steps: 10, pronunciationRules: rulesProj2 });

  assert.equal(gateway1.syntheses[0].text, 'Voice of គិរី');
  assert.equal(gateway2.syntheses[0].text, 'Voice of គីរី');
});

test('Release 2 Criterion 5.4: Pronunciation overrides apply to synthesis input while preserving user-facing text', async () => {
  const rules = [{ id: 'r1', source: 'Khmer', replacement: 'ខេមរា', enabled: true }];
  const gateway = createMockSpeechGateway();
  const useCase = createSynthesizeSpeechUseCase({ speechGateway: gateway });

  const seg = createEditableSegment({ id: 's1', text: 'Khmer language', voiceId: CHAR_NISA.id });
  await useCase.synthesizeSegment({ segment: seg, character: CHAR_NISA, pronunciationRules: rules });

  assert.equal(seg.text, 'Khmer language');
  assert.equal(gateway.syntheses[0].text, 'ខេមរា language');
});

test('Release 2 Criterion 5.5: Disabled pronunciation rules (enabled: false) are ignored during synthesis and do not modify input', () => {
  const rules = [
    { id: 'r1', source: 'Apple', replacement: 'ផ្លែប៉ោម', enabled: false },
    { id: 'r2', source: 'Orange', replacement: 'ផ្លែក្រូច', enabled: true },
  ];
  const input = 'I like Apple and Orange juice.';
  const rewritten = applyPronunciationRules(input, rules);
  assert.equal(rewritten, 'I like Apple and ផ្លែក្រូច juice.');
});

test('Release 2 Criterion 5.6: Longest matching prefix rule takes precedence when pronunciation rules overlap', () => {
  const rules = [
    { id: 'r1', source: 'Voice', replacement: 'សំឡេង', enabled: true },
    { id: 'r2', source: 'Voice Studio Pro', replacement: 'ស្ទូឌីយោសំឡេងកម្រិតខ្ពស់', enabled: true },
    { id: 'r3', source: 'Voice Studio', replacement: 'ស្ទូឌីយោសំឡេង', enabled: true },
  ];
  const input = 'We produce with Voice Studio Pro and Voice Studio today.';
  const rewritten = applyPronunciationRules(input, rules);
  assert.equal(rewritten, 'We produce with ស្ទូឌីយោសំឡេងកម្រិតខ្ពស់ and ស្ទូឌីយោសំឡេង today.');
});

// ============================================================================
// Release 2 Exit Criterion 6: Assembled WAV is valid and plays all chosen takes in the right order.
// ============================================================================

test('Release 2 Criterion 6.1: Assembled WAV accurately sequences selected takes in exact segment order with pauses', async () => {
  const take1A = createTestTake({ id: 't1a', duration: 0.2, isSelected: false, blob: createWavBlob(0.2, 100) });
  const take1B = createTestTake({ id: 't1b', duration: 0.3, isSelected: true, blob: createWavBlob(0.3, 200) });
  const take2A = createTestTake({ id: 't2a', duration: 0.4, isSelected: true, blob: createWavBlob(0.4, 300) });
  const take2B = createTestTake({ id: 't2b', duration: 0.5, isSelected: false, blob: createWavBlob(0.5, 400) });

  const seg1 = createEditableSegment({ id: 's1', text: KHMER_SENTENCE_A, pauseDuration: 0.2, takes: [take1A, take1B] });
  const seg2 = createEditableSegment({ id: 's2', text: KHMER_SENTENCE_B, pauseDuration: 0.1, takes: [take2A, take2B] });

  const result = await assembleAudioNarration({
    segments: [seg1, seg2],
    projectTitle: 'Khmer Narration Production',
    options: { defaultPauseSeconds: 0.2 },
  });

  assert.equal(result.recording.chunks.length, 2);
  assert.equal(result.recording.chunks[0].takeId, 't1b');
  assert.equal(result.recording.chunks[1].takeId, 't2a');
  assert.equal(result.recording.isAssembled, true);
  assert.equal(result.filename, 'khmer-narration-production-narration.wav');
});

test('Release 2 Criterion 6.2: Assembled WAV output is valid 48kHz 16-bit mono PCM with exact duration and pause silence', async () => {
  const take1 = createTestTake({ id: 't1', duration: 0.3, isSelected: true, blob: createWavBlob(0.3, 500) });
  const take2 = createTestTake({ id: 't2', duration: 0.4, isSelected: true, blob: createWavBlob(0.4, 500) });
  const seg1 = createEditableSegment({ id: 's1', text: KHMER_SENTENCE_A, pauseDuration: 0.3, takes: [take1] });
  const seg2 = createEditableSegment({ id: 's2', text: KHMER_SENTENCE_B, pauseDuration: 0.0, takes: [take2] });

  const result = await assembleAudioNarration({ segments: [seg1, seg2], projectTitle: 'Silence Test' });
  const bytes = await result.blob.arrayBuffer();
  const info = inspectWavBuffer(bytes);

  assert.equal(info.sampleRate, SAMPLE_RATE_HZ);
  assert.equal(info.numChannels, 1);
  assert.equal(info.bitsPerSample, 16);

  const dur = readWavDurationSeconds(bytes);
  assert.equal(Math.round(dur * 100) / 100, 1.0);

  const pauseStartByte = info.dataOffset + Math.round(0.3 * SAMPLE_RATE_HZ) * BYTES_PER_SAMPLE;
  const pauseSlice = new Uint8Array(bytes, pauseStartByte, Math.round(0.3 * SAMPLE_RATE_HZ) * BYTES_PER_SAMPLE);
  assert.equal(pauseSlice.every(b => b === 0), true);
});

test('Release 2 Criterion 6.3: Audio assembly guards against omissions across segments, rejecting missing takes', async () => {
  const take1 = createTestTake({ id: 't1', isSelected: true });
  const seg1 = createEditableSegment({ id: 's1', text: KHMER_SENTENCE_A, takes: [take1] });
  const seg2Missing = createEditableSegment({ id: 's2', text: KHMER_SENTENCE_B, takes: [] });

  await assert.rejects(
    async () => assembleAudioNarration({ segments: [seg1, seg2Missing] }),
    err => err instanceof ValidationError && err.code === 'MISSING_SEGMENT_TAKE' && err.message.includes('#2')
  );
});

test('Release 2 Criterion 6.4: Audio assembly validates PCM format and bit depth, throwing SynthesisError on mismatch', async () => {
  const badSampleRateBlob = createWavBlob(0.2, DEFAULT_AMPLITUDE, ALT_SAMPLE_RATE_HZ);
  const take1 = createTestTake({ id: 't1', isSelected: true, blob: createWavBlob(0.2) });
  const take2 = createTestTake({ id: 't2', isSelected: true, blob: badSampleRateBlob });

  const seg1 = createEditableSegment({ id: 's1', text: KHMER_SENTENCE_A, takes: [take1] });
  const seg2 = createEditableSegment({ id: 's2', text: KHMER_SENTENCE_B, takes: [take2] });

  await assert.rejects(
    async () => assembleAudioNarration({ segments: [seg1, seg2] }),
    err => err instanceof SynthesisError && err.code === 'WAV_FORMAT_MISMATCH'
  );
});

test('Release 2 Criterion 6.5: Audio assembly sanitizes project titles into safe filesystem narration filenames', () => {
  const safe1 = formatNarrationExportFilename('Khmer Project: Episode #1!');
  assert.equal(safe1, 'khmer-project-episode-1-narration.wav');

  const safe2 = formatNarrationExportFilename('  ');
  assert.equal(safe2, DEFAULT_NARRATION_FILENAME);
});

test('Release 2 Criterion 6.6: Audio assembly rejects channel mismatch (mono vs stereo) with SynthesisError and code WAV_FORMAT_MISMATCH', async () => {
  const monoBlob = createWavBlob(0.2, DEFAULT_AMPLITUDE, SAMPLE_RATE_HZ);
  const stereoBlob = createCustomWavBlob({ durationSec: 0.2, numChannels: 2, sampleRate: SAMPLE_RATE_HZ });

  const take1 = createTestTake({ id: 't-mono', isSelected: true, blob: monoBlob });
  const take2 = createTestTake({ id: 't-stereo', isSelected: true, blob: stereoBlob });

  const seg1 = createEditableSegment({ id: 's-m1', text: KHMER_SENTENCE_A, takes: [take1] });
  const seg2 = createEditableSegment({ id: 's-m2', text: KHMER_SENTENCE_B, takes: [take2] });

  await assert.rejects(
    async () => assembleAudioNarration({ segments: [seg1, seg2] }),
    err => err instanceof SynthesisError && err.code === 'WAV_FORMAT_MISMATCH' && err.message.includes('mismatched channels')
  );
});

test('Release 2 Criterion 6.7: Single-segment assembly works correctly and outputs valid 48kHz PCM WAV', async () => {
  const take = createTestTake({ id: 't-solo', duration: 0.3, isSelected: true, blob: createWavBlob(0.3) });
  const seg = createEditableSegment({ id: 's-solo', text: KHMER_SENTENCE_A, takes: [take] });

  const result = await assembleAudioNarration({ segments: [seg], projectTitle: 'Single Segment Project' });
  assert.equal(result.recording.chunks.length, 1);
  assert.equal(result.recording.isAssembled, true);
  assert.equal(result.filename, 'single-segment-project-narration.wav');

  const bytes = await result.blob.arrayBuffer();
  const info = inspectWavBuffer(bytes);
  assert.equal(info.sampleRate, SAMPLE_RATE_HZ);
  assert.equal(info.numChannels, 1);
});

test('Release 2 Criterion 6.8: Audio assembly embeds custom per-segment pauses with exact zero-byte silence lengths', async () => {
  const take1 = createTestTake({ id: 't-p1', duration: 0.2, isSelected: true, blob: createWavBlob(0.2, 500) });
  const take2 = createTestTake({ id: 't-p2', duration: 0.3, isSelected: true, blob: createWavBlob(0.3, 500) });
  const seg1 = createEditableSegment({ id: 's-p1', text: KHMER_SENTENCE_A, pauseDuration: 0.4, takes: [take1] });
  const seg2 = createEditableSegment({ id: 's-p2', text: KHMER_SENTENCE_B, pauseDuration: 0.0, takes: [take2] });

  const result = await assembleAudioNarration({ segments: [seg1, seg2], projectTitle: 'Calibrated Pauses' });
  const bytes = await result.blob.arrayBuffer();
  const dur = readWavDurationSeconds(bytes);
  // 0.2 + 0.4 (pause) + 0.3 = 0.9s
  assert.equal(Math.round(dur * 10) / 10, 0.9);
});

test('Release 2 Criterion 6.9: Multi-speaker narration sets isMultiSpeaker flag and tracks distinct voices across chunks', async () => {
  const take1 = createTestTake({ id: 't-nisa', duration: 0.2, voiceId: CHAR_NISA.id, isSelected: true });
  const take2 = createTestTake({ id: 't-kiri', duration: 0.3, voiceId: CHAR_KIRI.id, isSelected: true });
  const seg1 = createEditableSegment({ id: 's-nisa', text: KHMER_SENTENCE_A, voiceId: CHAR_NISA.id, takes: [take1] });
  const seg2 = createEditableSegment({ id: 's-kiri', text: KHMER_SENTENCE_B, voiceId: CHAR_KIRI.id, takes: [take2] });

  const result = await assembleAudioNarration({ segments: [seg1, seg2], projectTitle: 'Multi Voice Cast' });
  assert.equal(result.recording.isMultiSpeaker, true);
  assert.equal(result.recording.characterId, 'multi-speaker');
  assert.equal(result.recording.chunks[0].voiceId, CHAR_NISA.id);
  assert.equal(result.recording.chunks[1].voiceId, CHAR_KIRI.id);
});

// ============================================================================
// Release 2 Exit Criterion 7: Saved project and take data persist across app/service restarts.
// ============================================================================

test('Release 2 Criterion 7.1: Multi-segment project with multiple takes persists atomically across service restart', async () => {
  const { tempDir, store } = await createTempStorage();
  try {
    const asset1A = await store.saveAsset({ bytes: createWavBuffer(0.2), fileName: 't1a.wav', mimeType: 'audio/wav', kind: 'audio' });
    const asset1B = await store.saveAsset({ bytes: createWavBuffer(0.3), fileName: 't1b.wav', mimeType: 'audio/wav', kind: 'audio' });
    const asset2A = await store.saveAsset({ bytes: createWavBuffer(0.4), fileName: 't2a.wav', mimeType: 'audio/wav', kind: 'audio' });

    const take1A = createTestTake({ id: 'take-1a', audioAssetId: asset1A.id, duration: 0.2, isSelected: false });
    const take1B = createTestTake({ id: 'take-1b', audioAssetId: asset1B.id, duration: 0.3, isSelected: true });
    const take2A = createTestTake({ id: 'take-2a', audioAssetId: asset2A.id, duration: 0.4, isSelected: true });

    const seg1 = createEditableSegment({ id: 's1', text: KHMER_SENTENCE_A, voiceId: CHAR_NISA.id, takes: [take1A, take1B], status: 'ready' });
    const seg2 = createEditableSegment({ id: 's2', text: KHMER_SENTENCE_B, voiceId: CHAR_KIRI.id, takes: [take2A], status: 'ready' });

    const projectId = generateProjectId();
    const project = createProject({
      id: projectId,
      name: 'Restart Persistence Suite',
      type: 'tts',
      segments: [seg1, seg2],
      settings: { script: `${KHMER_SENTENCE_A}\n${KHMER_SENTENCE_B}` },
    });

    await store.upsertProject(projectId, project);

    const restartedStore = createStorageStore({ dataDir: tempDir });
    await restartedStore.init();

    const loaded = await restartedStore.getProject(projectId);
    assert.equal(loaded.schemaVersion, PROJECT_SCHEMA_VERSION);
    assert.equal(loaded.segments.length, 2);

    assert.equal(loaded.segments[0].takes.length, 2);
    assert.equal(loaded.segments[0].takes[0].id, 'take-1a');
    assert.equal(loaded.segments[0].takes[0].isSelected, false);
    assert.equal(loaded.segments[0].takes[1].id, 'take-1b');
    assert.equal(loaded.segments[0].takes[1].isSelected, true);

    assert.equal(loaded.segments[1].takes.length, 1);
    assert.equal(loaded.segments[1].takes[0].id, 'take-2a');
    assert.equal(loaded.segments[1].takes[0].isSelected, true);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

test('Release 2 Criterion 7.2: Binary audio assets for all takes remain bit-for-bit identical after service reload', async () => {
  const { tempDir, store } = await createTempStorage();
  try {
    const rawBytes = createWavBuffer(0.25, 888);
    const asset = await store.saveAsset({ bytes: rawBytes, fileName: 'exact-audio.wav', mimeType: 'audio/wav', kind: 'audio' });

    const restartedStore = createStorageStore({ dataDir: tempDir });
    await restartedStore.init();

    const binary = await restartedStore.getAssetBinary(asset.id);
    assert.equal(binary.bytes.length, rawBytes.length);
    assert.equal(Buffer.compare(binary.bytes, rawBytes), 0);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

test('Release 2 Criterion 7.3: Storage integrity verification passes with zero errors on persisted R2 projects and takes', async () => {
  const { tempDir, store } = await createTempStorage();
  try {
    const asset = await store.saveAsset({ bytes: createWavBuffer(0.2), fileName: 'take.wav', mimeType: 'audio/wav', kind: 'audio' });
    const take = createTestTake({ id: 't1', audioAssetId: asset.id, isSelected: true });
    const seg = createEditableSegment({ id: 's1', text: KHMER_SENTENCE_A, takes: [take], status: 'ready' });

    const projectId = generateProjectId();
    const project = createProject({ id: projectId, name: 'Integrity Check Project', type: 'tts', segments: [seg] });
    await store.upsertProject(projectId, project);

    const integrity = await verifyStorageIntegrity({ dataDir: tempDir });
    assert.equal(integrity.valid, true);
    assert.equal(integrity.issues.length, 0);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

test('Release 2 Criterion 7.4: Deserialized JSON takes without in-memory Blobs correctly resolve audio URL to durable binary asset endpoint', () => {
  const deserializedTake = {
    id: 'take-persisted-1',
    duration: 1.2,
    isSelected: true,
    audioAssetId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
    blob: null,
    audioUrl: null,
  };
  const resolvedUrl = resolveTakeAudioUrl(deserializedTake);
  assert.equal(resolvedUrl, '/api/v1/assets/a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d/binary');

  // Also resilient if blob was deserialized as an empty object {}
  const deserializedWithEmptyObject = {
    ...deserializedTake,
    blob: {},
  };
  const fallbackUrl = resolveTakeAudioUrl(deserializedWithEmptyObject);
  assert.equal(fallbackUrl, '/api/v1/assets/a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d/binary');
});

test('Release 2 Criterion 7.5: Project save detects revision conflict and prevents stale overwrite across concurrent sessions', async () => {
  const { tempDir, store } = await createTempStorage();
  try {
    const projectId = generateProjectId();
    const seg = createEditableSegment({ id: 's1', text: KHMER_SENTENCE_A });
    const initialProject = createProject({ id: projectId, name: 'Concurrency Test', type: 'tts', segments: [seg], revision: 1 });

    const { project: created } = await store.upsertProject(projectId, initialProject);
    assert.equal(created.revision, 1);

    // Save with expectedRevision = 1 -> succeeds and increments to 2
    const { project: updated } = await store.upsertProject(projectId, { ...created, name: 'First Update' }, { expectedRevision: 1 });
    assert.equal(updated.revision, 2);

    // Stale concurrent update with expectedRevision = 1 -> throws conflict
    await assert.rejects(
      async () => store.upsertProject(projectId, { ...created, name: 'Stale Overwrite' }, { expectedRevision: 1 }),
      err => err.code === 'CONFLICT' || err.name === 'ConflictError'
    );
  } finally {
    await cleanupTempDir(tempDir);
  }
});
