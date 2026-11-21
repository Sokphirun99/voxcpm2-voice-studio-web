/**
 * @fileoverview Standalone Text-to-Speech function workspace managing scripts, character voices, library modal, and playback.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_STEPS, MAX_SCRIPT_LENGTH, STYLE_MODES, countGraphemes } from '../../domain/presets.js';
import { createTtsProjectSnapshot } from '../../domain/projects.js';
import { useStudioServices } from '../StudioContext.jsx';
import { resolveEffectiveSeed } from '../hooks/useCharacterActions.js';
import { useProjectAutosave } from '../hooks/useProjectAutosave.js';
import { useSpeechSynthesis } from '../hooks/useSpeechSynthesis.js';
import { useSpeechVerification } from '../hooks/useSpeechVerification.js';
import { AudioPlayer } from './AudioPlayer.jsx';
import { ChunkSegmentsPanel } from './ChunkSegmentsPanel.jsx';
import { Icon } from './Icon.jsx';
import { ScriptEditor } from './ScriptEditor.jsx';
import { Toolbar } from './Toolbar.jsx';
import { VoiceControls } from './VoiceControls.jsx';
import { VoiceLibrary } from './VoiceLibrary.jsx';

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
  verifyAudio: false,
};

function isApplePlatform() {
  const uaPlatform = navigator.userAgentData?.platform;
  if (typeof uaPlatform === 'string') return /mac|iphone|ipad|ipod/i.test(uaPlatform);
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

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
 * Side effects: triggers character mutations, library modal state, seed clearing, and inference options.
 * Failure modes: async errors in sample upload, voice reset, and anchor updates are handled in `actions`.
 * @param {object} deps - Bound character action dependencies.
 * @returns {object} VoiceControls action callbacks.
 */
export function buildVoiceActions({ actions, activeCharacter, setLibraryModal, setOptions, setLockedSeeds }) {
  return {
    onSelectCharacter: actions.handleSelectCharacter,
    onOpenNewCharacter: () => setLibraryModal?.({ open: true, openForm: true }),
    onUploadSample: file => { clearCharacterLockedSeed(setLockedSeeds, activeCharacter.id); void actions.handleUploadSample(file); },
    onResetVoice: () => { clearCharacterLockedSeed(setLockedSeeds, activeCharacter.id); void actions.handleResetVoice(activeCharacter.id); },
    onUpdateAnchor: patch => void actions.handleUpdateAnchor(activeCharacter.id, patch),
    onChangeOption: (key, value) => {
      if ((key === 'seed' && value === '') || (key === 'lockSeed' && value === false)) clearCharacterLockedSeed(setLockedSeeds, activeCharacter.id);
      setOptions(prev => ({ ...prev, [key]: value }));
    },
  };
}

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

function handleScriptShortcut(event, generateDisabled) {
  if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey) || generateDisabled) return;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}

function focusValidationField(refs, field) {
  if (field === 'promptText') refs.transcriptRef.current?.focus();
  if (field === 'script') refs.scriptRef.current?.focus();
}

function TtsSpeechForm({ state, ctrl, voiceActions, onOpenLibrary }) {
  const activeRecording = ctrl.synthesis.recording;
  const chunkCount = Array.isArray(activeRecording?.chunks) ? activeRecording.chunks.length : 0;
  const belongsToOtherCharacter = Boolean(activeRecording?.characterId && activeRecording.characterId !== ctrl.activeCharacter.id);
  const segmentsPanel = chunkCount >= 2 ? (
    <ChunkSegmentsPanel key={activeRecording.id} recording={activeRecording}
      busy={ctrl.synthesis.busy || Boolean(ctrl.synthesis.regeneratingChunk)}
      regeneratingIndex={ctrl.synthesis.regeneratingChunk?.index ?? null}
      disabled={belongsToOtherCharacter}
      onRegenerate={(index, text) => ctrl.synthesis.regenerateChunk({
        recording: activeRecording, index, text,
        character: ctrl.activeCharacter, anchor: ctrl.activeAnchor,
        cachedUpload: ctrl.actions.uploadedRefsRef.current[ctrl.activeCharacter.id] || null,
        options: state.options,
      })}
      onPlaybackError={() => ctrl.synthesis.setStatus({ message: 'Could not play this segment in the browser. You can still regenerate it.', error: true })} />
  ) : null;
  return (
    <form id="speech-form" className="studio-grid" onSubmit={event => submitCharacterSpeech(event, { ...state, ...ctrl })}>
      <ScriptEditor scriptInput={state.scriptRef} script={state.script} count={ctrl.count} isOverLimit={ctrl.isOverLimit}
        onReplaceScript={text => { state.setScript(text); state.scriptRef.current?.focus(); }}
        onScriptChange={state.setScript} onScriptKey={event => handleScriptShortcut(event, ctrl.generateDisabled)}
        segmentsPanel={segmentsPanel} />
      <section className="voice-inspector" aria-labelledby="voice-title">
        <div className="pane-heading">
          <h2 id="voice-title">Voice</h2>
          <button type="button" className="button subtle-button" id="open-voice-library"
            aria-haspopup="dialog" onClick={onOpenLibrary}>
            <Icon name="list_bullet" /><span>Character library</span>
          </button>
        </div>
        <VoiceControls characters={state.library.allVoices} anchors={state.anchorApi.anchors} activeCharacter={ctrl.activeCharacter}
          activeAnchor={ctrl.activeAnchor} anchorWarning={state.anchorApi.anchorWarning} busy={ctrl.synthesis.busy}
          options={state.options} lastSeed={ctrl.synthesis.lastSeed} lockedSeed={state.lockedSeeds[ctrl.activeCharacter.id] ?? null}
          transcriptRef={state.transcriptRef} actions={voiceActions} glossaryRepository={ctrl.glossaryRepository} />
      </section>
    </form>
  );
}

function applyProjectSnapshotToTts(snapshot, setters) {
  if (!snapshot) return;
  setters.setProjectId(snapshot.id || '');
  setters.setProjectTitle(snapshot.title || snapshot.name || '');
  if (setters.setProjectRevision) setters.setProjectRevision(snapshot.revision || 1);
  setters.setScript(snapshot.payload?.script || snapshot.settings?.script || '');
  const opts = snapshot.payload?.ttsOptions || snapshot.settings?.ttsOptions;
  if (opts && typeof opts === 'object') setters.setOptions(prev => ({ ...prev, ...opts }));
  const voiceId = snapshot.payload?.voiceId || snapshot.settings?.voiceId;
  if (voiceId && setters.allVoices.some(voice => voice.id === voiceId)) {
    setters.characterActions?.handleSelectCharacter?.(voiceId);
  }
}

function useTextToSpeechWorkspace({ shared, hidden, actionsRef, externalScript: propExternalScript = '', onConsumeExternalScript: propConsume }) {
  const {
    library, anchorApi, activeCharacter, activeAnchor,
    lockedSeeds, setLockedSeeds, characterActions,
    externalScript: sharedScript, onConsumeExternalScript: sharedConsume, onTtsStateChange,
  } = shared;
  const externalScript = propExternalScript || sharedScript || '';
  const onConsumeExternalScript = propConsume || sharedConsume;
  const { logger, projectRepository, glossaryRepository = null } = useStudioServices();
  const scriptRef = useRef(null);
  const transcriptRef = useRef(null);
  const prevHiddenRef = useRef(hidden);
  const [script, setScript] = useState('');
  const [options, setOptions] = useState(INITIAL_OPTIONS);
  const [projectId, setProjectId] = useState('');
  const [projectTitle, setProjectTitle] = useState('');
  const [projectRevision, setProjectRevision] = useState(1);
  const [projectsReady, setProjectsReady] = useState(false);
  const scriptValueRef = useRef(script);
  scriptValueRef.current = script;
  const [libraryModal, setLibraryModal] = useState({ open: false, openForm: false });
  const receivedExternalScriptRef = useRef(Boolean(externalScript));
  const allVoicesRef = useRef(library.allVoices);
  const characterActionsRef = useRef(shared.characterActions);
  allVoicesRef.current = library.allVoices;
  characterActionsRef.current = shared.characterActions;
  if (externalScript) receivedExternalScriptRef.current = true;
  const charactersRef = useRef(library.allVoices);
  charactersRef.current = library.allVoices;

  useEffect(() => {
    if (!externalScript) return;
    setScript(externalScript);
    onConsumeExternalScript?.();
  }, [externalScript, onConsumeExternalScript]);

  useEffect(() => {
    if (!projectRepository) {
      setProjectsReady(true);
      return undefined;
    }
    let active = true;
    const restoreLatestProject = async () => {
      try {
        const page = await projectRepository.listProjects({ limit: 50, offset: 0 });
        const latest = page.items.find(project => project.kind === 'tts');
        if (!latest) return;
        const snapshot = await projectRepository.getProject(latest.id);
        if (!active || !snapshot || receivedExternalScriptRef.current || scriptValueRef.current.trim()) return;
        setProjectId(snapshot.id);
        setProjectTitle(snapshot.title);
        setProjectRevision(snapshot.revision || 1);
        setScript(snapshot.payload?.script || '');
        if (snapshot.payload?.ttsOptions && typeof snapshot.payload.ttsOptions === 'object') {
          setOptions(prev => ({ ...prev, ...snapshot.payload.ttsOptions }));
        }
        const voiceId = snapshot.payload?.voiceId;
        if (voiceId && allVoicesRef.current.some(voice => voice.id === voiceId)) {
          characterActionsRef.current.handleSelectCharacter(voiceId);
        }
      } catch (error) {
        logger?.error?.('TextToSpeechWorkspace.restoreProject', error);
      } finally {
        if (active) setProjectsReady(true);
      }
    };
    void restoreLatestProject();
    return () => { active = false; };
  }, [projectRepository, logger]);

  const buildSnapshot = useCallback(() => {
    if (!projectId && !script.trim()) return null;
    const title = projectTitle || script.split(/\r?\n/, 1)[0].trim().slice(0, 60) || 'Untitled TTS project';
    return createTtsProjectSnapshot({
      id: projectId || undefined,
      title,
      script,
      voiceId: activeCharacter.id,
      ttsOptions: options,
    });
  }, [projectId, projectTitle, script, activeCharacter.id, options]);

  const autosave = useProjectAutosave({
    projectId,
    initialRevision: projectRevision,
    buildSnapshot,
    enabled: projectsReady,
    debounceMs: 1500,
    deps: [script, projectTitle, activeCharacter.id, options],
    hidden,
    projectRepository,
    logger,
    onSaveSuccess: saved => {
      if (saved?.id && !projectId) {
        setProjectId(saved.id);
        setProjectTitle(saved.title || projectTitle);
      }
      if (saved?.revision) setProjectRevision(saved.revision);
    },
    onConflict: () => {
      shared.onNotify?.({
        type: 'warning',
        message: 'This project was modified in another session. Unsaved edits remain in memory.',
      });
    },
  });

  useEffect(() => {
    if (prevHiddenRef.current && !hidden) {
      scriptRef.current?.focus();
    }
    prevHiddenRef.current = hidden;
  }, [hidden]);

  const synthesis = useSpeechSynthesis({
    onFailure: shared.refreshEngine,
    onValidationFieldError: field => focusValidationField({ scriptRef, transcriptRef }, field),
    onNotify: shared.onNotify,
    onUnlockSound: shared.onUnlockSound,
  });
  const hasScript = Boolean(script.trim());
  useEffect(() => {
    onTtsStateChange?.({ busy: synthesis.busy, hasScript, libraryOpen: libraryModal.open });
  }, [synthesis.busy, hasScript, libraryModal.open, onTtsStateChange]);

  if (actionsRef) {
    actionsRef.current = {
      focusScript: () => scriptRef.current?.focus(),
      cancelIfCharacter: id => { if (synthesis.activeCharacterId === id) synthesis.cancel(); },
      setStatus: synthesis.setStatus,
      closeLibrary: () => setLibraryModal({ open: false, openForm: false }),
      loadProject: snapshot => {
        autosave.resetProject(snapshot?.id || '', snapshot?.revision || 1);
        applyProjectSnapshotToTts(snapshot, {
          setProjectId,
          setProjectTitle,
          setProjectRevision,
          setScript,
          setOptions,
          allVoices: allVoicesRef.current,
          characterActions: characterActionsRef.current,
        });
      },
      autosave,
    };
  }
  const count = countGraphemes(script);
  const isOverLimit = count > MAX_SCRIPT_LENGTH;
  const generateDisabled = synthesis.busy || Boolean(synthesis.regeneratingChunk) || !anchorApi.isLoaded || !hasScript || isOverLimit;
  const state = { scriptRef, transcriptRef, script, setScript, options, setOptions, lockedSeeds, setLockedSeeds, library, anchorApi, charactersRef, libraryModal, setLibraryModal };
  const ctrl = { logger, glossaryRepository, synthesis, activeCharacter, activeAnchor, actions: characterActions, count, isOverLimit, generateDisabled, autosave };
  return { state, ctrl };
}

/**
 * Self-contained Text-to-Speech workspace function owning its scoped Character Library dialog.
 * Inputs: `{ shared, notices, hidden, actionsRef, externalScript, onConsumeExternalScript }`.
 * Outputs: `<div className="workspace-panel">` element containing TTS toolbar, script/voice panes, library modal, and playback dock.
 * Side effects: delegates speech synthesis, character selection/locking, and audio mastering via Studio services.
 * Failure modes: surfaces validation, engine, and storage errors inside playback status bar and inline dialog alerts.
 * @param {object} props - Workspace container props.
 * @returns {React.ReactElement} Text-to-Speech function workspace.
 */
export function TextToSpeechWorkspace({ shared, notices, hidden = false, actionsRef, externalScript = '', onConsumeExternalScript }) {
  const { state, ctrl } = useTextToSpeechWorkspace({ shared, hidden, actionsRef, externalScript, onConsumeExternalScript });
  const verification = useSpeechVerification({
    recording: ctrl.synthesis.recording,
    autoVerify: Boolean(state.options.verifyAudio),
  });
  const voiceActions = buildVoiceActions({
    actions: ctrl.actions, activeCharacter: ctrl.activeCharacter,
    setLibraryModal: state.setLibraryModal, setOptions: state.setOptions, setLockedSeeds: state.setLockedSeeds,
  });
  return (
    <div className="workspace-panel" hidden={hidden}>
      {notices}
      <Toolbar busy={ctrl.synthesis.busy} generateDisabled={ctrl.generateDisabled}
        shortcut={isApplePlatform() ? '⌘ Enter' : 'Ctrl Enter'} onCancel={ctrl.synthesis.cancel}
        autosave={ctrl.autosave} />
      <TtsSpeechForm state={state} ctrl={ctrl} voiceActions={voiceActions}
        onOpenLibrary={() => state.setLibraryModal({ open: true, openForm: false })} />
      <AudioPlayer recording={ctrl.synthesis.recording} takes={ctrl.synthesis.takes}
        activeTakeId={ctrl.synthesis.activeTakeId} activeCharacter={ctrl.activeCharacter} activeAnchor={ctrl.activeAnchor}
        status={ctrl.synthesis.status} busyMeta={ctrl.synthesis.busyMeta} verification={verification}
        onSelectTake={ctrl.synthesis.selectTake} onDeleteTake={ctrl.synthesis.deleteTake}
        onPinTake={() => void ctrl.actions.handlePinCurrentTake(ctrl.synthesis.recording)}
        onPlaybackError={() => ctrl.synthesis.setStatus({ message: 'Could not play this audio in the browser. You can still download the WAV.', error: true })} />
      <VoiceLibrary open={state.libraryModal.open} openSaveForm={state.libraryModal.openForm}
        busy={ctrl.synthesis.busy} library={state.library} anchors={state.anchorApi.anchors}
        onSelectVoice={voice => ctrl.actions.handleSelectCharacter(voice)}
        onCreateCharacter={input => ctrl.actions.handleCreateCharacter(input)}
        onDeleteCharacter={id => void ctrl.actions.handleDeleteCharacter(id)}
        onUnpinAnchor={id => void ctrl.actions.handleResetVoice(id)}
        onClose={() => state.setLibraryModal({ open: false, openForm: false })} />
    </div>
  );
}
