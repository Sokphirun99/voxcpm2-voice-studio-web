/**
 * @fileoverview Presentation hook managing persistent batch job queueing, bounded sequential execution, cancellation, retry, and restart recovery.
 */

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { persistTakeAsset } from '../../data/takeAssetStorage.js';
import { ConflictError, SynthesisCancelledError, ValidationError } from '../../domain/errors.js';
import {
  ACTIVE_JOB_STATUSES,
  DEFAULT_MAX_RETRIES,
  JOB_STATUS,
  PRUNABLE_HISTORY_STATUSES,
  getPendingJobItems,
  hasCompletedItemArtifact,
  isJobWorkerStale,
  summarizeJobs,
} from '../../domain/productionJobs.js';
import { attachTakeToSegment, computeSegmentStatus, getSegmentActiveTake } from '../../domain/projectSegments.js';
import {
  attachSubtitleClipTake,
  buildSubtitleSynthesisCommand,
  extractActiveSubtitleTakeSpec,
} from '../../domain/subtitleTts.js';
import {
  EXPORT_PRESET_IDS,
  VIDEO_AUDIO_MODES,
  VIDEO_SUBTITLE_MODES,
  assertVideoAudioMode,
  assertVideoSubtitleMode,
  hasCustomDubMixSettings,
  recordPresetExport,
  resolveDubVideoCodec,
  validateDubMixSettings,
} from '../../domain/exportPresets.js';
import { resolveLanguageDisplayMeta } from '../../domain/subtitleLanguages.js';
import { BUILT_IN_VOICES, findCharacterById } from '../../domain/voiceLibrary.js';
import { tryReadWavDurationSeconds } from '../../domain/wavCodec.js';
import { StudioContext } from '../StudioContext.jsx';

const TAB_SESSION_STORAGE_KEY = 'voxcpm.jobs.tab-session.v1';
const HEARTBEAT_INTERVAL_MS = 10_000;

export const JOB_FILTER_OPTIONS = Object.freeze([
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'interrupted', label: 'Interrupted' },
  { id: 'failed', label: 'Failed' },
  { id: 'completed', label: 'Completed' },
  { id: 'cancelled', label: 'Cancelled' },
]);

export const JOB_STATUS_LABELS = Object.freeze({
  queued: 'Queued',
  preparing: 'Preparing',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancel_requested: 'Cancelling…',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
});

export const JOB_TYPE_LABELS = Object.freeze({
  tts_batch: 'TTS Batch',
  subtitle_voiceover: 'Subtitle Voiceover',
  subtitle_extract: 'Subtitle Extract',
  subtitle_translate: 'Translation',
  video_burn: 'Burn Subtitles MP4',
  video_dub: 'Dubbed MP4',
});

/**
 * Filters a list of production jobs by UI status filter chip.
 * Inputs: jobs array, filterStatus string.
 * Outputs: filtered job array.
 * Side effects: none.
 * Failure modes: returns empty array on invalid jobs input.
 * @param {Array<object>} jobs - All loaded jobs.
 * @param {string} filterStatus - Selected filter chip id.
 * @returns {Array<object>} Filtered jobs.
 */
export function filterJobsByStatus(jobs, filterStatus = 'all') {
  if (!Array.isArray(jobs)) return [];
  if (!filterStatus || filterStatus === 'all') return jobs;
  if (filterStatus === 'active') return jobs.filter(job => ACTIVE_JOB_STATUSES.has(job.status));
  return jobs.filter(job => job.status === filterStatus);
}

/**
 * Formats a human-readable elapsed duration label between `startedAt` and `completedAt` or now.
 * Inputs: ISO timestamp strings.
 * Outputs: formatted duration label like `12s` or `1m 05s` or empty string.
 * Side effects: none.
 * Failure modes: returns empty string for invalid timestamps.
 * @param {string|null} startedAt - Start timestamp.
 * @param {string|null} completedAt - End timestamp.
 * @returns {string} Formatted duration text.
 */
export function formatJobDuration(startedAt, completedAt) {
  if (!startedAt) return '';
  const startMs = Date.parse(startedAt);
  const endMs = completedAt ? Date.parse(completedAt) : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return '';
  const totalSec = Math.round((endMs - startMs) / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}m ${String(secs).padStart(2, '0')}s`;
}

function createWorkerSessionId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return `tab-${globalThis.crypto.randomUUID()}`;
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readPreviousTabSession(workerSessionId) {
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) return '';
    const previous = storage.getItem(TAB_SESSION_STORAGE_KEY) || '';
    storage.setItem(TAB_SESSION_STORAGE_KEY, workerSessionId);
    return previous === workerSessionId ? '' : previous;
  } catch {
    return '';
  }
}

function isCancellationError(err) {
  return err instanceof SynthesisCancelledError || err?.name === 'SynthesisCancelledError' || err?.name === 'AbortError';
}

async function resolveBlobDurationSeconds(blob, fallback = null) {
  if (Number.isFinite(fallback) && fallback > 0) return fallback;
  if (blob && typeof blob.arrayBuffer === 'function') {
    const measured = tryReadWavDurationSeconds(await blob.arrayBuffer());
    if (measured > 0) return measured;
  }
  return null;
}

async function resolveVoiceAndAnchor(voiceId, deps, sessionAnchors = null) {
  const saved = deps.voiceLibrary?.loadSaved?.()?.entries || [];
  const allVoices = [...saved, ...BUILT_IN_VOICES];
  const character = findCharacterById(allVoices, voiceId || deps.defaultVoiceId);
  const anchors = deps.voiceAnchors ? await deps.voiceAnchors.loadAll() : {};
  const anchor = anchors?.[character.id] || sessionAnchors?.get(character.id) || null;
  return { character, anchor };
}

async function captureSessionAnchor({ deps, character, anchor, recording, sessionAnchors }) {
  if (anchor || !recording?.anchorBlob) return;
  const derived = { characterId: character.id, label: character.name, blob: recording.anchorBlob, source: 'generated', exactClone: false };
  sessionAnchors?.set(character.id, derived);
  if (deps.voiceAnchors?.pinCharacter) {
    await deps.voiceAnchors.pinCharacter(derived).catch(err => {
      deps.logger?.warn?.('useProductionJobs.pinCharacter', err?.message || 'Could not pin generated anchor');
    });
  }
}

async function persistItemWavAsset(deps, { blob, segmentId, seed, projectId }) {
  if (!deps.assetRepository || !blob) return null;
  return persistTakeAsset({
    assetRepository: deps.assetRepository,
    blob,
    segmentId,
    seed,
    projectId,
    logger: deps.logger,
  });
}

function buildAudioArtifact({ item, assetId, takeId, durationSeconds, blob }) {
  return {
    itemId: item.itemId,
    segmentId: item.segmentId,
    assetId,
    takeId,
    kind: 'audio',
    fileName: `${item.segmentId || item.itemId}.wav`,
    mimeType: blob?.type || 'audio/wav',
    sizeBytes: Number.isFinite(blob?.size) ? blob.size : 0,
    durationSeconds,
    signature: item.inputSignature || '',
  };
}

async function saveProjectMutationWithRetry(projectRepository, projectId, buildNextProject) {
  if (!projectRepository || !projectId) return;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const project = await projectRepository.getProject(projectId);
    if (!project) return;
    const nextProject = buildNextProject(project);
    try {
      await projectRepository.saveProject(nextProject, { expectedRevision: project.revision });
      return;
    } catch (err) {
      if (!(err instanceof ConflictError || err?.status === 409 || err?.code === 'REVISION_CONFLICT') || attempt === 1) {
        throw err;
      }
    }
  }
}

async function attachTakeAndSaveProject(deps, { projectId, segmentId, recording, characterId, outputAssetId, durationSeconds, options }) {
  if (!deps.projectRepository || !projectId || !segmentId) return;
  const resolvedRecording = Number.isFinite(durationSeconds) && !Number.isFinite(recording?.audioDurationSeconds)
    ? { ...recording, audioDurationSeconds: durationSeconds }
    : recording;
  const persistableRecording = outputAssetId ? { ...resolvedRecording, blob: null, anchorBlob: null } : resolvedRecording;
  await saveProjectMutationWithRetry(deps.projectRepository, projectId, project => {
    const segs = Array.isArray(project.segments) ? project.segments : (project.payload?.segments || []);
    const nextSegments = attachTakeToSegment(segs, segmentId, persistableRecording, {
      voiceId: characterId,
      audioAssetId: outputAssetId,
      guidance: options.guidance,
      steps: options.steps,
      styleMode: options.styleMode,
      customStyle: options.customStyle,
      ...(options.pronunciationSignature !== undefined ? { pronunciationSignature: options.pronunciationSignature } : {}),
    });
    const nextPayload = { ...(project.payload || {}), segments: nextSegments };
    return { ...project, segments: nextSegments, payload: nextPayload };
  });
}

async function runTtsSynthesis({ synthesizeSpeech, segmentId, text, character, anchor, cachedUpload, onReferenceUploaded, options, signal }) {
  if (typeof synthesizeSpeech.synthesizeSegment === 'function') {
    return synthesizeSpeech.synthesizeSegment({
      segment: { id: segmentId, text },
      character,
      anchor,
      cachedUpload,
      onReferenceUploaded,
      options,
      signal,
    });
  }
  return synthesizeSpeech.execute({ script: text, character, anchor, cachedUpload, onReferenceUploaded, ...options, signal });
}

async function findExistingReadyProjectTake({ deps, job, item, text, voiceId, pronunciationSignature }) {
  if ((job.attempt || 1) <= 1 || !job.projectId || !item.segmentId || !deps.projectRepository?.getProject) return null;
  try {
    const project = await deps.projectRepository.getProject(job.projectId);
    const segs = Array.isArray(project?.segments) ? project.segments : (project?.payload?.segments || []);
    const projSeg = segs.find(seg => seg.id === item.segmentId);
    if (!projSeg) return null;
    const candidate = { ...projSeg, text, voiceId };
    const statusOpts = pronunciationSignature !== undefined ? { pronunciationSignature } : {};
    if (computeSegmentStatus(candidate, statusOpts) !== 'ready') return null;
    const take = getSegmentActiveTake(projSeg);
    if (!take?.audioAssetId) return null;
    return {
      outputAssetId: take.audioAssetId,
      takeId: take.id || null,
      durationSeconds: Number.isFinite(take.duration) ? take.duration : null,
      seed: take.settings?.seed ?? null,
      artifact: buildAudioArtifact({
        item,
        assetId: take.audioAssetId,
        takeId: take.id || null,
        durationSeconds: Number.isFinite(take.duration) ? take.duration : null,
        blob: null,
      }),
    };
  } catch (err) {
    deps.logger?.debug?.('useProductionJobs.findExistingReadyProjectTake', err?.message || 'Could not inspect project take');
    return null;
  }
}

async function executeTtsBatchItem({ job, item, signal, deps, sessionAnchors, sessionUploads }) {
  if (!deps.synthesizeSpeech?.synthesizeSegment && !deps.synthesizeSpeech?.execute) {
    throw new ValidationError('Speech synthesis service is unavailable.', 'synthesizeSpeech', 'SYNTHESIS_UNAVAILABLE');
  }
  const itemMeta = item.metadata || {};
  const jobMeta = job.metadata || {};
  const voiceId = itemMeta.voiceId || jobMeta.voiceId || '';
  const { character, anchor } = await resolveVoiceAndAnchor(voiceId, deps, sessionAnchors);
  const text = String(itemMeta.text || '').trim();
  if (!text) throw new ValidationError(`Segment '${item.label}' has empty text.`, 'text', 'EMPTY_SEGMENT');
  const options = { guidance: 2, steps: 10, ...(jobMeta.options || {}), ...(itemMeta.options || {}) };
  const reusable = await findExistingReadyProjectTake({
    deps, job, item, text, voiceId: character.id, pronunciationSignature: options.pronunciationSignature,
  });
  if (reusable) return reusable;
  const result = await runTtsSynthesis({
    synthesizeSpeech: deps.synthesizeSpeech,
    segmentId: item.segmentId || item.itemId,
    text,
    character,
    anchor,
    cachedUpload: sessionUploads?.get(character.id) || null,
    onReferenceUploaded: fileData => { if (fileData) sessionUploads?.set(character.id, fileData); },
    options,
    signal,
  });
  if (signal.aborted) throw new SynthesisCancelledError();
  if (result?.uploadedFileData) sessionUploads?.set(character.id, result.uploadedFileData);
  await captureSessionAnchor({ deps, character, anchor, recording: result.recording, sessionAnchors });
  const outputAssetId = await persistItemWavAsset(deps, {
    blob: result.recording.blob, segmentId: item.segmentId || item.itemId, seed: result.recording.seed, projectId: job.projectId,
  });
  const durationSeconds = await resolveBlobDurationSeconds(result.recording.blob, result.recording.audioDurationSeconds);
  await attachTakeAndSaveProject(deps, {
    projectId: job.projectId, segmentId: item.segmentId, recording: result.recording,
    characterId: character.id, outputAssetId, durationSeconds, options,
  });
  return {
    outputAssetId,
    takeId: result.recording.id,
    durationSeconds,
    seed: result.recording.seed ?? null,
    artifact: buildAudioArtifact({ item, assetId: outputAssetId, takeId: result.recording.id, durationSeconds, blob: result.recording.blob }),
  };
}

async function findExistingSubtitleProjectTake({ deps, job, item, signature }) {
  if ((job.attempt || 1) <= 1 || !job.projectId || !item.segmentId || !deps.projectRepository?.getProject) return null;
  try {
    const project = await deps.projectRepository.getProject(job.projectId);
    const segs = Array.isArray(project?.segments) ? project.segments : (project?.payload?.segments || []);
    const projSeg = segs.find(seg => seg?.id === item.segmentId);
    const spec = extractActiveSubtitleTakeSpec(projSeg);
    if (!spec?.audioAssetId) return null;
    if (signature && spec.signature && spec.signature !== signature) return null;
    return {
      outputAssetId: spec.audioAssetId,
      takeId: spec.takeId || null,
      durationSeconds: spec.durationSeconds,
      seed: spec.seed,
      artifact: buildAudioArtifact({
        item, assetId: spec.audioAssetId, takeId: spec.takeId || null, durationSeconds: spec.durationSeconds, blob: null,
      }),
    };
  } catch (err) {
    deps.logger?.debug?.('useProductionJobs.findExistingSubtitleProjectTake', err?.message || 'Could not inspect subtitle project take');
    return null;
  }
}

async function attachSubtitleTakeToProject(deps, { projectId, segmentId, clipSpec }) {
  if (!deps.projectRepository || !projectId || !segmentId || !clipSpec?.audioAssetId) return;
  await saveProjectMutationWithRetry(deps.projectRepository, projectId, project => {
    const segs = Array.isArray(project.segments) ? project.segments : (project.payload?.segments || []);
    const nextSegments = attachSubtitleClipTake(segs, segmentId, clipSpec);
    if (nextSegments === segs) return project;
    return { ...project, segments: nextSegments, payload: { ...(project.payload || {}), segments: nextSegments } };
  });
}

async function executeSubtitleVoiceItem({ job, item, signal, deps, sessionAnchors, sessionUploads }) {
  if (!deps.synthesizeSpeech?.execute) {
    throw new ValidationError('Speech synthesis service is unavailable.', 'synthesizeSpeech', 'SYNTHESIS_UNAVAILABLE');
  }
  const itemMeta = item.metadata || {};
  const jobMeta = job.metadata || {};
  const reusable = await findExistingSubtitleProjectTake({ deps, job, item, signature: item.inputSignature || itemMeta.signature || '' });
  if (reusable) return reusable;
  const { character, anchor } = await resolveVoiceAndAnchor(itemMeta.voiceId || jobMeta.voiceId, deps, sessionAnchors);
  const command = buildSubtitleSynthesisCommand({
    text: itemMeta.text || '',
    character,
    anchor,
    cachedUpload: sessionUploads?.get(character.id) || null,
    seed: itemMeta.seed ?? jobMeta.seed ?? '',
    terminology: jobMeta.terminology,
    sourceLanguage: jobMeta.speechLanguage,
  });
  const result = await deps.synthesizeSpeech.execute({
    ...command,
    signal,
    onReferenceUploaded: fileData => { if (fileData) sessionUploads?.set(character.id, fileData); },
  });
  if (signal.aborted) throw new SynthesisCancelledError();
  if (result?.uploadedFileData) sessionUploads?.set(character.id, result.uploadedFileData);
  await captureSessionAnchor({ deps, character, anchor, recording: result.recording, sessionAnchors });
  const segmentId = item.segmentId || item.itemId;
  const outputAssetId = await persistItemWavAsset(deps, {
    blob: result.recording.blob, segmentId, seed: result.recording.seed, projectId: job.projectId,
  });
  const durationSeconds = await resolveBlobDurationSeconds(result.recording.blob, result.recording.audioDurationSeconds);
  const clipSpec = {
    takeId: result.recording.id,
    audioAssetId: outputAssetId,
    text: itemMeta.text || '',
    characterId: character.id,
    characterName: character.name,
    signature: item.inputSignature || itemMeta.signature || '',
    durationSeconds,
    seed: result.recording.seed ?? null,
  };
  await attachSubtitleTakeToProject(deps, { projectId: job.projectId, segmentId, clipSpec });
  return {
    outputAssetId,
    takeId: result.recording.id,
    durationSeconds,
    seed: result.recording.seed ?? null,
    recording: result.recording,
    character,
    artifact: buildAudioArtifact({ item, assetId: outputAssetId, takeId: result.recording.id, durationSeconds, blob: result.recording.blob }),
  };
}

async function executeSubtitleTranslateItem({ job, item, signal, deps }) {
  if (!deps.mediaSubtitleGateway?.translateSegments) {
    throw new ValidationError('Media translation service is unavailable.', 'mediaSubtitleGateway', 'MEDIA_UNAVAILABLE');
  }
  const meta = job.metadata || {};
  const segment = item.metadata?.segment || { id: item.segmentId || item.itemId, start: 0, end: 1, text: item.metadata?.text || '' };
  const res = await deps.mediaSubtitleGateway.translateSegments({
    segments: [segment],
    sourceLanguage: meta.sourceLanguage || 'en',
    targetLanguage: meta.targetLanguage || 'km',
    terminology: meta.terminology || null,
    signal,
  });
  const translatedText = res?.segments?.[0]?.translatedText || '';
  if (deps.projectRepository && job.projectId && item.segmentId) {
    await saveProjectMutationWithRetry(deps.projectRepository, job.projectId, project => {
      const segs = (project.segments || project.payload?.segments || []).map(seg => (
        seg.id === item.segmentId ? { ...seg, translatedText } : seg
      ));
      const targetLang = meta.targetLanguage || project.payload?.translatedLanguage || project.targetLanguage || '';
      return {
        ...project,
        segments: segs,
        ...(targetLang ? { targetLanguage: targetLang } : {}),
        payload: { ...(project.payload || {}), segments: segs, hasTranslation: true, ...(targetLang ? { translatedLanguage: targetLang } : {}) },
      };
    });
  }
  return { translatedText };
}

async function resolveVideoAssetBlob(assetRepository, assetId) {
  if (!assetRepository?.getAssetBinary || !assetId) return null;
  const fetched = await assetRepository.getAssetBinary(assetId);
  if (!fetched?.bytes) return null;
  return new Blob([fetched.bytes], { type: fetched.mimeType || 'video/mp4' });
}

async function executeSubtitleExtractItem({ job, signal, deps }) {
  if (!deps.mediaSubtitleGateway?.transcribeVideo) {
    throw new ValidationError('Media transcription service is unavailable.', 'mediaSubtitleGateway', 'MEDIA_UNAVAILABLE');
  }
  const meta = job.metadata || {};
  const file = meta.sourceAssetId ? await resolveVideoAssetBlob(deps.assetRepository, meta.sourceAssetId) : null;
  if (!file) {
    throw new ValidationError('Re-link the source media file before retrying subtitle extraction.', 'sourceAssetId', 'MISSING_SOURCE_ASSET');
  }
  const res = await deps.mediaSubtitleGateway.transcribeVideo({ file, ...(meta.options || {}), signal });
  if (deps.projectRepository && job.projectId) {
    await saveProjectMutationWithRetry(deps.projectRepository, job.projectId, project => {
      const segs = Array.isArray(res.segments) ? res.segments : [];
      return {
        ...project,
        segments: segs,
        sourceLanguage: res.language || project.sourceLanguage,
        payload: { ...(project.payload || {}), segments: segs, detectedLanguage: res.language || '' },
      };
    });
  }
  return { result: res };
}

async function uploadVideoOutputArtifact(deps, { blob, fileName, projectId, item }) {
  if (!deps.assetRepository?.uploadAsset || !blob) return { outputAssetId: null, artifact: null };
  const uploaded = await deps.assetRepository.uploadAsset({
    bytes: blob,
    fileName,
    kind: 'video',
    mimeType: blob.type || 'video/mp4',
    projectId: projectId || undefined,
  });
  const assetId = uploaded?.asset?.id || null;
  return {
    outputAssetId: assetId,
    artifact: assetId ? {
      itemId: item.itemId,
      segmentId: item.segmentId,
      assetId,
      kind: 'video',
      fileName,
      mimeType: blob.type || 'video/mp4',
      sizeBytes: blob.size || 0,
    } : null,
  };
}

function wrapMediaSessionError(err) {
  if (err?.status === 404) {
    return new ValidationError(
      'Temporary media processing session expired. Re-open the project video in Video to subtitle and re-run export.',
      'mediaJobId',
      'MEDIA_JOB_EXPIRED'
    );
  }
  return err;
}

async function recordBatchVideoExportHistory(deps, projectId, presetId, spec) {
  if (!deps.projectRepository?.getProject || !deps.projectRepository?.saveProject || !projectId) return;
  try {
    await saveProjectMutationWithRetry(deps.projectRepository, projectId, project => {
      const nextHistory = recordPresetExport(project.exportHistory ?? project.payload?.exportHistory ?? [], presetId, spec);
      return {
        ...project,
        exportHistory: nextHistory,
        payload: { ...(project.payload || {}), exportHistory: nextHistory },
      };
    });
  } catch (err) {
    deps.logger?.warn?.('useProductionJobs.recordBatchVideoExportHistory', err?.message || 'Could not update project exportHistory', { projectId, presetId });
  }
}

async function executeVideoBurnItem({ job, item, signal, deps }) {
  if (!deps.mediaSubtitleGateway?.burnSubtitles) {
    throw new ValidationError('Media burn-in service is unavailable.', 'mediaSubtitleGateway', 'MEDIA_UNAVAILABLE');
  }
  const meta = job.metadata || {};
  if (!meta.mediaJobId) {
    throw new ValidationError('Re-open the video and extract subtitles before retrying subtitle burn-in.', 'mediaJobId', 'MISSING_MEDIA_JOB');
  }
  let mp4Blob;
  try {
    mp4Blob = await deps.mediaSubtitleGateway.burnSubtitles({
      jobId: meta.mediaJobId,
      segments: meta.segments || [],
      speakerNames: meta.speakerNames || {},
      includeSpeaker: Boolean(meta.includeSpeaker),
      useTranslation: Boolean(meta.useTranslation),
      bilingual: Boolean(meta.bilingual),
      subtitleStyle: meta.subtitleStyle,
      videoSize: meta.videoSize,
      ...(meta.audioLanguage ? { audioLanguage: String(meta.audioLanguage) } : {}),
      signal,
    });
  } catch (err) {
    throw wrapMediaSessionError(err);
  }
  const fileName = meta.outputFileName || 'subtitled.mp4';
  const uploaded = await uploadVideoOutputArtifact(deps, { blob: mp4Blob, fileName, projectId: job.projectId, item });
  const langMeta = resolveLanguageDisplayMeta(meta.subtitleLanguage || meta.audioLanguage || '');
  await recordBatchVideoExportHistory(deps, job.projectId, EXPORT_PRESET_IDS.VIDEO_BURNED_MP4, {
    filename: fileName,
    languageCode: langMeta.bcp47,
    languageLabel: langMeta.label,
    audioMode: VIDEO_AUDIO_MODES.ORIGINAL,
    subtitleMode: VIDEO_SUBTITLE_MODES.BURNED,
  });
  return uploaded;
}

async function loadDubClipsFromAssets(meta, assetRepository) {
  const specs = Array.isArray(meta.clips) ? meta.clips : [];
  if (specs.length === 0) {
    throw new ValidationError('No dubbed audio clips are attached to this export job.', 'clips', 'MISSING_CLIP_ASSET');
  }
  const clips = [];
  for (const clip of specs) {
    const fetched = clip.assetId ? await assetRepository?.getAssetBinary?.(clip.assetId) : null;
    if (!fetched?.bytes) throw new ValidationError(`Missing audio asset for cue '${clip.segmentId}'.`, 'clips', 'MISSING_CLIP_ASSET');
    clips.push({ ...clip, blob: new Blob([fetched.bytes], { type: fetched.mimeType || 'audio/wav' }) });
  }
  return clips;
}

function validateBatchDubSubtitles(subtitleMode, subtitles) {
  if (subtitleMode === VIDEO_SUBTITLE_MODES.NONE) return null;
  if (!subtitles || typeof subtitles !== 'object' || !Array.isArray(subtitles.segments) || subtitles.segments.length === 0) {
    throw new ValidationError('Non-empty subtitle segments are required when subtitleMode is burned or soft.', 'subtitles', 'MISSING_DUB_SUBTITLES');
  }
  return subtitles;
}

async function executeVideoDubItem({ job, item, signal, deps }) {
  if (!deps.mediaSubtitleGateway?.exportDubbedVideo) {
    throw new ValidationError('Media dubbing service is unavailable.', 'mediaSubtitleGateway', 'MEDIA_UNAVAILABLE');
  }
  const meta = job.metadata || {};
  if (!meta.mediaJobId) {
    throw new ValidationError('Re-open the video and extract subtitles before retrying dubbed video export.', 'mediaJobId', 'MISSING_MEDIA_JOB');
  }
  const audioMode = assertVideoAudioMode(meta.originalAudioMode ?? meta.audioMode ?? VIDEO_AUDIO_MODES.DUCK);
  const subtitleMode = assertVideoSubtitleMode(meta.subtitleMode ?? VIDEO_SUBTITLE_MODES.NONE);
  const mixSettings = meta.mixSettings !== undefined ? validateDubMixSettings(meta.mixSettings) : null;
  const subtitles = validateBatchDubSubtitles(subtitleMode, meta.subtitles);
  const clips = audioMode === VIDEO_AUDIO_MODES.ORIGINAL ? [] : await loadDubClipsFromAssets(meta, deps.assetRepository);
  let mp4Blob;
  try {
    mp4Blob = await deps.mediaSubtitleGateway.exportDubbedVideo({
      jobId: meta.mediaJobId,
      clips,
      originalAudioMode: audioMode,
      ...(meta.audioLanguage ? { audioLanguage: String(meta.audioLanguage) } : {}),
      ...(mixSettings && hasCustomDubMixSettings(mixSettings) ? { mixSettings } : {}),
      ...(subtitleMode !== VIDEO_SUBTITLE_MODES.NONE ? { subtitleMode, subtitles } : {}),
      signal,
    });
  } catch (err) {
    throw wrapMediaSessionError(err);
  }
  const fileName = meta.outputFileName || 'dubbed.mp4';
  const uploaded = await uploadVideoOutputArtifact(deps, { blob: mp4Blob, fileName, projectId: job.projectId, item });
  const langMeta = resolveLanguageDisplayMeta(meta.audioLanguage || '');
  await recordBatchVideoExportHistory(deps, job.projectId, EXPORT_PRESET_IDS.VIDEO_DUBBED_MP4, {
    filename: fileName,
    codec: resolveDubVideoCodec(subtitleMode),
    languageCode: langMeta.bcp47,
    languageLabel: langMeta.label,
    audioMode,
    subtitleMode,
  });
  return uploaded;
}

function runBuiltInItemExecutor(ctx) {
  switch (ctx.job.type) {
    case 'tts_batch': return executeTtsBatchItem(ctx);
    case 'subtitle_voiceover': return executeSubtitleVoiceItem(ctx);
    case 'subtitle_translate': return executeSubtitleTranslateItem(ctx);
    case 'subtitle_extract': return executeSubtitleExtractItem(ctx);
    case 'video_burn': return executeVideoBurnItem(ctx);
    case 'video_dub': return executeVideoDubItem(ctx);
    default: throw new ValidationError(`Unsupported batch job type '${ctx.job.type}'.`, 'type', 'INVALID_JOB_TYPE');
  }
}

function useResolvedJobDeps(opts) {
  const ctx = useContext(StudioContext);
  const jobRepository = opts.jobRepository ?? ctx?.jobRepository ?? null;
  const projectRepository = opts.projectRepository ?? ctx?.projectRepository ?? null;
  const assetRepository = opts.assetRepository ?? ctx?.assetRepository ?? null;
  const synthesizeSpeech = opts.synthesizeSpeech ?? ctx?.synthesizeSpeech ?? null;
  const mediaSubtitleGateway = opts.mediaSubtitleGateway ?? ctx?.mediaSubtitleGateway ?? null;
  const voiceLibrary = opts.voiceLibrary ?? ctx?.voiceLibrary ?? null;
  const voiceAnchors = opts.voiceAnchors ?? ctx?.voiceAnchors ?? null;
  const logger = opts.logger ?? ctx?.logger ?? null;
  return useMemo(() => ({
    jobRepository, projectRepository, assetRepository, synthesizeSpeech,
    mediaSubtitleGateway, voiceLibrary, voiceAnchors, logger,
  }), [
    jobRepository, projectRepository, assetRepository, synthesizeSpeech,
    mediaSubtitleGateway, voiceLibrary, voiceAnchors, logger,
  ]);
}

function isJobCancelRequested(cancelSet, job) {
  return cancelSet.has(job.id) || job.status === JOB_STATUS.CANCEL_REQUESTED || job.status === JOB_STATUS.CANCELLED;
}

async function syncExistingArtifactItem({ repo, job, item, onJobUpdate }) {
  const existingArt = (job.artifacts || []).find(art => art.itemId === item.itemId);
  const synced = (await repo.updateJob(job.id, {
    action: 'item_complete',
    itemId: item.itemId,
    outputAssetId: existingArt?.assetId ?? item.outputAssetId ?? null,
    takeId: existingArt?.takeId ?? item.takeId ?? null,
  })).job;
  onJobUpdate(synced);
  return synced;
}

async function runSingleJobItems({ job, signal, deps, customExecutor, cancelSet, workerSessionId, onJobUpdate }) {
  let latest = job;
  const sessionAnchors = new Map();
  const sessionUploads = new Map();
  for (const item of getPendingJobItems(latest)) {
    if (signal.aborted || isJobCancelRequested(cancelSet, latest)) throw new SynthesisCancelledError();
    if (hasCompletedItemArtifact(latest, item.itemId)) {
      latest = await syncExistingArtifactItem({ repo: deps.jobRepository, job: latest, item, onJobUpdate });
      continue;
    }
    latest = (await deps.jobRepository.updateJob(latest.id, { action: 'item_start', itemId: item.itemId, workerSessionId })).job;
    onJobUpdate(latest);
    const out = customExecutor
      ? await customExecutor({ job: latest, item, signal, deps })
      : await runBuiltInItemExecutor({ job: latest, item, signal, deps, sessionAnchors, sessionUploads });
    latest = (await deps.jobRepository.updateJob(latest.id, {
      action: 'item_complete', itemId: item.itemId,
      outputAssetId: out?.outputAssetId ?? null, takeId: out?.takeId ?? null,
      durationSeconds: out?.durationSeconds ?? null, seed: out?.seed ?? null, artifact: out?.artifact ?? null,
    })).job;
    onJobUpdate(latest);
  }
  return latest;
}

async function handleInterruptionOnUnmount({ repo, job, onJobUpdate, onProjectUpdated }) {
  const interrupted = (await repo.interruptJob(job.id, {
    reason: 'Interrupted before completion. Retry to resume remaining items.',
  })).job;
  onJobUpdate(interrupted);
  if (interrupted?.progress?.completed > 0) onProjectUpdated?.(interrupted);
  return interrupted;
}

function isConflictErr(err) {
  return err instanceof ConflictError || err?.status === 409;
}

function isOwnedByOtherWorker(job, workerSessionId) {
  return Boolean(job?.workerSessionId && workerSessionId && job.workerSessionId !== workerSessionId);
}

async function resolveExternalCancelState(repo, job, err, logger) {
  if (!isConflictErr(err)) return job;
  try {
    const latest = await repo.getJob(job.id);
    return latest || job;
  } catch (readErr) {
    logger?.debug?.('useProductionJobs.resolveExternalCancelState', readErr?.message || 'Could not refresh conflicted job');
    return job;
  }
}

async function syncConflictedExternalState({ repo, job, workerSessionId, onJobUpdate, onProjectUpdated, logger }) {
  const latest = await resolveExternalCancelState(repo, job, { status: 409 }, logger);
  if (latest) {
    onJobUpdate(latest);
    if (!ACTIVE_JOB_STATUSES.has(latest.status) && latest?.progress?.completed > 0) onProjectUpdated?.(latest);
  }
  logger?.debug?.('useProductionJobs.yieldConflictedJob', 'Yielded job after concurrent state change', {
    jobId: job.id,
    status: latest?.status,
    owner: latest?.workerSessionId,
    workerSessionId,
  });
  return { persisted: true };
}

async function finalizeJobFailure({ repo, job, err, workerSessionId, claimed, cancelSet, mountedRef, onJobUpdate, onProjectUpdated, onNotify, logger }) {
  if (!claimed && isConflictErr(err)) {
    return syncConflictedExternalState({ repo, job, workerSessionId, onJobUpdate, onProjectUpdated, logger });
  }
  const effectiveJob = await resolveExternalCancelState(repo, job, err, logger);
  if (isConflictErr(err) && (isOwnedByOtherWorker(effectiveJob, workerSessionId) || !ACTIVE_JOB_STATUSES.has(effectiveJob.status))) {
    onJobUpdate(effectiveJob);
    if (!ACTIVE_JOB_STATUSES.has(effectiveJob.status) && effectiveJob?.progress?.completed > 0) onProjectUpdated?.(effectiveJob);
    return { persisted: true };
  }
  const isAbortedUnmount = isCancellationError(err) && !mountedRef.current && !isJobCancelRequested(cancelSet, effectiveJob);
  if (isAbortedUnmount) {
    try {
      await handleInterruptionOnUnmount({ repo, job: effectiveJob, onJobUpdate, onProjectUpdated });
      return { persisted: true };
    } catch (e) {
      logger?.warn?.('useProductionJobs.interruptOnUnmount', e?.message || 'Could not mark job interrupted');
      return { persisted: false };
    }
  }
  if (isCancellationError(err) || isJobCancelRequested(cancelSet, effectiveJob)) {
    try {
      const cancelled = effectiveJob.status === JOB_STATUS.CANCELLED
        ? effectiveJob
        : (await repo.cancelJob(effectiveJob.id, { finalize: true })).job;
      onJobUpdate(cancelled);
      if (cancelled?.progress?.completed > 0) onProjectUpdated?.(cancelled);
      onNotify?.({ kind: 'info', title: 'Batch job cancelled', message: `Cancelled "${cancelled.title}". Completed items were preserved.` });
      return { persisted: true };
    } catch (cancelErr) {
      logger?.error?.('useProductionJobs.finalizeCancel', cancelErr, { jobId: effectiveJob.id });
      return { persisted: false };
    }
  }
  logger?.error?.('useProductionJobs.executeJob', err, { jobId: effectiveJob.id, type: effectiveJob.type });
  try {
    const failed = (await repo.updateJob(effectiveJob.id, {
      action: 'fail',
      code: err?.code || 'JOB_FAILED',
      message: err?.message || 'Batch job failed.',
      itemId: effectiveJob.progress?.currentItemId || null,
    })).job;
    onJobUpdate(failed);
    if (failed?.progress?.completed > 0) onProjectUpdated?.(failed);
    onNotify?.({ kind: 'error', title: 'Batch job failed', message: failed.error?.message || failed.title });
    return { persisted: true };
  } catch (failErr) {
    logger?.error?.('useProductionJobs.finalizeFailure', failErr, { jobId: effectiveJob.id });
    onNotify?.({ kind: 'error', title: 'Batch job error', message: err?.message || 'Batch job storage error.' });
    return { persisted: false };
  }
}

function startHeartbeatTimer({ repo, jobId, workerSessionId, controller, cancelSet, onJobUpdate, logger }) {
  const timer = globalThis.setInterval?.(() => {
    void repo.updateJob(jobId, { action: 'heartbeat', workerSessionId })
      .then(res => {
        const latest = res?.job;
        if (!latest) return;
        onJobUpdate?.(latest);
        if (latest.status === JOB_STATUS.CANCEL_REQUESTED || latest.status === JOB_STATUS.CANCELLED) {
          cancelSet?.add(jobId);
          controller?.abort();
        }
      })
      .catch(err => {
        logger?.debug?.('useProductionJobs.heartbeat', err?.message || 'Heartbeat skipped', { jobId });
      });
  }, HEARTBEAT_INTERVAL_MS);
  timer?.unref?.();
  return timer;
}

async function executeOneQueuedJob({ initialJob, deps, workerSessionId, cancelSet, mountedRef, customExecutors, abortControllers, onJobUpdate, onProjectUpdated, onNotify, onJobCompleted }) {
  const controller = new AbortController();
  abortControllers.set(initialJob.id, controller);
  let heartbeat;
  let claimed = false;
  const latestRef = { current: initialJob };
  const recordUpdate = next => {
    if (!next) return;
    latestRef.current = next;
    onJobUpdate(next);
  };
  try {
    if (isJobCancelRequested(cancelSet, latestRef.current)) throw new SynthesisCancelledError();
    const prepared = (await deps.jobRepository.updateJob(
      latestRef.current.id,
      { action: 'prepare', workerSessionId },
      latestRef.current.revision ? { expectedRevision: latestRef.current.revision } : undefined
    )).job;
    claimed = true;
    recordUpdate(prepared);
    heartbeat = startHeartbeatTimer({
      repo: deps.jobRepository,
      jobId: initialJob.id,
      workerSessionId,
      controller,
      cancelSet,
      onJobUpdate: recordUpdate,
      logger: deps.logger,
    });
    const started = (await deps.jobRepository.updateJob(latestRef.current.id, { action: 'start', workerSessionId })).job;
    recordUpdate(started);
    const customExecutor = customExecutors.get(latestRef.current.id) || customExecutors.get(latestRef.current.type) || null;
    await runSingleJobItems({ job: latestRef.current, signal: controller.signal, deps, customExecutor, cancelSet, workerSessionId, onJobUpdate: recordUpdate });
    if (controller.signal.aborted || isJobCancelRequested(cancelSet, latestRef.current)) throw new SynthesisCancelledError();
    const completed = (await deps.jobRepository.updateJob(latestRef.current.id, { action: 'complete' })).job;
    recordUpdate(completed);
    onJobCompleted?.(completed);
    onNotify?.({ kind: 'success', title: 'Batch job completed', message: `${completed.title} finished cleanly.` });
    return { shouldContinue: true };
  } catch (err) {
    const outcome = await finalizeJobFailure({
      repo: deps.jobRepository, job: latestRef.current, err, workerSessionId, claimed,
      cancelSet, mountedRef, onJobUpdate: recordUpdate, onProjectUpdated, onNotify, logger: deps.logger,
    });
    return { shouldContinue: outcome.persisted };
  } finally {
    if (heartbeat !== undefined) globalThis.clearInterval?.(heartbeat);
    abortControllers.delete(initialJob.id);
    cancelSet.delete(initialJob.id);
  }
}

async function recoverStaleSessionJobs(repo, items, sessionCtx, logger) {
  let recoveredAny = false;
  for (const job of items) {
    if (!isJobWorkerStale(job, sessionCtx)) continue;
    try {
      await repo.interruptJob(job.id, {
        reason: 'Interrupted by browser reload or session disconnect. Retry to resume remaining items.',
        ...(job.revision ? { expectedRevision: job.revision } : {}),
      });
      recoveredAny = true;
    } catch (err) {
      if (isConflictErr(err)) {
        logger?.debug?.('useProductionJobs.recoverStaleSessionJobs', err?.message || 'Job already transitioned', { jobId: job.id });
        recoveredAny = true;
        continue;
      }
      throw err;
    }
  }
  return recoveredAny;
}

/**
 * Presentation hook orchestrating durable production batch jobs, bounded FIFO execution, cancellation, retry, and restart recovery.
 * Inputs: `{ jobRepository, projectRepository, assetRepository, synthesizeSpeech, mediaSubtitleGateway, voiceLibrary, voiceAnchors, initialJobs, autoRecover, autoRun, onNotify, onJobCompleted, logger }`.
 * Outputs: job state (`jobs`, `filteredJobs`, `summary`, `loading`, `busy`, `error`, `filterStatus`), queue actions (`enqueueJob`, `cancelJob`, `retryJob`, `retryAllInterrupted`, `deleteJob`, `clearHistory`, `refreshJobs`, `registerExecutor`).
 * Side effects: communicates with `/api/v1/jobs`, executes queued jobs sequentially (`concurrency = 1`), saves durable assets & projects.
 * Failure modes: surfaces API/execution errors via `error` and `onNotify` without losing completed job items or artifacts.
 * @param {object} [options={}] - Hook dependencies and configuration.
 * @returns {object} Production jobs controller.
 */
export function useProductionJobs(options = {}) {
  const deps = useResolvedJobDeps(options);
  const { initialJobs = [], enabled = true, autoRecover = true, autoRun = true, onNotify = null, onJobCompleted = null, onProjectUpdated = null } = options;
  const [jobs, setJobs] = useState(initialJobs);
  const [summary, setSummary] = useState(() => summarizeJobs(initialJobs));
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [filterStatus, setFilterStatus] = useState('all');

  const workerSessionId = useMemo(() => options.workerSessionId || createWorkerSessionId(), [options.workerSessionId]);
  const sessionCheckedRef = useRef(false);
  const previousSessionRef = useRef('');
  if (enabled && !sessionCheckedRef.current) {
    sessionCheckedRef.current = true;
    previousSessionRef.current = readPreviousTabSession(workerSessionId);
  }

  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const callbacksRef = useRef({ onNotify, onJobCompleted, onProjectUpdated });
  callbacksRef.current = { onNotify, onJobCompleted, onProjectUpdated };
  const autoRunRef = useRef(autoRun);
  autoRunRef.current = autoRun;
  const pumpingRef = useRef(false);
  const pumpingPromiseRef = useRef(null);
  const mountedRef = useRef(true);
  const cancelSetRef = useRef(new Set());
  const abortControllersRef = useRef(new Map());
  const abortHandlersRef = useRef(new Map());
  const customExecutorsRef = useRef(new Map());
  const pumpQueueRef = useRef(null);

  const applyJobsList = useCallback(next => {
    jobsRef.current = next;
    setJobs(next);
    setSummary(summarizeJobs(next));
  }, []);

  const upsertLocalJob = useCallback(updated => {
    if (!updated?.id) return;
    if (updated.status === JOB_STATUS.QUEUED) cancelSetRef.current.delete(updated.id);
    const prev = jobsRef.current;
    const existing = prev.find(item => item.id === updated.id);
    if (existing && Number(updated.revision || 0) < Number(existing.revision || 0)) return;
    const next = existing ? prev.map(item => (item.id === updated.id ? updated : item)) : [updated, ...prev];
    applyJobsList(next);
  }, [applyJobsList]);

  const pumpQueue = useCallback(() => {
    if (!enabled || !autoRunRef.current || !deps.jobRepository) return Promise.resolve();
    if (pumpingPromiseRef.current) return pumpingPromiseRef.current;
    pumpingRef.current = true;
    const run = (async () => {
      try {
        while (mountedRef.current) {
          const queued = [...jobsRef.current]
            .filter(j => j.status === JOB_STATUS.QUEUED)
            .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
          if (queued.length === 0) break;
          const runOutcome = await executeOneQueuedJob({
            initialJob: queued[0],
            deps,
            workerSessionId,
            cancelSet: cancelSetRef.current,
            mountedRef,
            customExecutors: customExecutorsRef.current,
            abortControllers: abortControllersRef.current,
            onJobUpdate: upsertLocalJob,
            onProjectUpdated: job => callbacksRef.current.onProjectUpdated?.(job),
            onNotify: msg => callbacksRef.current.onNotify?.(msg),
            onJobCompleted: job => callbacksRef.current.onJobCompleted?.(job),
          });
          if (!runOutcome?.shouldContinue) break;
        }
      } finally {
        pumpingRef.current = false;
        pumpingPromiseRef.current = null;
      }
    })();
    pumpingPromiseRef.current = run;
    return run;
  }, [enabled, deps, workerSessionId, upsertLocalJob]);
  pumpQueueRef.current = pumpQueue;

  const refreshJobs = useCallback(async () => {
    if (!enabled || !deps.jobRepository) return [];
    setLoading(true);
    setError(null);
    try {
      let page = await deps.jobRepository.listJobs({ limit: 100, offset: 0 });
      let items = page.items || [];
      const activeJobIds = new Set([...abortControllersRef.current.keys(), ...abortHandlersRef.current.keys()]);
      const sessionCtx = { currentSessionId: workerSessionId, previousSessionId: previousSessionRef.current, activeJobIds };
      if (autoRecover && await recoverStaleSessionJobs(deps.jobRepository, items, sessionCtx, deps.logger)) {
        page = await deps.jobRepository.listJobs({ limit: 100, offset: 0 });
        items = page.items || items;
      }
      if (!mountedRef.current) return items;
      const prevById = new Map(jobsRef.current.map(item => [item.id, item]));
      let keptNewerLocal = false;
      const mergedItems = items.map(item => {
        const local = prevById.get(item.id);
        if (local && Number(local.revision || 0) > Number(item.revision || 0)) {
          keptNewerLocal = true;
          return local;
        }
        return item;
      });
      jobsRef.current = mergedItems;
      setJobs(mergedItems);
      setSummary(!keptNewerLocal && page.summary ? page.summary : summarizeJobs(mergedItems));
      if (autoRunRef.current && mergedItems.some(j => j.status === JOB_STATUS.QUEUED)) void pumpQueueRef.current?.();
      return mergedItems;
    } catch (err) {
      if (mountedRef.current) setError(err?.message || 'Could not load batch jobs.');
      deps.logger?.error?.('useProductionJobs.refreshJobs', err);
      return [];
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [enabled, deps.jobRepository, deps.logger, autoRecover, workerSessionId]);

  useEffect(() => {
    mountedRef.current = true;
    if (enabled) void refreshJobs();
    const controllers = abortControllersRef.current;
    return () => {
      mountedRef.current = false;
      for (const ctrl of controllers.values()) ctrl.abort();
      controllers.clear();
    };
  }, [enabled, refreshJobs]);

  const registerExecutor = useCallback((key, fn) => {
    if (!key) return;
    if (typeof fn === 'function') customExecutorsRef.current.set(key, fn);
    else customExecutorsRef.current.delete(key);
  }, []);

  const registerAbortHandler = useCallback((jobId, fn) => {
    if (!jobId) return;
    if (typeof fn === 'function') abortHandlersRef.current.set(jobId, fn);
    else abortHandlersRef.current.delete(jobId);
  }, []);

  const enqueueJob = useCallback(async (spec, itemExecutor = null) => {
    if (!deps.jobRepository) return null;
    setBusy(true);
    setError(null);
    try {
      const { job } = await deps.jobRepository.enqueueJob(spec);
      if (typeof itemExecutor === 'function') customExecutorsRef.current.set(job.id, itemExecutor);
      upsertLocalJob(job);
      void pumpQueue();
      return job;
    } catch (err) {
      setError(err?.message || 'Could not queue batch job.');
      deps.logger?.error?.('useProductionJobs.enqueueJob', err);
      callbacksRef.current.onNotify?.({ kind: 'error', title: 'Queue full or invalid job', message: err?.message || 'Could not queue batch job.' });
      return null;
    } finally {
      setBusy(false);
    }
  }, [deps.jobRepository, deps.logger, upsertLocalJob, pumpQueue]);

  const cancelJob = useCallback(async jobId => {
    if (!deps.jobRepository || !jobId) return null;
    const hasLocalPump = abortControllersRef.current.has(jobId);
    if (hasLocalPump) cancelSetRef.current.add(jobId);
    abortControllersRef.current.get(jobId)?.abort();
    abortHandlersRef.current.get(jobId)?.();
    try {
      const { job } = await deps.jobRepository.cancelJob(jobId);
      if (job?.status === JOB_STATUS.CANCELLED) cancelSetRef.current.delete(jobId);
      upsertLocalJob(job);
      return job;
    } catch (err) {
      if (err instanceof ConflictError || err?.status === 409) {
        const latest = await deps.jobRepository.getJob(jobId).catch(readErr => {
          deps.logger?.debug?.('useProductionJobs.cancelJobRefresh', readErr?.message || 'Could not reload conflicted job', { jobId });
          return null;
        });
        if (latest) {
          if (!ACTIVE_JOB_STATUSES.has(latest.status)) cancelSetRef.current.delete(jobId);
          upsertLocalJob(latest);
        }
        return latest;
      }
      cancelSetRef.current.delete(jobId);
      setError(err?.message || 'Could not cancel job.');
      deps.logger?.error?.('useProductionJobs.cancelJob', err, { jobId });
      return null;
    }
  }, [deps.jobRepository, deps.logger, upsertLocalJob]);

  const retryJob = useCallback(async jobId => {
    if (!deps.jobRepository || !jobId) return null;
    cancelSetRef.current.delete(jobId);
    setBusy(true);
    setError(null);
    try {
      const { job } = await deps.jobRepository.retryJob(jobId);
      cancelSetRef.current.delete(jobId);
      upsertLocalJob(job);
      callbacksRef.current.onNotify?.({ kind: 'info', title: 'Job re-queued', message: `Resuming "${job.title}" without duplicating completed items.` });
      void pumpQueue();
      return job;
    } catch (err) {
      setError(err?.message || 'Could not retry job.');
      deps.logger?.error?.('useProductionJobs.retryJob', err, { jobId });
      callbacksRef.current.onNotify?.({ kind: 'error', title: 'Retry failed', message: err?.message || 'Could not retry job.' });
      return null;
    } finally {
      setBusy(false);
    }
  }, [deps.jobRepository, deps.logger, upsertLocalJob, pumpQueue]);

  const retryAllInterrupted = useCallback(async () => {
    const targets = jobsRef.current.filter(
      job => job.status === JOB_STATUS.INTERRUPTED && (job.retryCount || 0) < (job.maxRetries ?? DEFAULT_MAX_RETRIES)
    );
    const retried = [];
    for (const target of targets) {
      const next = await retryJob(target.id);
      if (next) retried.push(next);
    }
    return retried;
  }, [retryJob]);

  const deleteJob = useCallback(async jobId => {
    if (!deps.jobRepository || !jobId) return false;
    setError(null);
    try {
      await deps.jobRepository.deleteJob(jobId);
      applyJobsList(jobsRef.current.filter(job => job.id !== jobId));
      return true;
    } catch (err) {
      setError(err?.message || 'Could not remove job.');
      deps.logger?.error?.('useProductionJobs.deleteJob', err, { jobId });
      return false;
    }
  }, [deps.jobRepository, deps.logger, applyJobsList]);

  const clearHistory = useCallback(async () => {
    if (!deps.jobRepository) return 0;
    setBusy(true);
    setError(null);
    try {
      const { clearedCount } = await deps.jobRepository.clearHistory();
      await refreshJobs();
      return clearedCount;
    } catch (err) {
      setError(err?.message || 'Could not clear job history.');
      deps.logger?.error?.('useProductionJobs.clearHistory', err);
      return 0;
    } finally {
      setBusy(false);
    }
  }, [deps.jobRepository, deps.logger, refreshJobs]);

  const filteredJobs = useMemo(() => filterJobsByStatus(jobs, filterStatus), [jobs, filterStatus]);
  const interruptedCount = summary.interrupted || 0;
  const retryableInterruptedCount = useMemo(
    () => jobs.filter(
      job => job.status === JOB_STATUS.INTERRUPTED && (job.retryCount || 0) < (job.maxRetries ?? DEFAULT_MAX_RETRIES)
    ).length,
    [jobs]
  );
  const badgeCount = (summary.active || 0) + interruptedCount;
  const hasClearableHistory = useMemo(
    () => jobs.some(job => PRUNABLE_HISTORY_STATUSES.has(job.status)),
    [jobs]
  );

  return {
    jobs,
    filteredJobs,
    summary,
    badgeCount,
    interruptedCount,
    retryableInterruptedCount,
    hasClearableHistory,
    loading,
    busy,
    error,
    setError,
    filterStatus,
    setFilterStatus,
    workerSessionId,
    refreshJobs,
    syncJob: upsertLocalJob,
    enqueueJob,
    cancelJob,
    retryJob,
    retryAllInterrupted,
    deleteJob,
    clearHistory,
    registerExecutor,
    registerAbortHandler,
    pumpQueue,
  };
}
