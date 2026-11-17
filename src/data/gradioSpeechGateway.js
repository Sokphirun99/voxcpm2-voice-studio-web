/**
 * @fileoverview Gradio 6 HTTP/SSE gateway adapter implementing the domain SpeechGatewayPort.
 */

import { SynthesisCancelledError, SynthesisError } from '../domain/errors.js';

const API_ROOT = '/gradio_api';
const GENERATE_ENDPOINT = `${API_ROOT}/call/generate`;
const UPLOAD_ENDPOINT = `${API_ROOT}/upload`;
const INFO_ENDPOINT = `${API_ROOT}/info`;
const FILE_PREFIX = `${API_ROOT}/file=`;
const ENGINE_CHECK_TIMEOUT_MS = 4000;
const DEFAULT_DIFFUSION_STEPS = 10;
const MAX_ERROR_DETAIL_CHARS = 160;
const EVENT_ID_PATTERN = /^[a-f0-9]+$/i;

const HTTP_STATUS_MESSAGES = {
  400: 'VoxCPM2 rejected the request parameters.',
  413: 'Reference audio file is too large for the server limit.',
  422: 'VoxCPM2 rejected invalid generation inputs.',
  502: 'Could not reach the VoxCPM2 engine on port 8808. Check that app.py is running.',
  503: 'The VoxCPM2 engine is busy or unavailable. Try again shortly.',
  504: 'VoxCPM2 timed out while generating audio. Try shorter text or retry.',
};

const ERROR_PATTERNS = [
  { pattern: /queue is full/i, message: 'The VoxCPM2 queue is full (up to 10 pending jobs). Wait a moment and try again.' },
  { pattern: /queue is stopped|server stopped/i, message: 'The VoxCPM2 engine stopped. Restart app.py and try again.' },
  { pattern: /not uploaded by a user|cannot move .* gradio cache/i, message: 'The locked reference audio expired on the server. Unlock and re-lock or re-upload the clip.' },
  { pattern: /out of memory|\boom\b|mps backend out of memory|cuda error/i, message: 'VoxCPM2 ran out of GPU or system memory. Try shorter text or free memory.' },
  { pattern: /huggingface|hf_hub|connection|timed out|readtimeout|repository|weights|no such file|filenotfound/i, message: 'VoxCPM2 could not load its model weights. Check the app.py terminal for details.' },
  { pattern: /input text to synthesize/i, message: 'Enter text before generating speech.' },
];

/**
 * Strips stack-trace markers and filesystem paths from server errors before display.
 * @param {string} raw - Raw error text.
 * @returns {string} Sanitized single-line excerpt.
 */
function sanitizeErrorDetail(raw) {
  if (typeof raw !== 'string') return '';
  const cleaned = raw
    .replace(/Traceback \(most recent call last\):[\s\S]*/i, '')
    .replace(/File "[^"]+", line \d+[^\n]*/g, '')
    .replace(/(?:\/[\w.-]+){2,}/g, '[path]')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= MAX_ERROR_DETAIL_CHARS) return cleaned;
  return `${cleaned.slice(0, MAX_ERROR_DETAIL_CHARS - 1)}…`;
}

/**
 * Translates raw Gradio/nginx HTTP status codes and error text into user-readable messages.
 * Inputs: raw detail string and optional HTTP status code.
 * Outputs: actionable message free of stack traces.
 * Side effects: none.
 * Failure modes: always returns a non-empty fallback message.
 * @param {string} rawDetail - Raw error text.
 * @param {number} [httpStatus] - HTTP status code.
 * @returns {string} Translated message.
 */
export function translateServerError(rawDetail, httpStatus) {
  const safeDetail = sanitizeErrorDetail(rawDetail);
  const matched = ERROR_PATTERNS.find(rule => rule.pattern.test(rawDetail) || rule.pattern.test(safeDetail));
  if (matched) return matched.message;
  if (httpStatus && HTTP_STATUS_MESSAGES[httpStatus]) {
    return safeDetail && (httpStatus === 400 || httpStatus === 422)
      ? `${HTTP_STATUS_MESSAGES[httpStatus]} (${safeDetail})`
      : HTTP_STATUS_MESSAGES[httpStatus];
  }
  if (safeDetail) return `VoxCPM2 failed: ${safeDetail}`;
  return 'VoxCPM2 could not complete speech generation. Check the app.py terminal for details and retry.';
}

/**
 * Parses SSE text into `{ event, data }` frames.
 * Inputs: raw SSE payload text.
 * Outputs: array of `{ event, data }` objects.
 * Side effects: none.
 * Failure modes: returns empty array on empty/non-string input.
 * @param {string} rawText - Raw event-stream text.
 * @returns {Array<{ event: string, data: string }>} Parsed frames.
 */
export function parseSseEvents(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) return [];
  return rawText.split(/\r?\n\r?\n/).map(parseSseBlock).filter(Boolean);
}

/**
 * Parses one blank-line-delimited SSE frame.
 * @param {string} block - Raw frame text.
 * @returns {{ event: string, data: string }|null} Parsed event or null.
 */
function parseSseBlock(block) {
  const lines = block.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return null;
  let event = 'message';
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  return { event, data: dataLines.join('\n') };
}

/**
 * Extracts a readable error string from an SSE `event: error` payload.
 * Inputs: raw `data:` text.
 * Outputs: extracted error string or empty string.
 * Side effects: none.
 * Failure modes: returns trimmed raw text on non-JSON input.
 * @param {string} dataText - Raw `data:` string.
 * @returns {string} Error string.
 */
export function extractErrorDetail(dataText) {
  if (typeof dataText !== 'string' || !dataText.trim()) return '';
  try {
    const parsed = JSON.parse(dataText);
    if (parsed === null || parsed === undefined) return '';
    if (typeof parsed === 'string') return parsed;
    if (typeof parsed === 'object') return String(parsed.error || parsed.message || parsed.detail || '');
  } catch {
    return dataText.trim();
  }
  return '';
}

/**
 * Extracts and validates the WAV URL and seed from an SSE `event: complete` payload.
 * Inputs: raw `data:` text and base origin.
 * Outputs: `{ filePath, seed }` or `null`.
 * Side effects: none.
 * Failure modes: throws SynthesisError if JSON is malformed or path escapes `/gradio_api/file=`.
 * @param {string} dataText - Raw `data:` payload.
 * @param {string} origin - Origin for URL validation.
 * @returns {{ filePath: string, seed: number|null }|null} Validated path and seed.
 */
export function extractCompleteResult(dataText, origin) {
  let parsed;
  try {
    parsed = JSON.parse(dataText);
  } catch (error) {
    throw new SynthesisError('VoxCPM2 returned an unreadable completion response.', { code: 'INVALID_PAYLOAD', cause: error });
  }
  if (!Array.isArray(parsed)) return null;
  const [file, generatedSeed] = parsed;
  if (typeof file?.url !== 'string') return null;
  if (file.url.includes('..')) {
    throw new SynthesisError('VoxCPM2 returned an unexpected audio file path.', { code: 'UNSAFE_FILE_URL' });
  }
  const fileUrl = new URL(file.url, origin);
  if (!fileUrl.pathname.startsWith(FILE_PREFIX) || fileUrl.pathname.includes('..')) {
    throw new SynthesisError('VoxCPM2 returned an unexpected audio file path.', { code: 'UNSAFE_FILE_URL' });
  }
  return { filePath: `${fileUrl.pathname}${fileUrl.search}`, seed: generatedSeed ?? null };
}

/**
 * Throws SynthesisCancelledError when signal is aborted.
 * @param {AbortSignal} [signal] - Request abort signal.
 */
function throwIfAborted(signal) {
  if (signal?.aborted) throw new SynthesisCancelledError();
}

/**
 * Normalizes caught failures into SynthesisCancelledError or SynthesisError.
 * @param {unknown} error - Caught error.
 * @param {AbortSignal} [signal] - Request abort signal.
 * @param {string} fallbackMessage - Default network failure message.
 */
function rethrowSynthesisFailure(error, signal, fallbackMessage) {
  if (error instanceof SynthesisCancelledError || error?.name === 'AbortError' || signal?.aborted) {
    throw new SynthesisCancelledError();
  }
  if (error instanceof SynthesisError) throw error;
  throw new SynthesisError(fallbackMessage, { code: 'NETWORK_ERROR', cause: error });
}

/**
 * Reads an HTTP error response body and throws a translated SynthesisError.
 * @param {Response} response - Non-OK response.
 * @returns {Promise<never>} Always throws.
 */
async function throwHttpSynthesisError(response) {
  let detail = '';
  try {
    const bodyText = await response.text();
    const parsed = JSON.parse(bodyText);
    detail = typeof parsed?.detail === 'string' ? parsed.detail : bodyText;
  } catch {
    detail = '';
  }
  throw new SynthesisError(translateServerError(detail, response.status), {
    code: 'HTTP_ERROR',
    status: response.status,
  });
}

/**
 * Evaluates parsed SSE frames and returns completion data or throws on SSE error.
 * @param {Array<{ event: string, data: string }>} events - Parsed SSE events.
 * @param {string} origin - Base origin.
 * @returns {{ filePath: string, seed: number|null }|null} Result if complete.
 */
function evaluateSseEvents(events, origin) {
  for (const item of events) {
    if (item.event === 'error') {
      throw new SynthesisError(translateServerError(extractErrorDetail(item.data)), { code: 'ENGINE_ERROR' });
    }
    if (item.event === 'complete') return extractCompleteResult(item.data, origin);
  }
  return null;
}

/**
 * Splits buffered SSE text into complete frames and trailing partial frame text.
 * @param {string} buffer - Accumulated UTF-8 text.
 * @returns {{ completeText: string, remainder: string }} Split result.
 */
function splitCompletedSseFrames(buffer) {
  const match = /^([\s\S]*\r?\n\r?\n)([\s\S]*)$/.exec(buffer);
  if (!match) return { completeText: '', remainder: buffer };
  return { completeText: match[1], remainder: match[2] };
}

/**
 * Reads an SSE ReadableStream chunk by chunk until complete/error or EOF.
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader - Stream reader.
 * @param {string} origin - Base origin.
 * @param {AbortSignal} [signal] - Optional abort signal.
 * @returns {Promise<{ filePath: string, seed: number|null }>} Validated completion result.
 */
async function readStreamingSse(reader, origin, signal) {
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      throwIfAborted(signal);
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const { completeText, remainder } = done ? { completeText: buffer, remainder: '' } : splitCompletedSseFrames(buffer);
      buffer = remainder;
      const result = evaluateSseEvents(parseSseEvents(completeText), origin);
      if (result) return result;
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  throw new SynthesisError('VoxCPM2 ended the request without returning audio.', { code: 'EMPTY_STREAM' });
}

/**
 * Reads an SSE response (streaming or buffered) into a validated completion result.
 * @param {Response} response - HTTP SSE response.
 * @param {string} origin - Base origin.
 * @param {AbortSignal} [signal] - Optional abort signal.
 * @returns {Promise<{ filePath: string, seed: number|null }>} Validated completion result.
 */
async function readSseResult(response, origin, signal) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const result = evaluateSseEvents(parseSseEvents(await response.text()), origin);
    if (result) return result;
    throw new SynthesisError('VoxCPM2 ended the request without returning audio.', { code: 'EMPTY_STREAM' });
  }
  return readStreamingSse(response.body.getReader(), origin, signal);
}

/**
 * Builds the 10-element positional input tuple matching `engine/app.py` `/generate`.
 * @param {object} options - Validated synthesis request options.
 * @returns {Array<unknown>} Positional Gradio API data array.
 */
function buildGeneratePayload(options) {
  const {
    text,
    instruction,
    referenceFile = null,
    usePromptText = false,
    promptText = '',
    guidance,
    steps = DEFAULT_DIFFUSION_STEPS,
    seed,
    denoiseReference = false,
  } = options;
  return [text, instruction, referenceFile, Boolean(usePromptText), promptText, guidance, false, Boolean(denoiseReference), steps, seed];
}

/**
 * Posts generation arguments to Gradio and returns the validated hex event ID.
 * @param {typeof fetch} fetchImpl - HTTP fetch function.
 * @param {object} options - Validated synthesis request parameters.
 * @returns {Promise<string>} Validated event ID.
 */
async function postGenerationJob(fetchImpl, options) {
  const submission = await fetchImpl(GENERATE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: buildGeneratePayload(options) }),
    signal: options.signal,
  });
  if (!submission.ok) await throwHttpSynthesisError(submission);
  const { event_id: eventId } = await submission.json();
  if (typeof eventId !== 'string' || !EVENT_ID_PATTERN.test(eventId)) {
    throw new SynthesisError('VoxCPM2 did not return a valid generation ID.', { code: 'INVALID_EVENT_ID' });
  }
  return eventId;
}

/**
 * Downloads the generated WAV file from Gradio's file proxy endpoint with a normalized `audio/*` MIME type.
 * @param {typeof fetch} fetchImpl - HTTP fetch function.
 * @param {string} filePath - Validated `/gradio_api/file=...` URL path.
 * @param {AbortSignal} [signal] - Optional abort signal.
 * @returns {Promise<Blob>} Audio blob with `audio/*` MIME type.
 */
async function fetchGeneratedBlob(fetchImpl, filePath, signal) {
  const audio = await fetchImpl(filePath, { signal });
  if (!audio.ok) {
    throw new SynthesisError(translateServerError('', audio.status), { code: 'AUDIO_DOWNLOAD_FAILED', status: audio.status });
  }
  const blob = await audio.blob();
  return blob.type && blob.type.toLowerCase().startsWith('audio/') ? blob : new Blob([blob], { type: 'audio/wav' });
}

/**
 * Creates a Gradio 6 SpeechGatewayPort adapter.
 * Inputs: `{ fetchImpl, origin, logger }`.
 * Outputs: SpeechGatewayPort `{ checkAvailability, uploadReferenceAudio, synthesize }`.
 * Side effects: performs HTTP/SSE requests to `/gradio_api/*`.
 * Failure modes: throws SynthesisCancelledError or SynthesisError on failure; `checkAvailability` returns `false`.
 * @param {{ fetchImpl?: typeof fetch, origin?: string, logger?: import('../domain/ports.js').LoggerPort }} [deps] - Injected HTTP & logging deps.
 * @returns {import('../domain/ports.js').SpeechGatewayPort} Gradio speech gateway adapter.
 */
export function createGradioSpeechGateway({
  fetchImpl = (...args) => globalThis.fetch(...args),
  origin = globalThis.window?.location?.origin || 'http://127.0.0.1',
  logger,
} = {}) {
  return {
    async checkAvailability() {
      try {
        const response = await fetchImpl(INFO_ENDPOINT, { cache: 'no-store', signal: AbortSignal.timeout(ENGINE_CHECK_TIMEOUT_MS) });
        if (!response.ok) return false;
        const info = await response.json();
        return Boolean(info.named_endpoints?.['/generate']);
      } catch (error) {
        logger?.debug('gradioSpeechGateway.checkAvailability', 'Engine readiness check failed', { reason: error?.message || 'offline' });
        return false;
      }
    },

    async uploadReferenceAudio({ blob, fileName, mimeType = 'audio/wav', signal }) {
      throwIfAborted(signal);
      try {
        const form = new FormData();
        form.append('files', blob, fileName);
        const response = await fetchImpl(UPLOAD_ENDPOINT, { method: 'POST', body: form, signal });
        if (!response.ok) await throwHttpSynthesisError(response);
        const paths = await response.json();
        if (!Array.isArray(paths) || typeof paths[0] !== 'string' || !paths[0]) {
          throw new SynthesisError('VoxCPM2 did not return an uploaded audio path.', { code: 'INVALID_UPLOAD_RESPONSE' });
        }
        return { path: paths[0], orig_name: fileName, mime_type: mimeType, meta: { _type: 'gradio.FileData' } };
      } catch (error) {
        if (!(error instanceof SynthesisCancelledError) && error?.name !== 'AbortError' && !signal?.aborted) {
          logger?.error('gradioSpeechGateway.uploadReferenceAudio', error, { fileName });
        }
        rethrowSynthesisFailure(error, signal, 'Could not upload the reference audio to VoxCPM2.');
      }
    },

    async synthesize(options) {
      const { signal } = options;
      throwIfAborted(signal);
      try {
        const eventId = await postGenerationJob(fetchImpl, options);
        const streamResponse = await fetchImpl(`${GENERATE_ENDPOINT}/${eventId}`, { cache: 'no-store', signal });
        if (!streamResponse.ok) await throwHttpSynthesisError(streamResponse);
        const { filePath, seed } = await readSseResult(streamResponse, origin, signal);
        const blob = await fetchGeneratedBlob(fetchImpl, filePath, signal);
        return { blob, seed };
      } catch (error) {
        if (!(error instanceof SynthesisCancelledError) && error?.name !== 'AbortError' && !signal?.aborted) {
          logger?.error('gradioSpeechGateway.synthesize', error, { code: error?.code, status: error?.status });
        }
        rethrowSynthesisFailure(error, signal, 'Could not reach the VoxCPM2 engine. Check that app.py is running.');
      }
    },
  };
}
