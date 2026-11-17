import test from 'node:test';
import assert from 'node:assert/strict';
import { SynthesisError } from '../../src/domain/errors.js';
import {
  concatenateWavBlobs,
  ensureAudioWavBlob,
  inspectWavBuffer,
  readWavDurationSeconds,
  tryReadWavDurationSeconds,
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
