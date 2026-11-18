/**
 * @fileoverview Standalone Text-to-Speech function workspace managing scripts, character voices, and playback.
 */

import React, { useEffect, useRef, useState } from 'react';
import { DEFAULT_STEPS, MAX_SCRIPT_LENGTH, STYLE_MODES, countGraphemes } from '../../domain/presets.js';
import { useStudioServices } from '../StudioContext.jsx';
import { resolveEffectiveSeed } from '../hooks/useCharacterActions.js';
import { useSpeechSynthesis } from '../hooks/useSpeechSynthesis.js';
import { AudioPlayer } from './AudioPlayer.jsx';
import { ScriptEditor } from './ScriptEditor.jsx';
import { Toolbar } from './Toolbar.jsx';
import { VoiceControls } from './VoiceControls.jsx';

const INITIAL_OPTIONS = {
  guidance: 2,
  steps: DEFAULT_STEPS,
  seed: '',
  lockSeed: true,
  autoFormatKhmer: true,
  styleMode: STYLE_MODES.AUTO,
  customStyle: '',
  denoiseReference: false,
  masterAudio: true,
};

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
 * Clears any saved locked seed for `characterId` when voice is reset or randomized.
 * @param {Function} [setLockedSeeds] - Optional locked-seed state setter.
 * @param {string} characterId - Target character ID.
 */
export function clearCharacterLockedSeed(setLockedSeeds, characterId) {
  if (!setLockedSeeds || !characterId) return;
  setLockedSeeds(prev => {
    if (!(characterId in prev)) return prev;
    const { [characterId]: _removed, ...rest } = prev;
    return rest;
  });
}

/**
 * Builds the validated submission request for the active character generation run.
 * @param {object} spec - Current script, character, anchor, actions, options, and locked seeds.
 * @returns {object} Synthesis request payload.
 */
function buildSubmissionRequest({ script, submittedCharacter, submittedAnchor, actions, options, lockedSeeds = {} }) {
  const lockedSeed = options.lockSeed !== false ? lockedSeeds[submittedCharacter.id] : null;
  const seed = resolveEffectiveSeed({
    rawSeed: options.seed,
    character: submittedCharacter,
    hasAnchor: Boolean(submittedAnchor),
    rerolledIds: actions.rerolledIdsRef.current,
    lockedSeed,
  });
  return {
    script,
    character: submittedCharacter,
    anchor: submittedAnchor,
    cachedUpload: actions.uploadedRefsRef.current[submittedCharacter.id] || null,
    guidance: options.guidance,
    steps: options.steps,
    seed,
    autoFormatKhmer: options.autoFormatKhmer !== false,
    styleMode: options.styleMode || STYLE_MODES.AUTO,
    customStyle: options.customStyle || '',
    denoiseReference: options.denoiseReference,
    masterAudio: options.masterAudio !== false,
  };
}

/**
 * Builds the `VoiceControls` action callback bundle bound to the active character.
 * Inputs: `{ actions, activeCharacter, setLibraryModal, setOptions, setLockedSeeds }`.
 * Outputs: callback map passed to `<VoiceControls actions={...} />`.
 * Side effects: triggers character mutations, modal open state, seed clearing, and inference option updates.
 * Failure modes: async errors in sample upload, voice reset, and anchor updates are handled in `actions`.
 * @param {object} deps - Bound character action dependencies.
 * @returns {object} VoiceControls action callbacks.
 */
export function buildVoiceActions({ actions, activeCharacter, onOpenNewCharacter, setLibraryModal, setOptions, setLockedSeeds }) {
  return {
    onSelectCharacter: actions.handleSelectCharacter,
    onOpenNewCharacter: () => (onOpenNewCharacter ? onOpenNewCharacter() : setLibraryModal?.({ open: true, openForm: true })),
    onUploadSample: file => { clearCharacterLockedSeed(setLockedSeeds, activeCharacter.id); void actions.handleUploadSample(file); },
    onResetVoice: () => { clearCharacterLockedSeed(setLockedSeeds, activeCharacter.id); void actions.handleResetVoice(activeCharacter.id); },
    onUpdateAnchor: patch => void actions.handleUpdateAnchor(activeCharacter.id, patch),
    onChangeOption: (key, value) => {
      if ((key === 'seed' && value === '') || (key === 'lockSeed' && value === false)) clearCharacterLockedSeed(setLockedSeeds, activeCharacter.id);
      setOptions(prev => ({ ...prev, [key]: value }));
    },
  };
}

/**
 * Submits the active character's script for synthesis, persists locked seeds, and wires Take-1 voice locking.
 * @param {Event} event - Form submit event.
 * @param {object} ctx - Submission context.
 */
function submitCharacterSpeech(event, ctx) {
  event.preventDefault();
  if (!ctx.anchorApi.isLoaded) return;
  const submittedCharacter = ctx.activeCharacter;
  const submittedAnchor = ctx.anchorApi.anchors[submittedCharacter.id] || null;
  const submittedRevision = ctx.anchorApi.getRevision(submittedCharacter.id);
  const request = buildSubmissionRequest({ script: ctx.script, submittedCharacter, submittedAnchor, actions: ctx.actions, options: ctx.options, lockedSeeds: ctx.lockedSeeds });
  void ctx.synthesis.runGeneration({
    request,
    onReferenceUploaded: ctx.actions.setCachedUpload,
    onCompleted: result => {
      if (ctx.options.lockSeed !== false && result.recording?.seed != null) {
        ctx.setLockedSeeds?.(prev => ({ ...prev, [submittedCharacter.id]: result.recording.seed }));
      }
      return finalizeCharacterGeneration({
        result, submittedCharacter, submittedRevision,
        characterExists: id => ctx.charactersRef.current.some(item => item.id === id),
        actions: ctx.actions, anchorApi: ctx.anchorApi, logger: ctx.logger,
      });
    },
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
 * Focuses the input element matching a domain validation field error.
 * @param {object} refs - Field ref state.
 * @param {string} field - Failing validation field name.
 */
function focusValidationField(refs, field) {
  if (field === 'promptText') refs.transcriptRef.current?.focus();
  if (field === 'script') refs.scriptRef.current?.focus();
}

/**
 * Renders the script editor and character voice inspector form.
 * @param {object} props - Form state, controller handles, and voice actions.
 * @returns {React.ReactElement} Speech form element.
 */
function TtsSpeechForm({ state, ctrl, voiceActions }) {
  return (
    <form id="speech-form" className="studio-grid" onSubmit={event => submitCharacterSpeech(event, { ...state, ...ctrl })}>
      <ScriptEditor scriptInput={state.scriptRef} script={state.script} count={ctrl.count} isOverLimit={ctrl.isOverLimit}
        onReplaceScript={text => { state.setScript(text); state.scriptRef.current?.focus(); }}
        onScriptChange={state.setScript} onScriptKey={event => handleScriptShortcut(event, ctrl.generateDisabled)} />
      <section className="voice-inspector" aria-labelledby="voice-title">
        <div className="pane-heading"><h2 id="voice-title">Voice</h2></div>
        <VoiceControls characters={state.library.allVoices} anchors={state.anchorApi.anchors} activeCharacter={ctrl.activeCharacter}
          activeAnchor={ctrl.activeAnchor} anchorWarning={state.anchorApi.anchorWarning} busy={ctrl.synthesis.busy}
          options={state.options} lastSeed={ctrl.synthesis.lastSeed} lockedSeed={state.lockedSeeds[ctrl.activeCharacter.id] ?? null}
          transcriptRef={state.transcriptRef} actions={voiceActions} />
      </section>
    </form>
  );
}

/**
 * Coordinates local TTS state, script sync, synthesis actions, and seed locks for the TTS workspace.
 * @param {object} props - Shared shell services and library state.
 * @returns {object} Combined workspace state and controller handles.
 */
function useTextToSpeechWorkspace({ shared, actionsRef, externalScript: propExternalScript = '', onConsumeExternalScript: propConsume }) {
  const {
    library,
    anchorApi,
    activeCharacter,
    activeAnchor,
    lockedSeeds,
    setLockedSeeds,
    characterActions,
    externalScript: sharedScript,
    onConsumeExternalScript: sharedConsume,
    onTtsStateChange,
  } = shared;
  const externalScript = propExternalScript || sharedScript || '';
  const onConsumeExternalScript = propConsume || sharedConsume;
  const { logger } = useStudioServices();
  const scriptRef = useRef(null);
  const transcriptRef = useRef(null);
  const [script, setScript] = useState('');
  const [options, setOptions] = useState(INITIAL_OPTIONS);
  const charactersRef = useRef(library.allVoices);
  charactersRef.current = library.allVoices;

  useEffect(() => {
    if (!externalScript) return;
    setScript(externalScript);
    onConsumeExternalScript?.();
  }, [externalScript, onConsumeExternalScript]);

  const synthesis = useSpeechSynthesis({ onFailure: shared.refreshEngine, onValidationFieldError: field => focusValidationField({ scriptRef, transcriptRef }, field) });
  const hasScript = Boolean(script.trim());
  useEffect(() => {
    onTtsStateChange?.({ busy: synthesis.busy, hasScript });
  }, [synthesis.busy, hasScript, onTtsStateChange]);

  if (actionsRef) {
    actionsRef.current = {
      focusScript: () => scriptRef.current?.focus(),
      cancelIfCharacter: id => { if (synthesis.activeCharacterId === id) synthesis.cancel(); },
      setStatus: synthesis.setStatus,
    };
  }
  const count = countGraphemes(script);
  const isOverLimit = count > MAX_SCRIPT_LENGTH;
  const generateDisabled = synthesis.busy || !anchorApi.isLoaded || !hasScript || isOverLimit;
  const state = { scriptRef, transcriptRef, script, setScript, options, setOptions, lockedSeeds, setLockedSeeds, library, anchorApi, charactersRef };
  const ctrl = { logger, synthesis, activeCharacter, activeAnchor, actions: characterActions, count, isOverLimit, generateDisabled };
  return { state, ctrl };
}

/**
 * Self-contained Text-to-Speech workspace function rendered inside the Studio shell.
 * Inputs: `{ shared, notices, hidden, actionsRef, externalScript, onConsumeExternalScript }`.
 * Outputs: `<div className="workspace-panel">` element containing TTS toolbar, form, and playback dock.
 * Side effects: delegates speech synthesis and audio mastering while consuming shared Character catalog state.
 * Failure modes: surfaces validation, engine, and storage errors inside playback status bar.
 * @param {object} props - Workspace container props.
 * @returns {React.ReactElement} Text-to-Speech function workspace.
 */
export function TextToSpeechWorkspace({ shared, notices, hidden = false, actionsRef, externalScript = '', onConsumeExternalScript }) {
  const { state, ctrl } = useTextToSpeechWorkspace({ shared, actionsRef, externalScript, onConsumeExternalScript });
  const voiceActions = buildVoiceActions({
    actions: ctrl.actions, activeCharacter: ctrl.activeCharacter,
    onOpenNewCharacter: shared.onOpenNewCharacter, setOptions: state.setOptions, setLockedSeeds: state.setLockedSeeds,
  });
  return (
    <div className="workspace-panel" hidden={hidden}>
      {notices}
      <Toolbar busy={ctrl.synthesis.busy} generateDisabled={ctrl.generateDisabled}
        shortcut={isApplePlatform() ? '⌘ Enter' : 'Ctrl Enter'} onCancel={ctrl.synthesis.cancel} />
      <TtsSpeechForm state={state} ctrl={ctrl} voiceActions={voiceActions} />
      <AudioPlayer recording={ctrl.synthesis.recording} activeCharacter={ctrl.activeCharacter} activeAnchor={ctrl.activeAnchor}
        status={ctrl.synthesis.status} onPinTake={() => void ctrl.actions.handlePinCurrentTake(ctrl.synthesis.recording)}
        onPlaybackError={() => ctrl.synthesis.setStatus({ message: 'Could not play this audio in the browser. You can still download the WAV.', error: true })} />
    </div>
  );
}
