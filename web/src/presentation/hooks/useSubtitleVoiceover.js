/**
 * @fileoverview Presentation hook managing subtitle frame selection, inline/batch VoxCPM2 voice synthesis, playback, and WAV export.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MIN_SPILL_CUE_DURATION_SEC,
  assertNoUnresolvedDurationMismatches,
  createSpillApproval,
  detectDurationMismatches,
  isSpillApprovalValid,
  trimClipWavToInterval,
} from '../../domain/durationMismatch.js';
import { SynthesisCancelledError, ValidationError } from '../../domain/errors.js';
import {
  DEFAULT_DUB_MIX_SETTINGS,
  DEFAULT_DUB_SUBTITLE_MODE,
  EXPORT_PRESET_IDS,
  VIDEO_AUDIO_MODES,
  VIDEO_SUBTITLE_MODES,
  assertVideoAudioMode,
  assertVideoSubtitleMode,
  clampDubMixField,
  formatPresetFilename,
  hasCustomDubMixSettings,
  normalizeDubMixSettings,
  normalizeVideoAudioMode,
  normalizeVideoSubtitleMode,
  resolveDubVideoCodec,
  validateDubMixSettings,
} from '../../domain/exportPresets.js';
import { resolveLanguageDisplayMeta } from '../../domain/subtitleLanguages.js';
import { pickSegmentText } from '../../domain/subtitles.js';
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
  extractActiveSubtitleTakeSpec,
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

async function resolveRecordingDuration(recording) {
  if (Number.isFinite(recording?.audioDurationSeconds) && recording.audioDurationSeconds > 0) {
    return recording.audioDurationSeconds;
  }
  if (recording?.blob && typeof recording.blob.arrayBuffer === 'function') {
    const measured = tryReadWavDurationSeconds(await recording.blob.arrayBuffer());
    return measured > 0 ? measured : null;
  }
  return null;
}

function buildClipRecord({ recording, text, character, signature, durationSeconds = null }) {
  const effectiveDur = Number.isFinite(durationSeconds) && durationSeconds > 0
    ? durationSeconds
    : (Number.isFinite(recording?.audioDurationSeconds) && recording.audioDurationSeconds > 0 ? recording.audioDurationSeconds : null);
  return {
    blob: recording.blob,
    url: createBlobUrl(recording.blob),
    text,
    characterId: character.id,
    characterName: character.name,
    durationSeconds: effectiveDur,
    signature,
    seed: recording.seed ?? null,
    preTrimClip: null,
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

async function runTrackAlignment({ segments, matched, segmentClips, totalDuration, audioMaster, scope, clips, spillApprovals, logger }) {
  const targetIds = matched.map(seg => seg.id);
  const res = await assembleTimelineAlignedVoiceover({
    segments,
    segmentClips,
    totalDuration,
    audioMaster,
    selectedIds: scope === 'selected' ? targetIds : null,
    spillApprovals,
    logger,
  });
  if (!res?.blob) return null;
  return {
    blob: res.blob,
    count: res.clipCount,
    scope,
    durationSeconds: res.duration,
    warnings: res.warnings || [],
    mismatches: res.mismatches || [],
    segmentIds: targetIds,
    characterName: resolveCombinedVoiceLabel(clips),
  };
}

function useAlignedVoiceoverState({ segments, selectedIds, segmentClips, totalDuration, audioMaster, spillApprovals, logger }) {
  const [alignedClip, setAlignedClip] = useState(null);
  const urlRef = useRef('');
  const seqRef = useRef(0);
  const settledSeqRef = useRef(0);
  const replace = useCallback(next => {
    revokeBlobUrl(urlRef.current);
    urlRef.current = next?.url || '';
    setAlignedClip(next);
  }, []);
  useEffect(() => () => { revokeBlobUrl(urlRef.current); urlRef.current = ''; }, []);
  useEffect(() => {
    const seq = ++seqRef.current;
    const { scope, matched } = collectCombinedTargetClips(segments, selectedIds, segmentClips);
    if (!matched.length) { settledSeqRef.current = seq; replace(null); return; }
    const clips = matched.map(seg => segmentClips[seg.id]);
    runTrackAlignment({ segments, matched, segmentClips, totalDuration, audioMaster, scope, clips, spillApprovals, logger })
      .then(res => {
        if (seq !== seqRef.current) return;
        settledSeqRef.current = seq;
        if (res) replace({ ...res, url: createBlobUrl(res.blob) });
      })
      .catch(err => {
        if (seq !== seqRef.current) return;
        settledSeqRef.current = seq;
        logger?.warn?.('useSubtitleVoiceover.align', err?.message || 'Could not align WAV');
        replace(null);
      });
  }, [segments, selectedIds, segmentClips, totalDuration, audioMaster, spillApprovals, replace, logger]);
  const isAlignmentSettled = () => settledSeqRef.current === seqRef.current;
  return { alignedClip, isAlignmentSettled, clearAligned: () => replace(null) };
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

async function synthesizeOneFrame({ synthesizeSpeech, text, character, anchor, cachedUpload, seed, terminology, speechLanguage, signal, onReferenceUploaded }) {
  const command = buildSubtitleSynthesisCommand({
    text,
    character,
    anchor,
    cachedUpload,
    seed,
    terminology,
    sourceLanguage: speechLanguage,
  });
  return synthesizeSpeech.execute({ ...command, signal, onReferenceUploaded });
}

async function persistGeneratedSubtitleFrame({ assetRepository, recording, segId, text, character, signature, durationSeconds, projectId, onAttachSegmentTake, logger }) {
  const { outputAssetId } = await uploadSubtitleFrameAsset({
    assetRepository, recording, segId, idx: 0, projectId, logger,
  });
  if (outputAssetId) {
    onAttachSegmentTake?.(segId, {
      takeId: recording?.id || null,
      audioAssetId: outputAssetId,
      text,
      characterId: character.id,
      characterName: character.name,
      signature,
      durationSeconds,
      seed: recording?.seed ?? null,
    });
  }
  return outputAssetId;
}

async function resolveSynthesizedClipRecord(ctx) {
  const { res, seg, text, activeCharacter, signature, assetRepository, projectId, onAttachSegmentTake, logger } = ctx;
  const durationSeconds = await resolveRecordingDuration(res.recording);
  const outputAssetId = await persistGeneratedSubtitleFrame({
    assetRepository, recording: res.recording, segId: seg.id, text, character: activeCharacter,
    signature, durationSeconds, projectId, onAttachSegmentTake, logger,
  });
  const record = buildClipRecord({
    recording: res.recording, text, character: activeCharacter, signature, durationSeconds,
  });
  return outputAssetId ? { ...record, audioAssetId: outputAssetId } : record;
}

function useVoiceSynthesisActions(ctx) {
  const {
    synthesizeSpeech, logger, segments, selectedIds, useTranslation, activeCharacter, activeAnchor,
    anchorTag, lockedSeeds, segmentClipsRef, cachedUploadsRef, abortRef,
    terminology, pronunciationSignature, speechLanguage,
    assetRepository, projectId, onAttachSegmentTake,
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
          terminology, speechLanguage, signal,
          onReferenceUploaded: fileData => { cachedUploadsRef.current[activeCharacter.id] = fileData; },
        });
        const signature = buildSubtitleSpeechSignature({
          text, characterId: activeCharacter.id, anchorTag, pronunciationTag: pronunciationSignature,
        });
        const clipRecord = await resolveSynthesizedClipRecord({
          res, seg: segment, text, activeCharacter, signature, assetRepository, projectId, onAttachSegmentTake, logger,
        });
        storeClip(segment.id, clipRecord);
        const doneMsg = `Voice ready for frame (${activeCharacter.name}).`;
        onStatus?.({ message: doneMsg, error: false });
        onNotify?.({ kind: 'success', title: 'Subtitle voice ready', message: doneMsg });
        return 1;
      },
    });
  }, [useTranslation, activeCharacter, activeAnchor, anchorTag, lockedSeeds, terminology, pronunciationSignature, speechLanguage, cachedUploadsRef, synthesizeSpeech, runVoiceJob, storeClip, assetRepository, projectId, onAttachSegmentTake, logger, onStatus, onNotify]);

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
          const signature = buildSubtitleSpeechSignature({
            text, characterId: activeCharacter.id, anchorTag, pronunciationTag: pronunciationSignature,
          });
          if (segmentClipsRef.current[seg.id]?.signature === signature) {
            done += 1;
            continue;
          }
          setGeneratingSegmentId(seg.id);
          setBatchProgress({ completed: i, total: targets.length, currentSegmentId: seg.id });
          onStatus?.({ message: `Generating voice ${i + 1} of ${targets.length} (${activeCharacter.name})…`, error: false });
          const res = await synthesizeOneFrame({
            synthesizeSpeech, text, character: activeCharacter, anchor: sessionAnchor,
            cachedUpload: sessionUpload, seed: lockedSeeds?.[activeCharacter.id] ?? '',
            terminology, speechLanguage, signal,
            onReferenceUploaded: fileData => {
              sessionUpload = fileData;
              if (activeAnchor) cachedUploadsRef.current[activeCharacter.id] = fileData;
            },
          });
          if (!sessionAnchor && res.recording?.anchorBlob) {
            sessionAnchor = { characterId: activeCharacter.id, blob: res.recording.anchorBlob, exactClone: false };
            sessionUpload = res.uploadedFileData || sessionUpload;
          }
          const clipRecord = await resolveSynthesizedClipRecord({
            res, seg, text, activeCharacter, signature, assetRepository, projectId, onAttachSegmentTake, logger,
          });
          storeClip(seg.id, clipRecord);
          done += 1;
        }
        const summary = `Voice ready for ${targets.length} selected ${targets.length === 1 ? 'frame' : 'frames'} (${activeCharacter.name}).`;
        onStatus?.({ message: summary, error: false });
        onNotify?.({ kind: 'success', title: 'Selected voiceover ready', message: summary });
        return done;
      },
    });
  }, [segments, selectedIds, useTranslation, activeCharacter, activeAnchor, anchorTag, lockedSeeds, terminology, pronunciationSignature, speechLanguage, segmentClipsRef, cachedUploadsRef, synthesizeSpeech, runVoiceJob, setGeneratingSegmentId, setBatchProgress, storeClip, assetRepository, projectId, onAttachSegmentTake, logger, onStatus, onNotify]);

  return { generateSegmentVoice, generateSelectedVoices, cancelVoiceGeneration };
}

function blockIfDurationMismatched({ exportMismatchReport, onStatus, onNotify, throwOnError = false }) {
  if (!exportMismatchReport?.hasUnresolved) return false;
  try {
    assertNoUnresolvedDurationMismatches(exportMismatchReport);
  } catch (err) {
    const message = err?.message || 'Resolve speech duration mismatches before exporting.';
    onStatus?.({ message, error: true });
    onNotify?.({ kind: 'error', title: 'Resolve duration mismatches', message });
    if (throwOnError) throw err;
    return true;
  }
  return false;
}

function useMismatchControls({ segments, segmentClipsRef, setSpillApprovals, mediaDuration, storeClip, assetRepository, projectId, onAttachSegmentTake, onStatus, onNotify, logger }) {
  const approveSegmentSpill = useCallback(segId => {
    const idx = (segments || []).findIndex(seg => seg.id === segId);
    const segment = idx >= 0 ? segments[idx] : null;
    const clip = segmentClipsRef.current[segId];
    if (!segment || !clip) return false;
    const approval = createSpillApproval(segment, clip);
    const nextSeg = idx < segments.length - 1 ? segments[idx + 1] : null;
    if (!isSpillApprovalValid(approval, { segment, clip, nextSegment: nextSeg, mediaDuration })) {
      const cueSpan = (Number(segment.end) || 0) - Math.max(0, Number(segment.start) || 0);
      const msg = cueSpan < MIN_SPILL_CUE_DURATION_SEC
        ? `Cannot allow spill: extend Cue #${idx + 1} to at least ${MIN_SPILL_CUE_DURATION_SEC.toFixed(2)}s first.`
        : 'Cannot allow spill: speech collides with the next cue or video end.';
      onStatus?.({ message: msg, error: true });
      onNotify?.({ kind: 'error', title: 'Spill blocked', message: msg });
      return false;
    }
    setSpillApprovals(prev => ({ ...prev, [segId]: approval }));
    onStatus?.({ message: `Allowed speech spill for Cue #${idx + 1} into trailing pause.`, error: false });
    return true;
  }, [segments, segmentClipsRef, setSpillApprovals, mediaDuration, onStatus, onNotify]);

  const revokeSegmentSpill = useCallback(segId => {
    setSpillApprovals(prev => {
      if (!(segId in prev)) return prev;
      const { [segId]: _removed, ...rest } = prev;
      return rest;
    });
  }, [setSpillApprovals]);

  const trimSegmentClipToInterval = useCallback(async (segId, targetDurationSec = null) => {
    const idx = (segments || []).findIndex(item => item.id === segId);
    const clip = segmentClipsRef.current[segId];
    if (idx < 0 || !clip?.blob) return false;
    const cueDur = resolveSafeTrimSeconds(segments, idx, mediaDuration, targetDurationSec);
    try {
      const res = await trimClipWavToInterval(clip.blob, cueDur);
      const preTrimClip = clip.preTrimClip || {
        blob: clip.blob, durationSeconds: clip.durationSeconds, audioAssetId: clip.audioAssetId || null,
      };
      const { outputAssetId } = await uploadSubtitleFrameAsset({
        assetRepository, recording: { blob: res.blob }, segId, idx, projectId, logger,
      });
      if (outputAssetId) {
        onAttachSegmentTake?.(segId, {
          audioAssetId: outputAssetId, text: clip.text, characterId: clip.characterId,
          characterName: clip.characterName, signature: clip.signature, durationSeconds: res.durationSeconds,
          seed: clip.seed ?? null, preTrimAssetId: preTrimClip.audioAssetId || null,
          preTrimDuration: preTrimClip.durationSeconds ?? null,
        });
      }
      storeClip(segId, {
        ...clip, blob: res.blob, url: createBlobUrl(res.blob), durationSeconds: res.durationSeconds,
        preTrimClip, ...(outputAssetId ? { audioAssetId: outputAssetId } : {}),
      });
      const msg = `Trimmed audio clip to ${res.durationSeconds.toFixed(2)}s.`;
      onStatus?.({ message: msg, error: false });
      onNotify?.({ kind: 'success', title: 'Audio trimmed to fit', message: msg });
      return true;
    } catch (err) {
      const message = err?.message || 'Could not trim audio clip.';
      logger?.error?.('useSubtitleVoiceover.trimClip', err, { segId, cueDur });
      onStatus?.({ message, error: true });
      onNotify?.({ kind: 'error', title: 'Audio trim failed', message });
      return false;
    }
  }, [segments, segmentClipsRef, mediaDuration, storeClip, assetRepository, projectId, onAttachSegmentTake, onStatus, onNotify, logger]);

  const undoTrimSegmentClip = useCallback(segId => {
    const clip = segmentClipsRef.current[segId];
    if (!clip?.preTrimClip?.blob) return false;
    const prevAssetId = clip.preTrimClip.audioAssetId || null;
    if (prevAssetId) {
      onAttachSegmentTake?.(segId, {
        audioAssetId: prevAssetId, text: clip.text, characterId: clip.characterId,
        characterName: clip.characterName, signature: clip.signature,
        durationSeconds: clip.preTrimClip.durationSeconds, seed: clip.seed ?? null,
      });
    }
    storeClip(segId, {
      ...clip,
      blob: clip.preTrimClip.blob,
      url: createBlobUrl(clip.preTrimClip.blob),
      durationSeconds: clip.preTrimClip.durationSeconds,
      audioAssetId: prevAssetId,
      preTrimClip: null,
    });
    onStatus?.({ message: 'Restored original untrimmed clip audio.', error: false });
    return true;
  }, [segmentClipsRef, storeClip, onAttachSegmentTake, onStatus]);

  return { approveSegmentSpill, revokeSegmentSpill, trimSegmentClipToInterval, undoTrimSegmentClip };
}

function resolveSafeTrimSeconds(segments, idx, mediaDuration, targetDurationSec) {
  if (Number.isFinite(targetDurationSec) && targetDurationSec > 0) return targetDurationSec;
  const seg = segments[idx];
  const start = Math.max(0, Number(seg.start) || 0);
  const cueDur = Math.max(0, (Number(seg.end) || 0) - start);
  const nextSeg = idx < segments.length - 1 ? segments[idx + 1] : null;
  const nextCap = nextSeg ? Math.max(0, (Number(nextSeg.start) || 0) - start) : Infinity;
  const mediaCap = Number.isFinite(mediaDuration) && mediaDuration > 0 ? Math.max(0, mediaDuration - start) : Infinity;
  return Math.min(cueDur, nextCap, mediaCap);
}

function resolveDubFilenameForModes(videoFile, audioMode, subtitleMode) {
  if (audioMode !== VIDEO_AUDIO_MODES.ORIGINAL && subtitleMode === VIDEO_SUBTITLE_MODES.NONE) {
    return buildDubDownloadFilename(videoFile);
  }
  const suffix = audioMode === VIDEO_AUDIO_MODES.ORIGINAL
    ? (subtitleMode === VIDEO_SUBTITLE_MODES.BURNED ? '-subtitled.mp4' : (subtitleMode === VIDEO_SUBTITLE_MODES.SOFT ? '-captioned.mp4' : '-original.mp4'))
    : (subtitleMode === VIDEO_SUBTITLE_MODES.BURNED ? '-dubbed-subtitled.mp4' : '-dubbed-captioned.mp4');
  return formatPresetFilename(EXPORT_PRESET_IDS.VIDEO_DUBBED_MP4, {
    videoFileName: videoFile?.name || '',
    suffixOverride: suffix,
  });
}

function buildValidatedDubSubtitlesPayload({ subtitleMode, segments, subtitleContext, overrides, burnInSupported }) {
  if (subtitleMode === VIDEO_SUBTITLE_MODES.NONE) return null;
  if (subtitleMode === VIDEO_SUBTITLE_MODES.BURNED && burnInSupported === false) {
    throw new ValidationError('Installed FFmpeg lacks libass support for burning captions.', 'subtitleMode', 'BURNIN_UNSUPPORTED');
  }
  const subCtx = { ...(subtitleContext || {}), ...(overrides?.subtitleOptions || {}) };
  const useTrans = Boolean(subCtx.useTranslation);
  const biling = Boolean(subCtx.bilingual);
  const renderedCues = segments.filter(seg => Boolean(pickSegmentText(seg, useTrans, biling)));
  if (!renderedCues.length) {
    throw new ValidationError('Add or transcribe at least one subtitle cue before exporting video subtitles.', 'segments', 'EMPTY_SUBTITLES');
  }
  if (renderedCues.some(seg => !(Number(seg?.end) > Number(seg?.start)) || Number(seg?.start) < 0)) {
    throw new ValidationError('Subtitle cues must have positive duration (0 <= start < end) before exporting video subtitles.', 'segments', 'INVALID_SUBTITLE_TIMING');
  }
  if (!subCtx.hasTranslation && (useTrans || biling) && !segments.some(seg => Boolean(seg?.translatedText?.trim()))) {
    throw new ValidationError('Translate at least one subtitle cue before exporting translated or bilingual video subtitles.', 'languageMode', 'MISSING_TRANSLATION_CUES');
  }
  return {
    segments,
    speakerNames: subCtx.speakerNames || {},
    includeSpeaker: Boolean(subCtx.includeSpeaker),
    useTranslation: useTrans,
    bilingual: biling,
    ...(subCtx.subtitleStyle ? { subtitleStyle: subCtx.subtitleStyle } : {}),
    ...(subCtx.videoSize ? { videoSize: subCtx.videoSize } : {}),
    ...(subCtx.subtitleLanguage ? { subtitleLanguage: String(subCtx.subtitleLanguage) } : {}),
  };
}

function prepareValidatedDubExportRequest(ctx, overrides) {
  const mode = assertVideoAudioMode(overrides?.originalAudioMode ?? ctx.dubAudioMode);
  const subMode = assertVideoSubtitleMode(overrides?.subtitleMode ?? ctx.dubSubtitleMode);
  const mix = validateDubMixSettings(overrides?.mixSettings ?? ctx.dubMixSettings);
  if (mode !== VIDEO_AUDIO_MODES.REPLACE && ctx.hasAudioStream === false) {
    throw new ValidationError(
      'Source video has no original audio track; select Replacement dubbing (mute original) instead.',
      'audioMode',
      'MISSING_ORIGINAL_AUDIO'
    );
  }
  const subtitles = buildValidatedDubSubtitlesPayload({
    subtitleMode: subMode,
    segments: ctx.segments,
    subtitleContext: ctx.subtitleContext,
    overrides,
    burnInSupported: ctx.burnInSupported,
  });
  if (mode === VIDEO_AUDIO_MODES.ORIGINAL) {
    const rawSrcLang = String(overrides?.sourceAudioLanguage ?? overrides?.audioLanguage ?? ctx.sourceLanguage ?? '').trim();
    return { mode, subMode, mix, subtitles, clips: [], cleanLang: rawSrcLang && rawSrcLang !== 'auto' ? rawSrcLang : '' };
  }
  if (ctx.exportMismatchReport?.hasUnresolved) assertNoUnresolvedDurationMismatches(ctx.exportMismatchReport);
  const clips = buildDubExportClips(ctx.segments, ctx.selectedIds, ctx.segmentClips, {
    spillApprovals: ctx.spillApprovals, mediaDuration: ctx.mediaDuration,
  });
  if (!clips.length) throw new ValidationError('No valid voice clips match the subtitle timeline.', 'clips', 'NO_DUB_CLIPS');
  const rawLang = String(overrides?.audioLanguage ?? ctx.audioLanguage ?? '').trim();
  return { mode, subMode, mix, subtitles, clips, cleanLang: rawLang && rawLang !== 'auto' ? rawLang : '' };
}

function useDubExportAction(ctx) {
  return useCallback(async (overrides = null) => {
    const throwOnError = Boolean(overrides?.throwOnError);
    if (ctx.dubBusy || ctx.voiceBusy || ctx.abortRef.current) {
      if (throwOnError) throw new Error('Another voice or dubbing export is already running.');
      return;
    }
    if (!ctx.jobId || ctx.isAudioOnly || !ctx.mediaSubtitleGateway?.exportDubbedVideo) {
      if (throwOnError) throw new Error('Dubbed MP4 export requires a loaded video on the media server.');
      return;
    }
    let req;
    try {
      req = prepareValidatedDubExportRequest(ctx, overrides);
    } catch (err) {
      const msg = err?.message || 'Invalid video dubbing export configuration.';
      ctx.onStatus?.({ message: msg, error: true });
      ctx.onNotify?.({ kind: 'error', title: err?.code === 'DURATION_MISMATCH' ? 'Resolve duration mismatches' : 'Video export blocked', message: msg });
      if (throwOnError) throw err;
      return;
    }
    ctx.onUnlockSound?.();
    const controller = new AbortController();
    ctx.abortRef.current = controller;
    ctx.setDubBusy(true);
    const clipWord = req.clips.length === 1 ? 'clip' : 'clips';
    const progressLabel = req.mode === VIDEO_AUDIO_MODES.ORIGINAL ? 'original audio' : `${req.clips.length} ${clipWord}`;
    ctx.onStatus?.({ message: `Exporting MP4 (${progressLabel})…`, error: false });
    try {
      const mp4Blob = await ctx.mediaSubtitleGateway.exportDubbedVideo({
        jobId: ctx.jobId,
        clips: req.clips,
        originalAudioMode: req.mode,
        ...(req.cleanLang ? { audioLanguage: req.cleanLang } : {}),
        ...(hasCustomDubMixSettings(req.mix) ? { mixSettings: req.mix } : {}),
        ...(req.subMode !== VIDEO_SUBTITLE_MODES.NONE ? { subtitleMode: req.subMode, subtitles: req.subtitles } : {}),
        signal: controller.signal,
      });
      const filename = overrides?.filename || resolveDubFilenameForModes(ctx.videoFile, req.mode, req.subMode);
      triggerFileDownload(mp4Blob, filename);
      const langMeta = resolveLanguageDisplayMeta(req.cleanLang);
      const maxEnd = ctx.segments.reduce((m, s) => Math.max(m, Number(s?.end) || 0), 0);
      ctx.onExportRecorded?.(EXPORT_PRESET_IDS.VIDEO_DUBBED_MP4, {
        filename,
        codec: resolveDubVideoCodec(req.subMode),
        durationSeconds: Number(ctx.mediaDuration) || maxEnd || null,
        languageCode: langMeta.bcp47,
        languageLabel: langMeta.label,
        audioMode: req.mode,
        subtitleMode: req.subMode,
      });
      const doneMsg = req.mode === VIDEO_AUDIO_MODES.ORIGINAL ? 'Video MP4 exported (original audio).' : `Dubbed MP4 exported (${req.clips.length} ${clipWord}).`;
      ctx.onStatus?.({ message: doneMsg, error: false });
      ctx.onNotify?.({ kind: 'success', title: 'MP4 exported', message: doneMsg });
    } catch (err) {
      if (isCancellationError(err)) {
        ctx.onStatus?.({ message: 'Dubbed video export cancelled.', error: false });
        return;
      }
      if (err?.status === 404) ctx.onMediaJobExpired?.();
      const message = err?.message || 'Could not export dubbed MP4. Check that the media service is running.';
      ctx.logger?.error?.('useSubtitleVoiceover.exportDubbedVideo', err, { jobId: ctx.jobId, clipCount: req.clips.length, dubAudioMode: req.mode, dubSubtitleMode: req.subMode });
      ctx.onStatus?.({ message, error: true });
      ctx.onNotify?.({ kind: 'error', title: 'Dubbed MP4 export failed', message });
      if (throwOnError) throw err;
    } finally {
      if (ctx.abortRef.current === controller) ctx.abortRef.current = null;
      ctx.setDubBusy(false);
    }
  }, [ctx]);
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
function buildSubtitleJobItems({ targets, activeCharacter, anchorTag, pronunciationSignature, existingClips }) {
  const items = [];
  const artifacts = [];
  for (let i = 0; i < targets.length; i += 1) {
    const { seg, text } = targets[i];
    const sig = buildSubtitleSpeechSignature({ text, characterId: activeCharacter.id, anchorTag, pronunciationTag: pronunciationSignature });
    const existing = existingClips?.[seg.id];
    const isReady = Boolean(existing?.signature === sig && existing?.blob);
    const assetId = isReady ? (existing.audioAssetId || null) : null;
    items.push({
      itemId: seg.id,
      segmentId: seg.id,
      label: `Frame #${i + 1}`,
      status: isReady ? 'completed' : 'pending',
      inputSignature: sig,
      outputAssetId: assetId,
      metadata: { text, voiceId: activeCharacter.id, signature: sig },
    });
    if (isReady && assetId) {
      artifacts.push({ itemId: seg.id, segmentId: seg.id, assetId, kind: 'audio', fileName: `frame-${String(i + 1).padStart(2, '0')}.wav`, mimeType: 'audio/wav', durationSeconds: existing.durationSeconds ?? null, signature: sig });
    }
  }
  return { items, artifacts };
}

async function uploadSubtitleFrameAsset({ assetRepository, recording, segId, idx, projectId, logger }) {
  if (!assetRepository?.uploadAsset || !recording?.blob) return { outputAssetId: null, artifact: null };
  const fileName = `frame-${String(idx + 1).padStart(2, '0')}.wav`;
  try {
    const uploaded = await assetRepository.uploadAsset({
      bytes: recording.blob,
      fileName,
      kind: 'audio',
      mimeType: recording.blob.type || 'audio/wav',
      projectId: projectId || undefined,
    });
    const assetId = uploaded?.asset?.id || null;
    if (!assetId) return { outputAssetId: null, artifact: null };
    return {
      outputAssetId: assetId,
      artifact: { itemId: segId, segmentId: segId, assetId, takeId: recording.id || null, kind: 'audio', fileName, mimeType: recording.blob.type || 'audio/wav', sizeBytes: recording.blob.size || 0 },
    };
  } catch (err) {
    logger?.warn?.('useSubtitleVoiceover.uploadSubtitleFrameAsset', err?.message || 'Could not persist subtitle frame audio asset');
    return { outputAssetId: null, artifact: null };
  }
}

function syncTrackedJobUi(productionJobs, job) {
  if (job && productionJobs?.syncJob) productionJobs.syncJob(job);
  else if (productionJobs?.refreshJobs) void productionJobs.refreshJobs();
}

async function startTrackedSubtitleJob({ jobRepository, spec, workerSessionId, productionJobs, logger }) {
  if (!jobRepository?.enqueueJob) return null;
  let createdId = null;
  try {
    const { job: created } = await jobRepository.enqueueJob(spec);
    createdId = created.id;
    await jobRepository.updateJob(created.id, { action: 'prepare', workerSessionId });
    const started = (await jobRepository.updateJob(created.id, { action: 'start', workerSessionId }))?.job;
    syncTrackedJobUi(productionJobs, started || created);
    return created.id;
  } catch (err) {
    logger?.error?.('useSubtitleVoiceover.startTrackedSubtitleJob', err, { type: spec?.type, createdId });
    if (createdId && jobRepository?.cancelJob) {
      await jobRepository.cancelJob(createdId, { finalize: true }).catch(cleanupErr => {
        logger?.warn?.('useSubtitleVoiceover.cleanupOrphanedJob', cleanupErr?.message || 'Could not cancel partially created job', { createdId });
      });
    }
    return null;
  }
}

async function finalizeTrackedSubtitleJob({ jobRepository, jobId, outcome, err, productionJobs, logger }) {
  if (!jobRepository || !jobId) return;
  let finalJob = null;
  try {
    if (outcome === 'completed') finalJob = (await jobRepository.updateJob(jobId, { action: 'complete' }))?.job;
    else if (outcome === 'interrupted') {
      finalJob = (await jobRepository.interruptJob(jobId, {
        reason: 'Interrupted before completion. Retry to resume remaining frames.',
      }))?.job;
    } else if (outcome === 'cancelled') finalJob = (await jobRepository.cancelJob(jobId, { finalize: true }))?.job;
    else finalJob = (await jobRepository.updateJob(jobId, { action: 'fail', code: err?.code || 'VOICEOVER_ERROR', message: err?.message || 'Subtitle voiceover failed.' }))?.job;
  } catch (updateErr) {
    logger?.error?.('useSubtitleVoiceover.finalizeTrackedSubtitleJob', updateErr, { jobId, outcome });
  } finally {
    syncTrackedJobUi(productionJobs, finalJob);
  }
}

const SUBTITLE_JOB_HEARTBEAT_MS = 10_000;

async function assertSubtitleJobNotCancelled({ jobRepository, jobId, signal, logger }) {
  if (signal?.aborted) throw new SynthesisCancelledError();
  if (!jobRepository || !jobId) return;
  const res = await jobRepository.getJob(jobId).catch(err => {
    logger?.debug?.('useSubtitleVoiceover.assertSubtitleJobNotCancelled', err?.message || 'Could not poll job status', { jobId });
    return null;
  });
  const status = (res?.job ?? res)?.status;
  if (status === 'cancel_requested' || status === 'cancelled') throw new SynthesisCancelledError();
}

function startSubtitleJobHeartbeat({ jobRepository, jobId, workerSessionId, controller, userCancelledRef, productionJobs, logger }) {
  if (!jobRepository?.updateJob || !jobId) return undefined;
  const timer = globalThis.setInterval?.(() => {
    void jobRepository.updateJob(jobId, { action: 'heartbeat', workerSessionId })
      .then(res => {
        const latest = res?.job;
        if (!latest) return;
        syncTrackedJobUi(productionJobs, latest);
        if (latest.status === 'cancel_requested' || latest.status === 'cancelled') {
          if (userCancelledRef) userCancelledRef.current = true;
          controller?.abort();
        }
      })
      .catch(err => {
        logger?.debug?.('useSubtitleVoiceover.heartbeat', err?.message || 'Heartbeat skipped', { jobId });
      });
  }, SUBTITLE_JOB_HEARTBEAT_MS);
  timer?.unref?.();
  return timer;
}

function createTrackedSubtitleSpec({ targets, projectTitle, videoFile, projectId, activeCharacter, items, artifacts, lockedSeeds, terminology, speechLanguage }) {
  return {
    type: 'subtitle_voiceover',
    title: `${projectTitle || videoFile?.name || 'Subtitle Voiceover'} (${targets.length} frames)`,
    projectId: projectId || null,
    projectTitle: projectTitle || videoFile?.name || '',
    items,
    artifacts,
    metadata: {
      sourceWorkspace: 'subtitles',
      voiceId: activeCharacter.id,
      seed: lockedSeeds?.[activeCharacter.id] ?? '',
      terminology,
      speechLanguage,
    },
  };
}

async function processTrackedSubtitleTarget(ctx) {
  const { target, idx, total, trackedJobId, workerSessionId, signal, session } = ctx;
  const { seg, text } = target;
  const sig = buildSubtitleSpeechSignature({
    text, characterId: ctx.activeCharacter.id, anchorTag: ctx.anchorTag, pronunciationTag: ctx.pronunciationSignature,
  });
  const existing = ctx.segmentClipsRef.current[seg.id];
  if (existing?.signature === sig && existing?.blob) {
    ctx.setBatchProgress({ completed: idx + 1, total, currentSegmentId: seg.id });
    if (trackedJobId && !existing.audioAssetId) {
      const { outputAssetId, artifact } = await uploadSubtitleFrameAsset({
        assetRepository: ctx.assetRepository,
        recording: { blob: existing.blob, id: existing.takeId || null },
        segId: seg.id,
        idx,
        projectId: ctx.projectId,
        logger: ctx.logger,
      });
      if (outputAssetId) {
        ctx.storeClip(seg.id, { ...existing, audioAssetId: outputAssetId });
        ctx.onAttachSegmentTake?.(seg.id, {
          takeId: existing.takeId || null,
          audioAssetId: outputAssetId,
          text,
          characterId: ctx.activeCharacter.id,
          characterName: ctx.activeCharacter.name,
          signature: sig,
          durationSeconds: existing.durationSeconds ?? null,
          seed: existing.seed ?? null,
        });
      }
      const updated = (await ctx.jobRepository.updateJob(trackedJobId, {
        action: 'item_complete',
        itemId: seg.id,
        outputAssetId,
        durationSeconds: existing.durationSeconds ?? null,
        artifact: artifact ? { ...artifact, durationSeconds: existing.durationSeconds ?? null, signature: sig } : undefined,
      }).catch(err => {
        ctx.logger?.debug?.('useSubtitleVoiceover.syncCachedItem', err?.message || 'Could not update cached item', { trackedJobId, segId: seg.id });
        return null;
      }))?.job;
      if (updated) syncTrackedJobUi(ctx.productionJobs, updated);
    }
    return;
  }
  ctx.setGeneratingSegmentId(seg.id);
  ctx.setBatchProgress({ completed: idx, total, currentSegmentId: seg.id });
  ctx.onStatus?.({ message: `Generating voice ${idx + 1} of ${total} (${ctx.activeCharacter.name})…`, error: false });
  if (trackedJobId) {
    await ctx.jobRepository.updateJob(trackedJobId, { action: 'item_start', itemId: seg.id, workerSessionId }).catch(err => {
      ctx.logger?.debug?.('useSubtitleVoiceover.itemStart', err?.message || 'Could not mark item running', { trackedJobId, segId: seg.id });
    });
  }
  const res = await synthesizeOneFrame({
    synthesizeSpeech: ctx.synthesizeSpeech, text, character: ctx.activeCharacter, anchor: session.anchor,
    cachedUpload: session.upload, seed: ctx.seed, terminology: ctx.terminology, speechLanguage: ctx.speechLanguage, signal,
    onReferenceUploaded: fileData => {
      session.upload = fileData;
      if (ctx.activeAnchor) ctx.cachedUploadsRef.current[ctx.activeCharacter.id] = fileData;
    },
  });
  if (!session.anchor && res.recording?.anchorBlob) {
    session.anchor = { characterId: ctx.activeCharacter.id, blob: res.recording.anchorBlob, exactClone: false };
    session.upload = res.uploadedFileData || session.upload;
  }
  if (signal?.aborted) throw new SynthesisCancelledError();
  const durationSeconds = await resolveRecordingDuration(res.recording);
  const { outputAssetId, artifact } = await uploadSubtitleFrameAsset({
    assetRepository: ctx.assetRepository, recording: res.recording, segId: seg.id, idx, projectId: ctx.projectId, logger: ctx.logger,
  });
  ctx.storeClip(seg.id, {
    ...buildClipRecord({ recording: res.recording, text, character: ctx.activeCharacter, signature: sig, durationSeconds }),
    ...(outputAssetId ? { audioAssetId: outputAssetId } : {}),
  });
  if (outputAssetId) {
    ctx.onAttachSegmentTake?.(seg.id, {
      takeId: res.recording?.id || null,
      audioAssetId: outputAssetId,
      text,
      characterId: ctx.activeCharacter.id,
      characterName: ctx.activeCharacter.name,
      signature: sig,
      durationSeconds,
      seed: res.recording?.seed ?? null,
    });
  }
  if (trackedJobId) {
    const updated = (await ctx.jobRepository.updateJob(trackedJobId, {
      action: 'item_complete', itemId: seg.id, outputAssetId, takeId: res.recording?.id || null, durationSeconds, seed: res.recording?.seed ?? null,
      artifact: artifact ? { ...artifact, durationSeconds, signature: sig } : undefined,
    }).catch(err => {
      ctx.logger?.warn?.('useSubtitleVoiceover.itemComplete', err?.message || 'Could not record completed frame', { trackedJobId, segId: seg.id });
      return null;
    }))?.job;
    if (updated) syncTrackedJobUi(ctx.productionJobs, updated);
  }
}

async function fetchOptionalPreTrimClip(assetRepository, spec, logger) {
  if (!spec.preTrimAssetId) return null;
  const rawPre = await assetRepository.getAssetBinary(spec.preTrimAssetId).catch(err => {
    logger?.debug?.('useSubtitleVoiceover.hydratePreTrim', err?.message || 'Pre-trim clip unavailable', { preTrimAssetId: spec.preTrimAssetId });
    return null;
  });
  if (!rawPre?.bytes) return null;
  return {
    blob: new Blob([rawPre.bytes], { type: rawPre.mimeType || 'audio/wav' }),
    durationSeconds: spec.preTrimDuration,
    audioAssetId: spec.preTrimAssetId,
  };
}

async function buildHydratedSubtitleClip({ seg, spec, assetRepository, characters, anchorTag, pronunciationSignature, logger }) {
  const fetched = await assetRepository.getAssetBinary(spec.audioAssetId);
  if (!fetched?.bytes) return null;
  const blob = new Blob([fetched.bytes], { type: fetched.mimeType || 'audio/wav' });
  const durationSeconds = await resolveRecordingDuration({ blob, audioDurationSeconds: spec.durationSeconds });
  const character = findCharacterById(characters, spec.characterId);
  const text = spec.text || seg.translatedText || seg.text || '';
  const signature = spec.signature || buildSubtitleSpeechSignature({
    text, characterId: character.id, anchorTag, pronunciationTag: pronunciationSignature,
  });
  const preTrimClip = await fetchOptionalPreTrimClip(assetRepository, spec, logger);
  return {
    ...buildClipRecord({ recording: { blob, seed: spec.seed, audioDurationSeconds: durationSeconds }, text, character, signature, durationSeconds }),
    takeId: spec.takeId || null,
    audioAssetId: spec.audioAssetId,
    preTrimClip,
  };
}

function hydrateSingleSegmentTake({ inFlightRef, segmentsRef, segmentClipsRef, assetRepository, characters, anchorTag, pronunciationSignature, mountedRef, storeHydratedClip, logger, isCancelled }, seg, spec) {
  const cacheKey = `${seg.id}:${spec.audioAssetId}`;
  if (inFlightRef.current.has(cacheKey)) return;
  inFlightRef.current.add(cacheKey);
  void buildHydratedSubtitleClip({ seg, spec, assetRepository, characters, anchorTag, pronunciationSignature, logger })
    .then(clip => {
      if (isCancelled() || !mountedRef.current || !clip) return;
      const liveSeg = (segmentsRef.current || []).find(item => item?.id === seg.id);
      const liveSpec = extractActiveSubtitleTakeSpec(liveSeg);
      if (!liveSpec || liveSpec.audioAssetId !== spec.audioAssetId) return;
      if (segmentClipsRef.current[seg.id]?.audioAssetId === spec.audioAssetId) return;
      storeHydratedClip(seg.id, clip);
    })
    .catch(err => logger?.warn?.('useSubtitleVoiceover.hydratePersistedTake', err?.message || 'Could not restore take audio', { segId: seg.id, audioAssetId: spec.audioAssetId }))
    .finally(() => { inFlightRef.current.delete(cacheKey); });
}

function useHydratePersistedSubtitleTakes(opts) {
  const { segments, segmentsRef, segmentClipsRef, assetRepository, characters, anchorTag, pronunciationSignature, generatingSegmentId, mountedRef, storeHydratedClip, logger } = opts;
  const inFlightRef = useRef(new Set());
  useEffect(() => {
    if (!assetRepository?.getAssetBinary || !Array.isArray(segments) || segments.length === 0) return undefined;
    let cancelled = false;
    const ctx = { inFlightRef, segmentsRef, segmentClipsRef, assetRepository, characters, anchorTag, pronunciationSignature, mountedRef, storeHydratedClip, logger, isCancelled: () => cancelled };
    for (const seg of segments) {
      const spec = extractActiveSubtitleTakeSpec(seg);
      if (!spec?.audioAssetId || generatingSegmentId === seg.id) continue;
      if (segmentClipsRef.current[seg.id]?.audioAssetId === spec.audioAssetId) continue;
      hydrateSingleSegmentTake(ctx, seg, spec);
    }
    return () => { cancelled = true; };
  }, [segments, segmentsRef, segmentClipsRef, assetRepository, characters, anchorTag, pronunciationSignature, generatingSegmentId, mountedRef, storeHydratedClip, logger]);
}

export function useSubtitleVoiceover({
  segments = [],
  useTranslation = false,
  videoFile = null,
  videoFileName = '',
  jobId = '',
  isAudioOnly = false,
  hasAudioStream = true,
  burnInSupported = true,
  voiceCatalog = null,
  mediaDuration = 0,
  totalDuration = 0,
  transcriptEpoch = 0,
  terminology = null,
  pronunciationSignature = '',
  sourceLanguage = '',
  speechLanguage = '',
  audioLanguage = '',
  subtitleContext = null,
  dubAudioModeProp = undefined,
  onChangeDubAudioMode = null,
  dubSubtitleModeProp = undefined,
  onChangeDubSubtitleMode = null,
  dubMixSettingsProp = undefined,
  onChangeDubMixSettings = null,
  selectedVoiceIdProp = undefined,
  onChangeSelectedVoiceId = null,
  pauseGapMsProp = undefined,
  onChangePauseGapMs = null,
  spillApprovalsProp = undefined,
  onChangeSpillApprovals = null,
  onAttachSegmentTake = null,
  onClearSegmentTakes = null,
  projectId = '',
  projectTitle = '',
  productionJobs = null,
  onStatus,
  onNotify,
  onUnlockSound,
  onEngineFailure,
  onMediaJobExpired = null,
  onExportRecorded = null,
} = {}) {
  const effectiveNameSource = useMemo(() => {
    if (videoFile?.name) return videoFile;
    if (videoFileName) return { name: videoFileName };
    if (projectTitle) return { name: projectTitle };
    return null;
  }, [videoFile, videoFileName, projectTitle]);
  const { synthesizeSpeech, mediaSubtitleGateway, audioMaster, logger, jobRepository = null, assetRepository = null } = useStudioServices();
  const characters = useMemo(
    () => (voiceCatalog?.characters?.length ? voiceCatalog.characters : BUILT_IN_VOICES),
    [voiceCatalog?.characters]
  );
  const anchors = voiceCatalog?.anchors || {};
  const lockedSeeds = voiceCatalog?.lockedSeeds || {};
  const [selectedVoiceIdState, setSelectedVoiceIdState] = useState(
    () => voiceCatalog?.defaultCharacterId || DEFAULT_CHARACTER_ID
  );
  const selectedVoiceId = selectedVoiceIdProp ? findCharacterById(characters, selectedVoiceIdProp).id : selectedVoiceIdState;
  const activeCharacter = useMemo(() => findCharacterById(characters, selectedVoiceId), [characters, selectedVoiceId]);
  const activeAnchor = anchors[activeCharacter.id] || null;
  const anchorTag = buildAnchorTag(activeAnchor);
  const effectiveTotalDuration = totalDuration || mediaDuration || 0;

  const [segmentClips, setSegmentClips] = useState({});
  const [spillApprovalsState, setSpillApprovalsState] = useState({});
  const [pauseGapMsState, setPauseGapMsState] = useState(SUBTITLE_VOICEOVER_PAUSE_MS);
  const [dubAudioModeState, setDubAudioModeState] = useState(() => normalizeVideoAudioMode(dubAudioModeProp, DEFAULT_DUB_AUDIO_MODE));
  const [dubSubtitleModeState, setDubSubtitleModeState] = useState(() => normalizeVideoSubtitleMode(dubSubtitleModeProp, DEFAULT_DUB_SUBTITLE_MODE));
  const [dubMixSettingsState, setDubMixSettingsState] = useState(() => normalizeDubMixSettings(dubMixSettingsProp));
  const [dubBusy, setDubBusy] = useState(false);
  const [playingSegmentId, setPlayingSegmentId] = useState('');
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [generatingSegmentId, setGeneratingSegmentId] = useState('');
  const [batchProgress, setBatchProgress] = useState(null);

  const dubAudioMode = dubAudioModeProp !== undefined ? normalizeVideoAudioMode(dubAudioModeProp, dubAudioModeState) : dubAudioModeState;
  const dubSubtitleMode = dubSubtitleModeProp !== undefined ? normalizeVideoSubtitleMode(dubSubtitleModeProp, dubSubtitleModeState) : dubSubtitleModeState;
  const dubMixSettings = useMemo(
    () => (dubMixSettingsProp !== undefined ? normalizeDubMixSettings(dubMixSettingsProp) : dubMixSettingsState),
    [dubMixSettingsProp, dubMixSettingsState]
  );
  const pauseGapMs = pauseGapMsProp !== undefined ? normalizeSubtitleVoiceoverGapMs(pauseGapMsProp) : pauseGapMsState;
  const spillApprovals = spillApprovalsProp !== undefined ? spillApprovalsProp : spillApprovalsState;
  const spillApprovalsRef = useRef(spillApprovals);
  spillApprovalsRef.current = spillApprovals;

  const setSelectedVoiceId = useCallback(rawId => {
    setSelectedVoiceIdState(rawId);
    onChangeSelectedVoiceId?.(rawId);
  }, [onChangeSelectedVoiceId]);

  const setPauseGapMs = useCallback(rawMs => {
    const next = normalizeSubtitleVoiceoverGapMs(rawMs);
    setPauseGapMsState(next);
    onChangePauseGapMs?.(next);
  }, [onChangePauseGapMs]);

  const setSpillApprovals = useCallback(updater => {
    const base = spillApprovalsRef.current || {};
    const next = typeof updater === 'function' ? updater(base) : (updater || {});
    if (next === base) return;
    setSpillApprovalsState(next);
    onChangeSpillApprovals?.(next);
  }, [onChangeSpillApprovals]);

  const setDubAudioMode = useCallback(rawMode => {
    const next = normalizeVideoAudioMode(rawMode);
    setDubAudioModeState(next);
    onChangeDubAudioMode?.(next);
  }, [onChangeDubAudioMode]);

  const setDubSubtitleMode = useCallback(rawMode => {
    const next = normalizeVideoSubtitleMode(rawMode);
    setDubSubtitleModeState(next);
    onChangeDubSubtitleMode?.(next);
  }, [onChangeDubSubtitleMode]);

  const updateDubMixSetting = useCallback((field, rawValue) => {
    setDubMixSettingsState(prev => {
      const base = dubMixSettingsProp !== undefined ? normalizeDubMixSettings(dubMixSettingsProp) : prev;
      const next = Object.freeze({ ...base, [field]: clampDubMixField(field, rawValue) });
      onChangeDubMixSettings?.(next);
      return next;
    });
  }, [dubMixSettingsProp, onChangeDubMixSettings]);

  const resetDubMixSettings = useCallback(() => {
    setDubMixSettingsState(DEFAULT_DUB_MIX_SETTINGS);
    onChangeDubMixSettings?.(DEFAULT_DUB_MIX_SETTINGS);
  }, [onChangeDubMixSettings]);

  const segmentClipsRef = useRef(segmentClips);
  segmentClipsRef.current = segmentClips;
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  const clipUrlsRef = useRef(new Map());
  const cachedUploadsRef = useRef({});
  const abortRef = useRef(null);
  const mountedRef = useRef(true);
  const userCancelledRef = useRef(false);

  const { selectedIds, toggleSelectSegment, toggleSelectAll, clearSelection } = useVoiceSelectionState(segments);
  const { togglePlaySegment, stopPlayback } = useClipPlayback({ segmentClips, playingSegmentId, setPlayingSegmentId, logger });
  const { combinedClip, clearCombined } = useCombinedVoiceoverState({ segments, selectedIds, segmentClips, pauseGapMs, logger });
  const { alignedClip, isAlignmentSettled, clearAligned } = useAlignedVoiceoverState({
    segments,
    selectedIds,
    segmentClips,
    totalDuration: effectiveTotalDuration,
    spillApprovals,
    audioMaster,
    logger,
  });

  const storeHydratedClip = useCallback((segId, clip) => {
    const prevUrl = clipUrlsRef.current.get(segId);
    if (prevUrl) revokeBlobUrl(prevUrl);
    clipUrlsRef.current.set(segId, clip.url);
    setSegmentClips(prev => ({ ...prev, [segId]: clip }));
  }, []);

  const storeClip = useCallback((segId, clip) => {
    storeHydratedClip(segId, clip);
    setSpillApprovals(prev => {
      if (!(segId in prev)) return prev;
      const { [segId]: _removed, ...rest } = prev;
      return rest;
    });
  }, [storeHydratedClip, setSpillApprovals]);

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
    setSpillApprovals(prev => {
      if (!(segId in prev)) return prev;
      const { [segId]: _removed, ...rest } = prev;
      return rest;
    });
    onClearSegmentTakes?.(segId);
  }, [playingSegmentId, stopPlayback, setSpillApprovals, onClearSegmentTakes]);

  const clearInMemoryVoiceover = useCallback(() => {
    abortRef.current?.abort();
    stopPlayback();
    clearSelection();
    clearCombined();
    clearAligned();
    for (const url of clipUrlsRef.current.values()) revokeBlobUrl(url);
    clipUrlsRef.current.clear();
    setSegmentClips({});
    if (spillApprovalsProp === undefined) setSpillApprovalsState({});
  }, [stopPlayback, clearSelection, clearCombined, clearAligned, spillApprovalsProp]);

  const resetVoiceover = useCallback(() => {
    clearInMemoryVoiceover();
    setSpillApprovals({});
  }, [clearInMemoryVoiceover, setSpillApprovals]);

  const lastEpochRef = useRef(transcriptEpoch);
  useEffect(() => {
    if (transcriptEpoch === lastEpochRef.current) return;
    lastEpochRef.current = transcriptEpoch;
    clearInMemoryVoiceover();
  }, [transcriptEpoch, clearInMemoryVoiceover]);

  useHydratePersistedSubtitleTakes({
    segments, segmentsRef, segmentClipsRef, assetRepository, characters, anchorTag,
    pronunciationSignature, generatingSegmentId, mountedRef, storeHydratedClip, logger,
  });

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
    setSpillApprovals(prev => {
      const keys = Object.keys(prev);
      if (!keys.some(id => !validIds.has(id))) return prev;
      return Object.fromEntries(keys.filter(id => validIds.has(id)).map(id => [id, prev[id]]));
    });
  }, [segments, setSpillApprovals]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      for (const url of clipUrlsRef.current.values()) revokeBlobUrl(url);
      clipUrlsRef.current.clear();
    };
  }, []);

  const isClipStale = useCallback(segment => {
    const clip = segmentClips[segment?.id];
    if (!clip) return false;
    const text = resolveSubtitleSpeechText(segment, useTranslation);
    const expected = buildSubtitleSpeechSignature({
      text,
      characterId: activeCharacter.id,
      anchorTag,
      pronunciationTag: pronunciationSignature,
    });
    return clip.signature !== expected;
  }, [segmentClips, useTranslation, activeCharacter.id, anchorTag, pronunciationSignature]);

  const allDurationMismatches = useMemo(() => detectDurationMismatches({
    segments,
    segmentClips,
    mediaDuration: effectiveTotalDuration,
    spillApprovals,
    isClipStale,
  }), [segments, segmentClips, effectiveTotalDuration, spillApprovals, isClipStale]);

  const exportMismatchReport = useMemo(() => detectDurationMismatches({
    segments,
    segmentClips,
    mediaDuration: effectiveTotalDuration,
    spillApprovals,
    isClipStale,
    selectedIds,
    targetOnly: true,
  }), [segments, segmentClips, effectiveTotalDuration, spillApprovals, isClipStale, selectedIds]);

  const remedies = useMismatchControls({
    segments,
    segmentClipsRef,
    setSpillApprovals,
    mediaDuration: effectiveTotalDuration,
    storeClip,
    assetRepository,
    projectId,
    onAttachSegmentTake,
    onStatus,
    onNotify,
    logger,
  });

  const synthesis = useVoiceSynthesisActions({
    synthesizeSpeech, logger, segments, selectedIds, useTranslation, activeCharacter, activeAnchor,
    anchorTag, lockedSeeds, segmentClipsRef, cachedUploadsRef, abortRef,
    terminology, pronunciationSignature, speechLanguage,
    assetRepository, projectId, onAttachSegmentTake,
    setBusy: setVoiceBusy, setGeneratingSegmentId, setBatchProgress, storeClip,
    onStatus, onNotify, onUnlockSound, onEngineFailure,
  });

  const dubActionCtx = useMemo(() => ({
    mediaSubtitleGateway, logger, jobId, isAudioOnly, hasAudioStream, burnInSupported,
    videoFile: effectiveNameSource, mediaDuration: effectiveTotalDuration,
    segments, selectedIds, segmentClips, spillApprovals, exportMismatchReport,
    dubAudioMode, dubSubtitleMode, dubMixSettings, subtitleContext,
    sourceLanguage, audioLanguage: audioLanguage || speechLanguage,
    abortRef, dubBusy, voiceBusy, setDubBusy, onStatus, onNotify, onUnlockSound, onMediaJobExpired, onExportRecorded,
  }), [
    mediaSubtitleGateway, logger, jobId, isAudioOnly, hasAudioStream, burnInSupported,
    effectiveNameSource, effectiveTotalDuration, segments, selectedIds, segmentClips,
    spillApprovals, exportMismatchReport, dubAudioMode, dubSubtitleMode, dubMixSettings,
    subtitleContext, sourceLanguage, audioLanguage, speechLanguage, abortRef,
    dubBusy, voiceBusy, setDubBusy, onStatus, onNotify, onUnlockSound, onMediaJobExpired, onExportRecorded,
  ]);
  const exportDubbedVideo = useDubExportAction(dubActionCtx);

  const canExportAlignedVoice = Boolean(alignedClip?.blob) && !exportMismatchReport.hasUnresolved;
  const canExportDub = useMemo(() => {
    if (!jobId || isAudioOnly || !mediaSubtitleGateway?.exportDubbedVideo) return false;
    if (dubAudioMode !== VIDEO_AUDIO_MODES.REPLACE && hasAudioStream === false) return false;
    if (dubAudioMode !== VIDEO_AUDIO_MODES.ORIGINAL) {
      if (!combinedClip?.count || exportMismatchReport.hasUnresolved) return false;
    }
    if (dubSubtitleMode !== VIDEO_SUBTITLE_MODES.NONE) {
      if (dubSubtitleMode === VIDEO_SUBTITLE_MODES.BURNED && burnInSupported === false) return false;
      const useTrans = Boolean(subtitleContext?.useTranslation);
      const biling = Boolean(subtitleContext?.bilingual);
      const rendered = segments.filter(s => Boolean(pickSegmentText(s, useTrans, biling)));
      if (!rendered.length) return false;
      if (rendered.some(s => !(Number(s?.end) > Number(s?.start)) || Number(s?.start) < 0)) return false;
      if (!subtitleContext?.hasTranslation && (useTrans || biling) && !segments.some(s => Boolean(s?.translatedText?.trim()))) return false;
    }
    return true;
  }, [
    jobId, isAudioOnly, mediaSubtitleGateway, dubAudioMode, hasAudioStream,
    combinedClip?.count, exportMismatchReport.hasUnresolved, dubSubtitleMode,
    burnInSupported, subtitleContext, segments,
  ]);

  const downloadSegmentVoice = useCallback((segment, index) => {
    const clip = segmentClips[segment?.id];
    if (!clip?.blob) return;
    const tag = String((index ?? 0) + 1).padStart(2, '0');
    triggerFileDownload(clip.blob, buildVoiceoverDownloadFilename(effectiveNameSource, `-frame-${tag}`));
  }, [segmentClips, effectiveNameSource]);

  const downloadCombinedVoice = useCallback((overrides = null) => {
    const throwOnError = Boolean(overrides?.throwOnError);
    if (!combinedClip?.blob) {
      if (throwOnError) throw new Error('No voiceover audio is ready to export.');
      return;
    }
    const suffix = combinedClip.scope === 'selected' ? '-selected-voiceover' : '-voiceover';
    const filename = overrides?.filename || buildVoiceoverDownloadFilename(effectiveNameSource, suffix);
    triggerFileDownload(combinedClip.blob, filename);
    const langMeta = resolveLanguageDisplayMeta(audioLanguage || speechLanguage);
    onExportRecorded?.(EXPORT_PRESET_IDS.SUBTITLE_VOICEOVER_WAV, {
      filename,
      durationSeconds: combinedClip.durationSeconds ?? combinedClip.duration ?? null,
      languageCode: langMeta.bcp47,
      languageLabel: langMeta.label,
    });
  }, [combinedClip, effectiveNameSource, audioLanguage, speechLanguage, onExportRecorded]);

  const downloadAlignedVoice = useCallback(async (overrides = null) => {
    const throwOnError = Boolean(overrides?.throwOnError);
    if (blockIfDurationMismatched({ exportMismatchReport, onStatus, onNotify, throwOnError })) return;
    const langMeta = resolveLanguageDisplayMeta(audioLanguage || speechLanguage);
    if (isAlignmentSettled() && alignedClip?.blob) {
      const suffix = alignedClip.scope === 'selected' ? '-selected-aligned-dub' : DEFAULT_TIME_ALIGNED_SUFFIX;
      const filename = overrides?.filename || buildTimeAlignedDubDownloadFilename(effectiveNameSource, suffix);
      triggerFileDownload(alignedClip.blob, filename);
      onExportRecorded?.(EXPORT_PRESET_IDS.SUBTITLE_ALIGNED_WAV, {
        filename,
        durationSeconds: alignedClip.durationSeconds ?? alignedClip.duration ?? null,
        languageCode: langMeta.bcp47,
        languageLabel: langMeta.label,
      });
      return;
    }
    const { scope, matched } = collectCombinedTargetClips(segments, selectedIds, segmentClips);
    if (!matched.length) {
      if (throwOnError) throw new Error('Generate voice clips before exporting aligned WAV.');
      return;
    }
    try {
      const fresh = await assembleTimelineAlignedVoiceover({
        segments, segmentClips, totalDuration: effectiveTotalDuration, audioMaster,
        selectedIds: scope === 'selected' ? matched.map(s => s.id) : null, spillApprovals, strictDurationCheck: true, logger,
      });
      if (fresh?.blob) {
        const filename = overrides?.filename || buildTimeAlignedDubDownloadFilename(effectiveNameSource, scope === 'selected' ? '-selected-aligned-dub' : DEFAULT_TIME_ALIGNED_SUFFIX);
        triggerFileDownload(fresh.blob, filename);
        onExportRecorded?.(EXPORT_PRESET_IDS.SUBTITLE_ALIGNED_WAV, {
          filename,
          durationSeconds: fresh.durationSeconds ?? fresh.duration ?? null,
          languageCode: langMeta.bcp47,
          languageLabel: langMeta.label,
        });
      }
    } catch (err) {
      const message = err?.message || 'Could not export time-aligned WAV.';
      onStatus?.({ message, error: true });
      onNotify?.({ kind: 'error', title: 'Aligned WAV export failed', message });
      if (throwOnError) throw err;
    }
  }, [alignedClip, isAlignmentSettled, segments, selectedIds, segmentClips, effectiveTotalDuration, audioMaster, spillApprovals, logger, effectiveNameSource, audioLanguage, speechLanguage, exportMismatchReport, onStatus, onNotify, onExportRecorded]);

  const generateSelectedVoicesTracked = useCallback(async () => {
    const targets = selectOrderedSegments(segments, selectedIds)
      .map(seg => ({ seg, text: resolveSubtitleSpeechText(seg, useTranslation) }))
      .filter(item => Boolean(item.text));
    if (!targets.length) return synthesis.generateSelectedVoices();
    if (abortRef.current || !synthesizeSpeech?.execute) return;
    const controller = new AbortController();
    abortRef.current = controller;
    userCancelledRef.current = false;
    onUnlockSound?.();
    setVoiceBusy(true);
    setGeneratingSegmentId(targets[0].seg.id);
    setBatchProgress({ completed: 0, total: targets.length, currentSegmentId: targets[0].seg.id });
    const { items, artifacts } = buildSubtitleJobItems({
      targets, activeCharacter, anchorTag, pronunciationSignature, existingClips: segmentClipsRef.current,
    });
    const workerSessionId = productionJobs?.workerSessionId || 'subtitle-fg';
    let trackedJobId = null;
    let heartbeat;
    try {
      trackedJobId = await startTrackedSubtitleJob({
        jobRepository, workerSessionId, productionJobs, logger,
        spec: createTrackedSubtitleSpec({ targets, projectTitle, videoFile, projectId, activeCharacter, items, artifacts, lockedSeeds, terminology, speechLanguage }),
      });
      if (controller.signal.aborted || !mountedRef.current) throw new SynthesisCancelledError();
      heartbeat = startSubtitleJobHeartbeat({
        jobRepository, jobId: trackedJobId, workerSessionId, controller, userCancelledRef, productionJobs, logger,
      });
      if (trackedJobId) {
        productionJobs?.registerAbortHandler?.(trackedJobId, () => {
          userCancelledRef.current = true;
          controller.abort();
        });
      }
      const session = { anchor: activeAnchor, upload: cachedUploadsRef.current[activeCharacter.id] || null };
      for (let i = 0; i < targets.length; i += 1) {
        await assertSubtitleJobNotCancelled({ jobRepository, jobId: trackedJobId, signal: controller.signal, logger });
        await processTrackedSubtitleTarget({
          target: targets[i], idx: i, total: targets.length, trackedJobId, workerSessionId,
          signal: controller.signal, session, activeCharacter, anchorTag, pronunciationSignature,
          segmentClipsRef, setBatchProgress, setGeneratingSegmentId, onStatus, jobRepository,
          synthesizeSpeech, seed: lockedSeeds?.[activeCharacter.id] ?? '', terminology, speechLanguage,
          activeAnchor, cachedUploadsRef, assetRepository, projectId, storeClip, onAttachSegmentTake, productionJobs, logger,
        });
      }
      await assertSubtitleJobNotCancelled({ jobRepository, jobId: trackedJobId, signal: controller.signal, logger });
      await finalizeTrackedSubtitleJob({ jobRepository, jobId: trackedJobId, outcome: 'completed', productionJobs, logger });
      const summary = `Voice ready for ${targets.length} selected ${targets.length === 1 ? 'frame' : 'frames'} (${activeCharacter.name}).`;
      onStatus?.({ message: summary, error: false });
      onNotify?.({ kind: 'success', title: 'Selected voiceover ready', message: summary });
    } catch (err) {
      if (isCancellationError(err) || controller.signal.aborted) {
        const outcome = !mountedRef.current && !userCancelledRef.current ? 'interrupted' : 'cancelled';
        await finalizeTrackedSubtitleJob({ jobRepository, jobId: trackedJobId, outcome, productionJobs, logger });
        if (mountedRef.current) onStatus?.({ message: 'Voiceover generation cancelled.', error: false });
        return;
      }
      await finalizeTrackedSubtitleJob({ jobRepository, jobId: trackedJobId, outcome: 'failed', err, productionJobs, logger });
      logger?.error?.('useSubtitleVoiceover.generateSelectedVoices', err);
      const msg = err?.message || 'Could not generate selected subtitle voiceover.';
      if (mountedRef.current) {
        onStatus?.({ message: msg, error: true });
        onNotify?.({ kind: 'error', title: 'Subtitle voiceover failed', message: msg });
      }
      if (err?.status >= 500 || err?.code === 'ENGINE_UNAVAILABLE') onEngineFailure?.();
    } finally {
      if (heartbeat !== undefined) globalThis.clearInterval?.(heartbeat);
      if (trackedJobId) productionJobs?.registerAbortHandler?.(trackedJobId, null);
      if (abortRef.current === controller) abortRef.current = null;
      userCancelledRef.current = false;
      if (mountedRef.current) {
        setVoiceBusy(false);
        setGeneratingSegmentId('');
        setBatchProgress(null);
      }
    }
  }, [
    segments, selectedIds, useTranslation, synthesis, activeCharacter, anchorTag, pronunciationSignature,
    segmentClipsRef, productionJobs, jobRepository, assetRepository, logger, projectTitle, projectId,
    videoFile, lockedSeeds, terminology, speechLanguage, abortRef, onUnlockSound, setVoiceBusy,
    setGeneratingSegmentId, setBatchProgress, activeAnchor, cachedUploadsRef, onStatus, synthesizeSpeech,
    storeClip, onAttachSegmentTake, onNotify, onEngineFailure,
  ]);

  const cancelVoiceGeneration = useCallback(() => {
    userCancelledRef.current = true;
    synthesis.cancelVoiceGeneration();
  }, [synthesis]);

  const hydrateClipsFromJob = useCallback(async job => {
    if (!job || job.type !== 'subtitle_voiceover' || !assetRepository?.getAssetBinary) return 0;
    const activeIds = new Set((segmentsRef.current || []).map(seg => seg.id));
    if (activeIds.size === 0) return 0;
    const artifactByItem = new Map((job.artifacts || []).map(art => [art.itemId || art.segmentId, art]));
    let hydrated = 0;
    for (const item of job.items || []) {
      const segId = item?.segmentId || item?.itemId;
      const assetId = item?.outputAssetId || artifactByItem.get(segId)?.assetId || null;
      if (item?.status !== 'completed' || !segId || !assetId || !activeIds.has(segId)) continue;
      const existing = segmentClipsRef.current[segId];
      const sig = item.inputSignature || item.metadata?.signature || artifactByItem.get(segId)?.signature || '';
      if (existing?.blob && (existing.audioAssetId === assetId || (sig && existing.signature === sig))) {
        onAttachSegmentTake?.(segId, {
          takeId: item.takeId || null, audioAssetId: assetId, text: existing.text || item.metadata?.text || '',
          characterId: existing.characterId || item.metadata?.voiceId || job.metadata?.voiceId || activeCharacter.id,
          characterName: existing.characterName || '', signature: sig || existing.signature || '',
          durationSeconds: existing.durationSeconds ?? item.durationSeconds ?? null, seed: existing.seed ?? item.seed ?? null,
        });
        continue;
      }
      try {
        const fetched = await assetRepository.getAssetBinary(assetId);
        if (!mountedRef.current || !fetched?.bytes) continue;
        const blob = new Blob([fetched.bytes], { type: fetched.mimeType || 'audio/wav' });
        const voiceId = item.metadata?.voiceId || job.metadata?.voiceId || activeCharacter.id;
        const character = findCharacterById(characters, voiceId);
        const text = item.metadata?.text || '';
        const durationSeconds = await resolveRecordingDuration({ blob, audioDurationSeconds: item.durationSeconds });
        const effectiveSig = sig || buildSubtitleSpeechSignature({ text, characterId: character.id, anchorTag, pronunciationTag: pronunciationSignature });
        storeHydratedClip(segId, {
          ...buildClipRecord({ recording: { blob, seed: item.seed ?? null, audioDurationSeconds: durationSeconds }, text, character, signature: effectiveSig, durationSeconds }),
          audioAssetId: assetId,
        });
        onAttachSegmentTake?.(segId, {
          takeId: item.takeId || null, audioAssetId: assetId, text, characterId: character.id,
          characterName: character.name, signature: effectiveSig, durationSeconds, seed: item.seed ?? null,
        });
        hydrated += 1;
      } catch (err) {
        logger?.warn?.('useSubtitleVoiceover.hydrateClipsFromJob', err?.message || 'Could not hydrate subtitle clip from batch job', { segId, assetId, jobId: job.id });
      }
    }
    return hydrated;
  }, [assetRepository, characters, activeCharacter.id, anchorTag, pronunciationSignature, storeClip, logger]);

  return {
    characters,
    anchors,
    selectedVoiceId: activeCharacter.id,
    setSelectedVoiceId,
    pauseGapMs,
    setPauseGapMs,
    dubAudioMode,
    setDubAudioMode,
    dubSubtitleMode,
    setDubSubtitleMode,
    dubMixSettings,
    updateDubMixSetting,
    resetDubMixSettings,
    dubBusy,
    canExportAlignedVoice,
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
    spillApprovals,
    allDurationMismatches,
    exportDurationMismatches: exportMismatchReport,
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
    hydrateClipsFromJob,
    ...remedies,
    ...synthesis,
    cancelVoiceGeneration,
    generateSelectedVoices: jobRepository ? generateSelectedVoicesTracked : synthesis.generateSelectedVoices,
  };
}
