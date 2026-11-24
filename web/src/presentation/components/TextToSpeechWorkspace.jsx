/**
 * @fileoverview Standalone Text-to-Speech function workspace managing scripts, character voices, library modal, and playback.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  attachTakesToSegments,
  createEditableSegment,
  deleteSegment,
  attachTakeToSegment,
  getSegmentActiveTake,
  getSegmentTake,
  hasSegmentAudio,
  selectSegmentTakeInList,
  removeSegmentTakeInList,
  cycleSegmentTakeInList,
  insertSegment,
  mergeSegments,
  moveSegmentDown,
  moveSegmentUp,
  reconcileScriptToSegments,
  reorderSegments,
  segmentsToScript,
  splitSegmentInList,
  updateSegmentContent,
  updateSegmentInList,
} from '../../domain/projectSegments.js';
import {
  DEFAULT_STEPS,
  MAX_SCRIPT_LENGTH,
  STYLE_MODES,
  countGraphemes,
} from '../../domain/presets.js';
import { findCharacterById } from '../../domain/voiceLibrary.js';
import { createTtsProjectSnapshot } from '../../domain/projects.js';
import { persistTakeAsset, resolveTakeAudioUrl } from '../../data/takeAssetStorage.js';
import { useStudioServices } from '../StudioContext.jsx';
import { resolveEffectiveSeed } from '../hooks/useCharacterActions.js';
import { useProjectAutosave } from '../hooks/useProjectAutosave.js';
import { useProjectRecovery } from '../hooks/useProjectRecovery.js';
import { useSpeechSynthesis } from '../hooks/useSpeechSynthesis.js';
import { useSpeechVerification } from '../hooks/useSpeechVerification.js';
import { AudioPlayer } from './AudioPlayer.jsx';
import { ChunkSegmentsPanel } from './ChunkSegmentsPanel.jsx';
import { DraftRecoveryBanner } from './DraftRecoveryBanner.jsx';
import { Icon } from './Icon.jsx';
import { MissingAssetBanner } from './MissingAssetBanner.jsx';
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

function resolveMultiSpeakerContext(spec) {
  const { segments = [], submittedCharacter, characters = [], anchors = {}, actions } = spec;
  const isMulti = Array.isArray(segments) && segments.length > 1 && new Set(segments.map(s => s.voiceId || submittedCharacter.id).filter(Boolean)).size > 1;
  return {
    isMultiSpeaker: isMulti,
    segments,
    characters,
    defaultCharacter: submittedCharacter,
    anchors,
    cachedUploads: actions.uploadedRefsRef.current,
  };
}

function buildSubmissionRequest(spec) {
  const { script, submittedCharacter, submittedAnchor, actions, options, lockedSeeds = {} } = spec;
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
    ...resolveMultiSpeakerContext(spec),
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

async function persistChunkAsset(assetRepository, chunk, meta) {
  if (!chunk?.blob || !assetRepository) return null;
  return persistTakeAsset({
    assetRepository,
    blob: chunk.blob,
    segmentId: chunk.segmentId || meta.fallbackSegmentId,
    seed: chunk.seed,
    projectId: meta.projectId,
    logger: meta.logger,
  });
}

async function persistChunkAssets(chunks, meta) {
  if (!Array.isArray(chunks) || chunks.length === 0 || !meta.assetRepository) return chunks;
  return Promise.all(chunks.map(async (chunk, idx) => {
    const audioAssetId = await persistChunkAsset(meta.assetRepository, chunk, {
      ...meta, fallbackSegmentId: `seg-${idx + 1}`,
    });
    return audioAssetId ? { ...chunk, audioAssetId } : chunk;
  }));
}

async function uploadAndAttachProjectTakes(spec) {
  const { assetRepository, setSegments, result, characterId, anchorRevision, options, projectId, logger } = spec;
  if (!result?.recording || !setSegments) return;
  const fullAssetId = await persistTakeAsset({
    assetRepository, blob: result.recording.blob, segmentId: 'full', seed: result.recording.seed, projectId, logger,
  });
  const chunks = await persistChunkAssets(result.recording.chunks, { assetRepository, projectId, logger });
  const rec = chunks ? { ...result.recording, chunks } : result.recording;
  setSegments(prev => attachTakesToSegments(prev, rec, {
    voiceId: characterId, audioAssetId: fullAssetId, anchorVersion: anchorRevision,
    guidance: options.guidance, steps: options.steps, styleMode: options.styleMode, customStyle: options.customStyle,
  }));
}

/**
 * Uploads a generated segment take blob to durable asset storage and attaches it to the segment.
 * Inputs: spec containing assetRepository, setSegments, segmentId, result, characterId, anchorRevision, options, projectId, logger.
 * Outputs: Promise<void>.
 * Side effects: uploads asset binary to storage, mutates React segment state.
 * Failure modes: logs warning via persistTakeAsset on upload error and attaches take with null audioAssetId.
 * @param {object} spec - Upload and attachment parameters.
 */
async function uploadAndAttachSegmentTake(spec) {
  const { assetRepository, setSegments, segmentId, result, characterId, anchorRevision, options, projectId, logger } = spec;
  if (!result?.recording || !setSegments || !segmentId) return;
  const audioAssetId = await persistTakeAsset({
    assetRepository, blob: result.recording.blob, segmentId, seed: result.recording.seed, projectId, logger,
  });
  setSegments(prev => attachTakeToSegment(prev, segmentId, result.recording, {
    voiceId: characterId, audioAssetId, anchorVersion: anchorRevision,
    guidance: options.guidance, steps: options.steps, styleMode: options.styleMode, customStyle: options.customStyle,
  }));
}

function submitCharacterSpeech(event, ctx) {
  event.preventDefault();
  if (!ctx.anchorApi.isLoaded) return;
  ctx.handleStopPreview?.();
  const submittedCharacter = ctx.activeCharacter;
  const submittedAnchor = ctx.anchorApi.anchors[submittedCharacter.id] || null;
  const submittedRevision = ctx.anchorApi.getRevision(submittedCharacter.id);
  const request = buildSubmissionRequest({
    script: ctx.script, submittedCharacter, submittedAnchor,
    actions: ctx.actions, options: ctx.options, lockedSeeds: ctx.lockedSeeds,
    segments: ctx.segments, characters: ctx.charactersRef.current, anchors: ctx.anchorApi.anchors,
  });
  void ctx.synthesis.runGeneration({
    request,
    onReferenceUploaded: ctx.actions.setCachedUpload,
    onCompleted: async result => {
      if (ctx.options.lockSeed !== false && result.recording?.seed != null && !request.isMultiSpeaker) {
        ctx.setLockedSeeds?.(prev => ({ ...prev, [submittedCharacter.id]: result.recording.seed }));
      }
      await uploadAndAttachProjectTakes({
        assetRepository: ctx.assetRepository, setSegments: ctx.setSegments, result,
        characterId: submittedCharacter.id, anchorRevision: submittedRevision || 1,
        options: ctx.options, projectId: ctx.projectId, logger: ctx.logger,
      });
      if (request.isMultiSpeaker) return null;
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
  if (field === 'script') {
    refs.scriptRef.current?.focus();
    const firstSegment = document.querySelector('.segment-textarea');
    firstSegment?.focus();
  }
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
        onCompleted: result => {
          if (state.setSegments && result?.recording) {
            state.setSegments(prev => attachTakesToSegments(prev, result.recording, { voiceId: ctrl.activeCharacter.id }));
          }
        },
      })}
      onPlaybackError={() => ctrl.synthesis.setStatus({ message: 'Could not play this segment in the browser. You can still regenerate it.', error: true })} />
  ) : null;
  return (
    <form id="speech-form" className="studio-grid" onSubmit={event => submitCharacterSpeech(event, { ...state, ...ctrl })}>
      <ScriptEditor
        scriptInput={state.scriptRef}
        script={state.script}
        count={ctrl.count}
        isOverLimit={ctrl.isOverLimit}
        onReplaceScript={state.handleReplaceScript}
        onScriptChange={state.handleScriptChange}
        onScriptKey={event => handleScriptShortcut(event, ctrl.generateDisabled)}
        segmentsPanel={segmentsPanel}
        segments={state.segments}
        activeSegmentId={state.activeSegmentId}
        onSelectSegment={state.setActiveSegmentId}
        onUpdateSegment={state.handleUpdateSegment}
        onAddSegment={state.handleAddSegment}
        onDeleteSegment={state.handleDeleteSegment}
        onMoveSegmentUp={state.handleMoveSegmentUp}
        onMoveSegmentDown={state.handleMoveSegmentDown}
        onMergeSegment={state.handleMergeSegment}
        onSplitSegment={state.handleSplitSegment}
        onReorderSegments={state.handleReorderSegments}
        onGenerateSegment={state.handleGenerateSegment}
        onTogglePlaySegment={state.handleTogglePlaySegment}
        generatingSegmentId={ctrl.synthesis.generatingSegmentId}
        playingSegmentId={state.playingSegmentId}
        onSelectSegmentTake={state.handleSelectSegmentTake}
        onDeleteSegmentTake={state.handleDeleteSegmentTake}
        onTogglePlayTake={state.handleTogglePlayTake}
        playingTakeId={state.playingTakeId}
        onCycleSegmentTake={state.handleCycleSegmentTake}
        onRestitchSegments={state.handleRestitchSegments}
        onExportNarration={state.handleExportNarration}
        hasTakesToRestitch={state.hasTakesToRestitch}
        viewMode={state.viewMode}
        onViewModeChange={state.setViewMode}
        voices={state.library.allVoices}
        defaultVoiceId={ctrl.activeCharacter.id}
        disabled={ctrl.synthesis.busy}
      />
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

function stopCurrentPreview(previewRef) {
  if (!previewRef?.current) return;
  previewRef.current.onended = null;
  previewRef.current.onerror = null;
  previewRef.current.pause();
  previewRef.current = null;
}

function pauseMainAudioElement() {
  if (typeof document === 'undefined') return;
  const mainAudio = document.querySelector('audio#audio');
  if (mainAudio && !mainAudio.paused) mainAudio.pause();
}

function createPlaybackNotifier(shared, logger, actionName, onClear) {
  return error => {
    onClear();
    logger?.error?.(actionName, error);
    shared?.onNotify?.({ type: 'warning', message: 'Could not play audio in the browser.' });
  };
}

function warnMissingAudio(shared, onClear, message) {
  onClear();
  shared?.onNotify?.({ type: 'warning', message });
}

function playSegmentAudio(audioUrl, onEnd, onError) {
  if (!audioUrl || typeof Audio === 'undefined') return null;
  try {
    const audio = new Audio(audioUrl);
    audio.onended = onEnd;
    audio.onerror = onError;
    const playPromise = audio.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(onError);
    }
    return audio;
  } catch (error) {
    onError?.(error);
    return null;
  }
}

function applyProjectSnapshotToTts(snapshot, setters) {
  if (!snapshot) return;
  setters.setProjectId(snapshot.id || '');
  setters.setProjectTitle(snapshot.title || snapshot.name || '');
  if (setters.setProjectRevision) setters.setProjectRevision(snapshot.revision || 1);
  const rawScript = snapshot.payload?.script || snapshot.settings?.script || '';
  setters.setScript(rawScript);
  const snapSegs = snapshot.segments || snapshot.payload?.segments;
  if (setters.setSegments) {
    if (Array.isArray(snapSegs) && snapSegs.length > 0) {
      setters.setSegments(snapSegs.map(createEditableSegment));
    } else {
      setters.setSegments(reconcileScriptToSegments([], rawScript));
    }
  }
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
  const services = useStudioServices();
  const { logger, projectRepository, glossaryRepository = null, assetRepository = null } = services;
  const scriptRef = useRef(null);
  const transcriptRef = useRef(null);
  const prevHiddenRef = useRef(hidden);
  const [script, setScript] = useState('');
  const [segments, setSegments] = useState([]);
  const [activeSegmentId, setActiveSegmentId] = useState(null);
  const [viewMode, setViewMode] = useState('script');
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

  const handleScriptChange = useCallback(nextScript => {
    setScript(nextScript);
    setSegments(prev => reconcileScriptToSegments(prev, nextScript, { defaultVoiceId: activeCharacter.id }));
  }, [activeCharacter.id]);

  const handleUpdateSegment = useCallback((id, updates) => {
    setSegments(prev => {
      const next = updateSegmentInList(prev, id, updates);
      setScript(segmentsToScript(next));
      return next;
    });
  }, []);

  const handleAddSegment = useCallback(afterId => {
    setSegments(prev => {
      const idx = prev.findIndex(s => s.id === afterId);
      const targetIndex = idx >= 0 ? idx + 1 : prev.length;
      const next = insertSegment(prev, targetIndex, { voiceId: activeCharacter.id });
      setScript(segmentsToScript(next));
      const added = next[targetIndex];
      if (added?.id) setActiveSegmentId(added.id);
      return next;
    });
  }, [activeCharacter.id]);

  const handleDeleteSegment = useCallback(id => {
    setSegments(prev => {
      const next = deleteSegment(prev, id);
      setScript(segmentsToScript(next));
      return next;
    });
    setActiveSegmentId(prev => (prev === id ? null : prev));
  }, []);

  const handleMoveSegmentUp = useCallback(id => {
    setActiveSegmentId(id);
    setSegments(prev => {
      const next = moveSegmentUp(prev, id);
      setScript(segmentsToScript(next));
      return next;
    });
  }, []);

  const handleMoveSegmentDown = useCallback(id => {
    setActiveSegmentId(id);
    setSegments(prev => {
      const next = moveSegmentDown(prev, id);
      setScript(segmentsToScript(next));
      return next;
    });
  }, []);

  const handleMergeSegment = useCallback(id => {
    setSegments(prev => {
      const idx = prev.findIndex(s => s.id === id);
      const successorId = idx >= 0 && idx < prev.length - 1 ? prev[idx + 1].id : null;
      const next = mergeSegments(prev, id);
      setScript(segmentsToScript(next));
      setActiveSegmentId(cur => (cur === successorId ? id : cur));
      return next;
    });
  }, []);

  const handleSplitSegment = useCallback((id, cursor) => {
    setActiveSegmentId(id);
    setSegments(prev => {
      const next = splitSegmentInList(prev, id, cursor);
      setScript(segmentsToScript(next));
      return next;
    });
  }, []);

  const handleReorderSegments = useCallback((sourceIndex, targetIndex) => {
    setSegments(prev => {
      const next = reorderSegments(prev, sourceIndex, targetIndex);
      setScript(segmentsToScript(next));
      return next;
    });
  }, []);

  const handleReplaceScript = useCallback(text => {
    setScript(text);
    setSegments(prev => reconcileScriptToSegments(prev, text, { defaultVoiceId: activeCharacter.id }));
    scriptRef.current?.focus();
  }, [activeCharacter.id]);

  useEffect(() => {
    if (!externalScript) return;
    setScript(externalScript);
    setSegments(reconcileScriptToSegments([], externalScript, { defaultVoiceId: activeCharacter.id }));
    onConsumeExternalScript?.();
  }, [externalScript, onConsumeExternalScript, activeCharacter.id]);

  useEffect(() => {
    setSegments(prev => {
      if (!prev || prev.length === 0) return prev;
      const hasUnassigned = prev.some(s => !s.voiceId);
      if (!hasUnassigned) return prev;
      return prev.map(s => (s.voiceId ? s : updateSegmentContent(s, { voiceId: activeCharacter.id })));
    });
  }, [activeCharacter.id]);

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
        const loadedScript = snapshot.payload?.script || '';
        setScript(loadedScript);
        const snapSegs = snapshot.segments || snapshot.payload?.segments;
        if (Array.isArray(snapSegs) && snapSegs.length > 0) {
          setSegments(snapSegs.map(createEditableSegment));
        } else {
          setSegments(reconcileScriptToSegments([], loadedScript));
        }
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
      segments,
      voiceId: activeCharacter.id,
      ttsOptions: options,
    });
  }, [projectId, projectTitle, script, segments, activeCharacter.id, options]);

  const autosave = useProjectAutosave({
    projectId,
    initialRevision: projectRevision,
    buildSnapshot,
    enabled: projectsReady,
    debounceMs: 1500,
    deps: [script, segments, projectTitle, activeCharacter.id, options],
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
    offlineReadiness: shared?.offlineReadiness,
  });
  const hasScript = Boolean(script.trim());
  const [playingSegmentId, setPlayingSegmentId] = useState(null);
  const [playingTakeId, setPlayingTakeId] = useState(null);
  const audioPreviewRef = useRef(null);

  const handleGenerateSegment = useCallback(async segmentId => {
    stopCurrentPreview(audioPreviewRef);
    setPlayingSegmentId(null);
    setPlayingTakeId(null);
    pauseMainAudioElement();
    const target = (segments || []).find(seg => seg.id === segmentId);
    if (!target) return;
    const voiceId = target.voiceId || activeCharacter.id;
    const character = findCharacterById(library.allVoices, voiceId) || activeCharacter;
    const anchor = anchorApi.anchors[character.id] || null;
    const rev = anchorApi.getRevision(character.id) || 1;
    const cachedUpload = characterActions.uploadedRefsRef.current[character.id] || null;
    const onCompleted = async result => {
      await uploadAndAttachSegmentTake({
        assetRepository, setSegments, segmentId, result,
        characterId: character.id, anchorRevision: rev,
        options, projectId, logger,
      });
    };
    await synthesis.generateSegment({
      segment: target, character, anchor, cachedUpload,
      options, onCompleted,
    });
  }, [segments, synthesis, activeCharacter, library.allVoices, anchorApi, characterActions, assetRepository, options, projectId, logger]);

  const handleTogglePlaySegment = useCallback(segmentId => {
    const clearState = () => { setPlayingSegmentId(null); setPlayingTakeId(null); };
    if (playingSegmentId === segmentId) {
      stopCurrentPreview(audioPreviewRef);
      clearState();
      return;
    }
    const target = (segments || []).find(seg => seg.id === segmentId);
    const take = getSegmentActiveTake(target);
    const url = resolveTakeAudioUrl(take);
    stopCurrentPreview(audioPreviewRef);
    if (!url) return warnMissingAudio(shared, clearState, 'No playable audio found for this segment.');
    pauseMainAudioElement();
    const onError = createPlaybackNotifier(shared, logger, 'playSegmentAudio', clearState);
    audioPreviewRef.current = playSegmentAudio(url, clearState, onError);
    if (audioPreviewRef.current) {
      setPlayingSegmentId(segmentId);
      setPlayingTakeId(take?.id || null);
    }
  }, [playingSegmentId, segments, shared, logger]);

  const handleSelectSegmentTake = useCallback((segmentId, takeId) => {
    if (playingSegmentId === segmentId && playingTakeId !== takeId) {
      stopCurrentPreview(audioPreviewRef);
      setPlayingSegmentId(null);
      setPlayingTakeId(null);
    }
    setSegments(prev => selectSegmentTakeInList(prev, segmentId, takeId));
  }, [playingSegmentId, playingTakeId]);

  const handleDeleteSegmentTake = useCallback((segmentId, takeId) => {
    if (playingTakeId === takeId) {
      stopCurrentPreview(audioPreviewRef);
      setPlayingTakeId(null);
      setPlayingSegmentId(null);
    }
    setSegments(prev => removeSegmentTakeInList(prev, segmentId, takeId));
  }, [playingTakeId]);

  const handleTogglePlayTake = useCallback((segmentId, takeId) => {
    const clearState = () => { setPlayingTakeId(null); setPlayingSegmentId(null); };
    if (playingTakeId === takeId) {
      stopCurrentPreview(audioPreviewRef);
      clearState();
      return;
    }
    const target = (segments || []).find(seg => seg.id === segmentId);
    const take = getSegmentTake(target, takeId);
    const url = resolveTakeAudioUrl(take);
    stopCurrentPreview(audioPreviewRef);
    if (!url) return warnMissingAudio(shared, clearState, 'No playable audio found for this take.');
    pauseMainAudioElement();
    const onError = createPlaybackNotifier(shared, logger, 'playTakeAudio', clearState);
    audioPreviewRef.current = playSegmentAudio(url, clearState, onError);
    if (audioPreviewRef.current) {
      setPlayingTakeId(takeId);
      setPlayingSegmentId(segmentId);
    }
  }, [playingTakeId, segments, shared, logger]);

  const handleCycleSegmentTake = useCallback((segmentId, direction = 1) => {
    if (playingSegmentId === segmentId) {
      stopCurrentPreview(audioPreviewRef);
      setPlayingSegmentId(null);
      setPlayingTakeId(null);
    }
    setSegments(prev => cycleSegmentTakeInList(prev, segmentId, direction));
  }, [playingSegmentId]);

  const hasTakesToRestitch = useMemo(() => (
    Array.isArray(segments) && segments.some(s => hasSegmentAudio(s))
  ), [segments]);

  const handleRestitchSegments = useCallback(async () => {
    const assetFetcher = assetRepository ? id => assetRepository.getAssetBinary(id) : null;
    await synthesis.restitchSegments({
      segments, character: activeCharacter, options, assetFetcher, projectTitle,
    });
  }, [segments, activeCharacter, options, assetRepository, synthesis, projectTitle]);

  const handleExportNarration = useCallback(async () => {
    const assetFetcher = assetRepository ? id => assetRepository.getAssetBinary(id) : null;
    await synthesis.exportNarration({
      segments, character: activeCharacter, options, assetFetcher, projectTitle,
    });
  }, [segments, activeCharacter, options, assetRepository, synthesis, projectTitle]);

  useEffect(() => () => {
    audioPreviewRef.current?.pause();
    audioPreviewRef.current = null;
    setPlayingSegmentId(null);
    setPlayingTakeId(null);
  }, []);
  useEffect(() => {
    onTtsStateChange?.({ busy: synthesis.busy, hasScript, libraryOpen: libraryModal.open });
  }, [synthesis.busy, hasScript, libraryModal.open, onTtsStateChange]);

  const handleRestoreDraft = useCallback(snapshot => {
    autosave.resetProject(snapshot?.id || '', snapshot?.revision || 1);
    applyProjectSnapshotToTts(snapshot, {
      setProjectId,
      setProjectTitle,
      setProjectRevision,
      setScript,
      setSegments,
      setOptions,
      allVoices: allVoicesRef.current,
      characterActions: characterActionsRef.current,
    });
    autosave.markDirty();
  }, [autosave]);

  const currentProjectSnapshot = useMemo(() => ({
    id: projectId,
    title: projectTitle,
    revision: projectRevision,
    segments,
    payload: { script, segments, ttsOptions: options, voiceId: activeCharacter.id },
  }), [projectId, projectTitle, projectRevision, script, segments, options, activeCharacter.id]);

  const recovery = useProjectRecovery({
    projectId,
    workspace: 'tts',
    currentProject: currentProjectSnapshot,
    onRestoreDraft: handleRestoreDraft,
    projectRepository,
    assetRepository,
    logger,
    onNotify: shared.onNotify,
  });

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
          setSegments,
          setOptions,
          allVoices: allVoicesRef.current,
          characterActions: characterActionsRef.current,
        });
        recovery.checkForDraft(snapshot);
        void recovery.verifyAssets(snapshot);
      },
      autosave,
    };
  }
  const count = countGraphemes(script);
  const isOverLimit = count > MAX_SCRIPT_LENGTH;
  const generateDisabled = synthesis.busy || Boolean(synthesis.regeneratingChunk) || !anchorApi.isLoaded || !hasScript || isOverLimit;
  const state = {
    scriptRef, transcriptRef, script, setScript,
    segments, setSegments, activeSegmentId, setActiveSegmentId,
    viewMode, setViewMode, handleScriptChange, handleUpdateSegment,
    handleAddSegment, handleDeleteSegment, handleReplaceScript,
    handleMoveSegmentUp, handleMoveSegmentDown, handleMergeSegment,
    handleSplitSegment, handleReorderSegments,
    handleGenerateSegment, handleTogglePlaySegment, playingSegmentId,
    handleSelectSegmentTake, handleDeleteSegmentTake, handleTogglePlayTake, playingTakeId,
    handleCycleSegmentTake,
    handleStopPreview: () => { stopCurrentPreview(audioPreviewRef); setPlayingSegmentId(null); setPlayingTakeId(null); },
    handleRestitchSegments, handleExportNarration, hasTakesToRestitch,
    options, setOptions, lockedSeeds, setLockedSeeds, library, anchorApi,
    charactersRef, libraryModal, setLibraryModal,
  };
  const ctrl = {
    logger, glossaryRepository, assetRepository, projectId,
    synthesis, activeCharacter, activeAnchor, actions: characterActions,
    count, isOverLimit, generateDisabled, autosave, recovery,
  };
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
      <div className="workspace-notices">
        {notices}
        <DraftRecoveryBanner
          visible={ctrl.recovery.showDraftBanner}
          timestamp={ctrl.recovery.recoveredDraft?.timestamp}
          onRestore={ctrl.recovery.restoreDraft}
          onDiscard={ctrl.recovery.discardDraft}
          workspace="tts"
        />
        <MissingAssetBanner
          visible={ctrl.recovery.showMissingAssetBanner}
          missingAssets={ctrl.recovery.missingAssets}
          onRelinkFile={ctrl.recovery.relinkAssetFile}
          onDismiss={ctrl.recovery.dismissMissingAssets}
          workspace="tts"
        />
      </div>
      <Toolbar busy={ctrl.synthesis.busy} generateDisabled={ctrl.generateDisabled}
        shortcut={isApplePlatform() ? '⌘ Enter' : 'Ctrl Enter'} onCancel={ctrl.synthesis.cancel}
        autosave={ctrl.autosave}
        offlineReadiness={shared?.offlineReadiness}
        onSelectModels={shared?.onSelectModels} />
      <TtsSpeechForm state={state} ctrl={ctrl} voiceActions={voiceActions}
        onOpenLibrary={() => state.setLibraryModal({ open: true, openForm: false })} />
      <AudioPlayer recording={ctrl.synthesis.recording} takes={ctrl.synthesis.takes}
        activeTakeId={ctrl.synthesis.activeTakeId} activeCharacter={ctrl.activeCharacter} activeAnchor={ctrl.activeAnchor}
        status={ctrl.synthesis.status} busyMeta={ctrl.synthesis.busyMeta} verification={verification}
        onSelectTake={ctrl.synthesis.selectTake} onDeleteTake={ctrl.synthesis.deleteTake}
        onPinTake={() => void ctrl.actions.handlePinCurrentTake(ctrl.synthesis.recording)}
        onAudioPlay={state.handleStopPreview}
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
