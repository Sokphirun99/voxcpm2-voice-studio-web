/**
 * @fileoverview Shared presentation hook encapsulating character selection, sample locking, reset, and custom creation actions.
 */

import { useRef } from 'react';
import { DEFAULT_CHARACTER_ID } from '../../domain/voiceLibrary.js';
import { useStudioServices } from '../StudioContext.jsx';

/**
 * Resolves the seed passed to VoxCPM2 based on explicit input, locked character seed, anchor state, and reset history.
 * @param {{ rawSeed: string, character: object, hasAnchor: boolean, rerolledIds: Set<string>, lockedSeed?: number|string|null }} spec - Seed context.
 * @returns {string|number} Seed value or blank for automatic randomization.
 */
export function resolveEffectiveSeed({ rawSeed, character, hasAnchor, rerolledIds, lockedSeed = null }) {
  if (rawSeed !== '' && rawSeed !== null && rawSeed !== undefined) return rawSeed;
  if (lockedSeed !== null && lockedSeed !== undefined && lockedSeed !== '' && !rerolledIds.has(character.id)) {
    return lockedSeed;
  }
  if (hasAnchor || rerolledIds.has(character.id)) return '';
  return character.defaultSeed ?? '';
}

function formatCharacterLabel(voices, id) {
  const target = voices.find(item => item.id === id);
  return target ? `${target.name} (${id})` : id;
}

function resolveStatusReporter(ctx) {
  return ctx.onStatus || ctx.synthesis?.setStatus || (() => {});
}

function setCachedUploadEntry(uploadedRefsRef, characterId, fileData) {
  if (!characterId) return;
  if (fileData) uploadedRefsRef.current[characterId] = fileData;
  else delete uploadedRefsRef.current[characterId];
}

function cancelIfSynthesizing(ctx, characterId) {
  if (ctx.onCancelCharacterSynthesis) {
    ctx.onCancelCharacterSynthesis(characterId);
    return;
  }
  if (ctx.synthesis?.activeCharacterId === characterId) ctx.synthesis.cancel?.();
}

async function validateClipForCharacter(file, ctx, reportStatus) {
  try {
    return await ctx.lockReferenceAudio.execute(file);
  } catch (error) {
    const message = error?.message || 'Could not validate voice sample.';
    reportStatus({ message, error: true });
    ctx.onNotify?.({ kind: 'error', title: 'Invalid audio file', message });
    return null;
  }
}

async function runAnchorStatusAction({ task, location, context, fallbackMessage, logger, setStatus }) {
  try {
    await task();
  } catch (error) {
    logger.error(location, error, context);
    setStatus({ message: error.message || fallbackMessage, error: true });
  }
}

async function uploadSampleForCharacter(file, characterId, ctx) {
  const { library, activeCharacter, anchorApi, uploadedRefsRef, rerolledIdsRef, logger } = ctx;
  const targetId = characterId || activeCharacter?.id;
  const targetVoice = library.allVoices.find(v => v.id === targetId) || activeCharacter;
  if (!targetVoice) return;
  ctx.onUnlockSound?.();
  const reportStatus = resolveStatusReporter(ctx);
  const validated = await validateClipForCharacter(file, ctx, reportStatus);
  if (!validated) return;
  cancelIfSynthesizing(ctx, targetVoice.id);
  await runAnchorStatusAction({
    location: 'useCharacterActions.handleUploadSample', context: { characterId: targetVoice.id },
    fallbackMessage: 'Could not assign voice sample.', logger, setStatus: reportStatus,
    task: async () => {
      await anchorApi.pinCharacterAnchor({
        characterId: targetVoice.id, label: targetVoice.name, blob: validated.blob,
        fileName: validated.fileName, source: 'upload', promptText: '', exactClone: false,
      });
      setCachedUploadEntry(uploadedRefsRef, targetVoice.id, null);
      rerolledIdsRef.current.delete(targetVoice.id);
      ctx.onClearLockedSeed?.(targetVoice.id);
      reportStatus({ message: `Assigned "${file.name}" as ${targetVoice.name}'s (${targetVoice.id}) voice.`, error: false });
    },
  });
}

async function resetCharacterVoice(characterId, ctx) {
  if (!characterId) return;
  const { library, anchorApi, uploadedRefsRef, rerolledIdsRef, logger } = ctx;
  const label = formatCharacterLabel(library.allVoices, characterId);
  const reportStatus = resolveStatusReporter(ctx);
  cancelIfSynthesizing(ctx, characterId);
  await runAnchorStatusAction({
    location: 'useCharacterActions.handleResetVoice',
    context: { characterId },
    fallbackMessage: 'Could not reset voice sample.',
    logger,
    setStatus: reportStatus,
    task: async () => {
      await anchorApi.unpinCharacterAnchor(characterId);
      setCachedUploadEntry(uploadedRefsRef, characterId, null);
      rerolledIdsRef.current.add(characterId);
      ctx.onClearLockedSeed?.(characterId);
      reportStatus({ message: `Cleared voice sample for ${label}. Next take generates a new voice.`, error: false });
    },
  });
}

async function pinCurrentTakeForCharacter(recordingArg, ctx) {
  const { activeCharacter, anchorApi, uploadedRefsRef, rerolledIdsRef, logger } = ctx;
  const rec = recordingArg || ctx.synthesis?.recording;
  const sourceBlob = rec?.anchorBlob || rec?.blob;
  if (!sourceBlob || !activeCharacter || rec.characterId !== activeCharacter.id) return;
  const reportStatus = resolveStatusReporter(ctx);
  await runAnchorStatusAction({
    location: 'useCharacterActions.handlePinCurrentTake', context: { characterId: activeCharacter.id },
    fallbackMessage: 'Could not lock this take.', logger, setStatus: reportStatus,
    task: async () => {
      await anchorApi.pinCharacterAnchor({
        characterId: activeCharacter.id, label: activeCharacter.name, blob: sourceBlob,
        source: 'generated', takeId: rec.id, promptText: rec.anchorTranscript || rec.transcript || '',
      });
      setCachedUploadEntry(uploadedRefsRef, activeCharacter.id, null);
      rerolledIdsRef.current.delete(activeCharacter.id);
      reportStatus({ message: `Locked this audio take to ${activeCharacter.name} (${activeCharacter.id}).`, error: false });
    },
  });
}

function rollbackSavedVoice(entryId, library, logger) {
  try {
    library.deleteVoice(entryId);
  } catch (rollbackError) {
    logger.error('useCharacterActions.handleCreateCharacter.rollback', rollbackError, { characterId: entryId });
  }
  void library.deleteVoiceRemote?.(entryId).catch(err => logger.error('useCharacterActions.handleCreateCharacter.remoteRollback', err, { characterId: entryId }));
}

async function createCharacterWithAnchor(input, ctx) {
  const { lockReferenceAudio, library, anchorApi, logger, onCharacterSelected, onCloseLibrary } = ctx;
  const reportStatus = resolveStatusReporter(ctx);
  const validatedAudio = input.audioFile ? await lockReferenceAudio.execute(input.audioFile) : null;
  const entry = library.saveVoice(input);
  try {
    await library.saveVoiceRemote?.(entry);
    if (validatedAudio) {
      await anchorApi.pinCharacterAnchor({
        characterId: entry.id, label: entry.name, blob: validatedAudio.blob,
        fileName: validatedAudio.fileName, source: 'upload', promptText: '', exactClone: false,
      });
    }
  } catch (error) {
    rollbackSavedVoice(entry.id, library, logger);
    throw error;
  }
  onCharacterSelected(entry.id);
  onCloseLibrary?.();
  reportStatus({ message: `Created character ${entry.name} (${entry.id}).`, error: false });
}

async function unpinDeletedAnchor(id, label, ctx, reportStatus) {
  await runAnchorStatusAction({
    location: 'useCharacterActions.handleDeleteCharacter',
    context: { id },
    fallbackMessage: 'Deleted character, but could not remove its stored voice clip.',
    logger: ctx.logger,
    setStatus: reportStatus,
    task: async () => {
      await ctx.anchorApi.unpinCharacterAnchor(id);
      reportStatus({ message: `Deleted character ${label}.`, error: false });
    },
  });
}

async function deleteCharacterWithAnchor(id, ctx) {
  if (!id) return;
  const label = formatCharacterLabel(ctx.library.allVoices, id);
  const reportStatus = resolveStatusReporter(ctx);
  try {
    await ctx.library.deleteVoiceRemote?.(id);
    ctx.library.deleteVoice(id);
  } catch (error) {
    ctx.logger.error('useCharacterActions.handleDeleteCharacter', error, { id });
    reportStatus({ message: error.message || `Could not delete character ${label}.`, error: true });
    return;
  }
  cancelIfSynthesizing(ctx, id);
  setCachedUploadEntry(ctx.uploadedRefsRef, id, null);
  ctx.rerolledIdsRef.current.delete(id);
  ctx.onClearLockedSeed?.(id);
  if (id === ctx.activeCharacter?.id) ctx.onCharacterSelected(DEFAULT_CHARACTER_ID);
  await unpinDeletedAnchor(id, label, ctx, reportStatus);
}

function updateCharacterAnchorAction(characterId, patch, ctx) {
  if (!characterId) return Promise.resolve();
  return runAnchorStatusAction({
    location: 'useCharacterActions.handleUpdateAnchor',
    context: { characterId },
    fallbackMessage: 'Could not save locked voice settings.',
    logger: ctx.logger,
    setStatus: resolveStatusReporter(ctx),
    task: () => ctx.anchorApi.updateCharacterAnchor(characterId, patch),
  });
}

function selectCharacterAction(character, fromLibrary, ctx) {
  const id = typeof character === 'string' ? character : character?.id;
  if (!id) return;
  ctx.onCharacterSelected(id);
  if (fromLibrary) ctx.onCharacterUsed?.(id);
  ctx.onCloseLibrary?.();
  resolveStatusReporter(ctx)({ message: `Selected ${formatCharacterLabel(ctx.library.allVoices, id)}.`, error: false });
}

/**
 * Creates character action handlers from injected shell-level hook dependencies.
 * Inputs: `{ activeCharacter, library, anchorApi, lockReferenceAudio, logger, uploadedRefsRef, rerolledIdsRef, onCharacterSelected, ... }`.
 * Outputs: character selection, upload, reset, pin, anchor update, create, and delete callbacks.
 * Side effects: persists anchors and characters via injected repositories and emits status notifications.
 * Failure modes: logs storage failures via `logger` and reports user-facing error messages via `onStatus`.
 * @param {object} ctx - Character action context.
 * @returns {object} Action handler bundle.
 */
export function createCharacterActionHandlers(ctx) {
  return {
    uploadedRefsRef: ctx.uploadedRefsRef,
    rerolledIdsRef: ctx.rerolledIdsRef,
    setCachedUpload: (characterId, fileData) => setCachedUploadEntry(ctx.uploadedRefsRef, characterId, fileData),
    handleSelectCharacter: (character, opts = null) => selectCharacterAction(character, Boolean(opts?.fromLibrary), ctx),
    handleUploadSample: (file, characterId = ctx.activeCharacter?.id) => uploadSampleForCharacter(file, characterId, ctx),
    handleResetVoice: (characterId = ctx.activeCharacter?.id) => resetCharacterVoice(characterId, ctx),
    handlePinCurrentTake: recording => pinCurrentTakeForCharacter(recording, ctx),
    handleUpdateAnchor: (characterId, patch) => updateCharacterAnchorAction(characterId, patch, ctx),
    handleCreateCharacter: input => createCharacterWithAnchor(input, ctx),
    handleDeleteCharacter: id => deleteCharacterWithAnchor(id, ctx),
  };
}

/**
 * Provides cohesive shared character catalog mutation callbacks independent of any single workspace.
 * Inputs: `{ activeCharacter, library, anchorApi, onCharacterSelected, onClearLockedSeed, onCancelCharacterSynthesis, onCharacterUsed, onCloseLibrary, onStatus, onNotify, onUnlockSound }`.
 * Outputs: `{ uploadedRefsRef, rerolledIdsRef, setCachedUpload, handleSelectCharacter, ... }`.
 * Side effects: updates persistent voice library and IndexedDB/Docker anchors.
 * Failure modes: logs errors via `logger` and surfaces messages via `onStatus`.
 * @param {object} params - Shell dependency bundle.
 * @returns {object} Shared character action handlers.
 */
export function useCharacterActions(params) {
  const { lockReferenceAudio, logger } = useStudioServices();
  const uploadedRefsRef = useRef({});
  const rerolledIdsRef = useRef(new Set());
  return createCharacterActionHandlers({
    ...params,
    lockReferenceAudio,
    logger,
    uploadedRefsRef,
    rerolledIdsRef,
  });
}
