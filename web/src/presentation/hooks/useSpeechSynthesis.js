/**
 * @fileoverview Presentation hook driving single-character speech synthesis and status reporting.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatGenerationMetrics } from '../../domain/audioValidation.js';
import { OfflineModelMissingError, SynthesisCancelledError, ValidationError } from '../../domain/errors.js';
import { assertFeatureOfflineReady } from '../../domain/offlineReadiness.js';
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
  if (error instanceof OfflineModelMissingError || error?.name === 'OfflineModelMissingError') {
    setStatus({ message: error.message, error: true });
    onNotify?.({ kind: 'error', title: 'Model download required', message: error.message });
    return;
  }
  const message = error?.message || 'Could not generate speech. Try again.';
  setStatus({ message, error: true });
  onNotify?.({ kind: 'error', title: 'Speech generation failed', message });
  onFailure();
}

/**
 * Builds a progress status line during synthesis.
 * @param {{ completed: number, total: number, characterName?: string }} progress - Chunk progress info.
 * @returns {string} Human-readable progress message.
 */
function formatProgressMessage({ completed, total, characterName }) {
  if (total <= 1) return 'Generating speech. The first request may take longer while the model loads.';
  if (characterName) return `Generating part ${completed + 1} of ${total} (${characterName})…`;
  return `Generating part ${completed + 1} of ${total} with the same character voice…`;
}

/**
 * Builds the default completion status line when no custom message is returned.
 * @param {{ name: string, id: string }} character - Target speaking character.
 * @param {object} recording - Returned recording.
 * @returns {string} Status line text.
 */
function formatSuccessStatus(character, recording) {
  const identity = recording?.isMultiSpeaker
    ? 'Multiple speakers'
    : (character ? `${character.name} (${character.id})` : 'Voice');
  const metrics = formatGenerationMetrics(recording);
  const parts = ['Audio ready'];
  if (recording?.fromCache) parts.push('cached');
  else if (recording?.mastered) parts.push('-16 LUFS mastered');
  if (metrics) parts.push(metrics);
  parts.push(identity);
  if (recording?.seed != null && !recording?.isMultiSpeaker) parts.push(`Seed ${recording.seed}`);
  return parts.join(' · ');
}

function formatCompletedStatus({ customMessage, character, recording }) {
  if (!customMessage) return formatSuccessStatus(character, recording);
  const metrics = formatGenerationMetrics(recording);
  return metrics ? `${customMessage} · ${metrics}` : customMessage;
}

function formatSegmentSuccessStatus(character, recording) {
  const identity = character ? `${character.name} (${character.id})` : 'Voice';
  const metrics = formatGenerationMetrics(recording);
  if (recording?.fromCache) return `Segment audio ready (cached) · ${identity}`;
  return ['Segment audio ready', metrics, identity].filter(Boolean).join(' · ');
}

async function executeSegmentRequest(spec) {
  const { synthesizeSpeech, segment, character, anchor, cachedUpload, options, signal, onCompleted, setStatus, onNotify, onReferenceUploaded, models, isOnline } = spec;
  const runner = synthesizeSpeech.synthesizeSegment || synthesizeSpeech.execute;
  const result = await runner({
    segment, character, anchor, cachedUpload, options, signal, models, isOnline,
    onReferenceUploaded: fileData => onReferenceUploaded?.(character.id, fileData),
  });
  if (signal.aborted || !result?.recording) return null;
  await onCompleted?.(result);
  const statusMsg = formatSegmentSuccessStatus(character, result.recording);
  setStatus({ message: statusMsg, error: false });
  onNotify?.({ kind: 'success', title: 'Segment generated', message: statusMsg });
  return result.recording;
}

function notifyRestitchedSuccess({ recording, commitRecording, setStatus, onNotify }) {
  commitRecording(recording);
  const action = recording.isNarration ? 'Complete narration assembled' : 'Full audio restitched';
  const title = recording.isNarration ? 'Narration assembled' : 'Audio track compiled';
  const message = [action, formatGenerationMetrics(recording)].filter(Boolean).join(' · ');
  setStatus({ message, error: false });
  onNotify?.({ kind: 'success', title, message });
}

async function runSegmentLifecycle(ctx, runner) {
  ctx.onUnlockSound?.();
  const controller = new AbortController();
  ctx.abortController.current = controller;
  ctx.setGeneratingSegmentId(ctx.segmentId);
  ctx.setBusy(true);
  ctx.setStatus({ message: `Generating segment audio (${ctx.voiceName})…`, error: false });
  try {
    return await runner(controller.signal);
  } catch (error) {
    handleGenerationFailure(error, ctx);
    return null;
  } finally {
    if (ctx.abortController.current === controller) ctx.abortController.current = null;
    ctx.setGeneratingSegmentId(null);
    ctx.setBusy(false);
  }
}

/**
 * Executes synthesis use case, stores recording/seed updates, and updates the status line.
 * @param {object} spec - Execution callbacks and services.
 * @returns {Promise<void>} Completion promise.
 */
async function executeSynthesisRequest({ synthesizeSpeech, request, signal, onReferenceUploaded, onCompleted, updateProgress, setStatus, commitRecording, setLastSeed, onNotify }) {
  const runner = request.isMultiSpeaker && typeof synthesizeSpeech.synthesizeMultiSpeaker === 'function'
    ? synthesizeSpeech.synthesizeMultiSpeaker
    : synthesizeSpeech.execute;
  const result = await runner({
    ...request,
    signal,
    onProgress: info => updateProgress(formatProgressMessage(info)),
    onReferenceUploaded: (charId, fileData) => onReferenceUploaded?.(charId || request.character?.id, fileData),
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

function resolveSynthesisOnline(ctx) {
  if (typeof ctx?.isOnline === 'boolean') return ctx.isOnline;
  if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
    return navigator.onLine;
  }
  return true;
}

function resolveSynthesisModels(ctx) {
  if (ctx?.models) return ctx.models;
  if (ctx?.offlineReadiness?.features) return ctx.offlineReadiness.features;
  return null;
}

/**
 * Guards against overlapping synthesis runs and delegates to `runSynthesisLifecycle`.
 * @param {object} ctx - Hook services, refs, setters, and generation args.
 * @returns {Promise<void>} Completion promise.
 */
function startSynthesisGeneration(ctx) {
  if (ctx.busy || ctx.abortController.current) return Promise.resolve();
  const isOnline = resolveSynthesisOnline(ctx);
  const models = resolveSynthesisModels(ctx);
  assertFeatureOfflineReady({ featureId: 'tts', models, isOnline });
  return runSynthesisLifecycle({
    abortController: ctx.abortController, request: ctx.request, setBusy: ctx.setBusy, setBusyMeta: ctx.setBusyMeta,
    setActiveCharacterId: ctx.setActiveCharacterId, setStatus: ctx.setStatus,
    onFailure: ctx.onFailure, onValidationFieldError: ctx.onValidationFieldError,
    onNotify: ctx.onNotify, onUnlockSound: ctx.onUnlockSound,
    run: (signal, updateProgress) => executeSynthesisRequest({
      synthesizeSpeech: ctx.synthesizeSpeech,
      request: { ...ctx.request, models, isOnline },
      signal,
      onReferenceUploaded: ctx.onReferenceUploaded,
      onCompleted: ctx.onCompleted,
      updateProgress, setStatus: ctx.setStatus, commitRecording: ctx.commitRecording, setLastSeed: ctx.setLastSeed, onNotify: ctx.onNotify,
    }),
  });
}

function prepareSegmentRun(args, defaults) {
  const online = resolveSynthesisOnline({ isOnline: args.isOnline ?? defaults.isOnline });
  const effectiveModels = resolveSynthesisModels({ models: args.models ?? defaults.models, offlineReadiness: defaults.offlineReadiness });
  assertFeatureOfflineReady({ featureId: 'tts', models: effectiveModels, isOnline: online });
  return { online, effectiveModels };
}

/**
 * Coordinates abortable single-character speech synthesis, bounded session take history, and status reporting.
 * Inputs: `{ onFailure, onValidationFieldError, onNotify, onUnlockSound, offlineReadiness, models, isOnline }`.
 * Outputs: `{ busy, busyMeta, activeCharacterId, takes, activeTakeId, regeneratingChunk, generatingSegmentId, recording, lastSeed, status, setStatus, selectTake, deleteTake, regenerateChunk, generateSegment, runGeneration, cancel }`.
 * Side effects: invokes injected domain use cases, commits generated takes, and aborts pending calls on unmount.
 * Failure modes: translates ValidationError, SynthesisCancelledError, and SynthesisError into status state.
 * @param {{ onFailure: () => void, onValidationFieldError?: (field: string) => void, onNotify?: Function, onUnlockSound?: Function, offlineReadiness?: object, models?: unknown, isOnline?: boolean }} params - Hook callbacks.
 * @returns {object} Synthesis state and actions.
 */
/**
 * Derives a unique non-destructive take ID for a chunk-regenerated recording so prior takes remain selectable.
 * @param {object} recording - Regenerated recording entity.
 * @param {object[]} existingTakes - Current session takes.
 * @returns {object} Recording with a unique take ID.
 */
function buildRegeneratedTake(recording, existingTakes) {
  if (!recording?.id) return recording;
  const baseId = String(recording.id).replace(/-regen-\d+$/, '');
  const existingIds = new Set((existingTakes || []).map(take => take?.id));
  let seq = 1;
  let candidateId = `${baseId}-regen-${seq}`;
  while (existingIds.has(candidateId)) {
    seq += 1;
    candidateId = `${baseId}-regen-${seq}`;
  }
  return { ...recording, id: candidateId };
}

export function useSpeechSynthesis({ onFailure, onValidationFieldError, onNotify, onUnlockSound, offlineReadiness = null, models = null, isOnline = undefined }) {
  const { synthesizeSpeech } = useStudioServices();
  const abortController = useRef(null);
  const [busy, setBusy] = useState(false);
  const [busyMeta, setBusyMeta] = useState(null);
  const [activeCharacterId, setActiveCharacterId] = useState(null);
  const [takes, setTakes] = useState([]);
  const [activeTakeId, setActiveTakeId] = useState(null);
  const [regeneratingChunk, setRegeneratingChunk] = useState(null);
  const [generatingSegmentId, setGeneratingSegmentId] = useState(null);
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

  const regenerateChunk = useCallback(async ({ recording: target, index, text, character, anchor, cachedUpload, options, onCompleted, models: chunkModels, isOnline: chunkOnline }) => {
    if (!target?.id || abortController.current || regeneratingRef.current) return null;
    const controller = new AbortController();
    abortController.current = controller;
    regeneratingRef.current = { takeId: target.id, index };
    setRegeneratingChunk({ takeId: target.id, index });
    setStatus({ message: `Regenerating segment ${index + 1} of ${target.chunks.length}…`, error: false });
    try {
      const online = resolveSynthesisOnline({ isOnline: chunkOnline ?? isOnline });
      const effectiveModels = resolveSynthesisModels({ models: chunkModels ?? models, offlineReadiness });
      assertFeatureOfflineReady({ featureId: 'tts', models: effectiveModels, isOnline: online });
      const result = await synthesizeSpeech.regenerateChunk({
        recording: target, index, text, character, anchor, cachedUpload, options, signal: controller.signal,
        models: effectiveModels, isOnline: online,
      });
      if (controller.signal.aborted || !result?.recording) return null;
      const nextRecording = buildRegeneratedTake(result.recording, takesRef.current);
      commitRecording(nextRecording);
      if (nextRecording.seed != null) setLastSeed(nextRecording.seed);
      const customMessage = await onCompleted?.({ ...result, recording: nextRecording });
      const metrics = formatGenerationMetrics(nextRecording);
      const identity = character ? `${character.name} (${character.id})` : 'Voice';
      const message = customMessage || [`Segment ${index + 1} regenerated`, metrics, identity].filter(Boolean).join(' · ');
      setStatus({ message, error: false });
      onNotify?.({ kind: 'success', title: 'Segment updated', message });
      return nextRecording;
    } catch (error) {
      handleGenerationFailure(error, { setStatus, onFailure, onValidationFieldError, onNotify });
      return null;
    } finally {
      if (abortController.current === controller) abortController.current = null;
      regeneratingRef.current = null;
      setRegeneratingChunk(null);
    }
  }, [synthesizeSpeech, commitRecording, onFailure, onValidationFieldError, onNotify, isOnline, models, offlineReadiness]);

  const generateSegment = useCallback(async args => {
    const { segment, character } = args || {};
    if (!segment?.id || abortController.current || generatingSegmentId) return null;
    if (!(segment.text || '').trim()) {
      handleGenerationFailure(new ValidationError('Enter text before generating speech.', 'script', 'EMPTY_SEGMENT'), { setStatus, onFailure, onValidationFieldError, onNotify });
      return null;
    }
    const { online, effectiveModels } = prepareSegmentRun(args, { isOnline, models, offlineReadiness });
    return runSegmentLifecycle({
      segmentId: segment.id, voiceName: character?.name || 'Voice', abortController,
      setGeneratingSegmentId, setBusy, setStatus, onFailure, onValidationFieldError, onNotify, onUnlockSound,
    }, signal => executeSegmentRequest({
      synthesizeSpeech, ...args, signal, setStatus, onNotify, models: effectiveModels, isOnline: online,
    }));
  }, [synthesizeSpeech, onFailure, onValidationFieldError, onNotify, onUnlockSound, isOnline, models, offlineReadiness, generatingSegmentId]);

  const restitchSegments = useCallback(async args => {
    if (!Array.isArray(args?.segments) || abortController.current) return null;
    const controller = new AbortController();
    abortController.current = controller;
    setBusy(true);
    const startMsg = args?.isNarration
      ? 'Assembling complete narration with calibrated pauses…'
      : 'Restitching audio segments with calibrated pauses…';
    setStatus({ message: startMsg, error: false });
    try {
      const result = await synthesizeSpeech.restitchSegments({ ...args, signal: controller.signal });
      if (controller.signal.aborted || !result?.recording) return null;
      notifyRestitchedSuccess({ recording: result.recording, commitRecording, setStatus, onNotify });
      return result.recording;
    } catch (error) {
      handleGenerationFailure(error, { setStatus, onFailure, onValidationFieldError, onNotify });
      if (args?.throwOnError) throw error;
      return null;
    } finally {
      if (abortController.current === controller) abortController.current = null;
      setBusy(false);
    }
  }, [synthesizeSpeech, commitRecording, onFailure, onValidationFieldError, onNotify]);

  const exportNarration = useCallback(async args => {
    const rec = await restitchSegments({ ...args, isNarration: true });
    if (rec?.audioUrl && typeof document !== 'undefined' && document.body) {
      const anchor = document.createElement('a');
      anchor.href = rec.audioUrl;
      anchor.download = args?.filename || rec.filename || 'voxcpm2-assembled-narration.wav';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
    }
    return rec;
  }, [restitchSegments]);

  const clearTakes = useCallback(() => {
    abortController.current?.abort();
    takesRef.current = [];
    setTakes([]);
    setActiveTakeId(null);
    setLastSeed(null);
    setRegeneratingChunk(null);
    setGeneratingSegmentId(null);
    setStatus({ message: 'No audio generated yet.', error: false });
  }, []);

  useEffect(() => () => abortController.current?.abort(), []);
  return {
    busy, busyMeta, activeCharacterId, takes, activeTakeId, regeneratingChunk, generatingSegmentId, recording, lastSeed, status, setStatus,
    selectTake, deleteTake, clearTakes, regenerateChunk, generateSegment, restitchSegments,
    assembleNarration: restitchSegments,
    exportNarration,
    runGeneration: args => startSynthesisGeneration({
      ...args, busy, abortController, synthesizeSpeech, setBusy, setBusyMeta, setActiveCharacterId,
      setStatus, commitRecording, setLastSeed, onFailure, onValidationFieldError, onNotify, onUnlockSound,
      offlineReadiness: args.offlineReadiness ?? offlineReadiness,
      models: args.models ?? models,
      isOnline: typeof args.isOnline === 'boolean' ? args.isOnline : isOnline,
    }),
    cancel: () => abortController.current?.abort(),
  };
}
