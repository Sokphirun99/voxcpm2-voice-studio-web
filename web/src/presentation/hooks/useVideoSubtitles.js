/**
 * @fileoverview Presentation hook managing multi-speaker video subtitle extraction, live VTT preview, editing, translation, and MP4 burn-in.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createMediaSubtitleGateway } from '../../data/mediaSubtitleGateway.js';
import {
  SUBTITLE_STYLE_DEFAULTS,
  adjustSubtitleSegmentTiming,
  buildBoundedTtsHandoff,
  buildDialogueText,
  buildSrt,
  buildVtt,
  collectUniqueSpeakers,
  countTextMatchesInSegments,
  deleteSubtitleSegment,
  findActiveSegmentId,
  isAudioOnlyFile,
  mergeSubtitleSegmentWithNext,
  pickSegmentText,
  replaceTextInSegments,
  splitSubtitleSegment,
} from '../../domain/subtitles.js';
import { useStudioServices } from '../StudioContext.jsx';

const MAX_CLIENT_VIDEO_BYTES = 500 * 1024 * 1024;
const ALLOWED_EXT_PATTERN = /\.(mp4|mov|m4v|webm|mkv|avi|mp3|wav|m4a|aac|ogg|flac)$/i;
const MEDIA_OFFLINE_POLL_MS = 10000;
const VTT_PREVIEW_DEBOUNCE_MS = 200;
const DEFAULT_OPTIONS = Object.freeze({
  sourceLanguage: 'km',
  detectSpeakers: false,
  speakerCount: '0',
  translateToKhmer: false,
  includeSpeaker: false,
  previewMode: 'original',
  subtitleStyle: SUBTITLE_STYLE_DEFAULTS,
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

function handleSubtitleTaskError({ err, setState, resetTranslationOnStart, hadTranslation, cancelMessage, errorTitle, fallbackError, onError, onNotify }) {
  if (err?.name === 'SynthesisCancelledError') {
    setState(prev => ({
      ...prev,
      busyAction: '',
      hasTranslation: restoreTaskTranslation(prev, resetTranslationOnStart, hadTranslation),
      status: { message: cancelMessage, error: false },
    }));
    return;
  }
  const errMsg = err?.message || fallbackError;
  onError?.();
  setState(prev => ({
    ...prev,
    busyAction: '',
    hasTranslation: restoreTaskTranslation(prev, resetTranslationOnStart, hadTranslation),
    status: { message: errMsg, error: true },
  }));
  onNotify?.({ kind: 'error', title: errorTitle, message: errMsg });
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
    status: { message: baseMessage, error: false },
  }));
  return controller;
}

async function runSubtitleTask({ abortRef, setState, setBusyMeta, busyAction, baseMessage, cancelMessage, errorTitle, fallbackError, resetTranslationOnStart = false, hadTranslation = false, onError, onNotify, onUnlockSound, run }) {
  onUnlockSound?.();
  const startedAt = Date.now();
  const controller = beginSubtitleTask({ abortRef, setState, setBusyMeta, busyAction, baseMessage, resetTranslationOnStart });
  try {
    await run(controller.signal, () => formatElapsedSec(startedAt));
  } catch (err) {
    if (abortRef.current !== controller) return;
    handleSubtitleTaskError({ err, setState, resetTranslationOnStart, hadTranslation, cancelMessage, errorTitle, fallbackError, onError, onNotify });
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

function buildExportName(file, suffix) {
  const stem = (file?.name || 'video').replace(/\.[^.]+$/, '') || 'video';
  return `${stem}${suffix}`;
}

function buildExportPayload(format, videoFile, spec) {
  if (format === 'srt') {
    return { data: buildSrt(spec), mimeType: 'application/x-subrip;charset=utf-8', filename: buildExportName(videoFile, '.srt') };
  }
  if (format === 'vtt') {
    return { data: buildVtt(spec), mimeType: 'text/vtt;charset=utf-8', filename: buildExportName(videoFile, '.vtt') };
  }
  return {
    data: buildDialogueText({ ...spec, includeTimestamps: true }),
    mimeType: 'text/plain;charset=utf-8',
    filename: buildExportName(videoFile, '-dialogue.txt'),
  };
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
  const [health, setHealth] = useState({ checked: false, online: true, burnInSupported: true, diarizationReady: false, reason: '' });
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

function useVttPreviewUrl({ segments, speakerNames, includeSpeaker, useTranslation, bilingual, hasSubtitleText }) {
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

    const modeKey = `${includeSpeaker ? 1 : 0}:${useTranslation ? 1 : 0}:${bilingual ? 1 : 0}`;
    const shouldUpdateImmediately = !activeUrlRef.current || lastModeRef.current !== modeKey;

    const commitVtt = () => {
      timerRef.current = undefined;
      const vttText = buildVtt({ segments, speakerNames, includeSpeaker, useTranslation, bilingual });
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
  }, [segments, speakerNames, includeSpeaker, useTranslation, bilingual, hasSubtitleText]);

  return vttUrl;
}

/**
 * Formats extraction completion summary for status text and notification toasts.
 * @param {number} segmentCount - Extracted segment count.
 * @param {number} speakerCount - Detected speaker count.
 * @param {string} elapsed - Formatted elapsed seconds string.
 * @returns {string} Summary copy with singular/plural segment noun.
 */
export function buildExtractSummary(segmentCount, speakerCount, elapsed) {
  const segmentLabel = segmentCount === 1 ? 'segment' : 'segments';
  const spkNote = speakerCount > 1 ? ` (${speakerCount} speakers)` : '';
  return `Extracted ${segmentCount} subtitle ${segmentLabel}${spkNote} in ${elapsed}s.`;
}

function applyExtractedSubtitleResult(prev, res, shouldTranslate, elapsed) {
  const detectedLanguage = res.language || prev.options.sourceLanguage;
  const segments = Array.isArray(res.segments) ? res.segments : [];
  const hasSegmentTranslation = hasAnyTranslatedText(segments);
  const hasTranslated = shouldTranslate && detectedLanguage !== 'km' && hasSegmentTranslation;
  const speakerCount = Array.isArray(res.speakers) ? res.speakers.length : collectUniqueSpeakers(segments).length;
  const nextIncludeSpeaker = (prev.options.detectSpeakers || speakerCount > 1) ? prev.options.includeSpeaker : false;
  return {
    ...prev,
    jobId: res.jobId || '',
    detectedLanguage,
    isAudioOnly: Boolean(res.isAudioOnly) || isAudioOnlyFile(prev.videoFile),
    videoSize: res.videoSize !== undefined ? res.videoSize : prev.videoSize,
    segments,
    hasTranslation: hasSegmentTranslation,
    speakerNames: {},
    options: { ...prev.options, includeSpeaker: nextIncludeSpeaker, previewMode: hasTranslated ? 'translated' : 'original' },
    busyAction: '',
    status: { message: buildExtractSummary(segments.length, speakerCount, elapsed), error: false },
  };
}

function useSubtitleAsyncActions({ state, stateRef, setState, setBusyMeta, setActiveSegmentId, effectiveIncludeSpeaker, hasSubtitleText, gateway, abortRef, refreshHealth, markOnline, onNotify, onUnlockSound }) {
  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, [abortRef]);

  const extractSubtitles = useCallback(async () => {
    if (!state.videoFile) return;
    const hadTranslation = Boolean(stateRef?.current?.hasTranslation ?? state.hasTranslation);
    const shouldTranslate = state.options.sourceLanguage !== 'km' && Boolean(state.options.translateToKhmer);
    const diarize = Boolean(state.options.detectSpeakers) && state.options.speakerCount !== '1';
    const numSpeakers = diarize ? (Number(state.options.speakerCount) || 0) : 1;
    await runSubtitleTask({
      abortRef, setState, setBusyMeta, busyAction: 'extract',
      baseMessage: diarize ? 'Extracting subtitles & detecting speakers…' : 'Extracting subtitles…',
      cancelMessage: 'Subtitle extraction cancelled.',
      errorTitle: 'Subtitle extraction failed',
      fallbackError: 'Subtitle extraction failed.',
      resetTranslationOnStart: true,
      hadTranslation,
      onError: () => void refreshHealth(),
      onNotify, onUnlockSound,
      run: async (signal, elapsedSecs) => {
        const res = await gateway.transcribeVideo({
          file: state.videoFile,
          language: state.options.sourceLanguage,
          numSpeakers,
          diarize,
          translateToKhmer: shouldTranslate,
          signal,
        });
        assertNotAborted(signal);
        markOnline();
        const elapsed = elapsedSecs();
        const segs = Array.isArray(res.segments) ? res.segments : [];
        const spkCount = Array.isArray(res.speakers) ? res.speakers.length : collectUniqueSpeakers(segs).length;
        setActiveSegmentId('');
        setState(prev => applyExtractedSubtitleResult(prev, res, shouldTranslate, elapsed));
        onNotify?.({ kind: 'success', title: 'Subtitles ready', message: buildExtractSummary(segs.length, spkCount, elapsed) });
      },
    });
  }, [state.videoFile, state.options, state.hasTranslation, stateRef, gateway, abortRef, setState, setBusyMeta, setActiveSegmentId, refreshHealth, markOnline, onNotify, onUnlockSound]);

  const translateNow = useCallback(async () => {
    if (!state.segments.length) return;
    await runSubtitleTask({
      abortRef, setState, setBusyMeta, busyAction: 'translate',
      baseMessage: 'Translating subtitles into Khmer offline…',
      cancelMessage: 'Translation cancelled.',
      errorTitle: 'Translation failed',
      fallbackError: 'Translation failed.',
      onError: () => void refreshHealth(),
      onNotify, onUnlockSound,
      run: async (signal, elapsedSecs) => {
        const sourceLang = state.detectedLanguage && state.detectedLanguage !== 'auto' ? state.detectedLanguage : state.options.sourceLanguage;
        const res = await gateway.translateSegments({
          segments: state.segments,
          sourceLanguage: sourceLang === 'auto' ? 'en' : sourceLang,
          targetLanguage: 'km',
          signal,
        });
        assertNotAborted(signal);
        markOnline();
        const summary = `Translated dialogue lines to Khmer in ${elapsedSecs()}s.`;
        setState(prev => {
          const nextSegments = Array.isArray(res.segments) ? res.segments : prev.segments;
          return {
            ...prev,
            segments: nextSegments,
            hasTranslation: nextSegments.length > 0,
            options: {
              ...prev.options,
              previewMode: prev.options.previewMode === 'bilingual' ? 'bilingual' : 'translated',
              translateToKhmer: true,
            },
            busyAction: '',
            status: { message: summary, error: false },
          };
        });
        onNotify?.({ kind: 'success', title: 'Khmer translation ready', message: summary });
      },
    });
  }, [state.segments, state.detectedLanguage, state.options.sourceLanguage, gateway, abortRef, setState, setBusyMeta, refreshHealth, markOnline, onNotify, onUnlockSound]);

  const burnVideo = useCallback(async () => {
    if (!state.jobId || !hasSubtitleText || state.isAudioOnly) return;
    await runSubtitleTask({
      abortRef, setState, setBusyMeta, busyAction: 'burn',
      baseMessage: 'Rendering MP4 with burned-in subtitles…',
      cancelMessage: 'MP4 export cancelled.',
      errorTitle: 'MP4 export failed',
      fallbackError: 'Video subtitle burn-in failed.',
      onError: () => void refreshHealth(),
      onNotify, onUnlockSound,
      run: async (signal, elapsedSecs) => {
        const { bilingual, useTranslation } = resolveTranslationFlags(state.hasTranslation, state.options.previewMode);
        const blob = await gateway.burnSubtitles({
          jobId: state.jobId,
          segments: state.segments,
          speakerNames: state.speakerNames,
          includeSpeaker: effectiveIncludeSpeaker,
          useTranslation,
          bilingual,
          subtitleStyle: state.options.subtitleStyle,
          videoSize: state.videoSize || undefined,
          signal,
        });
        assertNotAborted(signal);
        markOnline();
        downloadBlobOrText({ data: blob, mimeType: 'video/mp4', filename: buildExportName(state.videoFile, '-subtitled.mp4') });
        const summary = `Exported MP4 with burned-in subtitles in ${elapsedSecs()}s.`;
        setState(prev => ({ ...prev, busyAction: '', status: { message: summary, error: false } }));
        onNotify?.({ kind: 'success', title: 'MP4 exported', message: summary });
      },
    });
  }, [state, effectiveIncludeSpeaker, hasSubtitleText, gateway, abortRef, setState, setBusyMeta, refreshHealth, markOnline, onNotify, onUnlockSound]);

  return { cancel, extractSubtitles, translateNow, burnVideo };
}

function useSegmentEditingActions({ segments, setState, setActiveSegmentId, useTranslation }) {
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
      return { ...prev, segments: nextSegments, hasTranslation: nextSegments.length > 0 ? prev.hasTranslation : false };
    });
  }, [setState, setActiveSegmentId]);

  const mergeSegmentWithNext = useCallback(segId => {
    setState(prev => ({ ...prev, segments: mergeSubtitleSegmentWithNext(prev.segments, segId) }));
  }, [setState]);

  const splitSegment = useCallback((segId, ratio = 0.5) => {
    setState(prev => ({ ...prev, segments: splitSubtitleSegment(prev.segments, segId, { ratio }) }));
  }, [setState]);

  const updateSegmentTiming = useCallback((segId, timingPatch) => {
    setState(prev => ({ ...prev, segments: adjustSubtitleSegmentTiming(prev.segments, segId, timingPatch) }));
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

  return { updateSegment, deleteSegment, mergeSegmentWithNext, splitSegment, updateSegmentTiming, countMatches, findAndReplace };
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
export function useVideoSubtitles({ onStateChange, onNotify, onUnlockSound } = {}) {
  const services = useStudioServices();
  const gateway = useMemo(() => resolveSubtitleGateway(services), [services]);
  const [health, refreshHealth, markOnline] = useMediaHealthState(gateway);
  const videoRef = useRef(null);
  const abortRef = useRef(null);
  const [busyMeta, setBusyMeta] = useState(null);
  const [activeSegmentId, setActiveSegmentId] = useState('');
  const [ttsSpeakerId, setTtsSpeakerId] = useState('');
  const [state, setState] = useState({
    videoFile: null,
    videoUrl: '',
    isAudioOnly: false,
    jobId: '',
    detectedLanguage: '',
    videoSize: null,
    segments: [],
    hasTranslation: false,
    speakerNames: {},
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

  const vttUrl = useVttPreviewUrl({
    segments: state.segments,
    speakerNames: state.speakerNames,
    includeSpeaker: effectiveIncludeSpeaker,
    useTranslation,
    bilingual,
    hasSubtitleText,
  });

  const selectVideoFile = useCallback(file => {
    if (!file) return;
    if (!ALLOWED_EXT_PATTERN.test(file.name || '') && !String(file.type || '').startsWith('video/') && !String(file.type || '').startsWith('audio/')) {
      const msg = 'Choose a valid video or audio file (.mp4, .mov, .mkv, .webm, .wav, .mp3).';
      setState(prev => ({ ...prev, status: { message: msg, error: true } }));
      onNotify?.({ kind: 'error', title: 'Unsupported file', message: msg });
      return;
    }
    if (file.size > MAX_CLIENT_VIDEO_BYTES) {
      const msg = 'Media exceeds the 500 MB local processing cap.';
      setState(prev => ({ ...prev, status: { message: msg, error: true } }));
      onNotify?.({ kind: 'error', title: 'File too large', message: msg });
      return;
    }
    const controller = abortRef.current;
    abortRef.current = null;
    controller?.abort();
    const nextUrl = typeof URL !== 'undefined' ? URL.createObjectURL(file) : '';
    const audioOnly = isAudioOnlyFile(file);
    setBusyMeta(null);
    setActiveSegmentId('');
    setTtsSpeakerId('');
    setState(prev => ({
      ...prev,
      videoFile: file,
      videoUrl: nextUrl,
      isAudioOnly: audioOnly,
      jobId: '',
      detectedLanguage: '',
      videoSize: null,
      segments: [],
      hasTranslation: false,
      speakerNames: {},
      busyAction: '',
      options: {
        ...prev.options,
        includeSpeaker: prev.options.detectSpeakers ? prev.options.includeSpeaker : false,
        previewMode: prev.options.sourceLanguage !== 'km' && prev.options.translateToKhmer ? 'translated' : 'original',
      },
      status: { message: `Loaded ${file.name}. Ready to extract subtitles.`, error: false },
    }));
  }, [onNotify]);

  const clearWorkspace = useCallback(() => {
    const controller = abortRef.current;
    abortRef.current = null;
    controller?.abort();
    setBusyMeta(null);
    setActiveSegmentId('');
    setTtsSpeakerId('');
    setState(prev => ({
      ...prev,
      videoFile: null,
      videoUrl: '',
      isAudioOnly: false,
      jobId: '',
      detectedLanguage: '',
      videoSize: null,
      segments: [],
      hasTranslation: false,
      speakerNames: {},
      busyAction: '',
      status: { message: '', error: false },
    }));
  }, []);

  const updateOption = useCallback((key, value) => {
    setState(prev => {
      const next = { ...prev.options, [key]: value };
      if (key === 'sourceLanguage') {
        const isKhmer = value === 'km';
        next.translateToKhmer = !isKhmer;
        next.previewMode = isKhmer ? 'original' : 'translated';
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

  const seekToSegment = useCallback(seconds => {
    const el = videoRef.current;
    if (!el || !Number.isFinite(seconds)) return;
    el.currentTime = Math.max(0, seconds);
    void el.play?.().catch(err => services?.logger?.debug?.('useVideoSubtitles.seekToSegment', err?.message || 'Playback skipped'));
  }, [services]);

  const handleVideoMetadata = useCallback(videoEl => {
    const width = Number(videoEl?.videoWidth) || 0;
    const height = Number(videoEl?.videoHeight) || 0;
    if (width <= 0 || height <= 0) return;
    setState(prev => ({ ...prev, videoSize: { width, height } }));
  }, []);

  const handleVideoTimeUpdate = useCallback(currentTime => {
    const nextId = findActiveSegmentId(state.segments, currentTime);
    setActiveSegmentId(prev => (prev === nextId ? prev : nextId));
  }, [state.segments]);

  const exportFile = useCallback(format => {
    const hasExportableText = state.segments.some(seg => Boolean(pickSegmentText(seg, useTranslation, bilingual)));
    if (!hasExportableText) {
      setState(prev => ({ ...prev, status: { message: 'No subtitle text to export.', error: true } }));
      return;
    }
    const spec = {
      segments: state.segments,
      speakerNames: state.speakerNames,
      includeSpeaker: effectiveIncludeSpeaker,
      useTranslation,
      bilingual,
    };
    const payload = buildExportPayload(format, state.videoFile, spec);
    if (!payload.data) {
      setState(prev => ({ ...prev, status: { message: 'No subtitle text to export.', error: true } }));
      return;
    }
    downloadBlobOrText(payload);
  }, [state.segments, state.speakerNames, effectiveIncludeSpeaker, state.videoFile, useTranslation, bilingual]);

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

  const getTtsHandoff = useCallback(
    (speakerId = ttsSpeakerId) => buildBoundedTtsHandoff({ segments: state.segments, useTranslation, speakerId }),
    [state.segments, useTranslation, ttsSpeakerId]
  );

  const editActions = useSegmentEditingActions({ segments: state.segments, setState, setActiveSegmentId, useTranslation });
  const asyncActions = useSubtitleAsyncActions({
    state, stateRef, setState, setBusyMeta, setActiveSegmentId, effectiveIncludeSpeaker, hasSubtitleText, gateway, abortRef, refreshHealth, markOnline, onNotify, onUnlockSound,
  });

  return {
    videoRef,
    health,
    refreshHealth,
    state,
    busyMeta,
    activeSegmentId,
    ttsSpeakerId,
    setTtsSpeakerId,
    speakers,
    effectiveIncludeSpeaker,
    hasSubtitleText,
    hasTranslation,
    useTranslation,
    bilingual,
    vttUrl,
    selectVideoFile,
    clearWorkspace,
    updateOption,
    updateSubtitleStyle,
    updateSpeakerName,
    seekToSegment,
    handleVideoMetadata,
    handleVideoTimeUpdate,
    exportFile,
    copyDialogue,
    getTtsHandoff,
    ...editActions,
    ...asyncActions,
  };
}
