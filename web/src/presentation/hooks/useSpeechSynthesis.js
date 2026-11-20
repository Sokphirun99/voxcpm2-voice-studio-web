/**
 * @fileoverview Presentation hook driving single-character speech synthesis and status reporting.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatGenerationMetrics } from '../../domain/audioValidation.js';
import { SynthesisCancelledError, ValidationError } from '../../domain/errors.js';
import { findActiveTake, pushTakeHistory, removeTakeFromHistory } from '../../domain/takeHistory.js';
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
async function executeSynthesisRequest({ synthesizeSpeech, request, signal, onReferenceUploaded, onCompleted, updateProgress, setStatus, commitRecording, setLastSeed, onNotify }) {
  const result = await synthesizeSpeech.execute({
    ...request,
    signal,
    onProgress: info => updateProgress(formatProgressMessage(info)),
    onReferenceUploaded: fileData => onReferenceUploaded?.(request.character.id, fileData),
  });
  commitRecording(result.recording);
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
      updateProgress, setStatus: ctx.setStatus, commitRecording: ctx.commitRecording, setLastSeed: ctx.setLastSeed, onNotify: ctx.onNotify,
    }),
  });
}

/**
 * Coordinates abortable single-character speech synthesis, bounded session take history, and status reporting.
 * Inputs: `{ onFailure, onValidationFieldError, onNotify, onUnlockSound }`.
 * Outputs: `{ busy, busyMeta, activeCharacterId, takes, activeTakeId, regeneratingChunk, recording, lastSeed, status, setStatus, selectTake, deleteTake, regenerateChunk, runGeneration, cancel }`.
 * Side effects: invokes injected domain use cases, commits generated takes, and aborts pending calls on unmount.
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
  const [takes, setTakes] = useState([]);
  const [activeTakeId, setActiveTakeId] = useState(null);
  const [regeneratingChunk, setRegeneratingChunk] = useState(null);
  const [lastSeed, setLastSeed] = useState(null);
  const [status, setStatus] = useState({ message: 'No audio generated yet.', error: false });
  const takesRef = useRef(takes);
  takesRef.current = takes;
  const regeneratingRef = useRef(null);
  const recording = useMemo(() => findActiveTake(takes, activeTakeId), [takes, activeTakeId]);

  const commitRecording = useCallback(nextRecording => {
    if (!nextRecording?.id) return;
    const nextTakes = pushTakeHistory(takesRef.current, nextRecording);
    takesRef.current = nextTakes;
    setTakes(nextTakes);
    setActiveTakeId(nextRecording.id);
  }, []);

  const selectTake = useCallback(takeId => {
    if (!takesRef.current.some(take => take.id === takeId)) return;
    setActiveTakeId(takeId);
  }, []);

  const deleteTake = useCallback(takeId => {
    const currentTakes = takesRef.current;
    const remaining = removeTakeFromHistory(currentTakes, takeId);
    if (remaining.length === currentTakes.length) return;
    const removedIndex = currentTakes.findIndex(take => take.id === takeId);
    takesRef.current = remaining;
    setTakes(remaining);
    setActiveTakeId(currentId => {
      if (currentId !== takeId && remaining.some(take => take.id === currentId)) return currentId;
      const fallbackIndex = Math.min(Math.max(removedIndex, 0), remaining.length - 1);
      return remaining[fallbackIndex]?.id ?? null;
    });
  }, []);

  const replaceTake = useCallback((takeId, nextRecording) => {
    if (!takeId || !nextRecording?.id) return;
    const currentTakes = takesRef.current;
    if (!currentTakes.some(take => take.id === takeId)) return;
    const nextTakes = currentTakes.map(take => (take.id === takeId ? nextRecording : take));
    takesRef.current = nextTakes;
    setTakes(nextTakes);
  }, []);

  const regenerateChunk = useCallback(async ({ recording: target, index, text, character, anchor, cachedUpload, options, onCompleted }) => {
    if (!target?.id || abortController.current || regeneratingRef.current) return null;
    const controller = new AbortController();
    abortController.current = controller;
    regeneratingRef.current = { takeId: target.id, index };
    setRegeneratingChunk({ takeId: target.id, index });
    setStatus({ message: `Regenerating segment ${index + 1} of ${target.chunks.length}…`, error: false });
    try {
      const result = await synthesizeSpeech.regenerateChunk({
        recording: target, index, text, character, anchor, cachedUpload, options, signal: controller.signal,
      });
      if (controller.signal.aborted || !result?.recording) return null;
      replaceTake(target.id, result.recording);
      if (result.recording.seed != null) setLastSeed(result.recording.seed);
      const customMessage = await onCompleted?.(result);
      const metrics = formatGenerationMetrics(result.recording);
      const identity = character ? `${character.name} (${character.id})` : 'Voice';
      const message = customMessage || [`Segment ${index + 1} regenerated`, metrics, identity].filter(Boolean).join(' · ');
      setStatus({ message, error: false });
      onNotify?.({ kind: 'success', title: 'Segment updated', message });
      return result.recording;
    } catch (error) {
      handleGenerationFailure(error, { setStatus, onFailure, onValidationFieldError, onNotify });
      return null;
    } finally {
      if (abortController.current === controller) abortController.current = null;
      regeneratingRef.current = null;
      setRegeneratingChunk(null);
    }
  }, [synthesizeSpeech, replaceTake, onFailure, onValidationFieldError, onNotify]);

  useEffect(() => () => abortController.current?.abort(), []);
  return {
    busy, busyMeta, activeCharacterId, takes, activeTakeId, regeneratingChunk, recording, lastSeed, status, setStatus,
    selectTake, deleteTake, regenerateChunk,
    runGeneration: args => startSynthesisGeneration({
      ...args, busy, abortController, synthesizeSpeech, setBusy, setBusyMeta, setActiveCharacterId,
      setStatus, commitRecording, setLastSeed, onFailure, onValidationFieldError, onNotify, onUnlockSound,
    }),
    cancel: () => abortController.current?.abort(),
  };
}
