/**
 * @fileoverview Presentation hook driving single-character speech synthesis and status reporting.
 */

import { useEffect, useRef, useState } from 'react';
import { formatGenerationMetrics } from '../../domain/audioValidation.js';
import { SynthesisCancelledError, ValidationError } from '../../domain/errors.js';
import { useStudioServices } from '../StudioContext.jsx';

const LIVE_TIMER_TICK_MS = 100;

/**
 * Translates synthesis or validation exceptions into status messages and field focus callbacks.
 * @param {unknown} error - Caught exception.
 * @param {object} ctx - Error handling callbacks.
 */
function handleGenerationFailure(error, { setStatus, onFailure, onValidationFieldError }) {
  if (error instanceof ValidationError) {
    onValidationFieldError?.(error.field);
    setStatus({ message: error.message, error: true });
    return;
  }
  if (error instanceof SynthesisCancelledError) {
    setStatus({ message: error.message, error: false });
    return;
  }
  setStatus({ message: error.message || 'Could not generate speech. Try again.', error: true });
  onFailure();
}

/**
 * Builds a progress status line during synthesis.
 * @param {{ completed: number, total: number }} progress - Chunk progress info.
 * @returns {string} Human-readable progress message.
 */
function formatProgressMessage({ completed, total }) {
  if (total <= 1) return 'Generating speech. The first request may take longer while the model loads.';
  return `Generating part ${completed + 1} of ${total} with the same character voice…`;
}

/**
 * Builds the default completion status line when no custom message is returned.
 * @param {{ name: string, id: string }} character - Target speaking character.
 * @param {number|null} seed - Returned seed.
 * @returns {string} Status line text.
 */
function formatSuccessStatus(character, recording) {
  const identity = character ? `${character.name} (${character.id})` : 'Voice';
  const metrics = formatGenerationMetrics(recording);
  const parts = ['Audio ready'];
  if (recording?.fromCache) parts.push('cached');
  else if (recording?.mastered) parts.push('-16 LUFS mastered');
  if (metrics) parts.push(metrics);
  parts.push(identity);
  if (recording?.seed != null) parts.push(`Seed ${recording.seed}`);
  return parts.join(' · ');
}

function formatCompletedStatus({ customMessage, character, recording }) {
  if (!customMessage) return formatSuccessStatus(character, recording);
  const metrics = formatGenerationMetrics(recording);
  return metrics ? `${customMessage} · ${metrics}` : customMessage;
}

/**
 * Executes synthesis use case, stores recording/seed updates, and updates the status line.
 * @param {object} spec - Execution callbacks and services.
 * @returns {Promise<void>} Completion promise.
 */
async function executeSynthesisRequest({ synthesizeSpeech, request, signal, onReferenceUploaded, onCompleted, updateProgress, setStatus, setRecording, setLastSeed }) {
  const result = await synthesizeSpeech.execute({
    ...request,
    signal,
    onProgress: info => updateProgress(formatProgressMessage(info)),
    onReferenceUploaded: fileData => onReferenceUploaded?.(request.character.id, fileData),
  });
  setRecording(result.recording);
  if (result.recording.seed != null) setLastSeed(result.recording.seed);
  const customMessage = await onCompleted?.(result);
  setStatus({ message: formatCompletedStatus({ customMessage, character: request.character, recording: result.recording }), error: false });
}

/**
 * Manages AbortController, busy state, live timer, and failure translation around one synthesis run.
 * @param {object} spec - Lifecycle state setters and runner.
 * @returns {Promise<void>} Completion promise.
 */
async function runSynthesisLifecycle({ abortController, request, setBusy, setActiveCharacterId, setStatus, onFailure, onValidationFieldError, run }) {
  const controller = new AbortController();
  abortController.current = controller;
  const startedAt = Date.now();
  let baseMessage = 'Preparing speech generation…';
  const syncTimerStatus = () => {
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    setStatus({ message: `${baseMessage} (${secs}s)`, error: false });
  };
  const updateProgress = nextMsg => {
    baseMessage = nextMsg;
    syncTimerStatus();
  };
  setBusy(true);
  setActiveCharacterId(request?.character?.id || null);
  setStatus({ message: baseMessage, error: false });
  const timer = globalThis.setInterval(syncTimerStatus, LIVE_TIMER_TICK_MS);
  try {
    await run(controller.signal, updateProgress);
  } catch (error) {
    handleGenerationFailure(error, { setStatus, onFailure, onValidationFieldError });
  } finally {
    globalThis.clearInterval(timer);
    if (abortController.current === controller) abortController.current = null;
    setActiveCharacterId(null);
    setBusy(false);
  }
}

/**
 * Validates an audio clip via `lockReferenceAudio`, surfacing validation errors into `setStatus`.
 * @param {object} lockReferenceAudio - Audio validation use case.
 * @param {Function} setStatus - Status setter callback.
 * @param {File} file - Candidate audio file.
 * @returns {Promise<object|null>} Validated clip metadata or null on error.
 */
async function validateAudioClipWithStatus(lockReferenceAudio, setStatus, file) {
  try {
    return await lockReferenceAudio.execute(file);
  } catch (error) {
    setStatus({ message: error.message, error: true });
    return null;
  }
}

/**
 * Guards against overlapping synthesis runs and delegates to `runSynthesisLifecycle`.
 * @param {object} ctx - Hook services, refs, setters, and generation args.
 * @returns {Promise<void>} Completion promise.
 */
function startSynthesisGeneration(ctx) {
  if (ctx.busy || ctx.abortController.current) return Promise.resolve();
  return runSynthesisLifecycle({
    abortController: ctx.abortController, request: ctx.request, setBusy: ctx.setBusy,
    setActiveCharacterId: ctx.setActiveCharacterId, setStatus: ctx.setStatus,
    onFailure: ctx.onFailure, onValidationFieldError: ctx.onValidationFieldError,
    run: (signal, updateProgress) => executeSynthesisRequest({
      synthesizeSpeech: ctx.synthesizeSpeech, request: ctx.request, signal,
      onReferenceUploaded: ctx.onReferenceUploaded, onCompleted: ctx.onCompleted,
      updateProgress, setStatus: ctx.setStatus, setRecording: ctx.setRecording, setLastSeed: ctx.setLastSeed,
    }),
  });
}

/**
 * Coordinates abortable single-character speech synthesis and status reporting.
 * Inputs: `{ onFailure, onValidationFieldError }`.
 * Outputs: `{ busy, activeCharacterId, recording, lastSeed, status, setStatus, runGeneration, validateAudioClip, cancel }`.
 * Side effects: invokes injected domain use cases and aborts pending calls on unmount.
 * Failure modes: translates ValidationError, SynthesisCancelledError, and SynthesisError into status state.
 * @param {{ onFailure: () => void, onValidationFieldError?: (field: string) => void }} params - Hook callbacks.
 * @returns {object} Synthesis state and actions.
 */
export function useSpeechSynthesis({ onFailure, onValidationFieldError }) {
  const { synthesizeSpeech, lockReferenceAudio } = useStudioServices();
  const abortController = useRef(null);
  const [busy, setBusy] = useState(false);
  const [activeCharacterId, setActiveCharacterId] = useState(null);
  const [recording, setRecording] = useState(null);
  const [lastSeed, setLastSeed] = useState(null);
  const [status, setStatus] = useState({ message: 'No audio generated yet.', error: false });
  useEffect(() => () => abortController.current?.abort(), []);
  return {
    busy, activeCharacterId, recording, lastSeed, status, setStatus,
    runGeneration: args => startSynthesisGeneration({
      ...args, busy, abortController, synthesizeSpeech, setBusy, setActiveCharacterId,
      setStatus, setRecording, setLastSeed, onFailure, onValidationFieldError,
    }),
    validateAudioClip: file => validateAudioClipWithStatus(lockReferenceAudio, setStatus, file),
    cancel: () => abortController.current?.abort(),
  };
}
