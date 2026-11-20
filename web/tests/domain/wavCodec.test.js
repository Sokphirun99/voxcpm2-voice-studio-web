import test from 'node:test';
import assert from 'node:assert/strict';
import { SynthesisError } from '../../src/domain/errors.js';
import {
  concatenateWavBlobs,
  concatenateWavBlobsWithPauses,
  ensureAudioWavBlob,
  inspectWavBuffer,
  readWavDurationSeconds,
  replaceChunkAndRestitch,
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

test('concatenateWavBlobsWithPauses inserts exact per-entry PCM silence durations and preserves concatenateWavBlobs parity', async () => {
  const sampleRate = 48000;
  const clipA = makeTestWavBlob({ sampleRate, samples: new Array(sampleRate * 0.2).fill(1200) });
  const clipB = makeTestWavBlob({ sampleRate, samples: new Array(sampleRate * 0.3).fill(1500) });
  const clipC = makeTestWavBlob({ sampleRate, samples: new Array(sampleRate * 0.15).fill(1800) });

  // Trailing pauseAfterMs on the final entry is ignored (pauses separate clips only).
  const varied = await concatenateWavBlobsWithPauses([
    { blob: clipA, pauseAfterMs: 500 },
    { blob: clipB, pauseAfterMs: 800 },
    { blob: clipC, pauseAfterMs: 2500 },
  ]);
  const variedBuf = await varied.arrayBuffer();
  const variedInfo = inspectWavBuffer(variedBuf);
  assert.equal(varied.type, 'audio/wav');
  assert.equal(variedInfo.sampleRate, sampleRate);
  const expectedDuration = (200 + 500 + 300 + 800 + 150) / 1000;
  assert.equal(readWavDurationSeconds(variedBuf), expectedDuration);
  assert.equal(variedInfo.dataSize, Math.round(expectedDuration * sampleRate) * 2);

  // Verify the 500ms silence window between clipA and clipB is all zero PCM bytes.
  const silenceStart = variedInfo.dataOffset + Math.round(0.2 * sampleRate) * 2;
  const silenceBytes = new Uint8Array(variedBuf, silenceStart, Math.round(0.5 * sampleRate) * 2);
  assert.ok(silenceBytes.every(byte => byte === 0));

  // Explicit 0ms gap stitches back-to-back with zero inserted silence.
  const zeroGap = await concatenateWavBlobsWithPauses([
    { blob: clipA, pauseAfterMs: 0 },
    { blob: clipB, pauseAfterMs: 0 },
  ]);
  assert.equal(readWavDurationSeconds(await zeroGap.arrayBuffer()), 0.5);

  // Missing/null pauseAfterMs falls back to defaultPauseMs (160ms) and matches concatenateWavBlobs byte-for-byte.
  const viaPauses = await concatenateWavBlobsWithPauses([
    { blob: clipA, pauseAfterMs: null },
    { blob: clipB },
    { blob: clipC },
  ], 200);
  const viaUniform = await concatenateWavBlobs([clipA, clipB, clipC], 200);
  assert.deepEqual(new Uint8Array(await viaPauses.arrayBuffer()), new Uint8Array(await viaUniform.arrayBuffer()));
  assert.equal(readWavDurationSeconds(await viaPauses.arrayBuffer()), (200 + 200 + 300 + 200 + 150) / 1000);

  // Single clip returns normalized WAV unchanged.
  const single = await concatenateWavBlobsWithPauses([{ blob: clipA, pauseAfterMs: 1000 }]);
  assert.equal(readWavDurationSeconds(await single.arrayBuffer()), 0.2);

  // Invalid inputs reject with typed SynthesisError codes.
  await assert.rejects(() => concatenateWavBlobsWithPauses([]), err => err instanceof SynthesisError && err.code === 'EMPTY_AUDIO_SEGMENTS');
  await assert.rejects(() => concatenateWavBlobsWithPauses([{ blob: clipA }, { blob: null }]), err => err instanceof SynthesisError && err.code === 'EMPTY_AUDIO_SEGMENTS');
  const mismatched = makeTestWavBlob({ sampleRate: 16000, samples: new Array(1600).fill(500) });
  await assert.rejects(
    () => concatenateWavBlobsWithPauses([{ blob: clipA, pauseAfterMs: 300 }, { blob: mismatched }]),
    err => err instanceof SynthesisError && err.code === 'WAV_FORMAT_MISMATCH'
  );
});

test('replaceChunkAndRestitch preserves per-chunk pauseAfterMs when replacing one segment', async () => {
  const sampleRate = 48000;
  const clipA = makeTestWavBlob({ sampleRate, samples: new Array(sampleRate * 0.2).fill(900) });
  const clipB = makeTestWavBlob({ sampleRate, samples: new Array(sampleRate * 0.2).fill(900) });
  const clipBReplaced = makeTestWavBlob({ sampleRate, samples: new Array(sampleRate * 0.4).fill(900) });
  const clipC = makeTestWavBlob({ sampleRate, samples: new Array(sampleRate * 0.1).fill(900) });

  const chunks = [
    { index: 0, text: 'First', blob: clipA, pauseAfterMs: 500 },
    { index: 1, text: 'Second', blob: clipB, pauseAfterMs: 800 },
    { index: 2, text: 'Third', blob: clipC, pauseAfterMs: null },
  ];
  const { chunks: updated, blob } = await replaceChunkAndRestitch({
    chunks,
    index: 1,
    nextChunk: { text: 'Second updated', blob: clipBReplaced },
    pauseMs: 160,
  });

  assert.equal(updated[0].pauseAfterMs, 500);
  assert.equal(updated[1].pauseAfterMs, 800);
  assert.equal(updated[2].pauseAfterMs, null);
  assert.equal(readWavDurationSeconds(await blob.arrayBuffer()), (200 + 500 + 400 + 800 + 100) / 1000);
});
