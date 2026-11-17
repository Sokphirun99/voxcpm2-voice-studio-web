/**
 * @fileoverview HTTP gateway adapter communicating with the local Apple Silicon video subtitle service (`/media_api`).
 */

import { SynthesisCancelledError, SynthesisError } from '../domain/errors.js';

const HEALTH_ENDPOINT = '/media_api/health';
const TRANSCRIBE_ENDPOINT = '/media_api/transcribe';
const TRANSLATE_ENDPOINT = '/media_api/translate';
const BURN_ENDPOINT = '/media_api/burn';
const HEALTH_TIMEOUT_MS = 3000;

/**
 * Checks whether an error reflects an aborted Fetch call.
 * @param {unknown} error - Caught exception.
 * @returns {boolean} True when cancelled by user/lifecycle.
 */
function isAbortError(error) {
  return error?.name === 'AbortError';
}

/**
 * Reads a readable JSON `detail` or text error message from a failed HTTP response.
 * @param {Response} response - Non-OK HTTP response.
 * @param {string} fallback - Fallback error text.
 * @returns {Promise<string>} Safe error description.
 */
async function readHttpErrorDetail(response, fallback) {
  const raw = await response.text().catch(() => '');
  if (!raw) return `${fallback} (HTTP ${response.status}).`;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.detail === 'string' && parsed.detail.trim()) return parsed.detail.trim();
  } catch {
    // plain text fallback below
  }
  return raw.slice(0, 220).trim();
}

/**
 * Builds the multipart FormData payload for video transcription + speaker diarization.
 * @param {object} spec - Upload file and analysis options.
 * @returns {FormData} Multipart form payload.
 */
function buildTranscribeFormData({ file, language = 'auto', numSpeakers = 0, diarize = true, translateToKhmer = false }) {
  const form = new FormData();
  form.append('file', file, file?.name || 'video.mp4');
  form.append('language', language || 'auto');
  form.append('num_speakers', String(Number.isFinite(Number(numSpeakers)) ? Number(numSpeakers) : 0));
  form.append('diarize', String(Boolean(diarize)));
  form.append('translate_to', translateToKhmer ? 'km' : '');
  return form;
}

/**
 * Creates the local Video Subtitle Gateway backed by `/media_api`.
 * Inputs: optional `{ fetchImpl, logger }`.
 * Outputs: `{ checkHealth, transcribeVideo, translateSegments, burnSubtitles }`.
 * Side effects: performs HTTP multipart/JSON calls against `/media_api`.
 * Failure modes: throws SynthesisCancelledError on abort or SynthesisError on network/server failure.
 * @param {{ fetchImpl?: typeof fetch, logger?: { error?: Function, warn?: Function } }} [deps] - Gateway dependencies.
 * @returns {object} Media subtitle gateway port.
 */
export function createMediaSubtitleGateway({ fetchImpl = globalThis.fetch, logger = null } = {}) {
  return {
    async checkHealth() {
      const controller = new AbortController();
      const timer = globalThis.setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
      try {
        const res = await fetchImpl(HEALTH_ENDPOINT, { cache: 'no-store', signal: controller.signal });
        if (!res.ok) return { online: false, reason: `Video subtitle service returned HTTP ${res.status}.` };
        const data = await res.json();
        return { online: true, burnInSupported: Boolean(data?.burnInSupported), diarizationReady: Boolean(data?.diarizationReady) };
      } catch (err) {
        return { online: false, reason: err?.message || 'Cannot reach local video subtitle service on port 8810.' };
      } finally {
        globalThis.clearTimeout(timer);
      }
    },

    async transcribeVideo(params) {
      const { signal } = params || {};
      try {
        const res = await fetchImpl(TRANSCRIBE_ENDPOINT, {
          method: 'POST',
          body: buildTranscribeFormData(params),
          signal,
        });
        if (!res.ok) throw new SynthesisError(await readHttpErrorDetail(res, 'Could not extract subtitles from video'), { status: res.status });
        return await res.json();
      } catch (err) {
        if (isAbortError(err)) throw new SynthesisCancelledError('Subtitle extraction cancelled.');
        if (err instanceof SynthesisError) throw err;
        logger?.error?.('mediaSubtitleGateway.transcribeVideo', err);
        throw new SynthesisError('Could not connect to the local video subtitle service. Check that media service is running.');
      }
    },

    async translateSegments({ segments, sourceLanguage, targetLanguage = 'km', signal }) {
      try {
        const res = await fetchImpl(TRANSLATE_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ segments, sourceLanguage, targetLanguage }),
          signal,
        });
        if (!res.ok) throw new SynthesisError(await readHttpErrorDetail(res, 'Could not translate subtitles'), { status: res.status });
        return await res.json();
      } catch (err) {
        if (isAbortError(err)) throw new SynthesisCancelledError('Translation cancelled.');
        if (err instanceof SynthesisError) throw err;
        logger?.error?.('mediaSubtitleGateway.translateSegments', err);
        throw new SynthesisError('Subtitle translation failed.');
      }
    },

    async burnSubtitles({ jobId, segments, speakerNames, includeSpeaker = true, useTranslation = false, videoSize, signal }) {
      try {
        const res = await fetchImpl(BURN_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId, segments, speakerNames, includeSpeaker, useTranslation, videoSize }),
          signal,
        });
        if (!res.ok) throw new SynthesisError(await readHttpErrorDetail(res, 'Could not burn subtitles onto video'), { status: res.status });
        return await res.blob();
      } catch (err) {
        if (isAbortError(err)) throw new SynthesisCancelledError('Video export cancelled.');
        if (err instanceof SynthesisError) throw err;
        logger?.error?.('mediaSubtitleGateway.burnSubtitles', err);
        throw new SynthesisError('Could not render subtitled video.');
      }
    },
  };
}
