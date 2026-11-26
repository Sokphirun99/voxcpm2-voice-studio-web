/**
 * @fileoverview Presentation hook managing multi-speaker video subtitle extraction, live VTT preview, editing, translation, and MP4 burn-in.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createMediaSubtitleGateway } from '../../data/mediaSubtitleGateway.js';
import {
  DEFAULT_ENGLISH_TARGET,
  DEFAULT_KHMER_TARGET,
  MAX_SUBTITLE_FILE_BYTES,
  SUBTITLE_STYLE_DEFAULTS,
  adjustCuePause,
  adjustSubtitleSegmentTiming,
  applySpellingTermsToSegments,
  applyTranslationTermsToSegments,
  buildBoundedTtsHandoff,
  buildDialogueText,
  buildSrt,
  buildVtt,
  collectUniqueSpeakers,
  countTextMatchesInSegments,
  deleteSubtitleSegment,
  extendAllSafeMismatches,
  extendCueAndShiftLater,
  extendCueToSpeech,
  findActiveSegmentId,
  isAudioOnlyFile,
  isSameSubtitleLanguage,
  mergeSubtitleSegmentWithNext,
  normalizeTargetLanguageCode,
  parseSubtitleFileText,
  pickDefaultTargetLanguage,
  pickSegmentText,
  replaceTextInSegments,
  resolveCueOverlaps,
  resolveTargetLanguageMeta,
  shiftCueStartEarlier,
  splitSubtitleSegment,
} from '../../domain/subtitles.js';
import { ValidationError } from '../../domain/errors.js';
import {
  DEFAULT_DUB_MIX_SETTINGS,
  DEFAULT_DUB_SUBTITLE_MODE,
  EXPORT_PRESET_IDS,
  VIDEO_AUDIO_MODES,
  VIDEO_SUBTITLE_MODES,
  formatPresetFilename,
  normalizeDubMixSettings,
  normalizeExportHistory,
  normalizeVideoAudioMode,
  normalizeVideoSubtitleMode,
  recordPresetExport,
  resolveExportFilenameStem,
  resolvePresetLanguageInfo,
} from '../../domain/exportPresets.js';
import { assertFeatureOfflineReady } from '../../domain/offlineReadiness.js';
import { createSubtitleProjectSnapshot } from '../../domain/projects.js';
import {
  TERM_CATEGORIES,
  createEmptyProjectTerminology,
  inspectSegmentTerminology,
  normalizeProjectTerminology,
} from '../../domain/terminology.js';
import { useStudioServices } from '../StudioContext.jsx';
import { useProjectAutosave } from './useProjectAutosave.js';
import { useProjectRecovery } from './useProjectRecovery.js';

const MAX_CLIENT_VIDEO_BYTES = 500 * 1024 * 1024;
const ALLOWED_EXT_PATTERN = /\.(mp4|mov|m4v|webm|mkv|avi|mp3|wav|m4a|aac|ogg|flac)$/i;
const MEDIA_OFFLINE_POLL_MS = 10000;
const VTT_PREVIEW_DEBOUNCE_MS = 200;
const DEFAULT_OPTIONS = Object.freeze({
  sourceLanguage: 'km',
  targetLanguage: DEFAULT_ENGLISH_TARGET,
  detectSpeakers: false,
  speakerCount: '0',
  doubleCheckKhmer: false,
  translateToKhmer: false,
  includeSpeaker: false,
  previewMode: 'original',
  subtitleStyle: SUBTITLE_STYLE_DEFAULTS,
  dubAudioMode: VIDEO_AUDIO_MODES.DUCK,
  dubSubtitleMode: DEFAULT_DUB_SUBTITLE_MODE,
  dubMixSettings: DEFAULT_DUB_MIX_SETTINGS,
});

function formatElapsedSec(startedAt) {
  return ((Date.now() - startedAt) / 1000).toFixed(1);
}

function hasAnyTranslatedText(segments) {
  return Array.isArray(segments) && segments.some(seg => Boolean(seg?.translatedText?.trim()));
}

function restoreTaskTranslation(prev, resetTranslationOnStart, hadTranslation) {
  if (!resetTranslationOnStart) return prev.hasTranslation;
  return prev.segments.length > 0 ? hadTranslation : false;
}

function restoreTaskTranslatedLang(prev, resetTranslationOnStart, hadTranslatedLanguage) {
  if (!resetTranslationOnStart) return prev.translatedLanguage;
  return prev.segments.length > 0 ? hadTranslatedLanguage : '';
}

function handleSubtitleTaskError({ err, setState, resetTranslationOnStart, hadTranslation, hadTranslatedLanguage = '', cancelMessage, errorTitle, fallbackError, onError, onNotify }) {
  if (err?.name === 'SynthesisCancelledError') {
    setState(prev => ({
      ...prev,
      busyAction: '',
      hasTranslation: restoreTaskTranslation(prev, resetTranslationOnStart, hadTranslation),
      translatedLanguage: restoreTaskTranslatedLang(prev, resetTranslationOnStart, hadTranslatedLanguage),
      status: { message: cancelMessage, error: false },
    }));
    return;
  }
  const isMissingModel = err?.name === 'OfflineModelMissingError' || err?.code === 'OFFLINE_MODEL_MISSING';
  const errMsg = err?.message || fallbackError;
  const title = isMissingModel ? 'Model download required' : errorTitle;
  if (!isMissingModel) onError?.();
  setState(prev => ({
    ...prev,
    busyAction: '',
    hasTranslation: restoreTaskTranslation(prev, resetTranslationOnStart, hadTranslation),
    translatedLanguage: restoreTaskTranslatedLang(prev, resetTranslationOnStart, hadTranslatedLanguage),
    status: { message: errMsg, error: true },
  }));
  onNotify?.({ kind: 'error', title, message: errMsg });
}

function assertNotAborted(signal) {
  if (!signal?.aborted) return;
  const err = new Error('Operation cancelled.');
  err.name = 'SynthesisCancelledError';
  throw err;
}

function beginSubtitleTask({ abortRef, setState, setBusyMeta, busyAction, baseMessage, resetTranslationOnStart }) {
  abortRef.current?.abort();
  const controller = new AbortController();
  abortRef.current = controller;
  setBusyMeta({ startedAt: Date.now(), message: baseMessage });
  setState(prev => ({
    ...prev,
    busyAction,
    hasTranslation: resetTranslationOnStart ? false : prev.hasTranslation,
    translatedLanguage: resetTranslationOnStart ? '' : prev.translatedLanguage,
    status: { message: baseMessage, error: false },
  }));
  return controller;
}

async function runSubtitleTask({ abortRef, setState, setBusyMeta, busyAction, baseMessage, cancelMessage, errorTitle, fallbackError, resetTranslationOnStart = false, hadTranslation = false, hadTranslatedLanguage = '', onError, onNotify, onUnlockSound, throwOnError = false, run }) {
  onUnlockSound?.();
  const startedAt = Date.now();
  const controller = beginSubtitleTask({ abortRef, setState, setBusyMeta, busyAction, baseMessage, resetTranslationOnStart });
  try {
    await run(controller.signal, () => formatElapsedSec(startedAt));
  } catch (err) {
    if (abortRef.current !== controller) return;
    handleSubtitleTaskError({ err, setState, resetTranslationOnStart, hadTranslation, hadTranslatedLanguage, cancelMessage, errorTitle, fallbackError, onError, onNotify });
    if (throwOnError && err?.name !== 'SynthesisCancelledError') throw err;
  } finally {
    if (abortRef.current === controller) {
      setBusyMeta(null);
      abortRef.current = null;
    }
  }
}

function revokeUrl(url) {
  if (url && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(url);
  }
}

function buildExportName(file, suffix, fallbackName = '') {
  const sourceName = file?.name || fallbackName || 'video';
  const stem = sourceName.replace(/\.[^.]+$/, '') || 'video';
  return `${stem}${suffix}`;
}

function buildExportPayload(format, videoFile, spec, { fallbackName = '', filenameOverride = '' } = {}) {
  if (format === 'srt') {
    return {
      data: buildSrt(spec),
      mimeType: 'application/x-subrip;charset=utf-8',
      filename: filenameOverride || buildExportName(videoFile, '.srt', fallbackName),
    };
  }
  if (format === 'vtt') {
    return {
      data: buildVtt(spec),
      mimeType: 'text/vtt;charset=utf-8',
      filename: filenameOverride || buildExportName(videoFile, '.vtt', fallbackName),
    };
  }
  return {
    data: buildDialogueText({ ...spec, includeTimestamps: true }),
    mimeType: 'text/plain;charset=utf-8',
    filename: filenameOverride || buildExportName(videoFile, '-dialogue.txt', fallbackName),
  };
}

function assertExtractionOfflineReady(options, models, isOnline) {
  assertFeatureOfflineReady({ featureId: 'transcription_whisper', models, isOnline });
  if (options.sourceLanguage === 'km' || Boolean(options.doubleCheckKhmer)) {
    assertFeatureOfflineReady({ featureId: 'transcription_khmer', models, isOnline });
  }
  if (Boolean(options.detectSpeakers) && options.speakerCount !== '1') {
    assertFeatureOfflineReady({ featureId: 'diarization', models, isOnline });
  }
  if (Boolean(options.translateToKhmer)) {
    assertFeatureOfflineReady({ featureId: 'translation', models, isOnline });
  }
}

function downloadBlobOrText({ data, mimeType, filename }) {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  const blob = data instanceof Blob ? data : new Blob([data], { type: mimeType });
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  globalThis.setTimeout?.(() => URL.revokeObjectURL(href), 1500);
}

/**
 * Resolves active subtitle translation/bilingual flags from sticky translation availability and preview mode.
 * @param {boolean} hasTranslated - Sticky translation availability for the current subtitle set.
 * @param {string} previewMode - Active preview mode (`'original'`, `'translated'`, or `'bilingual'`).
 * @returns {{ hasTranslated: boolean, bilingual: boolean, useTranslation: boolean }} Derived translation flags.
 */
export function resolveTranslationFlags(hasTranslated, previewMode) {
  const hasTranslation = Boolean(hasTranslated);
  const bilingual = previewMode === 'bilingual' && hasTranslation;
  const useTranslation = (previewMode === 'translated' || bilingual) && hasTranslation;
  return { hasTranslated: hasTranslation, bilingual, useTranslation };
}

function resolveSubtitleGateway(services) {
  if (services?.mediaSubtitleGateway) return services.mediaSubtitleGateway;
  return createMediaSubtitleGateway({ logger: services?.logger });
}

function subscribeVisibilityRecheck(poll) {
  if (typeof document === 'undefined') return () => {};
  const onVisible = () => { if (document.visibilityState === 'visible') poll(); };
  document.addEventListener('visibilitychange', onVisible);
  globalThis.addEventListener?.('focus', poll);
  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    globalThis.removeEventListener?.('focus', poll);
  };
}

function useMediaHealthState(gateway) {
  const [health, setHealth] = useState({ checked: false, online: true, burnInSupported: true, diarizationReady: false, models: null, reason: '' });
  const mountedRef = useRef(true);
  const seqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (!gateway?.checkHealth) return;
    const seq = ++seqRef.current;
    try {
      const next = await gateway.checkHealth();
      if (!mountedRef.current || seq !== seqRef.current) return;
      setHealth(prev => ({
        burnInSupported: prev.burnInSupported,
        diarizationReady: prev.diarizationReady,
        reason: '',
        ...next,
        checked: true,
      }));
    } catch (err) {
      if (!mountedRef.current || seq !== seqRef.current) return;
      setHealth(prev => ({
        ...prev,
        checked: true,
        online: false,
        reason: err?.message || 'Cannot reach local video subtitle service on port 8810.',
      }));
    }
  }, [gateway]);

  const markOnline = useCallback(() => {
    seqRef.current += 1;
    setHealth(prev => (prev.checked && prev.online && !prev.reason ? prev : { ...prev, checked: true, online: true, reason: '' }));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!health.checked || health.online || !gateway?.checkHealth) return undefined;
    const poll = () => { void refresh(); };
    const timer = globalThis.setInterval?.(poll, MEDIA_OFFLINE_POLL_MS);
    const cleanupVisibility = subscribeVisibilityRecheck(poll);
    return () => {
      if (timer !== undefined) globalThis.clearInterval?.(timer);
      cleanupVisibility();
    };
  }, [health.checked, health.online, gateway, refresh]);

  return [health, refresh, markOnline];
}

function useVttPreviewUrl({ segments, speakerNames, includeSpeaker, useTranslation, bilingual, hasSubtitleText, language = '' }) {
  const [vttUrl, setVttUrl] = useState('');
  const lastModeRef = useRef('');
  const lastVttTextRef = useRef('');
  const activeUrlRef = useRef('');
  const vttUrlRef = useRef('');
  const timerRef = useRef(undefined);

  vttUrlRef.current = vttUrl;

  useEffect(() => () => revokeUrl(vttUrl), [vttUrl]);
  useEffect(() => () => {
    if (activeUrlRef.current && activeUrlRef.current !== vttUrlRef.current) {
      revokeUrl(activeUrlRef.current);
    }
    activeUrlRef.current = '';
    lastVttTextRef.current = '';
    lastModeRef.current = '';
  }, []);

  useEffect(() => {
    if (timerRef.current !== undefined) {
      globalThis.clearTimeout?.(timerRef.current);
      timerRef.current = undefined;
    }
    if (typeof URL === 'undefined' || typeof Blob === 'undefined' || !hasSubtitleText) {
      lastModeRef.current = '';
      lastVttTextRef.current = '';
      activeUrlRef.current = '';
      setVttUrl('');
      return undefined;
    }

    const modeKey = `${includeSpeaker ? 1 : 0}:${useTranslation ? 1 : 0}:${bilingual ? 1 : 0}:${language || ''}`;
    const shouldUpdateImmediately = !activeUrlRef.current || lastModeRef.current !== modeKey;

    const commitVtt = () => {
      timerRef.current = undefined;
      const vttText = buildVtt({ segments, speakerNames, includeSpeaker, useTranslation, bilingual, language });
      lastModeRef.current = modeKey;
      if (vttText === lastVttTextRef.current && activeUrlRef.current) return;
      lastVttTextRef.current = vttText;
      const nextUrl = URL.createObjectURL(new Blob([vttText], { type: 'text/vtt;charset=utf-8' }));
      activeUrlRef.current = nextUrl;
      setVttUrl(nextUrl);
    };

    if (shouldUpdateImmediately || typeof globalThis.setTimeout !== 'function') {
      commitVtt();
      return undefined;
    }

    timerRef.current = globalThis.setTimeout(commitVtt, VTT_PREVIEW_DEBOUNCE_MS);
    return () => {
      if (timerRef.current !== undefined) {
        globalThis.clearTimeout?.(timerRef.current);
        timerRef.current = undefined;
      }
    };
  }, [segments, speakerNames, includeSpeaker, useTranslation, bilingual, hasSubtitleText, language]);

  return vttUrl;
}

/**
 * Formats extraction completion summary for status text and notification toasts.
 * @param {number} segmentCount - Extracted segment count.
 * @param {number} speakerCount - Detected speaker count.
 * @param {string} elapsed - Formatted elapsed seconds string.
 * @returns {string} Summary copy with singular/plural segment noun.
 */
export function buildExtractSummary(segmentCount, speakerCount, elapsed, verificationSummary = null) {
  const segmentLabel = segmentCount === 1 ? 'segment' : 'segments';
  const spkNote = speakerCount > 1 ? ` (${speakerCount} speakers)` : '';
  const extras = [];
  const recovered = Number(verificationSummary?.fallbackApplied) || 0;
  const suggestions = Number(verificationSummary?.suggestions) || 0;
  if (recovered > 0) extras.push(`${recovered} recovered by Whisper`);
  if (suggestions > 0) extras.push(`${suggestions} Whisper ${suggestions === 1 ? 'suggestion' : 'suggestions'}`);
  const suffix = extras.length ? ` · ${extras.join(' · ')}` : '';
  return `Extracted ${segmentCount} subtitle ${segmentLabel}${spkNote} in ${elapsed}s${suffix}.`;
}

function applyExtractedSubtitleResult(prev, res, targetLanguage, elapsed) {
  const detectedLanguage = res.language || prev.options.sourceLanguage;
  const segments = Array.isArray(res.segments) ? res.segments : [];
  const hasSegmentTranslation = hasAnyTranslatedText(segments);
  const rawTarget = res.translatedLanguage || targetLanguage;
  const resolvedTarget = rawTarget ? normalizeTargetLanguageCode(rawTarget) : '';
  const hasTranslated = Boolean(resolvedTarget) && !isSameSubtitleLanguage(detectedLanguage, resolvedTarget) && hasSegmentTranslation;
  const speakerCount = Array.isArray(res.speakers) ? res.speakers.length : collectUniqueSpeakers(segments).length;
  const nextIncludeSpeaker = (prev.options.detectSpeakers || speakerCount > 1) ? prev.options.includeSpeaker : false;
  const nextTargetOption = pickDefaultTargetLanguage(detectedLanguage, prev.options.targetLanguage);
  return {
    ...prev,
    jobId: res.jobId || '',
    detectedLanguage,
    isAudioOnly: Boolean(res.isAudioOnly) || isAudioOnlyFile(prev.videoFile),
    hasAudioStream: res.hasAudioStream !== false,
    videoSize: res.videoSize !== undefined ? res.videoSize : prev.videoSize,
    segments,
    hasTranslation: hasSegmentTranslation,
    translatedLanguage: hasSegmentTranslation ? (resolvedTarget || prev.options.targetLanguage) : '',
    speakerNames: {},
    options: {
      ...prev.options,
      targetLanguage: nextTargetOption,
      includeSpeaker: nextIncludeSpeaker,
      previewMode: hasTranslated ? 'translated' : 'original',
    },
    busyAction: '',
    status: { message: buildExtractSummary(segments.length, speakerCount, elapsed, res.verificationSummary), error: false },
  };
}

function toMediaTerminologyPayload(effectiveTerms) {
  if (!Array.isArray(effectiveTerms) || effectiveTerms.length === 0) return null;
  const filtered = effectiveTerms
    .filter(item => item && item.category !== TERM_CATEGORIES.PRONUNCIATION && item.status === 'approved' && item.enabled !== false && !item.isDisabledInProject)
    .map(item => ({
      id: item.id,
      category: item.category,
      status: item.status,
      enabled: true,
      term: item.term,
      variants: Array.isArray(item.variants) ? [...item.variants] : [],
      translation: item.translation || '',
      preserveInTranslation: Boolean(item.preserveInTranslation),
      sourceLanguage: item.sourceLanguage || '',
      targetLanguage: item.targetLanguage || '',
      caseSensitive: Boolean(item.caseSensitive),
      scope: item.scope || 'global',
      isDisabledInProject: false,
    }));
  return filtered.length > 0 ? filtered : null;
}

function useSubtitleAsyncActions({ state, stateRef, setState, setBusyMeta, setActiveSegmentId, mediaDuration, setMediaDuration, bumpTranscriptEpoch, effectiveIncludeSpeaker, hasSubtitleText, effectiveTermsRef, gateway, abortRef, health, refreshHealth, markOnline, onNotify, onUnlockSound }) {
  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, [abortRef]);

  const extractSubtitles = useCallback(async () => {
    const live = stateRef?.current ?? state;
    if (!live.videoFile) return;
    const relinkingProject = Boolean(!live.jobId && live.segments.length);
    const hadTranslation = Boolean(live.hasTranslation);
    const hadTranslatedLanguage = live.translatedLanguage;
    const targetLanguage = normalizeTargetLanguageCode(live.options.targetLanguage);
    const shouldTranslate = Boolean(live.options.translateToKhmer)
      && !isSameSubtitleLanguage(live.options.sourceLanguage, targetLanguage);
    const diarize = Boolean(live.options.detectSpeakers) && live.options.speakerCount !== '1';
    const numSpeakers = diarize ? (Number(live.options.speakerCount) || 0) : 1;
    await runSubtitleTask({
      abortRef, setState, setBusyMeta, busyAction: 'extract',
      baseMessage: relinkingProject
        ? 'Linking video to the saved subtitle project…'
        : diarize ? 'Extracting subtitles & detecting speakers…' : 'Extracting subtitles…',
      cancelMessage: 'Subtitle extraction cancelled.',
      errorTitle: relinkingProject ? 'Video relink failed' : 'Subtitle extraction failed',
      fallbackError: relinkingProject ? 'Could not link video to the saved subtitle project.' : 'Subtitle extraction failed.',
      resetTranslationOnStart: !relinkingProject,
      hadTranslation,
      hadTranslatedLanguage,
      onError: () => void refreshHealth(),
      onNotify, onUnlockSound,
      run: async (signal, elapsedSecs) => {
        const isOnline = typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? navigator.onLine : true;
        if (!relinkingProject) {
          assertExtractionOfflineReady(state.options, health.models, isOnline);
        }
        const res = await gateway.transcribeVideo({
          file: state.videoFile,
          language: state.options.sourceLanguage,
          numSpeakers: relinkingProject ? 1 : numSpeakers,
          diarize: relinkingProject ? false : diarize,
          doubleCheck: relinkingProject ? false : Boolean(state.options.doubleCheckKhmer),
          translateTo: relinkingProject ? '' : shouldTranslate ? targetLanguage : '',
          translateToKhmer: !relinkingProject && shouldTranslate && targetLanguage === 'khm_Khmr',
          terminology: relinkingProject ? null : toMediaTerminologyPayload(effectiveTermsRef?.current),
          signal,
        });
        assertNotAborted(signal);
        markOnline();
        const elapsed = elapsedSecs();
        const segs = Array.isArray(res.segments) ? res.segments : [];
        const spkCount = Array.isArray(res.speakers) ? res.speakers.length : collectUniqueSpeakers(segs).length;
        const probedDur = Number(res.duration);
        if (Number.isFinite(probedDur) && probedDur > 0) setMediaDuration?.(probedDur);
        setActiveSegmentId('');
        if (relinkingProject) {
          setState(prev => ({
            ...prev,
            jobId: res.jobId || '',
            hasAudioStream: res.hasAudioStream !== false,
            videoSize: res.videoSize || prev.videoSize,
            hasTranslation: prev.hasTranslation,
            translatedLanguage: prev.translatedLanguage,
            busyAction: '',
            status: { message: `Video linked to saved project in ${elapsed}s. Existing subtitle edits were preserved.`, error: false },
          }));
          onNotify?.({ kind: 'success', title: 'Video linked', message: 'Saved subtitle edits are ready for MP4 burn-in.' });
          return;
        }
        bumpTranscriptEpoch?.();
        setState(prev => applyExtractedSubtitleResult(prev, res, shouldTranslate ? targetLanguage : '', elapsed));
        onNotify?.({ kind: 'success', title: 'Subtitles ready', message: buildExtractSummary(segs.length, spkCount, elapsed, res.verificationSummary) });
      },
    });
  }, [state.videoFile, state.jobId, state.segments.length, state.options, state.hasTranslation, state.translatedLanguage, stateRef, gateway, abortRef, setState, setBusyMeta, setActiveSegmentId, setMediaDuration, bumpTranscriptEpoch, refreshHealth, markOnline, onNotify, onUnlockSound]);

  const translateNow = useCallback(async () => {
    if (!state.segments.length) return;
    const sourceLang = state.detectedLanguage && state.detectedLanguage !== 'auto' ? state.detectedLanguage : state.options.sourceLanguage;
    const targetLanguage = normalizeTargetLanguageCode(state.options.targetLanguage);
    const targetMeta = resolveTargetLanguageMeta(targetLanguage);
    await runSubtitleTask({
      abortRef, setState, setBusyMeta, busyAction: 'translate',
      baseMessage: `Translating subtitles into ${targetMeta.shortLabel} offline…`,
      cancelMessage: 'Translation cancelled.',
      errorTitle: 'Translation failed',
      fallbackError: 'Translation failed.',
      onError: () => void refreshHealth(),
      onNotify, onUnlockSound,
      run: async (signal, elapsedSecs) => {
        const isOnline = typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? navigator.onLine : true;
        assertFeatureOfflineReady({ featureId: 'translation', models: health.models, isOnline });
        const res = await gateway.translateSegments({
          segments: state.segments,
          sourceLanguage: sourceLang === 'auto' ? 'en' : sourceLang,
          targetLanguage,
          terminology: toMediaTerminologyPayload(effectiveTermsRef?.current),
          signal,
        });
        assertNotAborted(signal);
        markOnline();
        const summary = `Translated dialogue lines to ${targetMeta.shortLabel} in ${elapsedSecs()}s.`;
        setState(prev => {
          const nextSegments = Array.isArray(res.segments) ? res.segments : prev.segments;
          return {
            ...prev,
            segments: nextSegments,
            hasTranslation: nextSegments.length > 0,
            translatedLanguage: nextSegments.length > 0 ? targetLanguage : '',
            options: {
              ...prev.options,
              previewMode: prev.options.previewMode === 'bilingual' ? 'bilingual' : 'translated',
              translateToKhmer: true,
            },
            busyAction: '',
            status: { message: summary, error: false },
          };
        });
        onNotify?.({ kind: 'success', title: `${targetMeta.shortLabel} translation ready`, message: summary });
      },
    });
  }, [state.segments, state.detectedLanguage, state.options.sourceLanguage, state.options.targetLanguage, gateway, abortRef, setState, setBusyMeta, refreshHealth, markOnline, onNotify, onUnlockSound]);

  const burnVideo = useCallback(async (overrides = null) => {
    const throwOnError = Boolean(overrides?.throwOnError);
    if (!state.videoFile || !state.jobId || !hasSubtitleText || state.isAudioOnly) {
      if (throwOnError) {
        throw new Error('Burned-in MP4 export requires a loaded video on the media server and non-empty subtitles.');
      }
      return;
    }
    await runSubtitleTask({
      abortRef, setState, setBusyMeta, busyAction: 'burn',
      baseMessage: 'Rendering MP4 with burned-in subtitles…',
      cancelMessage: 'MP4 export cancelled.',
      errorTitle: 'MP4 export failed',
      fallbackError: 'Video subtitle burn-in failed.',
      onError: () => void refreshHealth(),
      onNotify, onUnlockSound,
      throwOnError,
      run: async (signal, elapsedSecs) => {
        const isOnline = typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? navigator.onLine : true;
        assertFeatureOfflineReady({ featureId: 'burn_in', models: { burnIn: health.burnInSupported }, isOnline });
        const defaultFlags = resolveTranslationFlags(state.hasTranslation, state.options.previewMode);
        const sourceAudioLang = (state.detectedLanguage && state.detectedLanguage !== 'auto')
          ? state.detectedLanguage
          : (state.options.sourceLanguage && state.options.sourceLanguage !== 'auto' ? state.options.sourceLanguage : '');
        const langInfo = resolvePresetLanguageInfo({
          languageMode: overrides?.languageMode,
          useTranslation: overrides?.useTranslation ?? defaultFlags.useTranslation,
          bilingual: overrides?.bilingual ?? defaultFlags.bilingual,
          detectedLanguage: sourceAudioLang,
          translatedLanguage: state.translatedLanguage,
          selectedTargetLanguage: state.options.targetLanguage,
        });
        if (!state.hasTranslation && (langInfo.useTranslation || langInfo.bilingual) && !hasAnyTranslatedText(state.segments)) {
          throw new ValidationError('Translate at least one subtitle cue before burning translated or bilingual subtitles.', 'languageMode', 'MISSING_TRANSLATION_CUES');
        }
        const includeSpeaker = overrides?.includeSpeaker ?? effectiveIncludeSpeaker;
        const audioLang = overrides?.audioLanguage ?? sourceAudioLang;
        let blob;
        try {
          blob = await gateway.burnSubtitles({
            jobId: state.jobId,
            segments: state.segments,
            speakerNames: state.speakerNames,
            includeSpeaker,
            useTranslation: langInfo.useTranslation,
            bilingual: langInfo.bilingual,
            subtitleStyle: state.options.subtitleStyle,
            videoSize: state.videoSize || undefined,
            ...(audioLang ? { audioLanguage: audioLang } : {}),
            signal,
          });
        } catch (burnErr) {
          if (burnErr?.status === 404) {
            setState(prev => (prev.jobId ? { ...prev, jobId: '' } : prev));
          }
          throw burnErr;
        }
        assertNotAborted(signal);
        markOnline();
        const filename = overrides?.filename || formatPresetFilename(EXPORT_PRESET_IDS.VIDEO_BURNED_MP4, {
          filenameStem: overrides?.filenameStem,
          videoFileName: state.videoFile?.name || state.videoFileName,
          projectTitle: state.projectTitle,
        });
        downloadBlobOrText({ data: blob, mimeType: 'video/mp4', filename });
        const maxCueEnd = state.segments.reduce((m, s) => Math.max(m, Number(s?.end) || 0), 0);
        const exportedDuration = (Number(mediaDuration) > 0 ? Number(mediaDuration) : maxCueEnd) || null;
        const summary = `Exported MP4 with burned-in subtitles in ${elapsedSecs()}s.`;
        setState(prev => ({
          ...prev,
          exportHistory: recordPresetExport(prev.exportHistory, EXPORT_PRESET_IDS.VIDEO_BURNED_MP4, {
            filename,
            durationSeconds: exportedDuration,
            languageCode: langInfo.bcp47,
            languageLabel: langInfo.label,
            audioMode: VIDEO_AUDIO_MODES.ORIGINAL,
            subtitleMode: VIDEO_SUBTITLE_MODES.BURNED,
          }),
          busyAction: '',
          status: { message: summary, error: false },
        }));
        onNotify?.({ kind: 'success', title: 'MP4 exported', message: summary });
      },
    });
  }, [state, mediaDuration, effectiveIncludeSpeaker, hasSubtitleText, health.burnInSupported, gateway, abortRef, setState, setBusyMeta, refreshHealth, markOnline, onNotify, onUnlockSound]);

  return { cancel, extractSubtitles, translateNow, burnVideo };
}

function runTimingTransform({ stateRef, setState, onNotify, transform, successMessage }) {
  try {
    const nextSegments = transform(stateRef.current.segments);
    setState(prev => ({ ...prev, segments: nextSegments, status: { message: successMessage, error: false } }));
    return true;
  } catch (err) {
    const message = err?.message || 'Could not update cue timing.';
    setState(prev => ({ ...prev, status: { message, error: true } }));
    onNotify?.({ kind: 'error', title: 'Timing adjustment unavailable', message });
    return false;
  }
}

function useSegmentEditingActions({ segments, stateRef, setState, setActiveSegmentId, useTranslation, mediaDuration, onNotify }) {
  const updateSegment = useCallback((segId, patch) => {
    setState(prev => ({
      ...prev,
      hasTranslation: prev.hasTranslation || Boolean(patch?.translatedText?.trim()),
      segments: prev.segments.map(seg => (seg.id === segId ? { ...seg, ...patch } : seg)),
    }));
  }, [setState]);

  const deleteSegment = useCallback(segId => {
    setActiveSegmentId(prev => (prev === segId ? '' : prev));
    setState(prev => {
      const nextSegments = deleteSubtitleSegment(prev.segments, segId);
      const keepTrans = nextSegments.length > 0 && prev.hasTranslation;
      return {
        ...prev,
        segments: nextSegments,
        hasTranslation: keepTrans,
        translatedLanguage: keepTrans ? prev.translatedLanguage : '',
      };
    });
  }, [setState, setActiveSegmentId]);

  const mergeSegmentWithNext = useCallback(segId => {
    setState(prev => ({ ...prev, segments: mergeSubtitleSegmentWithNext(prev.segments, segId) }));
  }, [setState]);

  const splitSegment = useCallback((segId, ratio = 0.5) => {
    setState(prev => ({ ...prev, segments: splitSubtitleSegment(prev.segments, segId, { ratio }) }));
  }, [setState]);

  const updateSegmentTiming = useCallback((segId, timingPatch, options = {}) => {
    setState(prev => ({
      ...prev,
      segments: adjustSubtitleSegmentTiming(prev.segments, segId, timingPatch, options),
    }));
  }, [setState]);

  const updateSegmentPause = useCallback((segId, pauseSec, options = {}) => {
    setState(prev => ({
      ...prev,
      segments: adjustCuePause(prev.segments, segId, pauseSec, options),
    }));
  }, [setState]);

  const resolveOverlaps = useCallback((options = {}) => {
    setState(prev => ({
      ...prev,
      segments: resolveCueOverlaps(prev.segments, options),
    }));
  }, [setState]);

  const extendSegmentToSpeech = useCallback((segId, clipDuration) => (
    runTimingTransform({
      stateRef, setState, onNotify,
      transform: list => extendCueToSpeech(list, segId, clipDuration, { mediaDuration }),
      successMessage: 'Extended subtitle cue interval to match speech duration.',
    })
  ), [stateRef, setState, mediaDuration, onNotify]);

  const extendSegmentAndShift = useCallback((segId, clipDuration) => (
    runTimingTransform({
      stateRef, setState, onNotify,
      transform: list => extendCueAndShiftLater(list, segId, clipDuration, { mediaDuration }),
      successMessage: 'Extended cue and shifted later subtitles to resolve overlap.',
    })
  ), [stateRef, setState, mediaDuration, onNotify]);

  const shiftSegmentEarlier = useCallback((segId, clipDuration, segmentClips = null) => (
    runTimingTransform({
      stateRef, setState, onNotify,
      transform: list => shiftCueStartEarlier(list, segId, clipDuration, { mediaDuration, segmentClips }),
      successMessage: 'Moved cue start earlier to fit speech duration.',
    })
  ), [stateRef, setState, mediaDuration, onNotify]);

  const extendSafeMismatchSegments = useCallback(mismatches => {
    const result = extendAllSafeMismatches(stateRef.current.segments, mismatches, { mediaDuration });
    if (!result.fixedCount) return 0;
    const msg = `Extended ${result.fixedCount} ${result.fixedCount === 1 ? 'cue' : 'cues'} to fit speech.`;
    setState(prev => ({ ...prev, segments: result.segments, status: { message: msg, error: false } }));
    onNotify?.({ kind: 'success', title: 'Cues updated', message: msg });
    return result.fixedCount;
  }, [stateRef, setState, mediaDuration, onNotify]);

  const applySegmentSuggestion = useCallback(segId => {
    setState(prev => ({
      ...prev,
      segments: prev.segments.map(seg => (
        seg.id === segId && seg.altText?.trim()
          ? { ...seg, text: seg.altText.trim(), altText: '', verifyReason: '' }
          : seg
      )),
    }));
  }, [setState]);

  const dismissSegmentSuggestion = useCallback(segId => {
    setState(prev => ({
      ...prev,
      segments: prev.segments.map(seg => (
        seg.id === segId ? { ...seg, altText: '', verifyReason: '' } : seg
      )),
    }));
  }, [setState]);

  const countMatches = useCallback(
    ({ findText, caseSensitive = false }) => countTextMatchesInSegments({ segments, findText, useTranslation, caseSensitive }),
    [segments, useTranslation]
  );

  const findAndReplace = useCallback(({ findText, replaceText, caseSensitive = false }) => {
    const result = replaceTextInSegments({ segments, findText, replaceText, useTranslation, caseSensitive });
    if (!result.matchCount) {
      setState(prev => ({ ...prev, status: { message: `No matches found for "${findText}".`, error: false } }));
      return { matchCount: 0, segmentCount: 0 };
    }
    setState(prev => ({
      ...prev,
      segments: replaceTextInSegments({ segments: prev.segments, findText, replaceText, useTranslation, caseSensitive }).segments,
      status: { message: `Replaced ${result.matchCount} occurrence(s) across ${result.segmentCount} segment(s).`, error: false },
    }));
    return { matchCount: result.matchCount, segmentCount: result.segmentCount };
  }, [segments, setState, useTranslation]);

  return {
    updateSegment,
    deleteSegment,
    mergeSegmentWithNext,
    splitSegment,
    updateSegmentTiming,
    updateSegmentPause,
    resolveOverlaps,
    extendSegmentToSpeech,
    extendSegmentAndShift,
    shiftSegmentEarlier,
    extendSafeMismatchSegments,
    applySegmentSuggestion,
    dismissSegmentSuggestion,
    countMatches,
    findAndReplace,
  };
}

/**
 * Coordinates Function 2 (Video -> Subtitles, Editing, Translation, Burn-in, and TTS handoff).
 * Inputs: `{ onStateChange, onNotify, onUnlockSound }`.
 * Outputs: state flags, refs, domain derived tracks, segment editors, and async handlers.
 * Side effects: communicates with `/media_api` and manages browser object URLs.
 * Failure modes: surfaces validation, offline service, and cancellation states cleanly.
 * @param {{ onStateChange?: Function, onNotify?: Function, onUnlockSound?: Function }} [config] - Hook callbacks.
 * @returns {object} Subtitle workspace controller bundle.
 */
export function useVideoSubtitles({ onStateChange, onNotify, onUnlockSound, hidden = false, effectiveTermsRef = null } = {}) {
  const internalTermsRef = useRef([]);
  const activeEffectiveTermsRef = effectiveTermsRef || internalTermsRef;
  const services = useStudioServices();
  const gateway = useMemo(() => resolveSubtitleGateway(services), [services]);
  const [health, refreshHealth, markOnline] = useMediaHealthState(gateway);
  const projectRepository = services?.projectRepository;
  const videoRef = useRef(null);
  const abortRef = useRef(null);
  const [busyMeta, setBusyMeta] = useState(null);
  const [activeSegmentId, setActiveSegmentId] = useState('');
  const [ttsSpeakerId, setTtsSpeakerId] = useState('');
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [transcriptEpoch, setTranscriptEpoch] = useState(0);
  const bumpTranscriptEpoch = useCallback(() => setTranscriptEpoch(n => n + 1), []);
  const [state, setState] = useState({
    videoFile: null,
    videoFileName: null,
    videoUrl: '',
    isAudioOnly: false,
    hasAudioStream: true,
    jobId: '',
    detectedLanguage: '',
    videoSize: null,
    segments: [],
    hasTranslation: false,
    translatedLanguage: '',
    speakerNames: {},
    terminology: createEmptyProjectTerminology(),
    exportHistory: [],
    projectId: '',
    projectTitle: '',
    revision: 1,
    projectsReady: false,
    options: DEFAULT_OPTIONS,
    busyAction: '',
    status: { message: '', error: false },
  });
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => () => revokeUrl(state.videoUrl), [state.videoUrl]);

  useEffect(() => {
    onStateChange?.({ busy: Boolean(state.busyAction), hasVideo: Boolean(state.videoFile || state.segments.length) });
  }, [state.busyAction, state.videoFile, state.segments.length, onStateChange]);

  const targetLanguageMeta = useMemo(
    () => resolveTargetLanguageMeta(state.options.targetLanguage),
    [state.options.targetLanguage]
  );
  const translatedLanguageMeta = useMemo(
    () => resolveTargetLanguageMeta(state.translatedLanguage || state.options.targetLanguage),
    [state.translatedLanguage, state.options.targetLanguage]
  );
  const activeSourceLanguage = state.detectedLanguage && state.detectedLanguage !== 'auto'
    ? state.detectedLanguage
    : state.options.sourceLanguage;
  const canTranslate = !isSameSubtitleLanguage(activeSourceLanguage, state.options.targetLanguage);

  const { hasTranslated: hasTranslation, bilingual, useTranslation } = resolveTranslationFlags(
    state.hasTranslation,
    state.options.previewMode
  );
  const hasSubtitleText = useMemo(
    () => state.segments.some(seg => Boolean(pickSegmentText(seg, useTranslation, bilingual))),
    [state.segments, useTranslation, bilingual]
  );
  const speakersKey = collectUniqueSpeakers(state.segments).join('\0');
  const speakers = useMemo(() => (speakersKey ? speakersKey.split('\0') : []), [speakersKey]);
  const effectiveIncludeSpeaker = Boolean(state.options.includeSpeaker && (state.options.detectSpeakers || speakers.length > 1));
  useEffect(() => {
    if (ttsSpeakerId && !speakers.includes(ttsSpeakerId)) setTtsSpeakerId('');
  }, [speakers, ttsSpeakerId]);

  const effectiveSourceLang = activeSourceLanguage && activeSourceLanguage !== 'auto' ? activeSourceLanguage : '';
  const previewLanguageMeta = resolvePresetLanguageInfo({
    useTranslation,
    bilingual,
    detectedLanguage: effectiveSourceLang,
    translatedLanguage: state.translatedLanguage,
    selectedTargetLanguage: state.options.targetLanguage,
  });

  const vttUrl = useVttPreviewUrl({
    segments: state.segments,
    speakerNames: state.speakerNames,
    includeSpeaker: effectiveIncludeSpeaker,
    useTranslation,
    bilingual,
    hasSubtitleText,
    language: previewLanguageMeta.bcp47,
  });

  const selectVideoFile = useCallback(file => {
    if (!file) return { accepted: false, relinked: false };
    if (!ALLOWED_EXT_PATTERN.test(file.name || '') && !String(file.type || '').startsWith('video/') && !String(file.type || '').startsWith('audio/')) {
      const msg = 'Choose a valid video or audio file (.mp4, .mov, .mkv, .webm, .wav, .mp3).';
      setState(prev => ({ ...prev, status: { message: msg, error: true } }));
      onNotify?.({ kind: 'error', title: 'Unsupported file', message: msg });
      return { accepted: false, relinked: false };
    }
    if (file.size > MAX_CLIENT_VIDEO_BYTES) {
      const msg = 'Media exceeds the 500 MB local processing cap.';
      setState(prev => ({ ...prev, status: { message: msg, error: true } }));
      onNotify?.({ kind: 'error', title: 'File too large', message: msg });
      return { accepted: false, relinked: false };
    }
    const controller = abortRef.current;
    abortRef.current = null;
    controller?.abort();
    const nextUrl = typeof URL !== 'undefined' ? URL.createObjectURL(file) : '';
    const audioOnly = isAudioOnlyFile(file);
    setBusyMeta(null);
    setActiveSegmentId('');
    setTtsSpeakerId('');
    setCurrentTime(0);
    setMediaDuration(0);
    const cur = stateRef.current;
    const isReattachingMedia = Boolean(!cur.videoFile && (cur.projectId || cur.videoFileName || cur.segments.length));
    if (!isReattachingMedia) bumpTranscriptEpoch();
    setState(prev => {
      const keepExistingWork = Boolean(!prev.videoFile && (prev.projectId || prev.videoFileName || prev.segments.length));
      const defaultPreview = prev.options.translateToKhmer && !isSameSubtitleLanguage(prev.options.sourceLanguage, prev.options.targetLanguage)
        ? 'translated'
        : 'original';
      return {
        ...prev,
        videoFile: file,
        videoFileName: file.name || null,
        videoUrl: nextUrl,
        isAudioOnly: audioOnly,
        hasAudioStream: true,
        jobId: '',
        detectedLanguage: keepExistingWork ? prev.detectedLanguage : '',
        videoSize: null,
        segments: keepExistingWork ? prev.segments : [],
        hasTranslation: keepExistingWork ? prev.hasTranslation : false,
        translatedLanguage: keepExistingWork ? prev.translatedLanguage : '',
        speakerNames: keepExistingWork ? prev.speakerNames : {},
        exportHistory: keepExistingWork ? prev.exportHistory : [],
        busyAction: '',
        options: {
          ...prev.options,
          includeSpeaker: (keepExistingWork || prev.options.detectSpeakers) ? prev.options.includeSpeaker : false,
          previewMode: keepExistingWork ? prev.options.previewMode : defaultPreview,
        },
        status: { message: `Loaded ${file.name}. Ready to extract subtitles.`, error: false },
      };
    });
    return { accepted: true, relinked: isReattachingMedia };
  }, [onNotify, bumpTranscriptEpoch]);

  const importSubtitleFile = useCallback(async file => {
    try {
      if (!file || typeof file.text !== 'function') {
        throw new ValidationError('Choose a readable .srt or .vtt subtitle file.', 'file', 'INVALID_SUBTITLE_FILE');
      }
      if (Number.isFinite(file.size) && file.size > MAX_SUBTITLE_FILE_BYTES) {
        throw new ValidationError('Subtitle files must be 2 MB or smaller.', 'file', 'SUBTITLE_FILE_TOO_LARGE');
      }
      const parsed = parseSubtitleFileText(await file.text(), file.name);
      const speakerNames = {};
      const segments = parsed.map(({ speakerName, ...segment }) => {
        if (speakerName) speakerNames[segment.speakerId] = speakerName;
        return segment;
      });
      setActiveSegmentId('');
      setTtsSpeakerId('');
      bumpTranscriptEpoch();
      setState(prev => ({
        ...prev,
        isAudioOnly: prev.videoFile ? prev.isAudioOnly : false,
        jobId: prev.videoFile ? prev.jobId : '',
        detectedLanguage: '',
        videoSize: prev.videoFile ? prev.videoSize : null,
        segments,
        hasTranslation: false,
        translatedLanguage: '',
        speakerNames,
        options: { ...prev.options, previewMode: 'original' },
        status: { message: `Imported ${segments.length} subtitle cues from ${file.name}.`, error: false },
      }));
      onNotify?.({
        kind: 'success',
        title: 'Subtitles imported',
        message: `Imported ${segments.length} cues. Translate, edit, or generate voice per frame.`,
      });
      return true;
    } catch (error) {
      const message = error?.message || 'Could not import subtitle file.';
      services?.logger?.error?.('useVideoSubtitles.importSubtitleFile', error, { fileName: file?.name });
      setState(prev => ({ ...prev, status: { message, error: true } }));
      onNotify?.({ kind: 'error', title: 'Subtitle import failed', message });
      return false;
    }
  }, [onNotify, services, bumpTranscriptEpoch]);

  const clearWorkspace = useCallback(() => {
    const controller = abortRef.current;
    abortRef.current = null;
    controller?.abort();
    setBusyMeta(null);
    setActiveSegmentId('');
    setTtsSpeakerId('');
    setCurrentTime(0);
    setMediaDuration(0);
    bumpTranscriptEpoch();
    setState(prev => ({
      ...prev,
      videoFile: null,
      videoFileName: null,
      videoUrl: '',
      isAudioOnly: false,
      hasAudioStream: true,
      jobId: '',
      detectedLanguage: '',
      videoSize: null,
      segments: [],
      hasTranslation: false,
      translatedLanguage: '',
      speakerNames: {},
      terminology: createEmptyProjectTerminology(),
      exportHistory: [],
      projectId: '',
      projectTitle: '',
      busyAction: '',
      status: { message: '', error: false },
    }));
  }, [bumpTranscriptEpoch]);

  const updateOption = useCallback((key, value) => {
    setState(prev => {
      const next = { ...prev.options, [key]: value };
      if (key === 'sourceLanguage') {
        const isKhmer = value === 'km';
        const wasKhmer = prev.options.sourceLanguage === 'km';
        const desiredTarget = (wasKhmer && !isKhmer && !prev.options.translateToKhmer)
          ? DEFAULT_KHMER_TARGET
          : prev.options.targetLanguage;
        next.targetLanguage = pickDefaultTargetLanguage(value, desiredTarget);
        next.translateToKhmer = !isKhmer;
        next.previewMode = isKhmer ? 'original' : 'translated';
      } else if (key === 'targetLanguage') {
        next.targetLanguage = normalizeTargetLanguageCode(value);
      } else if (key === 'translateToKhmer') {
        next.previewMode = value ? 'translated' : 'original';
      } else if (key === 'detectSpeakers' && !value && collectUniqueSpeakers(prev.segments).length <= 1) {
        next.includeSpeaker = false;
      }
      return { ...prev, options: next };
    });
  }, []);

  const updateSubtitleStyle = useCallback((key, value) => {
    setState(prev => ({
      ...prev,
      options: { ...prev.options, subtitleStyle: { ...prev.options.subtitleStyle, [key]: value } },
    }));
  }, []);

  const updateSpeakerName = useCallback((speakerId, name) => {
    setState(prev => ({ ...prev, speakerNames: { ...prev.speakerNames, [speakerId]: name } }));
  }, []);

  const seekToSegment = useCallback((seconds, segmentId) => {
    const el = videoRef.current;
    if (!Number.isFinite(seconds)) return;
    const safeSec = Math.max(0, seconds);
    if (el) {
      el.currentTime = safeSec;
      void el.play?.().catch(err => services?.logger?.debug?.('useVideoSubtitles.seekToSegment', err?.message || 'Playback skipped'));
    }
    setCurrentTime(safeSec);
    const targetId = segmentId || findActiveSegmentId(state.segments, safeSec);
    if (targetId) setActiveSegmentId(targetId);
  }, [services, state.segments]);

  const seekToTime = useCallback(seconds => {
    const el = videoRef.current;
    if (!Number.isFinite(seconds)) return;
    const safeSec = Math.max(0, seconds);
    if (el) el.currentTime = safeSec;
    setCurrentTime(safeSec);
    const nextId = findActiveSegmentId(state.segments, safeSec);
    setActiveSegmentId(prev => (prev === nextId ? prev : nextId));
  }, [state.segments]);

  const handleVideoMetadata = useCallback(videoEl => {
    const width = Number(videoEl?.videoWidth) || 0;
    const height = Number(videoEl?.videoHeight) || 0;
    const dur = Number(videoEl?.duration);
    if (Number.isFinite(dur) && dur > 0) setMediaDuration(dur);
    if (width <= 0 || height <= 0) return;
    setState(prev => ({ ...prev, videoSize: { width, height } }));
  }, []);

  const handleVideoTimeUpdate = useCallback((currTime, dur) => {
    if (Number.isFinite(currTime)) {
      setCurrentTime(currTime);
      const nextId = findActiveSegmentId(state.segments, currTime);
      setActiveSegmentId(prev => (prev === nextId ? prev : nextId));
    }
    if (Number.isFinite(dur) && dur > 0) setMediaDuration(dur);
  }, [state.segments]);

  const recordExportHistory = useCallback((presetId, spec = {}) => {
    setState(prev => ({
      ...prev,
      exportHistory: recordPresetExport(prev.exportHistory, presetId, spec),
    }));
  }, []);

  const exportFile = useCallback((format, overrides = null) => {
    const throwOnError = Boolean(overrides?.throwOnError);
    const sourceLang = (state.detectedLanguage && state.detectedLanguage !== 'auto')
      ? state.detectedLanguage
      : (state.options.sourceLanguage && state.options.sourceLanguage !== 'auto' ? state.options.sourceLanguage : '');
    const langInfo = resolvePresetLanguageInfo({
      languageMode: overrides?.languageMode,
      useTranslation: overrides?.useTranslation ?? useTranslation,
      bilingual: overrides?.bilingual ?? bilingual,
      detectedLanguage: sourceLang,
      translatedLanguage: state.translatedLanguage,
      selectedTargetLanguage: state.options.targetLanguage,
    });
    const includeSpeaker = overrides?.includeSpeaker ?? effectiveIncludeSpeaker;
    if (!state.hasTranslation && (langInfo.useTranslation || langInfo.bilingual) && !hasAnyTranslatedText(state.segments)) {
      const msg = 'Translate at least one subtitle cue before exporting translated or bilingual subtitles.';
      setState(prev => ({ ...prev, status: { message: msg, error: true } }));
      if (throwOnError) throw new ValidationError(msg, 'languageMode', 'MISSING_TRANSLATION_CUES');
      return false;
    }
    const hasExportableText = state.segments.some(seg => Boolean(pickSegmentText(seg, langInfo.useTranslation, langInfo.bilingual)));
    if (!hasExportableText) {
      const msg = 'No subtitle text to export.';
      setState(prev => ({ ...prev, status: { message: msg, error: true } }));
      if (throwOnError) throw new Error(msg);
      return false;
    }
    const spec = {
      segments: state.segments,
      speakerNames: state.speakerNames,
      includeSpeaker,
      useTranslation: langInfo.useTranslation,
      bilingual: langInfo.bilingual,
      language: langInfo.bcp47,
    };
    const presetMap = { srt: EXPORT_PRESET_IDS.SUBTITLE_SRT, vtt: EXPORT_PRESET_IDS.SUBTITLE_VTT, txt: EXPORT_PRESET_IDS.SUBTITLE_TXT };
    const presetId = presetMap[format] || EXPORT_PRESET_IDS.SUBTITLE_TXT;
    const fallbackName = state.videoFile?.name || state.videoFileName || resolveExportFilenameStem({ projectTitle: state.projectTitle, fallback: 'video' });
    const filenameOverride = overrides?.filename || (
      overrides && (overrides.filenameStem || overrides.includeLanguageSuffix)
        ? formatPresetFilename(presetId, {
            filenameStem: overrides.filenameStem,
            videoFileName: state.videoFile?.name || state.videoFileName,
            projectTitle: state.projectTitle,
            languageCode: langInfo.bcp47,
            includeLanguageSuffix: Boolean(overrides.includeLanguageSuffix),
          })
        : ''
    );
    const payload = buildExportPayload(format, state.videoFile, spec, { fallbackName, filenameOverride });
    if (!payload.data) {
      const msg = 'No subtitle text to export.';
      setState(prev => ({ ...prev, status: { message: msg, error: true } }));
      if (throwOnError) throw new Error(msg);
      return false;
    }
    downloadBlobOrText(payload);
    const durationSeconds = state.segments.reduce((m, seg) => Math.max(m, Number(seg?.end) || 0), 0);
    setState(prev => ({
      ...prev,
      exportHistory: recordPresetExport(prev.exportHistory, presetId, {
        filename: payload.filename,
        durationSeconds: durationSeconds || null,
        languageCode: langInfo.bcp47,
        languageLabel: langInfo.label,
      }),
      status: { message: `Exported ${payload.filename}.`, error: false },
    }));
    return true;
  }, [
    state.segments,
    state.speakerNames,
    state.videoFile,
    state.videoFileName,
    state.projectTitle,
    state.detectedLanguage,
    state.translatedLanguage,
    state.options.sourceLanguage,
    state.options.targetLanguage,
    effectiveIncludeSpeaker,
    useTranslation,
    bilingual,
  ]);

  const copyDialogue = useCallback(async () => {
    const text = buildDialogueText({
      segments: state.segments,
      speakerNames: state.speakerNames,
      includeTimestamps: true,
      useTranslation,
      includeSpeaker: effectiveIncludeSpeaker,
      bilingual,
    });
    if (!text) {
      setState(prev => ({ ...prev, status: { message: 'No subtitle text to copy.', error: true } }));
      return;
    }
    try {
      await globalThis.navigator?.clipboard?.writeText(text);
      setState(prev => ({ ...prev, status: { message: 'Copied speaker dialogue script to clipboard.', error: false } }));
    } catch (err) {
      services?.logger?.debug?.('useVideoSubtitles.copyDialogue', err?.message || 'Clipboard write failed');
      setState(prev => ({ ...prev, status: { message: 'Could not copy automatically. Download .txt instead.', error: true } }));
    }
  }, [state.segments, state.speakerNames, effectiveIncludeSpeaker, useTranslation, bilingual, services]);

  const setStatus = useCallback(status => {
    setState(prev => ({ ...prev, status }));
  }, []);

  const clearExpiredJobId = useCallback(() => {
    setState(prev => (prev.jobId ? { ...prev, jobId: '' } : prev));
  }, []);

  const loadProjectFromSnapshot = useCallback(snapshot => {
    if (!snapshot) return;
    const isSubtitleType = snapshot.kind === 'subtitle' || snapshot.type === 'subtitles' || snapshot.type === 'dubbing';
    if (!isSubtitleType) return;
    const payload = snapshot.payload || {};
    const title = snapshot.title || snapshot.name || 'Untitled project';
    const snapshotDuration = Number(payload.mediaDuration);
    setActiveSegmentId('');
    setCurrentTime(0);
    setMediaDuration(Number.isFinite(snapshotDuration) && snapshotDuration > 0 ? snapshotDuration : 0);
    bumpTranscriptEpoch();
    setState(prev => ({
      ...prev,
      projectId: snapshot.id || '',
      projectTitle: title,
      revision: snapshot.revision || 1,
      videoFile: null,
      videoFileName: typeof payload.videoFileName === 'string' ? payload.videoFileName : null,
      videoUrl: '',
      isAudioOnly: false,
      hasAudioStream: true,
      jobId: '',
      detectedLanguage: payload.detectedLanguage || '',
      segments: Array.isArray(payload.segments) ? payload.segments : (Array.isArray(snapshot.segments) ? snapshot.segments : []),
      hasTranslation: Boolean(payload.hasTranslation),
      translatedLanguage: payload.translatedLanguage || '',
      speakerNames: typeof payload.speakerNames === 'object' && payload.speakerNames ? payload.speakerNames : {},
      terminology: normalizeProjectTerminology(snapshot.terminology ?? payload.terminology ?? payload.subtitleOptions?.terminology),
      exportHistory: normalizeExportHistory(snapshot.exportHistory ?? payload.exportHistory ?? payload.subtitleOptions?.exportHistory),
      options: (() => {
        const rawOpts = typeof payload.subtitleOptions === 'object' && payload.subtitleOptions ? payload.subtitleOptions : {};
        return {
          ...prev.options,
          ...rawOpts,
          dubAudioMode: normalizeVideoAudioMode(rawOpts.dubAudioMode, prev.options.dubAudioMode),
          dubSubtitleMode: normalizeVideoSubtitleMode(rawOpts.dubSubtitleMode, prev.options.dubSubtitleMode),
          dubMixSettings: normalizeDubMixSettings(rawOpts.dubMixSettings ?? prev.options.dubMixSettings),
        };
      })(),
      status: { message: `Project loaded: ${title}`, error: false },
    }));
  }, [bumpTranscriptEpoch]);

  const applyExternalProjectUpdate = useCallback(snapshot => {
    if (!snapshot) return;
    const isSubtitleType = snapshot.kind === 'subtitle' || snapshot.type === 'subtitles' || snapshot.type === 'dubbing';
    if (!isSubtitleType) return;
    const payload = snapshot.payload || {};
    const nextSegments = Array.isArray(payload.segments)
      ? payload.segments
      : (Array.isArray(snapshot.segments) ? snapshot.segments : null);
    setState(prev => {
      const rawOpts = typeof payload.subtitleOptions === 'object' && payload.subtitleOptions ? payload.subtitleOptions : null;
      return {
        ...prev,
        revision: snapshot.revision || prev.revision,
        detectedLanguage: payload.detectedLanguage || prev.detectedLanguage,
        segments: nextSegments ?? prev.segments,
        hasTranslation: payload.hasTranslation !== undefined ? Boolean(payload.hasTranslation) : prev.hasTranslation,
        translatedLanguage: payload.translatedLanguage || prev.translatedLanguage,
        speakerNames: typeof payload.speakerNames === 'object' && payload.speakerNames ? payload.speakerNames : prev.speakerNames,
        options: rawOpts ? {
          ...prev.options,
          ...rawOpts,
          dubAudioMode: normalizeVideoAudioMode(rawOpts.dubAudioMode, prev.options.dubAudioMode),
          dubSubtitleMode: normalizeVideoSubtitleMode(rawOpts.dubSubtitleMode, prev.options.dubSubtitleMode),
          dubMixSettings: normalizeDubMixSettings(rawOpts.dubMixSettings ?? prev.options.dubMixSettings),
        } : prev.options,
        terminology: snapshot.terminology !== undefined || payload.terminology !== undefined
          ? normalizeProjectTerminology(snapshot.terminology ?? payload.terminology ?? payload.subtitleOptions?.terminology)
          : prev.terminology,
        exportHistory: snapshot.exportHistory !== undefined || payload.exportHistory !== undefined
          ? normalizeExportHistory(snapshot.exportHistory ?? payload.exportHistory ?? payload.subtitleOptions?.exportHistory)
          : prev.exportHistory,
      };
    });
  }, []);

  useEffect(() => {
    if (!projectRepository) {
      setState(prev => ({ ...prev, projectsReady: true }));
      return undefined;
    }
    let active = true;
    const restoreLatestProject = async () => {
      try {
        const page = await projectRepository.listProjects({ limit: 50, offset: 0 });
        const latest = page.items.find(project => project.kind === 'subtitle');
        if (latest) {
          const snapshot = await projectRepository.getProject(latest.id);
          const current = stateRef.current;
          const hasLocalWork = Boolean(current.projectId || current.videoFile || current.segments.length);
          if (active && snapshot && !hasLocalWork) loadProjectFromSnapshot(snapshot);
        }
      } catch (error) {
        services?.logger?.error?.('useVideoSubtitles.restoreProject', error);
      } finally {
        if (active) setState(prev => ({ ...prev, projectsReady: true }));
      }
    };
    void restoreLatestProject();
    return () => { active = false; };
  }, [projectRepository, loadProjectFromSnapshot, services]);

  const buildProjectSnapshot = useCallback(() => createSubtitleProjectSnapshot({
    id: state.projectId || undefined,
    title: state.projectTitle || state.videoFileName || state.videoFile?.name || 'Untitled project',
    videoFileName: state.videoFileName || state.videoFile?.name || null,
    mediaDuration: Number.isFinite(Number(mediaDuration)) && Number(mediaDuration) > 0 ? Number(mediaDuration) : undefined,
    segments: state.segments,
    speakerNames: state.speakerNames,
    subtitleOptions: state.options,
    detectedLanguage: state.detectedLanguage,
    translatedLanguage: state.translatedLanguage,
    hasTranslation: state.hasTranslation,
    terminology: state.terminology,
    exportHistory: state.exportHistory,
  }), [
    state.projectId,
    state.projectTitle,
    state.videoFileName,
    state.videoFile?.name,
    mediaDuration,
    state.segments,
    state.speakerNames,
    state.options,
    state.detectedLanguage,
    state.translatedLanguage,
    state.hasTranslation,
    state.terminology,
    state.exportHistory,
  ]);

  const buildSnapshot = useCallback(() => {
    if (!state.projectId && !state.videoFileName && !state.segments.length) return null;
    return buildProjectSnapshot();
  }, [state.projectId, state.videoFileName, state.segments.length, buildProjectSnapshot]);

  const autosave = useProjectAutosave({
    projectId: state.projectId,
    initialRevision: state.revision || 1,
    buildSnapshot,
    enabled: Boolean(state.projectsReady),
    debounceMs: 1500,
    workspace: 'subtitles',
    deps: [
      state.segments,
      state.videoFileName,
      mediaDuration,
      state.speakerNames,
      state.options,
      state.projectTitle,
      state.detectedLanguage,
      state.translatedLanguage,
      state.terminology,
      state.exportHistory,
    ],
    hidden,
    projectRepository,
    logger: services?.logger,
    onSaveSuccess: saved => {
      const nextId = saved?.id;
      const nextTitle = saved?.title || state.projectTitle || buildSnapshot()?.title;
      const nextRev = saved?.revision;
      setState(prev => ({
        ...prev,
        ...(nextId && !prev.projectId ? { projectId: nextId, projectTitle: nextTitle } : {}),
        ...(nextRev ? { revision: nextRev } : {}),
      }));
    },
    onConflict: () => {
      onNotify?.({
        kind: 'warning',
        title: 'Project Conflict',
        message: 'This subtitle project was modified in another session. Unsaved edits remain in memory.',
      });
    },
  });

  const handleRestoreDraft = useCallback(snapshot => {
    autosave.resetProject(snapshot?.id || '', snapshot?.revision || 1);
    loadProjectFromSnapshot(snapshot);
    autosave.markDirty();
  }, [autosave, loadProjectFromSnapshot]);

  const currentProjectSnapshot = useMemo(() => ({
    id: state.projectId,
    title: state.projectTitle,
    revision: state.revision || 1,
    sourceAssetId: state.sourceAssetId || null,
    sourceAsset: state.sourceAsset || null,
    segments: state.segments,
    terminology: state.terminology,
    exportHistory: state.exportHistory,
    payload: {
      segments: state.segments,
      videoFileName: state.videoFileName,
      speakerNames: state.speakerNames,
      subtitleOptions: state.options,
      terminology: state.terminology,
      exportHistory: state.exportHistory,
    },
  }), [state.projectId, state.projectTitle, state.revision, state.sourceAssetId, state.sourceAsset, state.segments, state.videoFileName, state.speakerNames, state.options, state.terminology, state.exportHistory]);

  const recovery = useProjectRecovery({
    projectId: state.projectId,
    workspace: 'subtitles',
    currentProject: currentProjectSnapshot,
    onRestoreDraft: handleRestoreDraft,
    onProjectUpdated: loadProjectFromSnapshot,
    projectRepository,
    assetRepository: services?.assetRepository,
    logger: services?.logger,
    onNotify,
  });

  const persistCurrentProject = useCallback(async () => {
    return autosave.saveNow();
  }, [autosave]);

  const getTtsHandoff = useCallback((speakerId = ttsSpeakerId, selectedIds = null) => {
    const idSet = selectedIds?.length ? new Set(selectedIds) : null;
    const scopedSegments = idSet ? state.segments.filter(seg => idSet.has(seg.id)) : state.segments;
    return buildBoundedTtsHandoff({ segments: scopedSegments, useTranslation, speakerId });
  }, [state.segments, useTranslation, ttsSpeakerId]);

  const editActions = useSegmentEditingActions({
    segments: state.segments,
    stateRef,
    setState,
    setActiveSegmentId,
    useTranslation,
    mediaDuration,
    onNotify,
  });
  const setProjectTerminology = useCallback(nextTerminology => {
    setState(prev => ({
      ...prev,
      terminology: normalizeProjectTerminology(nextTerminology),
    }));
  }, []);

  const applySpellingTerminology = useCallback((segmentId = '') => {
    const current = stateRef.current;
    const terms = activeEffectiveTermsRef.current || [];
    const sourceLang = resolveSubtitleSourceLanguage(current);
    const result = applySpellingTermsToSegments(current.segments, terms, { sourceLanguage: sourceLang, segmentId });
    if (!result.updatedCount) {
      setState(prev => ({ ...prev, status: { message: 'All checked cue spellings already match approved terminology.', error: false } }));
      return 0;
    }
    const msg = `Applied approved spelling to ${result.updatedCount} ${result.updatedCount === 1 ? 'cue' : 'cues'}.`;
    setState(prev => ({ ...prev, segments: result.segments, status: { message: msg, error: false } }));
    onNotify?.({ kind: 'success', title: 'Spelling terminology applied', message: msg });
    return result.updatedCount;
  }, [activeEffectiveTermsRef, stateRef, onNotify]);

  const applyTranslationTerminology = useCallback(async (segmentId = '') => {
    const terms = activeEffectiveTermsRef.current || [];
    const current = stateRef.current;
    const sourceLang = resolveSubtitleSourceLanguage(current);
    const targetLang = current.translatedLanguage || normalizeTargetLanguageCode(current.options.targetLanguage);
    const origById = new Map(current.segments.map(seg => [seg.id, seg.translatedText || '']));
    const localResult = applyTranslationTermsToSegments(current.segments, terms, { sourceLanguage: sourceLang, targetLanguage: targetLang, segmentId });
    const updatesById = collectTranslatedUpdates(current.segments, localResult.segments);
    const unresolved = localResult.segments.filter(seg => (
      (!segmentId || seg.id === segmentId) &&
      inspectSegmentTerminology(seg, terms, { sourceLanguage: sourceLang, targetLanguage: targetLang }).translationGaps.length > 0
    ));
    let mtError = null;
    const mediaTerms = unresolved.length > 0 ? toMediaTerminologyPayload(terms) : null;
    if (unresolved.length > 0 && mediaTerms && gateway?.translateSegments && !current.busyAction) {
      try {
        const res = await gateway.translateSegments({
          segments: unresolved,
          sourceLanguage: (!sourceLang || sourceLang === 'auto') ? 'en' : sourceLang,
          targetLanguage: targetLang,
          terminology: mediaTerms,
        });
        for (const item of (res?.segments || [])) {
          if (item?.id && typeof item.translatedText === 'string') updatesById.set(item.id, item.translatedText);
        }
      } catch (err) {
        mtError = err;
        services?.logger?.warn?.('useVideoSubtitles.applyTranslationTerminology', err?.message || 'Retranslation failed');
      }
    }
    const changedIds = [...updatesById.keys()].filter(id => updatesById.get(id) !== (origById.get(id) || ''));
    const unresolvedCount = localResult.segments.filter(seg => {
      if (segmentId && seg.id !== segmentId) return false;
      const candidate = updatesById.has(seg.id) ? { ...seg, translatedText: updatesById.get(seg.id) } : seg;
      return inspectSegmentTerminology(candidate, terms, { sourceLanguage: sourceLang, targetLanguage: targetLang }).translationGaps.length > 0;
    }).length;
    const outcome = buildTranslationTermOutcome({ changedCount: changedIds.length, mtError, unresolvedCount });
    setState(prev => ({
      ...prev,
      segments: changedIds.length > 0 ? mergeTranslationUpdates(prev.segments, updatesById, origById) : prev.segments,
      status: outcome.status,
    }));
    if (outcome.notify) onNotify?.(outcome.notify);
    return changedIds.length;
  }, [activeEffectiveTermsRef, stateRef, gateway, services, onNotify]);

  const asyncActions = useSubtitleAsyncActions({
    state, stateRef, setState, setBusyMeta, setActiveSegmentId, mediaDuration, setMediaDuration, bumpTranscriptEpoch, effectiveIncludeSpeaker, hasSubtitleText, effectiveTermsRef: activeEffectiveTermsRef, gateway, abortRef, health, refreshHealth, markOnline, onNotify, onUnlockSound,
  });

  return {
    videoRef,
    health,
    refreshHealth,
    state,
    busyMeta,
    activeSegmentId,
    currentTime,
    mediaDuration,
    transcriptEpoch,
    ttsSpeakerId,
    setTtsSpeakerId,
    projectId: state.projectId,
    projectTitle: state.projectTitle,
    autosave,
    recovery,
    flushProjectSave: persistCurrentProject,
    loadProjectFromSnapshot,
    applyExternalProjectUpdate,
    setProjectTerminology,
    applySpellingTerminology,
    applyTranslationTerminology,
    exportHistory: state.exportHistory,
    recordExportHistory,
    projectRepository,
    speakers,
    effectiveIncludeSpeaker,
    hasSubtitleText,
    hasTranslation,
    targetLanguageMeta,
    translatedLanguageMeta,
    canTranslate,
    useTranslation,
    bilingual,
    vttUrl,
    setStatus,
    clearExpiredJobId,
    selectVideoFile,
    importSubtitleFile,
    clearWorkspace,
    updateOption,
    updateSubtitleStyle,
    updateSpeakerName,
    seekToSegment,
    seekToTime,
    handleVideoMetadata,
    handleVideoTimeUpdate,
    exportFile,
    copyDialogue,
    getTtsHandoff,
    ...editActions,
    ...asyncActions,
  };
}

function resolveSubtitleSourceLanguage(current) {
  const detected = current?.detectedLanguage;
  if (detected && detected !== 'auto') return detected;
  return current?.options?.sourceLanguage || '';
}

function collectTranslatedUpdates(prevSegments, nextSegments) {
  const updates = new Map();
  for (let i = 0; i < prevSegments.length; i += 1) {
    const prev = prevSegments[i];
    const next = nextSegments[i];
    if (prev && next && next.translatedText !== prev.translatedText) {
      updates.set(prev.id, next.translatedText);
    }
  }
  return updates;
}

function mergeTranslationUpdates(prevSegments, updatesById, origById) {
  let changed = false;
  const segments = prevSegments.map(seg => {
    if (!updatesById.has(seg.id)) return seg;
    const nextText = updatesById.get(seg.id);
    if (nextText === (seg.translatedText || '')) return seg;
    if ((seg.translatedText || '') !== (origById.get(seg.id) || '')) return seg;
    changed = true;
    return { ...seg, translatedText: nextText };
  });
  return changed ? segments : prevSegments;
}

function buildTranslationTermOutcome({ changedCount, mtError, unresolvedCount }) {
  if (mtError) {
    const detail = mtError?.message || 'Failed to apply approved translation terms via local translator.';
    return {
      status: { message: detail, error: true },
      notify: { kind: 'error', title: 'Translation terminology failed', message: detail },
    };
  }
  if (changedCount > 0) {
    const suffix = changedCount === 1 ? 'cue' : 'cues';
    const message = unresolvedCount > 0
      ? `Applied approved translation terminology to ${changedCount} ${suffix}; ${unresolvedCount} still need manual review.`
      : `Applied approved translation terminology to ${changedCount} ${suffix}.`;
    return {
      status: { message, error: false },
      notify: { kind: 'success', title: 'Translation terminology applied', message },
    };
  }
  if (unresolvedCount > 0) {
    const message = 'Some cues still need approved translation terms; retry when subtitle processing is idle or translate again.';
    return {
      status: { message, error: true },
      notify: { kind: 'warning', title: 'Translation terminology incomplete', message },
    };
  }
  return {
    status: { message: 'All checked cue translations already follow approved terminology.', error: false },
    notify: null,
  };
}
