/**
 * @fileoverview HTTP gateway adapter communicating with the local Apple Silicon video subtitle service (`/media_api`).
 */

import { SynthesisCancelledError, SynthesisError } from '../domain/errors.js';

const HEALTH_ENDPOINT = '/media_api/health';
const TRANSCRIBE_ENDPOINT = '/media_api/transcribe';
const TRANSLATE_ENDPOINT = '/media_api/translate';
const BURN_ENDPOINT = '/media_api/burn';
const VERIFY_SPEECH_ENDPOINT = '/media_api/verify-speech';
const DUB_ENDPOINT = '/media_api/dub';
const HEALTH_TIMEOUT_MS = 3000;
const MODEL_READINESS_DEFAULTS = Object.freeze({
  whisper: true,
  khmerAsr: true,
  translator: true,
  diarization: true,
});
const HTML_ERROR_MESSAGES = Object.freeze({
  413: 'Media file exceeds the server upload limit (HTTP 413).',
  502: 'Could not reach the local video subtitle service (HTTP 502). Check that media service is running.',
  503: 'The local video subtitle service is temporarily unavailable (HTTP 503).',
  504: 'Video subtitle processing timed out via proxy (HTTP 504).',
});

/**
 * Normalizes local model-cache readiness, defaulting absent legacy fields to ready so the UI stays silent.
 * @param {unknown} models - Raw `models` payload from `/health`.
 * @returns {{ whisper: boolean, khmerAsr: boolean, translator: boolean, diarization: boolean }} Safe readiness flags.
 */
function normalizeModelReadiness(models) {
  const source = models && typeof models === 'object' ? models : {};
  return Object.fromEntries(
    Object.entries(MODEL_READINESS_DEFAULTS).map(([key, fallback]) => [key, typeof source[key] === 'boolean' ? source[key] : fallback])
  );
}

/**
 * Checks whether an error reflects an aborted Fetch call.
 * @param {unknown} error - Caught exception.
 * @returns {boolean} True when cancelled by user/lifecycle.
 */
function isAbortError(error) {
  return error?.name === 'AbortError';
}

/**
 * Checks whether a response payload looks like an HTML error page from Nginx/proxy.
 * @param {string} raw - Trimmed response body.
 * @param {string} contentType - Normalized Content-Type header.
 * @returns {boolean} True when response is HTML.
 */
function isHtmlErrorPayload(raw, contentType) {
  return raw.startsWith('<') || contentType.includes('text/html');
}

/**
 * Reads a readable JSON `detail` or text error message from a failed HTTP response, hiding raw proxy HTML.
 * @param {Response} response - Non-OK HTTP response.
 * @param {string} fallback - Fallback error text.
 * @returns {Promise<string>} Safe error description.
 */
async function readHttpErrorDetail(response, fallback) {
  const raw = await response.text().catch(() => '');
  const trimmed = raw.trim();
  if (!trimmed) return `${fallback} (HTTP ${response.status}).`;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed?.detail === 'string' && parsed.detail.trim()) return parsed.detail.trim();
  } catch {
    // non-JSON fallback below
  }
  const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
  if (isHtmlErrorPayload(trimmed, contentType)) {
    return HTML_ERROR_MESSAGES[response.status] || `${fallback} (HTTP ${response.status}).`;
  }
  return trimmed.slice(0, 220);
}

/**
 * Builds the multipart FormData payload for video transcription + speaker diarization.
 * @param {object} spec - Upload file and analysis options.
 * @returns {FormData} Multipart form payload.
 */
function buildTranscribeFormData({ file, language = 'auto', numSpeakers = 0, diarize = true, translateTo = '', translateToKhmer = false, doubleCheck = false }) {
  const form = new FormData();
  const target = String(translateTo || '').trim() || (translateToKhmer ? 'km' : '');
  form.append('file', file, file?.name || 'video.mp4');
  form.append('language', language || 'auto');
  form.append('num_speakers', String(Number.isFinite(Number(numSpeakers)) ? Number(numSpeakers) : 0));
  form.append('diarize', String(Boolean(diarize)));
  form.append('translate_to', target);
  form.append('double_check', String(Boolean(doubleCheck)));
  return form;
}

/**
 * Builds the multipart FormData payload for TTS round-trip word verification via Whisper Khmer.
 * @param {{ blob: Blob, expectedText: string, language?: string, fileName?: string }} spec - Audio and script inputs.
 * @returns {FormData} Multipart payload for `/media_api/verify-speech`.
 */
function buildVerifySpeechFormData({ blob, expectedText, language = 'km', fileName = 'speech.wav' }) {
  const form = new FormData();
  form.append('file', blob, fileName || 'speech.wav');
  form.append('expected_text', String(expectedText || ''));
  form.append('language', language || 'km');
  return form;
}

/**
 * Builds the multipart FormData payload for time-aligned dubbed MP4 export (`/media_api/dub`).
 * @param {{ jobId: string, clips: Array<{ segmentId: string, start: number, end: number, blob: Blob }>, originalAudioMode?: string }} spec - Dub export inputs.
 * @returns {FormData} Multipart payload containing jobId, originalAudioMode, metadata JSON, and WAV files.
 */
function buildDubVideoFormData({ jobId, clips = [], originalAudioMode = 'duck' }) {
  const form = new FormData();
  form.append('jobId', String(jobId || ''));
  form.append('originalAudioMode', String(originalAudioMode || 'duck'));
  const metadata = clips.map((clip, fileIndex) => {
    const fileName = `dub-clip-${String(fileIndex + 1).padStart(3, '0')}.wav`;
    form.append('files', clip.blob, fileName);
    return {
      segmentId: String(clip.segmentId || `seg-${fileIndex + 1}`),
      start: Number(clip.start) || 0,
      end: Number(clip.end) || 0,
      fileIndex,
    };
  });
  form.append('metadata', JSON.stringify(metadata));
  return form;
}

/**
 * Creates the local Video Subtitle Gateway backed by `/media_api`.
 * Inputs: optional `{ fetchImpl, logger }`.
 * Outputs: `{ checkHealth, transcribeVideo, translateSegments, burnSubtitles, verifySpeech, exportDubbedVideo }`.
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
        return {
          online: true,
          burnInSupported: Boolean(data?.burnInSupported),
          diarizationReady: Boolean(data?.diarizationReady),
          models: normalizeModelReadiness(data?.models),
        };
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

    async burnSubtitles({
      jobId,
      segments,
      speakerNames,
      includeSpeaker = false,
      useTranslation = false,
      bilingual = false,
      subtitleStyle,
      videoSize,
      signal,
    }) {
      try {
        const res = await fetchImpl(BURN_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId, segments, speakerNames, includeSpeaker, useTranslation, bilingual, subtitleStyle, videoSize }),
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

    async verifySpeech({ blob, expectedText, language = 'km', fileName = 'speech.wav', signal }) {
      try {
        const res = await fetchImpl(VERIFY_SPEECH_ENDPOINT, {
          method: 'POST',
          body: buildVerifySpeechFormData({ blob, expectedText, language, fileName }),
          signal,
        });
        if (!res.ok) throw new SynthesisError(await readHttpErrorDetail(res, 'Could not verify spoken words'), { status: res.status });
        return await res.json();
      } catch (err) {
        if (isAbortError(err)) throw new SynthesisCancelledError('Speech verification cancelled.');
        if (err instanceof SynthesisError) throw err;
        logger?.error?.('mediaSubtitleGateway.verifySpeech', err);
        throw new SynthesisError('Could not reach the local speech verification service on port 8810.');
      }
    },

    async exportDubbedVideo({ jobId, clips = [], originalAudioMode = 'duck', signal }) {
      try {
        const res = await fetchImpl(DUB_ENDPOINT, {
          method: 'POST',
          body: buildDubVideoFormData({ jobId, clips, originalAudioMode }),
          signal,
        });
        if (!res.ok) throw new SynthesisError(await readHttpErrorDetail(res, 'Could not export dubbed MP4'), { status: res.status });
        return await res.blob();
      } catch (err) {
        if (isAbortError(err)) throw new SynthesisCancelledError('Dubbed video export cancelled.');
        if (err instanceof SynthesisError) throw err;
        logger?.error?.('mediaSubtitleGateway.exportDubbedVideo', err);
        throw new SynthesisError('Could not render dubbed MP4 video. Check that media service is running.');
      }
    },
  };
}
