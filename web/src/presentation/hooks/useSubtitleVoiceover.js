/**
 * @fileoverview Presentation hook managing subtitle frame selection, inline/batch VoxCPM2 voice synthesis, playback, and WAV export.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SynthesisCancelledError, ValidationError } from '../../domain/errors.js';
import {
  DEFAULT_DUB_AUDIO_MODE,
  DEFAULT_TIME_ALIGNED_SUFFIX,
  SUBTITLE_VOICEOVER_PAUSE_MS,
  assembleTimelineAlignedVoiceover,
  buildCombinedVoiceoverBlob,
  buildDubDownloadFilename,
  buildDubExportClips,
  buildSubtitleSpeechSignature,
  buildSubtitleSynthesisCommand,
  buildTimeAlignedDubDownloadFilename,
  buildVoiceoverDownloadFilename,
  normalizeDubAudioMode,
  normalizeSubtitleVoiceoverGapMs,
  resolveSubtitleSpeechText,
  selectOrderedSegments,
} from '../../domain/subtitleTts.js';
import { BUILT_IN_VOICES, DEFAULT_CHARACTER_ID, findCharacterById } from '../../domain/voiceLibrary.js';
import { tryReadWavDurationSeconds } from '../../domain/wavCodec.js';
import { useStudioServices } from '../StudioContext.jsx';

function createBlobUrl(blob) {
  if (!blob || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return '';
  return URL.createObjectURL(blob);
}

function revokeBlobUrl(url) {
  if (url && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(url);
  }
}

function triggerFileDownload(blob, filename) {
  if (!blob || typeof document === 'undefined' || typeof URL === 'undefined') return;
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  globalThis.setTimeout?.(() => URL.revokeObjectURL(href), 1500);
}

function buildAnchorTag(anchor) {
  if (!anchor) return '';
  const sourceKey = anchor.takeId || anchor.fileName || anchor.source || 'pinned';
  return `${sourceKey}:${anchor.exactClone ? '1' : '0'}:${anchor.promptText || ''}`;
}

function buildClipRecord({ recording, text, character, signature }) {
  const durationSeconds = Number.isFinite(recording?.audioDurationSeconds) && recording.audioDurationSeconds > 0
    ? recording.audioDurationSeconds
    : null;
  return {
    blob: recording.blob,
    url: createBlobUrl(recording.blob),
    text,
    characterId: character.id,
    characterName: character.name,
    durationSeconds,
    signature,
    seed: recording.seed ?? null,
  };
}

function sumClipDurations(clips) {
  let total = 0;
  let hasAny = false;
  for (const clip of clips) {
    if (Number.isFinite(clip.durationSeconds) && clip.durationSeconds > 0) {
      total += clip.durationSeconds;
      hasAny = true;
    }
  }
  return hasAny ? total : null;
}

function collectCombinedTargetClips(segments, selectedIds, segmentClips) {
  const orderedSelected = selectOrderedSegments(segments, selectedIds);
  const selectedWithClips = orderedSelected.filter(seg => Boolean(segmentClips[seg.id]?.blob));
  if (selectedWithClips.length > 0) {
    return { scope: 'selected', matched: selectedWithClips };
  }
  const allWithClips = (segments || []).filter(seg => Boolean(segmentClips[seg.id]?.blob));
  return { scope: 'all', matched: allWithClips };
}

function resolveCombinedVoiceLabel(clips) {
  const names = [...new Set(clips.map(clip => clip.characterName).filter(Boolean))];
  if (names.length === 1) return names[0];
  return names.length > 1 ? `${names.length} voices` : '';
}

function isCancellationError(err) {
  return err instanceof SynthesisCancelledError || err?.name === 'SynthesisCancelledError' || err?.name === 'AbortError';
}

function handleVoiceError({ err, generatedCount, logger, onStatus, onNotify, onEngineFailure }) {
  if (isCancellationError(err)) {
    const note = generatedCount > 0
      ? `Voice generation cancelled (${generatedCount} frame${generatedCount === 1 ? '' : 's'} kept).`
      : 'Voice generation cancelled.';
    onStatus?.({ message: note, error: false });
    return;
  }
  const message = err?.message || 'Could not generate subtitle voice. Check VoxCPM2 engine.';
  logger?.error?.('useSubtitleVoiceover.generate', err, { generatedCount });
  onStatus?.({ message, error: true });
  onNotify?.({ kind: 'error', title: err instanceof ValidationError ? 'Check subtitle text' : 'Voice generation failed', message });
  if (!(err instanceof ValidationError)) onEngineFailure?.();
}

function useClipPlayback({ segmentClips, playingSegmentId, setPlayingSegmentId, logger }) {
  const audioRef = useRef(null);

  const stopPlayback = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause?.();
      audio.currentTime = 0;
    }
    setPlayingSegmentId('');
  }, [setPlayingSegmentId]);

  useEffect(() => () => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause?.();
      audio.src = '';
      audioRef.current = null;
    }
  }, []);

  const togglePlaySegment = useCallback(segId => {
    const clip = segmentClips[segId];
    if (!clip?.url || typeof Audio === 'undefined') return;
    if (playingSegmentId === segId) {
      stopPlayback();
      return;
    }
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.addEventListener?.('ended', () => setPlayingSegmentId(''));
      audioRef.current.addEventListener?.('error', () => setPlayingSegmentId(''));
    }
    const audio = audioRef.current;
    audio.pause?.();
    audio.src = clip.url;
    setPlayingSegmentId(segId);
    const playPromise = audio.play?.();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(err => {
        logger?.debug?.('useSubtitleVoiceover.play', err?.message || 'Playback interrupted');
        setPlayingSegmentId('');
      });
    }
  }, [segmentClips, playingSegmentId, setPlayingSegmentId, stopPlayback, logger]);

  return { togglePlaySegment, stopPlayback };
}

function useCombinedVoiceoverState({ segments, selectedIds, segmentClips, pauseGapMs, logger }) {
  const [combinedClip, setCombinedClip] = useState(null);
  const combinedUrlRef = useRef('');
  const seqRef = useRef(0);

  const replaceCombined = useCallback(next => {
    revokeBlobUrl(combinedUrlRef.current);
    combinedUrlRef.current = next?.url || '';
    setCombinedClip(next);
  }, []);

  useEffect(() => () => {
    revokeBlobUrl(combinedUrlRef.current);
    combinedUrlRef.current = '';
  }, []);

  useEffect(() => {
    const seq = ++seqRef.current;
    const { scope, matched } = collectCombinedTargetClips(segments, selectedIds, segmentClips);
    if (!matched.length) {
      replaceCombined(null);
      return;
    }
    const clips = matched.map(seg => segmentClips[seg.id]);
    const blobs = clips.map(clip => clip.blob);
    void buildCombinedVoiceoverBlob(blobs, pauseGapMs)
      .then(async blob => {
        if (seq !== seqRef.current || !blob) return;
        const measuredDuration = typeof blob.arrayBuffer === 'function'
          ? tryReadWavDurationSeconds(await blob.arrayBuffer())
          : 0;
        if (seq !== seqRef.current) return;
        replaceCombined({
          blob,
          url: createBlobUrl(blob),
          count: clips.length,
          scope,
          pauseGapMs,
          segmentIds: matched.map(seg => seg.id),
          durationSeconds: measuredDuration > 0 ? measuredDuration : sumClipDurations(clips),
          characterName: resolveCombinedVoiceLabel(clips),
        });
      })
      .catch(err => {
        if (seq !== seqRef.current) return;
        logger?.warn?.('useSubtitleVoiceover.combine', err?.message || 'Could not combine WAV clips');
        replaceCombined(null);
      });
  }, [segments, selectedIds, segmentClips, pauseGapMs, replaceCombined, logger]);

  return { combinedClip, clearCombined: () => replaceCombined(null) };
}

async function runTrackAlignment({ matched, segmentClips, totalDuration, audioMaster, scope, clips }) {
  const targetIds = matched.map(seg => seg.id);
  const res = await assembleTimelineAlignedVoiceover({
    segments: matched,
    segmentClips,
    totalDuration,
    audioMaster,
    selectedIds: scope === 'selected' ? targetIds : null,
  });
  if (!res?.blob) return null;
  return {
    blob: res.blob,
    count: res.clipCount,
    scope,
    durationSeconds: res.duration,
    warnings: res.warnings || [],
    segmentIds: targetIds,
    characterName: resolveCombinedVoiceLabel(clips),
  };
}

function useAlignedVoiceoverState({ segments, selectedIds, segmentClips, totalDuration, audioMaster, logger }) {
  const [alignedClip, setAlignedClip] = useState(null);
  const urlRef = useRef('');
  const seqRef = useRef(0);
  const replace = useCallback(next => {
    revokeBlobUrl(urlRef.current);
    urlRef.current = next?.url || '';
    setAlignedClip(next);
  }, []);
  useEffect(() => () => { revokeBlobUrl(urlRef.current); urlRef.current = ''; }, []);
  useEffect(() => {
    const seq = ++seqRef.current;
    const { scope, matched } = collectCombinedTargetClips(segments, selectedIds, segmentClips);
    if (!matched.length) { replace(null); return; }
    const clips = matched.map(seg => segmentClips[seg.id]);
    runTrackAlignment({ matched, segmentClips, totalDuration, audioMaster, scope, clips })
      .then(res => {
        if (seq !== seqRef.current || !res) return;
        replace({ ...res, url: createBlobUrl(res.blob) });
      })
      .catch(err => {
        if (seq !== seqRef.current) return;
        logger?.warn?.('useSubtitleVoiceover.align', err?.message || 'Could not align WAV');
        replace(null);
      });
  }, [segments, selectedIds, segmentClips, totalDuration, audioMaster, replace, logger]);
  return { alignedClip, clearAligned: () => replace(null) };
}

function useVoiceSelectionState(segments) {
  const [selectedIds, setSelectedIds] = useState([]);

  useEffect(() => {
    const validIds = new Set((segments || []).map(seg => seg.id));
    setSelectedIds(prev => {
      const next = prev.filter(id => validIds.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [segments]);

  const toggleSelectSegment = useCallback(segId => {
    setSelectedIds(prev => (prev.includes(segId) ? prev.filter(id => id !== segId) : [...prev, segId]));
  }, []);

  const toggleSelectAll = useCallback(() => {
    const allIds = (segments || []).map(seg => seg.id);
    setSelectedIds(prev => (prev.length === allIds.length && allIds.length > 0 ? [] : allIds));
  }, [segments]);

  const clearSelection = useCallback(() => setSelectedIds([]), []);
  return { selectedIds, toggleSelectSegment, toggleSelectAll, clearSelection };
}

async function synthesizeOneFrame({ synthesizeSpeech, text, character, anchor, cachedUpload, seed, signal, onReferenceUploaded }) {
  const command = buildSubtitleSynthesisCommand({ text, character, anchor, cachedUpload, seed });
  return synthesizeSpeech.execute({ ...command, signal, onReferenceUploaded });
}

function useVoiceSynthesisActions(ctx) {
  const {
    synthesizeSpeech, logger, segments, selectedIds, useTranslation, activeCharacter, activeAnchor,
    anchorTag, lockedSeeds, segmentClipsRef, cachedUploadsRef, abortRef,
    setBusy, setGeneratingSegmentId, setBatchProgress, storeClip, onStatus, onNotify, onUnlockSound, onEngineFailure,
  } = ctx;

  const cancelVoiceGeneration = useCallback(() => { abortRef.current?.abort(); }, [abortRef]);

  const runVoiceJob = useCallback(async ({ initialSegId, initialMsg, execute }) => {
    if (abortRef.current || !synthesizeSpeech?.execute) return;
    onUnlockSound?.();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setGeneratingSegmentId(initialSegId);
    onStatus?.({ message: initialMsg, error: false });
    let generatedCount = 0;
    try {
      generatedCount = await execute(controller.signal);
    } catch (err) {
      handleVoiceError({ err, generatedCount, logger, onStatus, onNotify, onEngineFailure });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
      setGeneratingSegmentId('');
      setBatchProgress(null);
    }
  }, [abortRef, synthesizeSpeech, onUnlockSound, setBusy, setGeneratingSegmentId, setBatchProgress, logger, onStatus, onNotify, onEngineFailure]);

  const generateSegmentVoice = useCallback(async segment => {
    const text = resolveSubtitleSpeechText(segment, useTranslation);
    if (!text) {
      const msg = 'Add subtitle text to this frame before generating voice.';
      onStatus?.({ message: msg, error: true });
      onNotify?.({ kind: 'error', title: 'Empty subtitle frame', message: msg });
      return;
    }
    await runVoiceJob({
      initialSegId: segment.id,
      initialMsg: `Generating voice (${activeCharacter.name})…`,
      execute: async signal => {
        const res = await synthesizeOneFrame({
          synthesizeSpeech, text, character: activeCharacter, anchor: activeAnchor,
          cachedUpload: cachedUploadsRef.current[activeCharacter.id] || null,
          seed: lockedSeeds?.[activeCharacter.id] ?? '',
          signal,
          onReferenceUploaded: fileData => { cachedUploadsRef.current[activeCharacter.id] = fileData; },
        });
        const signature = buildSubtitleSpeechSignature({ text, characterId: activeCharacter.id, anchorTag });
        storeClip(segment.id, buildClipRecord({ recording: res.recording, text, character: activeCharacter, signature }));
        const doneMsg = `Voice ready for frame (${activeCharacter.name}).`;
        onStatus?.({ message: doneMsg, error: false });
        onNotify?.({ kind: 'success', title: 'Subtitle voice ready', message: doneMsg });
        return 1;
      },
    });
  }, [useTranslation, activeCharacter, activeAnchor, anchorTag, lockedSeeds, cachedUploadsRef, synthesizeSpeech, runVoiceJob, storeClip, onStatus, onNotify]);

  const generateSelectedVoices = useCallback(async () => {
    const targets = selectOrderedSegments(segments, selectedIds)
      .map(seg => ({ seg, text: resolveSubtitleSpeechText(seg, useTranslation) }))
      .filter(item => Boolean(item.text));
    if (!targets.length) {
      const msg = 'Select at least one non-empty subtitle frame first.';
      onStatus?.({ message: msg, error: true });
      onNotify?.({ kind: 'error', title: 'No frames selected', message: msg });
      return;
    }
    await runVoiceJob({
      initialSegId: targets[0].seg.id,
      initialMsg: `Generating voice 1 of ${targets.length} (${activeCharacter.name})…`,
      execute: async signal => {
        let done = 0;
        let sessionAnchor = activeAnchor;
        let sessionUpload = cachedUploadsRef.current[activeCharacter.id] || null;
        for (let i = 0; i < targets.length; i++) {
          if (signal.aborted) throw new SynthesisCancelledError();
          const { seg, text } = targets[i];
          const signature = buildSubtitleSpeechSignature({ text, characterId: activeCharacter.id, anchorTag });
          if (segmentClipsRef.current[seg.id]?.signature === signature) {
            done += 1;
            continue;
          }
          setGeneratingSegmentId(seg.id);
          setBatchProgress({ completed: i, total: targets.length, currentSegmentId: seg.id });
          onStatus?.({ message: `Generating voice ${i + 1} of ${targets.length} (${activeCharacter.name})…`, error: false });
          const res = await synthesizeOneFrame({
            synthesizeSpeech, text, character: activeCharacter, anchor: sessionAnchor,
            cachedUpload: sessionUpload, seed: lockedSeeds?.[activeCharacter.id] ?? '', signal,
            onReferenceUploaded: fileData => {
              sessionUpload = fileData;
              if (activeAnchor) cachedUploadsRef.current[activeCharacter.id] = fileData;
            },
          });
          if (!sessionAnchor && res.recording?.anchorBlob) {
            sessionAnchor = { characterId: activeCharacter.id, blob: res.recording.anchorBlob, exactClone: false };
            sessionUpload = res.uploadedFileData || sessionUpload;
          }
          storeClip(seg.id, buildClipRecord({ recording: res.recording, text, character: activeCharacter, signature }));
          done += 1;
        }
        const summary = `Voice ready for ${targets.length} selected ${targets.length === 1 ? 'frame' : 'frames'} (${activeCharacter.name}).`;
        onStatus?.({ message: summary, error: false });
        onNotify?.({ kind: 'success', title: 'Selected voiceover ready', message: summary });
        return done;
      },
    });
  }, [segments, selectedIds, useTranslation, activeCharacter, activeAnchor, anchorTag, lockedSeeds, segmentClipsRef, cachedUploadsRef, synthesizeSpeech, runVoiceJob, setGeneratingSegmentId, setBatchProgress, storeClip, onStatus, onNotify]);

  return { generateSegmentVoice, generateSelectedVoices, cancelVoiceGeneration };
}

function useDubExportAction({
  mediaSubtitleGateway, logger, jobId, isAudioOnly, videoFile,
  segments, selectedIds, segmentClips, dubAudioMode, abortRef,
  dubBusy, voiceBusy, setDubBusy, onStatus, onNotify, onUnlockSound,
}) {
  return useCallback(async () => {
    if (dubBusy || voiceBusy || abortRef.current || !jobId || isAudioOnly || !mediaSubtitleGateway?.exportDubbedVideo) return;
    const clips = buildDubExportClips(segments, selectedIds, segmentClips);
    if (!clips.length) return;
    onUnlockSound?.();
    const controller = new AbortController();
    abortRef.current = controller;
    setDubBusy(true);
    const clipWord = clips.length === 1 ? 'clip' : 'clips';
    onStatus?.({ message: `Exporting dubbed MP4 (${clips.length} ${clipWord})…`, error: false });
    try {
      const mp4Blob = await mediaSubtitleGateway.exportDubbedVideo({
        jobId,
        clips,
        originalAudioMode: dubAudioMode,
        signal: controller.signal,
      });
      triggerFileDownload(mp4Blob, buildDubDownloadFilename(videoFile));
      const doneMsg = `Dubbed MP4 exported (${clips.length} ${clipWord}).`;
      onStatus?.({ message: doneMsg, error: false });
      onNotify?.({ kind: 'success', title: 'Dubbed MP4 exported', message: doneMsg });
    } catch (err) {
      if (isCancellationError(err)) {
        onStatus?.({ message: 'Dubbed video export cancelled.', error: false });
        return;
      }
      const message = err?.message || 'Could not export dubbed MP4. Check that the media service is running.';
      logger?.error?.('useSubtitleVoiceover.exportDubbedVideo', err, { jobId, clipCount: clips.length, dubAudioMode });
      onStatus?.({ message, error: true });
      onNotify?.({ kind: 'error', title: 'Dubbed MP4 export failed', message });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setDubBusy(false);
    }
  }, [mediaSubtitleGateway, logger, jobId, isAudioOnly, videoFile, segments, selectedIds, segmentClips, dubAudioMode, abortRef, dubBusy, voiceBusy, setDubBusy, onStatus, onNotify, onUnlockSound]);
}

/**
 * Coordinates per-frame and multi-selected subtitle Text-to-Speech synthesis, inline audio playback, combined WAV downloads, and time-aligned dubbed MP4 export.
 * Inputs: `{ segments, useTranslation, videoFile, jobId, isAudioOnly, voiceCatalog, onStatus, onNotify, onUnlockSound, onEngineFailure }`.
 * Outputs: selection state, character state, per-frame clip map, combined voiceover clip, playback, synthesis, and dub export handlers.
 * Side effects: invokes `services.synthesizeSpeech` and `services.mediaSubtitleGateway.exportDubbedVideo`, plays browser audio, and manages/revokes `blob:` URLs.
 * Failure modes: surfaces validation, cancellation, and engine errors cleanly via status/toasts without discarding prior clips.
 * @param {object} config - Hook configuration.
 * @returns {object} Subtitle voiceover controller.
 */
export function useSubtitleVoiceover({
  segments = [],
  useTranslation = false,
  videoFile = null,
  jobId = '',
  isAudioOnly = false,
  voiceCatalog = null,
  mediaDuration = 0,
  totalDuration = 0,
  onStatus,
  onNotify,
  onUnlockSound,
  onEngineFailure,
} = {}) {
  const { synthesizeSpeech, mediaSubtitleGateway, audioMaster, logger } = useStudioServices();
  const characters = useMemo(
    () => (voiceCatalog?.characters?.length ? voiceCatalog.characters : BUILT_IN_VOICES),
    [voiceCatalog?.characters]
  );
  const anchors = voiceCatalog?.anchors || {};
  const lockedSeeds = voiceCatalog?.lockedSeeds || {};
  const [selectedVoiceId, setSelectedVoiceId] = useState(
    () => voiceCatalog?.defaultCharacterId || DEFAULT_CHARACTER_ID
  );
  const activeCharacter = useMemo(() => findCharacterById(characters, selectedVoiceId), [characters, selectedVoiceId]);
  const activeAnchor = anchors[activeCharacter.id] || null;
  const anchorTag = buildAnchorTag(activeAnchor);
  const effectiveTotalDuration = totalDuration || mediaDuration || 0;

  const [segmentClips, setSegmentClips] = useState({});
  const [pauseGapMs, setPauseGapMsState] = useState(SUBTITLE_VOICEOVER_PAUSE_MS);
  const [dubAudioMode, setDubAudioModeState] = useState(DEFAULT_DUB_AUDIO_MODE);
  const [dubBusy, setDubBusy] = useState(false);
  const [playingSegmentId, setPlayingSegmentId] = useState('');
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [generatingSegmentId, setGeneratingSegmentId] = useState('');
  const [batchProgress, setBatchProgress] = useState(null);

  const setPauseGapMs = useCallback(rawMs => {
    setPauseGapMsState(normalizeSubtitleVoiceoverGapMs(rawMs));
  }, []);

  const setDubAudioMode = useCallback(rawMode => {
    setDubAudioModeState(normalizeDubAudioMode(rawMode));
  }, []);

  const segmentClipsRef = useRef(segmentClips);
  segmentClipsRef.current = segmentClips;
  const clipUrlsRef = useRef(new Map());
  const cachedUploadsRef = useRef({});
  const abortRef = useRef(null);

  const { selectedIds, toggleSelectSegment, toggleSelectAll, clearSelection } = useVoiceSelectionState(segments);
  const { togglePlaySegment, stopPlayback } = useClipPlayback({ segmentClips, playingSegmentId, setPlayingSegmentId, logger });
  const { combinedClip, clearCombined } = useCombinedVoiceoverState({ segments, selectedIds, segmentClips, pauseGapMs, logger });
  const { alignedClip, clearAligned } = useAlignedVoiceoverState({
    segments,
    selectedIds,
    segmentClips,
    totalDuration: effectiveTotalDuration,
    audioMaster,
    logger,
  });

  const storeClip = useCallback((segId, clip) => {
    const prevUrl = clipUrlsRef.current.get(segId);
    if (prevUrl) revokeBlobUrl(prevUrl);
    clipUrlsRef.current.set(segId, clip.url);
    setSegmentClips(prev => ({ ...prev, [segId]: clip }));
  }, []);

  const removeSegmentClip = useCallback(segId => {
    if (playingSegmentId === segId) stopPlayback();
    const prevUrl = clipUrlsRef.current.get(segId);
    if (prevUrl) {
      revokeBlobUrl(prevUrl);
      clipUrlsRef.current.delete(segId);
    }
    setSegmentClips(prev => {
      if (!(segId in prev)) return prev;
      const { [segId]: _removed, ...rest } = prev;
      return rest;
    });
  }, [playingSegmentId, stopPlayback]);

  const resetVoiceover = useCallback(() => {
    abortRef.current?.abort();
    stopPlayback();
    clearSelection();
    clearCombined();
    clearAligned();
    for (const url of clipUrlsRef.current.values()) revokeBlobUrl(url);
    clipUrlsRef.current.clear();
    setSegmentClips({});
  }, [stopPlayback, clearSelection, clearCombined, clearAligned]);

  useEffect(() => {
    const validIds = new Set((segments || []).map(seg => seg.id));
    setSegmentClips(prev => {
      let changed = false;
      const next = {};
      for (const [id, clip] of Object.entries(prev)) {
        if (validIds.has(id)) {
          next[id] = clip;
        } else {
          changed = true;
          revokeBlobUrl(clipUrlsRef.current.get(id));
          clipUrlsRef.current.delete(id);
        }
      }
      return changed ? next : prev;
    });
  }, [segments]);

  useEffect(() => () => {
    abortRef.current?.abort();
    for (const url of clipUrlsRef.current.values()) revokeBlobUrl(url);
    clipUrlsRef.current.clear();
  }, []);

  const synthesis = useVoiceSynthesisActions({
    synthesizeSpeech, logger, segments, selectedIds, useTranslation, activeCharacter, activeAnchor,
    anchorTag, lockedSeeds, segmentClipsRef, cachedUploadsRef, abortRef,
    setBusy: setVoiceBusy, setGeneratingSegmentId, setBatchProgress, storeClip,
    onStatus, onNotify, onUnlockSound, onEngineFailure,
  });

  const exportDubbedVideo = useDubExportAction({
    mediaSubtitleGateway, logger, jobId, isAudioOnly, videoFile,
    segments, selectedIds, segmentClips, dubAudioMode, abortRef,
    dubBusy, voiceBusy, setDubBusy, onStatus, onNotify, onUnlockSound,
  });

  const canExportDub = Boolean(jobId && !isAudioOnly && combinedClip?.count > 0 && mediaSubtitleGateway?.exportDubbedVideo);

  const downloadSegmentVoice = useCallback((segment, index) => {
    const clip = segmentClips[segment?.id];
    if (!clip?.blob) return;
    const tag = String((index ?? 0) + 1).padStart(2, '0');
    triggerFileDownload(clip.blob, buildVoiceoverDownloadFilename(videoFile, `-frame-${tag}`));
  }, [segmentClips, videoFile]);

  const downloadCombinedVoice = useCallback(() => {
    if (!combinedClip?.blob) return;
    const suffix = combinedClip.scope === 'selected' ? '-selected-voiceover' : '-voiceover';
    triggerFileDownload(combinedClip.blob, buildVoiceoverDownloadFilename(videoFile, suffix));
  }, [combinedClip, videoFile]);

  const downloadAlignedVoice = useCallback(() => {
    if (!alignedClip?.blob) return;
    const suffix = alignedClip.scope === 'selected' ? '-selected-aligned-dub' : DEFAULT_TIME_ALIGNED_SUFFIX;
    triggerFileDownload(alignedClip.blob, buildTimeAlignedDubDownloadFilename(videoFile, suffix));
  }, [alignedClip, videoFile]);

  const isClipStale = useCallback(segment => {
    const clip = segmentClips[segment?.id];
    if (!clip) return false;
    const text = resolveSubtitleSpeechText(segment, useTranslation);
    const expected = buildSubtitleSpeechSignature({ text, characterId: activeCharacter.id, anchorTag });
    return clip.signature !== expected;
  }, [segmentClips, useTranslation, activeCharacter.id, anchorTag]);

  return {
    characters,
    anchors,
    selectedVoiceId: activeCharacter.id,
    setSelectedVoiceId,
    pauseGapMs,
    setPauseGapMs,
    dubAudioMode,
    setDubAudioMode,
    dubBusy,
    canExportDub,
    exportDubbedVideo,
    activeCharacter,
    selectedIds,
    selectedCount: selectedIds.length,
    allSelected: segments.length > 0 && selectedIds.length === segments.length,
    toggleSelectSegment,
    toggleSelectAll,
    clearSelection,
    segmentClips,
    combinedClip,
    alignedClip,
    playingSegmentId,
    voiceBusy,
    generatingSegmentId,
    batchProgress,
    isClipStale,
    togglePlaySegment,
    stopPlayback,
    removeSegmentClip,
    resetVoiceover,
    downloadSegmentVoice,
    downloadCombinedVoice,
    downloadAlignedVoice,
    ...synthesis,
  };
}
