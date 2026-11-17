/**
 * @fileoverview Presentation hook encapsulating character selection, audio sample pinning, reset, and custom creation actions.
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

/**
 * Formats a human-readable character label `Name (id)` from the character catalog.
 * @param {Array<object>} voices - All available characters.
 * @param {string} id - Character ID.
 * @returns {string} Display label.
 */
function formatCharacterLabel(voices, id) {
  const target = voices.find(item => item.id === id);
  return target ? `${target.name} (${id})` : id;
}

/**
 * Stores or clears the cached server-side FileData handle for a character's uploaded reference clip.
 * @param {{ current: Record<string, object> }} uploadedRefsRef - Mutable cache ref.
 * @param {string} characterId - Character identifier.
 * @param {object|null} fileData - Gradio FileData handle or null to clear.
 */
function setCachedUploadEntry(uploadedRefsRef, characterId, fileData) {
  if (!characterId) return;
  if (fileData) uploadedRefsRef.current[characterId] = fileData;
  else delete uploadedRefsRef.current[characterId];
}

/**
 * Cancels an active synthesis run if it belongs to `characterId`.
 * @param {object} synthesis - Synthesis hook handle.
 * @param {string} characterId - Target character identifier.
 */
function cancelIfSynthesizing(synthesis, characterId) {
  if (synthesis.activeCharacterId === characterId) synthesis.cancel();
}

/**
 * Executes an async anchor storage action with structured error logging and status reporting.
 * @param {object} spec - Action task and error reporting context.
 * @returns {Promise<void>} Completion promise.
 */
async function runAnchorStatusAction({ task, location, context, fallbackMessage, logger, setStatus }) {
  try {
    await task();
  } catch (error) {
    logger.error(location, error, context);
    setStatus({ message: error.message || fallbackMessage, error: true });
  }
}

/**
 * Validates and pins an uploaded audio clip as the active character's exclusive reference voice.
 * @param {File} file - Selected audio file.
 * @param {object} ctx - Character action context.
 * @returns {Promise<void>} Completion promise.
 */
async function uploadSampleForCharacter(file, ctx) {
  const { activeCharacter, synthesis, anchorApi, uploadedRefsRef, rerolledIdsRef, logger } = ctx;
  const validated = await synthesis.validateAudioClip(file);
  if (!validated) return;
  cancelIfSynthesizing(synthesis, activeCharacter.id);
  const anchorParams = {
    characterId: activeCharacter.id, label: activeCharacter.name, blob: validated.blob,
    fileName: validated.fileName, source: 'upload', promptText: '', exactClone: false,
  };
  await runAnchorStatusAction({
    location: 'useCharacterActions.handleUploadSample', context: { characterId: activeCharacter.id },
    fallbackMessage: 'Could not assign voice sample.', logger, setStatus: synthesis.setStatus,
    task: async () => {
      await anchorApi.pinCharacterAnchor(anchorParams);
      setCachedUploadEntry(uploadedRefsRef, activeCharacter.id, null);
      rerolledIdsRef.current.delete(activeCharacter.id);
      synthesis.setStatus({ message: `Assigned "${file.name}" as ${activeCharacter.name}'s (${activeCharacter.id}) voice.`, error: false });
    },
  });
}

/**
 * Unpins a character's stored anchor and clears cached uploads so the next take generates fresh audio.
 * @param {string} characterId - Target character identifier.
 * @param {object} ctx - Character action context.
 * @returns {Promise<void>} Completion promise.
 */
async function resetCharacterVoice(characterId, ctx) {
  if (!characterId) return;
  const { library, synthesis, anchorApi, uploadedRefsRef, rerolledIdsRef, logger } = ctx;
  const label = formatCharacterLabel(library.allVoices, characterId);
  cancelIfSynthesizing(synthesis, characterId);
  await runAnchorStatusAction({
    location: 'useCharacterActions.handleResetVoice',
    context: { characterId },
    fallbackMessage: 'Could not reset voice sample.',
    logger,
    setStatus: synthesis.setStatus,
    task: async () => {
      await anchorApi.unpinCharacterAnchor(characterId);
      setCachedUploadEntry(uploadedRefsRef, characterId, null);
      rerolledIdsRef.current.add(characterId);
      synthesis.setStatus({ message: `Cleared voice sample for ${label}. Next take generates a new voice.`, error: false });
    },
  });
}

/**
 * Locks the currently loaded generated take as the active character's persistent voice anchor.
 * @param {object} ctx - Character action context.
 * @returns {Promise<void>} Completion promise.
 */
async function pinCurrentTakeForCharacter(ctx) {
  const { activeCharacter, synthesis, anchorApi, uploadedRefsRef, rerolledIdsRef, logger } = ctx;
  const rec = synthesis.recording;
  const sourceBlob = rec?.anchorBlob || rec?.blob;
  if (!sourceBlob || rec.characterId !== activeCharacter.id) return;
  const anchorParams = {
    characterId: activeCharacter.id, label: activeCharacter.name, blob: sourceBlob,
    source: 'generated', takeId: rec.id, promptText: rec.anchorTranscript || rec.transcript || '',
  };
  await runAnchorStatusAction({
    location: 'useCharacterActions.handlePinCurrentTake', context: { characterId: activeCharacter.id },
    fallbackMessage: 'Could not lock this take.', logger, setStatus: synthesis.setStatus,
    task: async () => {
      await anchorApi.pinCharacterAnchor(anchorParams);
      setCachedUploadEntry(uploadedRefsRef, activeCharacter.id, null);
      rerolledIdsRef.current.delete(activeCharacter.id);
      synthesis.setStatus({ message: `Locked this audio take to ${activeCharacter.name} (${activeCharacter.id}).`, error: false });
    },
  });
}

/**
 * Rolls back a newly saved custom character entry if attaching its initial audio anchor fails.
 * @param {string} entryId - Saved character identifier.
 * @param {object} library - Voice library hook/actions.
 * @param {import('../../domain/ports.js').LoggerPort} logger - Application logger.
 */
function rollbackSavedVoice(entryId, library, logger) {
  try {
    library.deleteVoice(entryId);
  } catch (rollbackError) {
    logger.error('useCharacterActions.handleCreateCharacter.rollback', rollbackError, { characterId: entryId });
  }
  void library.deleteVoiceRemote?.(entryId).catch(err => logger.error('useCharacterActions.handleCreateCharacter.remoteRollback', err, { characterId: entryId }));
}

/**
 * Validates optional voice audio, saves a new custom character, and pins its uploaded anchor if provided.
 * @param {object} input - New character form payload.
 * @param {object} ctx - Character action context.
 * @returns {Promise<void>} Completion promise.
 */
async function createCharacterWithAnchor(input, ctx) {
  const { lockReferenceAudio, library, anchorApi, logger, onCharacterSelected, onCloseLibrary, synthesis } = ctx;
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
  onCloseLibrary();
  synthesis.setStatus({ message: `Created character ${entry.name} (${entry.id}).`, error: false });
}

/**
 * Unpins a deleted character's audio clip from IndexedDB and reports final delete status.
 * @param {string} id - Deleted character identifier.
 * @param {string} label - Formatted character display label.
 * @param {object} ctx - Character action context.
 * @returns {Promise<void>} Completion promise.
 */
async function unpinDeletedAnchor(id, label, ctx) {
  await runAnchorStatusAction({
    location: 'useCharacterActions.handleDeleteCharacter',
    context: { id },
    fallbackMessage: 'Deleted character, but could not remove its stored voice clip.',
    logger: ctx.logger,
    setStatus: ctx.synthesis.setStatus,
    task: async () => {
      await ctx.anchorApi.unpinCharacterAnchor(id);
      ctx.synthesis.setStatus({ message: `Deleted character ${label}.`, error: false });
    },
  });
}

/**
 * Deletes a custom character from localStorage and only unpins/resets state when deletion succeeds.
 * @param {string} id - Character identifier to delete.
 * @param {object} ctx - Character action context.
 * @returns {Promise<void>} Completion promise.
 */
async function deleteCharacterWithAnchor(id, ctx) {
  if (!id) return;
  const label = formatCharacterLabel(ctx.library.allVoices, id);
  try {
    await ctx.library.deleteVoiceRemote?.(id);
    ctx.library.deleteVoice(id);
  } catch (error) {
    ctx.logger.error('useCharacterActions.handleDeleteCharacter', error, { id });
    ctx.synthesis.setStatus({ message: error.message || `Could not delete character ${label}.`, error: true });
    return;
  }
  cancelIfSynthesizing(ctx.synthesis, id);
  setCachedUploadEntry(ctx.uploadedRefsRef, id, null);
  ctx.rerolledIdsRef.current.delete(id);
  if (id === ctx.activeCharacter.id) ctx.onCharacterSelected(DEFAULT_CHARACTER_ID);
  await unpinDeletedAnchor(id, label, ctx);
}

/**
 * Persists partial anchor edits (transcript or exact-clone toggle) with error logging and status feedback.
 * @param {string} characterId - Target character identifier.
 * @param {object} patch - Anchor patch fields.
 * @param {object} ctx - Character action context.
 * @returns {Promise<void>} Completion promise.
 */
function updateCharacterAnchorAction(characterId, patch, ctx) {
  if (!characterId) return Promise.resolve();
  return runAnchorStatusAction({
    location: 'useCharacterActions.handleUpdateAnchor',
    context: { characterId },
    fallbackMessage: 'Could not save locked voice settings.',
    logger: ctx.logger,
    setStatus: ctx.synthesis.setStatus,
    task: () => ctx.anchorApi.updateCharacterAnchor(characterId, patch),
  });
}

/**
 * Selects a character, closes the library modal if open, and updates the status line.
 * @param {string|object} character - Character ID or entity.
 * @param {object} ctx - Character action context.
 */
function selectCharacterAction(character, ctx) {
  const id = typeof character === 'string' ? character : character?.id;
  if (!id) return;
  ctx.onCharacterSelected(id);
  ctx.onCloseLibrary();
  ctx.synthesis.setStatus({ message: `Selected ${formatCharacterLabel(ctx.library.allVoices, id)}.`, error: false });
}

/**
 * Creates character action handlers from injected hook/service dependencies.
 * Inputs: `{ activeCharacter, library, synthesis, anchorApi, lockReferenceAudio, logger, uploadedRefsRef, rerolledIdsRef, onCharacterSelected, onCloseLibrary }`.
 * Outputs: character selection, upload, reset, pin, anchor update, create, and delete callbacks.
 * Side effects: mutates storage via `library` and `anchorApi`, and updates status via `synthesis.setStatus`.
 * Failure modes: handles and reports storage errors via `logger` and `synthesis.setStatus`; rethrows create validation/storage errors for inline modal display.
 * @param {object} ctx - Character action context.
 * @returns {object} Action handler bundle.
 */
export function createCharacterActionHandlers(ctx) {
  return {
    uploadedRefsRef: ctx.uploadedRefsRef,
    rerolledIdsRef: ctx.rerolledIdsRef,
    setCachedUpload: (characterId, fileData) => setCachedUploadEntry(ctx.uploadedRefsRef, characterId, fileData),
    handleSelectCharacter: character => selectCharacterAction(character, ctx),
    handleUploadSample: file => uploadSampleForCharacter(file, ctx),
    handleResetVoice: (characterId = ctx.activeCharacter.id) => resetCharacterVoice(characterId, ctx),
    handlePinCurrentTake: () => pinCurrentTakeForCharacter(ctx),
    handleUpdateAnchor: (characterId, patch) => updateCharacterAnchorAction(characterId, patch, ctx),
    handleCreateCharacter: input => createCharacterWithAnchor(input, ctx),
    handleDeleteCharacter: id => deleteCharacterWithAnchor(id, ctx),
  };
}

/**
 * Provides cohesive character voice mutation callbacks backed by domain use cases.
 * Inputs: `{ activeCharacter, library, synthesis, anchorApi, onCharacterSelected, onCloseLibrary }`.
 * Outputs: `{ uploadedRefsRef, rerolledIdsRef, setCachedUpload, handleSelectCharacter, handleUploadSample, handleResetVoice, handlePinCurrentTake, handleUpdateAnchor, handleCreateCharacter, handleDeleteCharacter }`.
 * Side effects: persists anchors in IndexedDB and characters in localStorage via injected hooks.
 * Failure modes: logs errors via `logger` and surfaces messages in `synthesis.setStatus`.
 * @param {object} params - Hook dependency bundle.
 * @returns {object} Character voice handlers and session caches.
 */
export function useCharacterActions({ activeCharacter, library, synthesis, anchorApi, onCharacterSelected, onCloseLibrary }) {
  const { lockReferenceAudio, logger } = useStudioServices();
  const uploadedRefsRef = useRef({});
  const rerolledIdsRef = useRef(new Set());
  return createCharacterActionHandlers({
    activeCharacter, library, synthesis, anchorApi, lockReferenceAudio, logger,
    uploadedRefsRef, rerolledIdsRef, onCharacterSelected, onCloseLibrary,
  });
}
