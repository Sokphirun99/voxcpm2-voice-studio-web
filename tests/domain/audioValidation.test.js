import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_REFERENCE_AUDIO_BYTES,
  computePeaksFromSamples,
  formatByteSize,
  formatElapsedTime,
  formatGenerationMetrics,
  formatTime,
  hasValidAudioMagicBytes,
  readPlaybackDuration,
  readPlaybackSeconds,
  validateAudioFile,
} from '../../src/domain/audioValidation.js';
import { ValidationError } from '../../src/domain/errors.js';

function createWavHeaderBlob(size = 44) {
  const bytes = new Uint8Array(size);
  bytes.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
  return new Blob([bytes], { type: 'audio/wav' });
}

test('formatTime formats non-negative durations and guards invalid values', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(65.9), '1:05');
  assert.equal(formatTime(-3), '0:00');
  assert.equal(formatTime(Number.NaN), '0:00');
});

test('computePeaksFromSamples normalizes amplitudes into [0, 1]', () => {
  assert.deepEqual(computePeaksFromSamples([]), []);
  const peaks = computePeaksFromSamples(new Float32Array([0, -0.25, 1, 0]), 2);
  assert.equal(peaks.length, 2);
  assert.equal(peaks[0], 0.5);
  assert.equal(peaks[1], 1);
});

test('hasValidAudioMagicBytes identifies audio headers and rejects spoofed bytes', () => {
  assert.equal(hasValidAudioMagicBytes(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])), true);
  assert.equal(hasValidAudioMagicBytes(new Uint8Array([0x49, 0x44, 0x33, 0x04])), true);
  assert.equal(hasValidAudioMagicBytes(new Uint8Array([0x66, 0x4c, 0x61, 0x43])), true);
  assert.equal(hasValidAudioMagicBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), false);
});

test('validateAudioFile rejects empty, oversized, wrong MIME, and non-audio content', async () => {
  await assert.rejects(() => validateAudioFile(new Blob([])), ValidationError);
  await assert.rejects(() => validateAudioFile(new Blob(['hello'], { type: 'text/plain' })), ValidationError);
  await assert.rejects(() => validateAudioFile(new Blob(['NOTWAVCONTENT123'], { type: 'audio/wav' })), ValidationError);
  const oversized = { size: MAX_REFERENCE_AUDIO_BYTES + 1, type: 'audio/wav', slice: () => new Blob([]) };
  await assert.rejects(() => validateAudioFile(oversized), ValidationError);
  await validateAudioFile(createWavHeaderBlob());
});

test('readPlaybackSeconds and readPlaybackDuration guard null currentTarget and non-finite numbers', () => {
  assert.equal(readPlaybackSeconds({ currentTarget: null }), 0);
  assert.equal(readPlaybackSeconds({ currentTarget: { currentTime: Number.NaN } }), 0);
  assert.equal(readPlaybackSeconds({ currentTarget: { currentTime: 1.75 } }), 1.75);
  assert.equal(readPlaybackDuration({ currentTarget: null }), 0);
  assert.equal(readPlaybackDuration({ currentTarget: { duration: Number.POSITIVE_INFINITY } }), 0);
  assert.equal(readPlaybackDuration({ currentTarget: { duration: 4.2 } }), 4.2);
});

test('formatByteSize, formatElapsedTime, and formatGenerationMetrics format synthesis metrics concisely', () => {
  assert.equal(formatByteSize(-1), '0 B');
  assert.equal(formatByteSize(512), '512 B');
  assert.equal(formatByteSize(404480), '395 KB');
  assert.equal(formatByteSize(5.2 * 1024 * 1024), '5.2 MB');
  assert.equal(formatByteSize(2.5 * 1024 * 1024 * 1024), '2.5 GB');

  assert.equal(formatElapsedTime(-10), '');
  assert.equal(formatElapsedTime(18), '18ms');
  assert.equal(formatElapsedTime(2840), '2.8s');

  assert.equal(
    formatGenerationMetrics({ elapsedMs: 2800, sizeBytes: 404480, audioDurationSeconds: 4.2 }),
    '2.8s (1.5×) · 395 KB'
  );
  assert.equal(formatGenerationMetrics({ elapsedMs: 12, sizeBytes: 102400, audioDurationSeconds: 2.0 }), '12ms · 100 KB');
});
