/**
 * @fileoverview Top-level Voice Studio coordinator connecting character voices, persistent 1-voice locks, and playback.
 */

import React, { useMemo, useRef, useState } from 'react';
import { DEFAULT_STEPS, MAX_SCRIPT_LENGTH, countGraphemes } from '../../domain/presets.js';
import { DEFAULT_CHARACTER_ID, findCharacterById } from '../../domain/voiceLibrary.js';
import { useStudioServices } from '../StudioContext.jsx';
import { resolveEffectiveSeed, useCharacterActions } from '../hooks/useCharacterActions.js';
import { useEngineStatus } from '../hooks/useEngineStatus.js';
import { useSpeechSynthesis } from '../hooks/useSpeechSynthesis.js';
import { useVoiceAnchors } from '../hooks/useVoiceAnchors.js';
import { useVoiceLibrary } from '../hooks/useVoiceLibrary.js';
import { AudioPlayer } from './AudioPlayer.jsx';
import { ScriptEditor } from './ScriptEditor.jsx';
import { Sidebar } from './Sidebar.jsx';
import { Toolbar } from './Toolbar.jsx';
import { VoiceControls } from './VoiceControls.jsx';
import { VoiceLibrary } from './VoiceLibrary.jsx';

const INITIAL_OPTIONS = { guidance: 2, steps: DEFAULT_STEPS, seed: '', denoiseReference: false, masterAudio: true };

/**
 * Detects Apple platforms using User-Agent Client Hints with a userAgent fallback.
 * @returns {boolean} True on macOS, iOS, or iPadOS browsers.
 */
function isApplePlatform() {
  const uaPlatform = navigator.userAgentData?.platform;
  if (typeof uaPlatform === 'string') return /mac|iphone|ipad|ipod/i.test(uaPlatform);
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/**
 * Pins a character's first generated voice take into persistent storage with status reporting.
 * @param {object} params - Pin context.
 * @returns {Promise<string>} User-facing status message.
 */
async function pinFirstTakeAnchor({ submittedCharacter, recording, actions, anchorApi, logger }) {
  try {
    await anchorApi.pinCharacterAnchor({
      characterId: submittedCharacter.id,
      label: submittedCharacter.name,
      blob: recording.anchorBlob,
      source: 'generated',
      takeId: recording.id,
      promptText: recording.anchorTranscript || '',
    });
    actions.rerolledIdsRef.current.delete(submittedCharacter.id);
    return `Audio ready · Locked 1-person voice for ${submittedCharacter.name} (${submittedCharacter.id})`;
  } catch (error) {
    logger.error('Studio.finalizeCharacterGeneration', error, { characterId: submittedCharacter.id });
    return `Audio ready · ${submittedCharacter.name} (${submittedCharacter.id}) generated, but could not persist lock`;
  }
}

/**
 * Handles post-synthesis auto-pinning of a character's first generated voice clip with race guards.
 * Inputs: `{ result, submittedCharacter, submittedRevision, characterExists, actions, anchorApi, logger }`.
 * Outputs: custom status string when Take 1 was auto-locked (or lock failed), or `null`.
 * Side effects: caches uploaded reference FileData and persists Take 1 anchor via `anchorApi`.
 * Failure modes: logs IndexedDB errors and returns a non-fatal warning status instead of throwing.
 * @param {object} ctx - Completion handler inputs.
 * @returns {Promise<string|null>} Custom status message or null.
 */
export async function finalizeCharacterGeneration(ctx) {
  const { result, submittedCharacter, submittedRevision, characterExists, actions, anchorApi } = ctx;
  if (!characterExists(submittedCharacter.id)) return null;
  const isSameRevision = anchorApi.getRevision(submittedCharacter.id) === submittedRevision;
  if (result.uploadedFileData && isSameRevision) actions.setCachedUpload(submittedCharacter.id, result.uploadedFileData);
  if (!isSameRevision || anchorApi.hasAnchor(submittedCharacter.id) || !result.recording?.anchorBlob) return null;
  return pinFirstTakeAnchor({ ...ctx, recording: result.recording });
}

/**
 * Builds the validated submission request for the active character generation run.
 * @param {object} spec - Current script, character, anchor, actions, and inference options.
 * @returns {object} Synthesis request payload.
 */
function buildSubmissionRequest({ script, submittedCharacter, submittedAnchor, actions, options }) {
  const seed = resolveEffectiveSeed({
    rawSeed: options.seed,
    character: submittedCharacter,
    hasAnchor: Boolean(submittedAnchor),
    rerolledIds: actions.rerolledIdsRef.current,
  });
  return {
    script,
    character: submittedCharacter,
    anchor: submittedAnchor,
    cachedUpload: actions.uploadedRefsRef.current[submittedCharacter.id] || null,
    guidance: options.guidance,
    steps: options.steps,
    seed,
    denoiseReference: options.denoiseReference,
    masterAudio: options.masterAudio !== false,
  };
}

/**
 * Builds the `VoiceControls` action callback bundle bound to the active character.
 * Inputs: `{ actions, activeCharacter, setLibraryModal, setOptions }`.
 * Outputs: callback map passed to `<VoiceControls actions={...} />`.
 * Side effects: triggers character mutations, modal open state, and inference option updates.
 * Failure modes: async errors in sample upload, voice reset, and anchor updates are handled in `actions`.
 * @param {object} deps - Bound character action dependencies.
 * @returns {object} VoiceControls action callbacks.
 */
export function buildVoiceActions({ actions, activeCharacter, setLibraryModal, setOptions }) {
  return {
    onSelectCharacter: actions.handleSelectCharacter,
    onOpenNewCharacter: () => setLibraryModal({ open: true, openForm: true }),
    onUploadSample: file => void actions.handleUploadSample(file),
    onResetVoice: () => void actions.handleResetVoice(activeCharacter.id),
    onUpdateAnchor: patch => void actions.handleUpdateAnchor(activeCharacter.id, patch),
    onChangeOption: (key, value) => setOptions(prev => ({ ...prev, [key]: value })),
  };
}

/**
 * Submits the active character's script for synthesis and wires Take-1 voice auto-locking.
 * @param {Event} event - Form submit event.
 * @param {object} ctx - Studio submission context.
 */
function submitCharacterSpeech(event, ctx) {
  event.preventDefault();
  if (!ctx.anchorApi.isLoaded) return;
  const submittedCharacter = ctx.activeCharacter;
  const submittedAnchor = ctx.anchorApi.anchors[submittedCharacter.id] || null;
  const submittedRevision = ctx.anchorApi.getRevision(submittedCharacter.id);
  const request = buildSubmissionRequest({ script: ctx.script, submittedCharacter, submittedAnchor, actions: ctx.actions, options: ctx.options });
  void ctx.synthesis.runGeneration({
    request,
    onReferenceUploaded: ctx.actions.setCachedUpload,
    onCompleted: result => finalizeCharacterGeneration({
      result, submittedCharacter, submittedRevision,
      characterExists: id => ctx.charactersRef.current.some(item => item.id === id),
      actions: ctx.actions, anchorApi: ctx.anchorApi, logger: ctx.logger,
    }),
  });
}

/**
 * Submits the speech form on Cmd/Ctrl+Enter inside the script editor when generation is enabled.
 * @param {KeyboardEvent} event - Keydown event.
 * @param {boolean} generateDisabled - Whether generation is currently blocked.
 */
function handleScriptShortcut(event, generateDisabled) {
  if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey) || generateDisabled) return;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}

/**
 * Renders the script editor and character voice inspector form.
 * @param {object} props - Form state, controller handles, and voice actions.
 * @returns {React.ReactElement} Speech form element.
 */
function StudioSpeechForm({ state, ctrl, voiceActions }) {
  return (
    <form id="speech-form" className="studio-grid" onSubmit={event => submitCharacterSpeech(event, { ...state, ...ctrl })}>
      <ScriptEditor scriptInput={state.scriptRef} script={state.script} count={ctrl.count} isOverLimit={ctrl.isOverLimit}
        onReplaceScript={text => { state.setScript(text); state.scriptRef.current?.focus(); }}
        onScriptChange={state.setScript} onScriptKey={event => handleScriptShortcut(event, ctrl.generateDisabled)} />
      <section className="voice-inspector" aria-labelledby="voice-title">
        <div className="pane-heading"><h2 id="voice-title">Voice</h2></div>
        <VoiceControls characters={state.library.allVoices} anchors={state.anchorApi.anchors} activeCharacter={ctrl.activeCharacter}
          activeAnchor={ctrl.activeAnchor} anchorWarning={state.anchorApi.anchorWarning} busy={ctrl.synthesis.busy}
          options={state.options} lastSeed={ctrl.synthesis.lastSeed} transcriptRef={state.transcriptRef} actions={voiceActions} />
      </section>
    </form>
  );
}

/**
 * Renders the main workspace pane containing toolbar, script/voice form, and playback dock.
 * @param {object} props - Workspace props.
 * @returns {React.ReactElement} Main workspace element.
 */
function StudioWorkspace({ state, ctrl, voiceActions }) {
  const { synthesis, activeCharacter, activeAnchor, actions, generateDisabled } = ctrl;
  return (
    <main className="studio-workspace">
      <Toolbar busy={synthesis.busy} generateDisabled={generateDisabled}
        shortcut={isApplePlatform() ? '⌘ Enter' : 'Ctrl Enter'} onCancel={synthesis.cancel} />
      <StudioSpeechForm state={state} ctrl={ctrl} voiceActions={voiceActions} />
      <AudioPlayer recording={synthesis.recording} activeCharacter={activeCharacter} activeAnchor={activeAnchor}
        status={synthesis.status} onPinTake={() => void actions.handlePinCurrentTake()}
        onPlaybackError={() => synthesis.setStatus({ message: 'Could not play this audio in the browser. You can still download the WAV.', error: true })} />
    </main>
  );
}

/**
 * Renders the two-column studio layout pairing sidebar navigation with the workspace pane.
 * @param {object} props - Layout props.
 * @returns {React.ReactElement} Studio window container.
 */
function StudioMain({ state, ctrl, voiceActions, onOpenLibrary }) {
  return (
    <div className="studio-window">
      <Sidebar engine={state.engine} onFocusScript={() => state.scriptRef.current?.focus()} onOpenLibrary={onOpenLibrary} />
      <StudioWorkspace state={state} ctrl={ctrl} voiceActions={voiceActions} />
    </div>
  );
}

/**
 * Focuses the input element matching a domain validation field error.
 * @param {object} state - Studio ref state.
 * @param {string} field - Failing validation field name.
 */
function focusValidationField(state, field) {
  if (field === 'promptText') state.transcriptRef.current?.focus();
  if (field === 'script') state.scriptRef.current?.focus();
}

/**
 * Allocates refs, UI state, and persistence/engine hooks for the Studio workspace.
 * @returns {object} Studio state and service hook handles.
 */
function useStudioState() {
  const scriptRef = useRef(null);
  const transcriptRef = useRef(null);
  const [script, setScript] = useState('');
  const [options, setOptions] = useState(INITIAL_OPTIONS);
  const [selectedCharacterId, setSelectedCharacterId] = useState(DEFAULT_CHARACTER_ID);
  const [libraryModal, setLibraryModal] = useState({ open: false, openForm: false });
  const [engine, refreshEngine] = useEngineStatus();
  const library = useVoiceLibrary();
  const anchorApi = useVoiceAnchors();
  const charactersRef = useRef(library.allVoices);
  charactersRef.current = library.allVoices;
  return {
    scriptRef, transcriptRef, script, setScript, options, setOptions, selectedCharacterId,
    setSelectedCharacterId, libraryModal, setLibraryModal, engine, refreshEngine, library, anchorApi, charactersRef,
  };
}

/**
 * Connects synthesis and character mutation actions to `useStudioState`.
 * @param {object} state - Studio state returned by `useStudioState`.
 * @returns {object} Derived active character, synthesis state, and character action handlers.
 */
function useStudioController(state) {
  const { logger } = useStudioServices();
  const synthesis = useSpeechSynthesis({
    onFailure: state.refreshEngine,
    onValidationFieldError: field => focusValidationField(state, field),
  });
  const activeCharacter = useMemo(() => findCharacterById(state.library.allVoices, state.selectedCharacterId), [state.library.allVoices, state.selectedCharacterId]);
  const activeAnchor = state.anchorApi.anchors[activeCharacter.id] || null;
  const actions = useCharacterActions({
    activeCharacter, library: state.library, synthesis, anchorApi: state.anchorApi,
    onCharacterSelected: state.setSelectedCharacterId,
    onCloseLibrary: () => state.setLibraryModal({ open: false, openForm: false }),
  });
  const count = countGraphemes(state.script);
  const isOverLimit = count > MAX_SCRIPT_LENGTH;
  const generateDisabled = synthesis.busy || !state.anchorApi.isLoaded || !state.script.trim() || isOverLimit;
  return { logger, synthesis, activeCharacter, activeAnchor, actions, count, isOverLimit, generateDisabled };
}

/**
 * Coordinates studio workspace state across script editor, Narakeet-style character voices, library modal, and player.
 * Inputs: none (consumes injected services via presentation hooks).
 * Outputs: complete Voice Studio workspace tree.
 * Side effects: delegates network/storage/audio work to presentation hooks backed by domain use cases.
 * Failure modes: displays errors in the playback status bar without uncaught UI crashes.
 * @returns {React.ReactElement} Voice Studio root component.
 */
export function Studio() {
  const state = useStudioState();
  const ctrl = useStudioController(state);
  const voiceActions = buildVoiceActions({
    actions: ctrl.actions, activeCharacter: ctrl.activeCharacter,
    setLibraryModal: state.setLibraryModal, setOptions: state.setOptions,
  });
  return (
    <>
      <StudioMain state={state} ctrl={ctrl} voiceActions={voiceActions}
        onOpenLibrary={() => state.setLibraryModal({ open: true, openForm: false })} />
      <VoiceLibrary open={state.libraryModal.open} openSaveForm={state.libraryModal.openForm} busy={ctrl.synthesis.busy}
        library={state.library} anchors={state.anchorApi.anchors}
        onSelectVoice={ctrl.actions.handleSelectCharacter} onCreateCharacter={ctrl.actions.handleCreateCharacter}
        onDeleteCharacter={id => void ctrl.actions.handleDeleteCharacter(id)}
        onUnpinAnchor={id => void ctrl.actions.handleResetVoice(id)}
        onClose={() => state.setLibraryModal({ open: false, openForm: false })} />
    </>
  );
}
