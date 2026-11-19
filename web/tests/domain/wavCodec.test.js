import test from 'node:test';
import assert from 'node:assert/strict';
import { SynthesisError } from '../../src/domain/errors.js';
import {
  concatenateWavBlobs,
  ensureAudioWavBlob,
  inspectWavBuffer,
  readWavDurationSeconds,
  smoothAndTrimWavBlob,
  tryReadWavDurationSeconds,
  trySmoothWavBlob,
} from '../../src/domain/wavCodec.js';

function makeTestWavBlob({ sampleRate = 48000, numChannels = 1, bitsPerSample = 16, samples = [100, -100, 200, -200] } = {}) {
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
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  write(36, 'data');
  view.setUint32(40, dataSize, true);
  samples.forEach((value, idx) => view.setInt16(44 + idx * 2, value, true));
  return new Blob([buffer], { type: 'audio/wav' });
}

test('inspectWavBuffer and readWavDurationSeconds parse PCM headers accurately', async () => {
  const blob = makeTestWavBlob({ sampleRate: 48000, samples: new Array(48000).fill(500) });
  const buffer = await blob.arrayBuffer();
  const info = inspectWavBuffer(buffer);
  assert.equal(info.sampleRate, 48000);
  assert.equal(info.numChannels, 1);
  assert.equal(readWavDurationSeconds(buffer), 1);

  assert.throws(() => inspectWavBuffer(new ArrayBuffer(12)), SynthesisError);
});

test('concatenateWavBlobs stitches multiple WAVs with frame-aligned silence gaps', async () => {
  const first = makeTestWavBlob({ sampleRate: 48000, samples: [1000, 2000] });
  const second = makeTestWavBlob({ sampleRate: 48000, samples: [3000, 4000] });
  const combined = await concatenateWavBlobs([first, second], 100);
  const info = inspectWavBuffer(await combined.arrayBuffer());
  assert.equal(info.sampleRate, 48000);
  assert.equal(info.dataSize, 4 + 9600 + 4);

  const mismatched = makeTestWavBlob({ sampleRate: 16000, samples: [100, 200] });
  await assert.rejects(() => concatenateWavBlobs([first, mismatched], 100), err => err.code === 'WAV_FORMAT_MISMATCH');
});

test('ensureAudioWavBlob and tryReadWavDurationSeconds normalize octet-stream single takes safely', async () => {
  const wav = makeTestWavBlob({ sampleRate: 48000, samples: new Array(48000).fill(100) });
  const octetBlob = new Blob([await wav.arrayBuffer()], { type: 'application/octet-stream' });

  const normalized = ensureAudioWavBlob(octetBlob);
  assert.equal(normalized.type, 'audio/wav');
  assert.equal(ensureAudioWavBlob(wav), wav);

  const singleCombined = await concatenateWavBlobs([octetBlob]);
  assert.equal(singleCombined.type, 'audio/wav');

  assert.equal(tryReadWavDurationSeconds(await singleCombined.arrayBuffer()), 1);
  assert.equal(tryReadWavDurationSeconds(new ArrayBuffer(8)), 0);
  assert.equal(tryReadWavDurationSeconds(new TextEncoder().encode('RIFF____WAVEfmt ').buffer), 0);
});

test('smoothAndTrimWavBlob trims excessive edge silence and fades edges while preserving stub safety', async () => {
  // 500ms zeros + 200ms active speech (48kHz * 0.2 = 9600 frames) + 500ms zeros = 1.2s raw
  const samples = [
    ...new Array(24000).fill(0),
    ...new Array(9600).fill(4000),
    ...new Array(24000).fill(0),
  ];
  const rawBlob = makeTestWavBlob({ sampleRate: 48000, samples });
  const smoothed = await smoothAndTrimWavBlob(rawBlob);
  const info = inspectWavBuffer(await smoothed.arrayBuffer());
  const trimmedDuration = readWavDurationSeconds(await smoothed.arrayBuffer());

  // 45ms head + 200ms active + 80ms tail = ~325ms instead of 1200ms
  assert.ok(trimmedDuration >= 0.31 && trimmedDuration <= 0.34, `Expected ~0.325s, got ${trimmedDuration}`);
  const firstSample = new DataView(await smoothed.arrayBuffer()).getInt16(info.dataOffset, true);
  assert.equal(firstSample, 0);

  // Silent-only clip stays intact and trySmoothWavBlob safely skips short non-WAV test blobs
  const silentOnly = makeTestWavBlob({ sampleRate: 48000, samples: new Array(24000).fill(0) });
  const keptSilent = await smoothAndTrimWavBlob(silentOnly);
  assert.equal(readWavDurationSeconds(await keptSilent.arrayBuffer()), 0.5);

  const stubBlob = new Blob(['RIFFstub'], { type: 'application/octet-stream' });
  const safeStub = await trySmoothWavBlob(stubBlob);
  assert.equal(safeStub.type, 'audio/wav');
  assert.equal(safeStub.size, 8);
});
