/**
 * @fileoverview Presentation hook driving single-character speech synthesis and status reporting.
 */

import { useEffect, useRef, useState } from 'react';
import { formatGenerationMetrics } from '../../domain/audioValidation.js';
import { SynthesisCancelledError, ValidationError } from '../../domain/errors.js';
import { useStudioServices } from '../StudioContext.jsx';

/**
 * Translates synthesis or validation exceptions into status messages, popup notifications, and field focus callbacks.
 * @param {unknown} error - Caught exception.
 * @param {object} ctx - Error handling callbacks.
 */
function handleGenerationFailure(error, { setStatus, onFailure, onValidationFieldError, onNotify }) {
  if (error instanceof ValidationError) {
    onValidationFieldError?.(error.field);
    setStatus({ message: error.message, error: true });
    onNotify?.({ kind: 'error', title: 'Check input', message: error.message });
    return;
  }
  if (error instanceof SynthesisCancelledError) {
    setStatus({ message: error.message, error: false });
    return;
  }
  const message = error?.message || 'Could not generate speech. Try again.';
  setStatus({ message, error: true });
  onNotify?.({ kind: 'error', title: 'Speech generation failed', message });
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
async function executeSynthesisRequest({ synthesizeSpeech, request, signal, onReferenceUploaded, onCompleted, updateProgress, setStatus, setRecording, setLastSeed, onNotify }) {
  const result = await synthesizeSpeech.execute({
    ...request,
    signal,
    onProgress: info => updateProgress(formatProgressMessage(info)),
    onReferenceUploaded: fileData => onReferenceUploaded?.(request.character.id, fileData),
  });
  setRecording(result.recording);
  if (result.recording.seed != null) setLastSeed(result.recording.seed);
  const customMessage = await onCompleted?.(result);
  const finalMessage = formatCompletedStatus({ customMessage, character: request.character, recording: result.recording });
  setStatus({ message: finalMessage, error: false });
  onNotify?.({ kind: 'success', title: 'Speech ready', message: finalMessage });
}

/**
 * Manages AbortController, busy state, isolated elapsed-timer metadata, and failure translation around one synthesis run.
 * @param {object} spec - Lifecycle state setters and runner.
 * @returns {Promise<void>} Completion promise.
 */
async function runSynthesisLifecycle({ abortController, request, setBusy, setBusyMeta, setActiveCharacterId, setStatus, onFailure, onValidationFieldError, onNotify, onUnlockSound, run }) {
  onUnlockSound?.();
  const controller = new AbortController();
  abortController.current = controller;
  const startedAt = Date.now();
  const initialMessage = 'Preparing speech generation…';
  const updateProgress = nextMsg => {
    setBusyMeta({ startedAt, message: nextMsg });
    setStatus({ message: nextMsg, error: false });
  };
  setBusy(true);
  setBusyMeta({ startedAt, message: initialMessage });
  setActiveCharacterId(request?.character?.id || null);
  setStatus({ message: initialMessage, error: false });
  try {
    await run(controller.signal, updateProgress);
  } catch (error) {
    handleGenerationFailure(error, { setStatus, onFailure, onValidationFieldError, onNotify });
  } finally {
    if (abortController.current === controller) abortController.current = null;
    setBusyMeta(null);
    setActiveCharacterId(null);
    setBusy(false);
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
    abortController: ctx.abortController, request: ctx.request, setBusy: ctx.setBusy, setBusyMeta: ctx.setBusyMeta,
    setActiveCharacterId: ctx.setActiveCharacterId, setStatus: ctx.setStatus,
    onFailure: ctx.onFailure, onValidationFieldError: ctx.onValidationFieldError,
    onNotify: ctx.onNotify, onUnlockSound: ctx.onUnlockSound,
    run: (signal, updateProgress) => executeSynthesisRequest({
      synthesizeSpeech: ctx.synthesizeSpeech, request: ctx.request, signal,
      onReferenceUploaded: ctx.onReferenceUploaded, onCompleted: ctx.onCompleted,
      updateProgress, setStatus: ctx.setStatus, setRecording: ctx.setRecording, setLastSeed: ctx.setLastSeed, onNotify: ctx.onNotify,
    }),
  });
}

/**
 * Coordinates abortable single-character speech synthesis and status reporting.
 * Inputs: `{ onFailure, onValidationFieldError, onNotify, onUnlockSound }`.
 * Outputs: `{ busy, busyMeta, activeCharacterId, recording, lastSeed, status, setStatus, runGeneration, cancel }`.
 * Side effects: invokes injected domain use cases and aborts pending calls on unmount.
 * Failure modes: translates ValidationError, SynthesisCancelledError, and SynthesisError into status state.
 * @param {{ onFailure: () => void, onValidationFieldError?: (field: string) => void, onNotify?: Function, onUnlockSound?: Function }} params - Hook callbacks.
 * @returns {object} Synthesis state and actions.
 */
export function useSpeechSynthesis({ onFailure, onValidationFieldError, onNotify, onUnlockSound }) {
  const { synthesizeSpeech } = useStudioServices();
  const abortController = useRef(null);
  const [busy, setBusy] = useState(false);
  const [busyMeta, setBusyMeta] = useState(null);
  const [activeCharacterId, setActiveCharacterId] = useState(null);
  const [recording, setRecording] = useState(null);
  const [lastSeed, setLastSeed] = useState(null);
  const [status, setStatus] = useState({ message: 'No audio generated yet.', error: false });
  useEffect(() => () => abortController.current?.abort(), []);
  return {
    busy, busyMeta, activeCharacterId, recording, lastSeed, status, setStatus,
    runGeneration: args => startSynthesisGeneration({
      ...args, busy, abortController, synthesizeSpeech, setBusy, setBusyMeta, setActiveCharacterId,
      setStatus, setRecording, setLastSeed, onFailure, onValidationFieldError, onNotify, onUnlockSound,
    }),
    cancel: () => abortController.current?.abort(),
  };
}
