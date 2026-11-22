/**
 * @fileoverview Integration test suite verifying multi-speaker script workflow (R2-07).
 * Tests per-segment character assignment, multi-speaker synthesis with isolated anchors,
 * outdated take detection on voice switch, and boundary-preserving multi-speaker restitching.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN_VOICES } from '../../src/domain/voiceLibrary.js';
import {
  createEditableSegment,
  attachTakeToSegment,
  assignSegmentVoice,
  assignSegmentVoiceInList,
  isMultiSpeakerScript,
  getScriptVoiceIds,
  computeSegmentStatus,
} from '../../src/domain/projectSegments.js';
import { createSegmentTake } from '../../src/domain/projects.js';
import { createSynthesizeSpeechUseCase } from '../../src/domain/useCases.js';
import { inspectWavBuffer } from '../../src/domain/wavCodec.js';

const CHAR_NISA = BUILT_IN_VOICES[0];
const CHAR_KIRI = BUILT_IN_VOICES[1];
const SAMPLE_RATE_HZ = 48000;
const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_SIZE = 44;

function writeWavHeader(view, dataSize) {
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
  view.setUint32(24, SAMPLE_RATE_HZ, true);
  view.setUint32(28, SAMPLE_RATE_HZ * BYTES_PER_SAMPLE, true);
  view.setUint16(32, BYTES_PER_SAMPLE, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
}

function makeWavBlob(sampleCount = 2400, sampleVal = 200) {
  const dataSize = sampleCount * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(WAV_HEADER_SIZE + dataSize);
  const view = new DataView(buffer);
  writeWavHeader(view, dataSize);
  for (let i = 0; i < sampleCount; i += 1) {
    view.setInt16(WAV_HEADER_SIZE + i * BYTES_PER_SAMPLE, sampleVal, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function createMockSpeechGateway() {
  const uploads = [];
  const syntheses = [];
  return {
    uploads,
    syntheses,
    async uploadReferenceAudio(params) {
      uploads.push(params);
      return { path: `/tmp/${params.characterId}.wav`, meta: { _type: 'gradio.FileData' } };
    },
    async synthesize(params) {
      syntheses.push(params);
      const val = params.text.includes('នីសា') ? 300 : 500;
      return {
        blob: makeWavBlob(4800, val),
        duration: 0.1,
        seed: params.seed ?? 777,
      };
    },
  };
}

test('Multi-speaker integration: script voice inspection and assignment', () => {
  const seg1 = createEditableSegment({ id: 's1', text: 'Sentence 1', voiceId: CHAR_NISA.id, speakerName: CHAR_NISA.name });
  const seg2 = createEditableSegment({ id: 's2', text: 'Sentence 2', voiceId: CHAR_KIRI.id, speakerName: CHAR_KIRI.name });
  const list = [seg1, seg2];

  assert.equal(isMultiSpeakerScript(list), true);
  assert.deepEqual(getScriptVoiceIds(list), [CHAR_NISA.id, CHAR_KIRI.id]);

  const updatedList = assignSegmentVoiceInList(list, 's2', CHAR_NISA.id, CHAR_NISA.name);
  assert.equal(isMultiSpeakerScript(updatedList), false);
  assert.deepEqual(getScriptVoiceIds(updatedList), [CHAR_NISA.id]);
});

test('Multi-speaker integration: voice switch invalidates take and marks segment outdated', () => {
  const takeNisa = createSegmentTake({
    id: 't-nisa',
    duration: 1.2,
    isSelected: true,
    settings: { voiceId: CHAR_NISA.id },
  });
  const seg = createEditableSegment({
    id: 's-voice-switch',
    text: 'សួស្តីកម្ពុជា',
    voiceId: CHAR_NISA.id,
    speakerName: CHAR_NISA.name,
    takes: [takeNisa],
    status: 'ready',
  });

  assert.equal(computeSegmentStatus(seg), 'ready');

  // Change voice to Kiri -> status turns outdated
  const segOutdated = assignSegmentVoice(seg, CHAR_KIRI.id, CHAR_KIRI.name);
  assert.equal(segOutdated.voiceId, CHAR_KIRI.id);
  assert.equal(segOutdated.speakerName, CHAR_KIRI.name);
  assert.equal(segOutdated.status, 'outdated');

  // Reverting to Nisa -> status becomes ready again
  const segRestored = assignSegmentVoice(segOutdated, CHAR_NISA.id, CHAR_NISA.name);
  assert.equal(segRestored.status, 'ready');
});

test('Multi-speaker integration: synthesizeMultiSpeaker generates isolated character audio and chunks', async () => {
  const gateway = createMockSpeechGateway();
  const useCase = createSynthesizeSpeechUseCase({ speechGateway: gateway });

  const anchorNisa = { characterId: CHAR_NISA.id, blob: makeWavBlob(480, 10), transcript: 'នីសា' };
  const anchorKiri = { characterId: CHAR_KIRI.id, blob: makeWavBlob(480, 20), transcript: 'គីរី' };

  const seg1 = createEditableSegment({ id: 's1', text: 'អត្ថបទពីនីសា', voiceId: CHAR_NISA.id, speakerName: CHAR_NISA.name, pauseDuration: 0.2 });
  const seg2 = createEditableSegment({ id: 's2', text: 'អត្ថបទពីគីរី', voiceId: CHAR_KIRI.id, speakerName: CHAR_KIRI.name, pauseDuration: 0.15 });

  const progressSteps = [];
  const result = await useCase.synthesizeMultiSpeaker({
    segments: [seg1, seg2],
    characters: [CHAR_NISA, CHAR_KIRI],
    anchors: { [CHAR_NISA.id]: anchorNisa, [CHAR_KIRI.id]: anchorKiri },
    options: { guidance: 2.0, steps: 10, defaultPauseSeconds: 0.2 },
    onProgress: p => progressSteps.push(p),
  });

  assert.equal(gateway.uploads.length, 2);
  assert.equal(gateway.syntheses.length, 2);
  assert.ok(gateway.uploads[0].fileName.includes(CHAR_NISA.id));
  assert.ok(gateway.uploads[1].fileName.includes(CHAR_KIRI.id));
  assert.equal(gateway.syntheses[0].text, 'អត្ថបទពីនីសា');
  assert.equal(gateway.syntheses[1].text, 'អត្ថបទពីគីរី');

  assert.ok(result.recording);
  assert.equal(result.recording.isMultiSpeaker, true);
  assert.equal(result.recording.characterId, 'multi-speaker');
  assert.equal(result.recording.characterName, 'Multiple speakers');
  assert.equal(result.recording.chunks.length, 2);

  const [c1, c2] = result.recording.chunks;
  assert.equal(c1.voiceId, CHAR_NISA.id);
  assert.equal(c1.speakerName, CHAR_NISA.name);
  assert.equal(c2.voiceId, CHAR_KIRI.id);
  assert.equal(c2.speakerName, CHAR_KIRI.name);

  const stitchedBuffer = await result.recording.blob.arrayBuffer();
  const info = inspectWavBuffer(stitchedBuffer);
  assert.equal(info.sampleRate, SAMPLE_RATE_HZ);
  assert.ok(info.dataSize > 0);
});

test('Multi-speaker integration: restitchSegments preserves chunk speaker tags and identities', async () => {
  const useCase = createSynthesizeSpeechUseCase({
    speechGateway: createMockSpeechGateway(),
  });

  const blob1 = makeWavBlob(4800, 100);
  const blob2 = makeWavBlob(4800, 200);
  const take1 = createSegmentTake({ id: 't1', duration: 0.1, blob: blob1, isSelected: true, settings: { voiceId: CHAR_NISA.id } });
  const take2 = createSegmentTake({ id: 't2', duration: 0.1, blob: blob2, isSelected: true, settings: { voiceId: CHAR_KIRI.id } });

  const seg1 = createEditableSegment({ id: 's1', text: 'ជំហានទីមួយ', voiceId: CHAR_NISA.id, speakerName: CHAR_NISA.name, takes: [take1] });
  const seg2 = createEditableSegment({ id: 's2', text: 'ជំហានទីពីរ', voiceId: CHAR_KIRI.id, speakerName: CHAR_KIRI.name, takes: [take2] });

  const result = await useCase.restitchSegments({
    segments: [seg1, seg2],
    options: { defaultPauseSeconds: 0.15 },
  });

  assert.ok(result.recording);
  assert.equal(result.recording.isMultiSpeaker, true);
  assert.equal(result.recording.characterId, 'multi-speaker');
  assert.equal(result.recording.characterName, 'Multiple speakers');
  assert.equal(result.recording.chunks[0].voiceId, CHAR_NISA.id);
  assert.equal(result.recording.chunks[1].voiceId, CHAR_KIRI.id);
});

test('Multi-speaker integration: applies pronunciation rules to per-segment speech input', async () => {
  const gateway = createMockSpeechGateway();
  const useCase = createSynthesizeSpeechUseCase({ speechGateway: gateway });

  const anchorNisa = { characterId: CHAR_NISA.id, blob: makeWavBlob(480, 10), transcript: 'នីសា' };
  const anchorKiri = { characterId: CHAR_KIRI.id, blob: makeWavBlob(480, 20), transcript: 'គីរី' };

  const seg1 = createEditableSegment({ id: 's1', text: 'យើងកំពុងប្រើ AI ទំនើប', voiceId: CHAR_NISA.id, speakerName: CHAR_NISA.name });
  const seg2 = createEditableSegment({ id: 's2', text: 'បាទ AI នេះល្អណាស់', voiceId: CHAR_KIRI.id, speakerName: CHAR_KIRI.name });

  const rules = [
    { id: 'r1', source: 'AI', replacement: 'បញ្ញាសិប្បនិម្មិត', enabled: true },
  ];

  await useCase.synthesizeMultiSpeaker({
    segments: [seg1, seg2],
    characters: [CHAR_NISA, CHAR_KIRI],
    anchors: { [CHAR_NISA.id]: anchorNisa, [CHAR_KIRI.id]: anchorKiri },
    options: { pronunciationRules: rules },
  });

  assert.equal(gateway.syntheses.length, 2);
  assert.ok(gateway.syntheses[0].text.includes('បញ្ញាសិប្បនិម្មិត'));
  assert.ok(!gateway.syntheses[0].text.includes('AI'));
  assert.ok(gateway.syntheses[1].text.includes('បញ្ញាសិប្បនិម្មិត'));
  assert.ok(!gateway.syntheses[1].text.includes('AI'));
});
