/**
 * @fileoverview Two-pass EBU R128 loudness mastering service powered by FFmpeg without shell interpolation.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ALLOWED_AUDIO_MIME_TYPES,
  MAX_REFERENCE_AUDIO_BYTES,
  hasValidAudioMagicBytes,
} from '../src/domain/audioValidation.js';
import { StorageError, ValidationError } from '../src/domain/errors.js';
import { inspectWavBuffer } from '../src/domain/wavCodec.js';

const DEFAULT_TARGET_LUFS = -16;
const DEFAULT_TRUE_PEAK = -1.5;
const DEFAULT_LRA = 11;
const DEFAULT_HIGHPASS_HZ = 75;
const DEFAULT_SAMPLE_RATE = 48000;
const DEFAULT_TIMEOUT_MS = 25000;
const OCTET_STREAM_MIME = 'application/octet-stream';

/**
 * Error raised when the FFmpeg binary is unavailable in the runtime environment.
 */
export class FfmpegUnavailableError extends Error {
  /**
   * @param {string} [message='FFmpeg mastering binary is unavailable.'] - Error message.
   */
  constructor(message = 'FFmpeg mastering binary is unavailable.') {
    super(message);
    this.name = 'FfmpegUnavailableError';
    this.code = 'FFMPEG_UNAVAILABLE';
    this.status = 503;
  }
}

/**
 * Validates raw mastering audio bytes and extracts the safe target WAV sample rate.
 * @param {{ bytes: Uint8Array, mimeType?: string }} input - Uploaded audio bytes.
 * @returns {number} Target PCM sample rate in Hz.
 */
function validateMasteringInput({ bytes, mimeType }) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new ValidationError('Provide a non-empty WAV clip to master.', 'audio', 'EMPTY_AUDIO');
  }
  if (bytes.byteLength > MAX_REFERENCE_AUDIO_BYTES) {
    throw new ValidationError('Audio clip must be 20 MB or smaller.', 'audio', 'AUDIO_TOO_LARGE');
  }
  const cleanMime = typeof mimeType === 'string' ? mimeType.split(';')[0].trim().toLowerCase() : '';
  const effectiveMime = cleanMime === OCTET_STREAM_MIME ? '' : cleanMime;
  if (effectiveMime && !ALLOWED_AUDIO_MIME_TYPES.has(effectiveMime)) {
    throw new ValidationError('Unsupported audio format for mastering.', 'audio', 'UNSUPPORTED_AUDIO_TYPE');
  }
  if (!hasValidAudioMagicBytes(bytes)) {
    throw new ValidationError('Audio payload is not a valid audio format.', 'audio', 'INVALID_AUDIO_CONTENT');
  }
  try {
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return inspectWavBuffer(ab).sampleRate || DEFAULT_SAMPLE_RATE;
  } catch {
    return DEFAULT_SAMPLE_RATE;
  }
}

/**
 * Spawns FFmpeg with fixed argv array (`shell: false`) and a hard execution timeout.
 * @param {{ binary: string, args: string[], timeoutMs: number }} spec - Process options.
 * @returns {Promise<{ stderr: string }>} Captured stderr output.
 */
function runFfmpegArgs({ binary, args, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    const chunks = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stderr?.on('data', chunk => chunks.push(chunk));
    child.on('error', err => {
      clearTimeout(timer);
      if (err?.code === 'ENOENT') reject(new FfmpegUnavailableError());
      else reject(new StorageError('Failed to start FFmpeg mastering process.', err));
    });
    child.on('close', code => {
      clearTimeout(timer);
      const stderr = Buffer.concat(chunks).toString('utf8');
      if (timedOut) reject(new StorageError('Audio mastering timed out.'));
      else if (code !== 0) reject(new StorageError(`FFmpeg mastering failed with exit code ${code}.`));
      else resolve({ stderr });
    });
  });
}

/**
 * Extracts finite EBU R128 loudness stats from FFmpeg Pass 1 stderr JSON output.
 * @param {string} stderr - FFmpeg stderr log.
 * @returns {object|null} Measured loudnorm metrics or null when unmeasurable (e.g. silent clip).
 */
function parseLoudnormStats(stderr) {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const stats = JSON.parse(stderr.slice(start, end + 1));
    const fields = ['input_i', 'input_lra', 'input_tp', 'input_thresh', 'target_offset'];
    const valid = fields.every(key => Number.isFinite(Number(stats?.[key])));
    return valid ? stats : null;
  } catch {
    return null;
  }
}

/**
 * Builds Pass 2 loudnorm filter expression from measured Pass 1 statistics.
 * @param {object} spec - Filter and stats configuration.
 * @returns {string} FFmpeg `-af` filter string.
 */
function buildSecondPassFilter({ highpassHz, targetLufs, stats }) {
  return [
    `highpass=f=${highpassHz}`,
    `loudnorm=I=${targetLufs}:TP=${DEFAULT_TRUE_PEAK}:LRA=${DEFAULT_LRA}`
      + `:measured_I=${stats.input_i}:measured_LRA=${stats.input_lra}`
      + `:measured_tp=${stats.input_tp}:measured_thresh=${stats.input_thresh}`
      + `:offset=${stats.target_offset}:linear=true`,
  ].join(',');
}

/**
 * Executes two-pass FFmpeg EBU R128 mastering inside an isolated temp directory.
 * @param {object} spec - Mastering execution inputs.
 * @returns {Promise<Uint8Array>} Mastered PCM WAV bytes.
 */
async function executeTwoPassMaster({ bytes, mimeType, ffmpegBinary, targetLufs, highpassHz, timeoutMs, runProcess }) {
  const sampleRate = validateMasteringInput({ bytes, mimeType });
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'voxcpm-master-'));
  const inputPath = path.join(tempDir, 'input.audio');
  const outputPath = path.join(tempDir, 'mastered.wav');
  try {
    await writeFile(inputPath, bytes);
    const pass1Args = [
      '-hide_banner', '-nostats', '-i', inputPath,
      '-af', `highpass=f=${highpassHz},loudnorm=I=${targetLufs}:TP=${DEFAULT_TRUE_PEAK}:LRA=${DEFAULT_LRA}:print_format=json`,
      '-f', 'null', '-',
    ];
    const pass1 = await runProcess({ binary: ffmpegBinary, args: pass1Args, timeoutMs });
    const stats = parseLoudnormStats(pass1.stderr);
    if (!stats) return bytes;
    const pass2Args = [
      '-hide_banner', '-nostats', '-y', '-i', inputPath,
      '-af', buildSecondPassFilter({ highpassHz, targetLufs, stats }),
      '-ar', String(sampleRate), '-c:a', 'pcm_s16le', outputPath,
    ];
    await runProcess({ binary: ffmpegBinary, args: pass2Args, timeoutMs });
    return new Uint8Array(await readFile(outputPath));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Creates a bounded concurrency queue so parallel mastering calls cannot exhaust container memory.
 * @returns {(task: () => Promise<any>) => Promise<any>} Serialized async runner.
 */
function createMasterQueue() {
  let chain = Promise.resolve();
  return task => {
    const next = chain.then(task, task);
    chain = next.catch(() => {});
    return next;
  };
}

/**
 * Creates an FFmpeg audio mastering service performing two-pass EBU R128 loudness normalization.
 * Inputs: optional `{ ffmpegBinary, targetLufs, highpassHz, timeoutMs, runProcess, logger }`.
 * Outputs: `{ checkAvailability, masterWav }`.
 * Side effects: spawns bounded FFmpeg subprocesses with isolated temp files.
 * Failure modes: throws `ValidationError` on invalid audio, `FfmpegUnavailableError` (503), or `StorageError`.
 * @param {object} [config] - Mastering configuration.
 * @returns {{ checkAvailability: () => Promise<boolean>, masterWav: (input: { bytes: Uint8Array, mimeType?: string }) => Promise<Uint8Array> }} Audio master service.
 */
export function createAudioMaster(config = {}) {
  const ffmpegBinary = config.ffmpegBinary || 'ffmpeg';
  const targetLufs = config.targetLufs ?? DEFAULT_TARGET_LUFS;
  const highpassHz = config.highpassHz ?? DEFAULT_HIGHPASS_HZ;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runProcess = config.runProcess || runFfmpegArgs;
  const enqueue = createMasterQueue();
  let availabilityPromise = null;
  return {
    checkAvailability() {
      if (!availabilityPromise) {
        availabilityPromise = runProcess({ binary: ffmpegBinary, args: ['-version'], timeoutMs: 3000 })
          .then(() => true)
          .catch(error => {
            config.logger?.debug?.('audioMaster.checkAvailability', error?.message || 'ffmpeg check failed');
            return false;
          });
      }
      return availabilityPromise;
    },
    masterWav: ({ bytes, mimeType }) => enqueue(() => executeTwoPassMaster({
      bytes, mimeType, ffmpegBinary, targetLufs, highpassHz, timeoutMs, runProcess,
    })),
  };
}
