/**
 * @fileoverview Presentation hook managing multi-speaker video subtitle extraction, live VTT preview, Khmer translation, and MP4 burn-in.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildDialogueText,
  buildSrt,
  buildTtsScriptFromSegments,
  buildVtt,
  collectUniqueSpeakers,
} from '../../domain/subtitles.js';
import { createMediaSubtitleGateway } from '../../data/mediaSubtitleGateway.js';
import { useStudioServices } from '../StudioContext.jsx';

const LIVE_TIMER_TICK_MS = 100;
const MAX_CLIENT_VIDEO_BYTES = 500 * 1024 * 1024;
const ALLOWED_EXT_PATTERN = /\.(mp4|mov|m4v|webm|mkv|avi|mp3|wav|m4a)$/i;
const DEFAULT_OPTIONS = Object.freeze({
  sourceLanguage: 'km',
  speakerCount: '0',
  translateToKhmer: false,
  includeSpeaker: true,
  previewMode: 'original',
});

function startStatusTimer(setState, baseMessage) {
  const startedAt = Date.now();
  const elapsedSecs = () => ((Date.now() - startedAt) / 1000).toFixed(1);
  const timer = globalThis.setInterval(() => {
    setState(prev => ({ ...prev, status: { message: `${baseMessage} (${elapsedSecs()}s)`, error: false } }));
  }, LIVE_TIMER_TICK_MS);
  return { timer, elapsedSecs };
}

async function runTimedSubtitleAction({ abortRef, setState, busyAction, baseMessage, cancelMessage, fallbackError, onError, run }) {
  abortRef.current?.abort();
  const controller = new AbortController();
  abortRef.current = controller;
  setState(prev => ({ ...prev, busyAction, status: { message: `${baseMessage} (0.0s)`, error: false } }));
  const { timer, elapsedSecs } = startStatusTimer(setState, baseMessage);
  try {
    await run(controller.signal, elapsedSecs);
  } catch (err) {
    if (err?.name === 'SynthesisCancelledError') {
      setState(prev => ({ ...prev, busyAction: '', status: { message: cancelMessage, error: false } }));
      return;
    }
    onError?.();
    setState(prev => ({ ...prev, busyAction: '', status: { message: err?.message || fallbackError, error: true } }));
  } finally {
    globalThis.clearInterval(timer);
    if (abortRef.current === controller) abortRef.current = null;
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
  window.setTimeout(() => URL.revokeObjectURL(href), 1500);
}

function resolveUseTranslation(segments, previewMode) {
  if (previewMode !== 'translated') return false;
  return segments.some(seg => Boolean(seg?.translatedText?.trim()));
}

function resolveSubtitleGateway(services) {
  if (services?.mediaSubtitleGateway) return services.mediaSubtitleGateway;
  return createMediaSubtitleGateway({ logger: services?.logger });
}

function useMediaHealthState(gateway) {
  const [health, setHealth] = useState({ checked: false, online: true, burnInSupported: true, diarizationReady: false, reason: '' });
  const refresh = useCallback(async () => {
    if (!gateway?.checkHealth) return;
    const next = await gateway.checkHealth();
    setHealth({ checked: true, ...next });
  }, [gateway]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return [health, refresh];
}

function useVttPreviewUrl({ segments, speakerNames, includeSpeaker, useTranslation }) {
  const [vttUrl, setVttUrl] = useState('');
  useEffect(() => {
    if (typeof URL === 'undefined' || typeof Blob === 'undefined' || !segments.length) {
      setVttUrl('');
      return undefined;
    }
    const vttText = buildVtt({ segments, speakerNames, includeSpeaker, useTranslation });
    const nextUrl = URL.createObjectURL(new Blob([vttText], { type: 'text/vtt;charset=utf-8' }));
    setVttUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [segments, speakerNames, includeSpeaker, useTranslation]);
  return vttUrl;
}

function applyExtractedSubtitleResult(prev, res, shouldTranslate, elapsed) {
  const detectedLanguage = res.language || prev.options.sourceLanguage;
  const segments = Array.isArray(res.segments) ? res.segments : [];
  const hasTranslated = shouldTranslate && detectedLanguage !== 'km' && segments.some(s => Boolean(s?.translatedText?.trim()));
  return {
    ...prev,
    jobId: res.jobId || '',
    detectedLanguage,
    videoSize: res.videoSize || null,
    segments,
    speakerNames: {},
    options: { ...prev.options, previewMode: hasTranslated ? 'translated' : 'original' },
    busyAction: '',
    status: { message: `Extracted ${segments.length} subtitle segments (${res.speakers?.length || 1} speaker(s)) in ${elapsed}s.`, error: false },
  };
}

function useSubtitleAsyncActions({ state, setState, gateway, abortRef, refreshHealth }) {
  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, [abortRef]);

  const extractSubtitles = useCallback(async () => {
    if (!state.videoFile) return;
    const shouldTranslate = state.options.sourceLanguage !== 'km' && Boolean(state.options.translateToKhmer);
    await runTimedSubtitleAction({
      abortRef, setState, busyAction: 'extract',
      baseMessage: 'Extracting subtitles & speaker turns…',
      cancelMessage: 'Subtitle extraction cancelled.',
      fallbackError: 'Subtitle extraction failed.',
      onError: () => void refreshHealth(),
      run: async (signal, elapsedSecs) => {
        const res = await gateway.transcribeVideo({
          file: state.videoFile,
          language: state.options.sourceLanguage,
          numSpeakers: Number(state.options.speakerCount) || 0,
          diarize: true,
          translateToKhmer: shouldTranslate,
          signal,
        });
        setState(prev => applyExtractedSubtitleResult(prev, res, shouldTranslate, elapsedSecs()));
      },
    });
  }, [state.videoFile, state.options, gateway, abortRef, setState, refreshHealth]);

  const translateNow = useCallback(async () => {
    if (!state.segments.length) return;
    await runTimedSubtitleAction({
      abortRef, setState, busyAction: 'translate',
      baseMessage: 'Translating subtitles into Khmer offline…',
      cancelMessage: 'Translation cancelled.',
      fallbackError: 'Translation failed.',
      run: async (signal, elapsedSecs) => {
        const sourceLang = state.detectedLanguage && state.detectedLanguage !== 'auto' ? state.detectedLanguage : state.options.sourceLanguage;
        const res = await gateway.translateSegments({
          segments: state.segments,
          sourceLanguage: sourceLang === 'auto' ? 'en' : sourceLang,
          targetLanguage: 'km',
          signal,
        });
        setState(prev => ({
          ...prev,
          segments: Array.isArray(res.segments) ? res.segments : prev.segments,
          options: { ...prev.options, previewMode: 'translated', translateToKhmer: true },
          busyAction: '',
          status: { message: `Translated dialogue lines to Khmer in ${elapsedSecs()}s.`, error: false },
        }));
      },
    });
  }, [state.segments, state.detectedLanguage, state.options.sourceLanguage, gateway, abortRef, setState]);

  const burnVideo = useCallback(async () => {
    if (!state.jobId || !state.segments.length) return;
    await runTimedSubtitleAction({
      abortRef, setState, busyAction: 'burn',
      baseMessage: 'Rendering MP4 with speaker-colored subtitles…',
      cancelMessage: 'MP4 export cancelled.',
      fallbackError: 'Video subtitle burn-in failed.',
      run: async (signal, elapsedSecs) => {
        const useTranslation = resolveUseTranslation(state.segments, state.options.previewMode);
        const blob = await gateway.burnSubtitles({
          jobId: state.jobId,
          segments: state.segments,
          speakerNames: state.speakerNames,
          includeSpeaker: state.options.includeSpeaker,
          useTranslation,
          videoSize: state.videoSize || undefined,
          signal,
        });
        downloadBlobOrText({ data: blob, mimeType: 'video/mp4', filename: buildExportName(state.videoFile, '-subtitled.mp4') });
        setState(prev => ({ ...prev, busyAction: '', status: { message: `Exported MP4 with burned-in subtitles in ${elapsedSecs()}s.`, error: false } }));
      },
    });
  }, [state, gateway, abortRef, setState]);

  return { cancel, extractSubtitles, translateNow, burnVideo };
}

/**
 * Coordinates Function 2 (Video -> Multi-Speaker Subtitles & Dialogue Extraction).
 * Inputs: `{ onStateChange }`.
 * Outputs: state flags, refs, domain derived tracks, and user action handlers.
 * Side effects: communicates with `/media_api` and manages browser object URLs.
 * Failure modes: surfaces validation, offline service, and cancellation states cleanly.
 * @param {{ onStateChange?: (meta: { busy: boolean, hasVideo: boolean }) => void }} [config] - Hook callbacks.
 * @returns {object} Subtitle workspace controller bundle.
 */
export function useVideoSubtitles({ onStateChange } = {}) {
  const services = useStudioServices();
  const gateway = useMemo(() => resolveSubtitleGateway(services), [services]);
  const [health, refreshHealth] = useMediaHealthState(gateway);
  const videoRef = useRef(null);
  const abortRef = useRef(null);
  const [state, setState] = useState({
    videoFile: null,
    videoUrl: '',
    jobId: '',
    detectedLanguage: '',
    videoSize: null,
    segments: [],
    speakerNames: {},
    options: DEFAULT_OPTIONS,
    busyAction: '',
    status: { message: '', error: false },
  });

  useEffect(() => () => {
    abortRef.current?.abort();
    revokeUrl(state.videoUrl);
  }, [state.videoUrl]);

  useEffect(() => {
    onStateChange?.({ busy: Boolean(state.busyAction), hasVideo: Boolean(state.videoFile || state.segments.length) });
  }, [state.busyAction, state.videoFile, state.segments.length, onStateChange]);

  const useTranslation = resolveUseTranslation(state.segments, state.options.previewMode);
  const speakers = useMemo(() => collectUniqueSpeakers(state.segments), [state.segments]);
  const vttUrl = useVttPreviewUrl({
    segments: state.segments,
    speakerNames: state.speakerNames,
    includeSpeaker: state.options.includeSpeaker,
    useTranslation,
  });

  const selectVideoFile = useCallback(file => {
    if (!file) return;
    if (!ALLOWED_EXT_PATTERN.test(file.name || '') && !String(file.type || '').startsWith('video/') && !String(file.type || '').startsWith('audio/')) {
      setState(prev => ({ ...prev, status: { message: 'Choose a valid video or audio file (.mp4, .mov, .mkv, .webm, .wav, .mp3).', error: true } }));
      return;
    }
    if (file.size > MAX_CLIENT_VIDEO_BYTES) {
      setState(prev => ({ ...prev, status: { message: 'Video exceeds the 500 MB local processing cap.', error: true } }));
      return;
    }
    const nextUrl = typeof URL !== 'undefined' ? URL.createObjectURL(file) : '';
    setState(prev => ({
      ...prev,
      videoFile: file,
      videoUrl: nextUrl,
      jobId: '',
      detectedLanguage: '',
      segments: [],
      speakerNames: {},
      status: { message: `Loaded ${file.name}. Ready to extract subtitles.`, error: false },
    }));
  }, []);

  const clearWorkspace = useCallback(() => {
    abortRef.current?.abort();
    setState(prev => ({
      ...prev,
      videoFile: null,
      videoUrl: '',
      jobId: '',
      detectedLanguage: '',
      videoSize: null,
      segments: [],
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
      }
      return { ...prev, options: next };
    });
  }, []);

  const updateSpeakerName = useCallback((speakerId, name) => {
    setState(prev => ({ ...prev, speakerNames: { ...prev.speakerNames, [speakerId]: name } }));
  }, []);

  const updateSegment = useCallback((segId, patch) => {
    setState(prev => ({
      ...prev,
      segments: prev.segments.map(seg => (seg.id === segId ? { ...seg, ...patch } : seg)),
    }));
  }, []);

  const seekToSegment = useCallback(seconds => {
    const el = videoRef.current;
    if (!el || !Number.isFinite(seconds)) return;
    el.currentTime = Math.max(0, seconds);
    void el.play?.().catch(() => {});
  }, []);

  const exportFile = useCallback(format => {
    const spec = { segments: state.segments, speakerNames: state.speakerNames, includeSpeaker: state.options.includeSpeaker, useTranslation };
    if (format === 'srt') {
      downloadBlobOrText({ data: buildSrt(spec), mimeType: 'application/x-subrip;charset=utf-8', filename: buildExportName(state.videoFile, '.srt') });
    } else if (format === 'vtt') {
      downloadBlobOrText({ data: buildVtt(spec), mimeType: 'text/vtt;charset=utf-8', filename: buildExportName(state.videoFile, '.vtt') });
    } else {
      downloadBlobOrText({ data: buildDialogueText({ ...spec, includeTimestamps: true }), mimeType: 'text/plain;charset=utf-8', filename: buildExportName(state.videoFile, '-dialogue.txt') });
    }
  }, [state.segments, state.speakerNames, state.options.includeSpeaker, state.videoFile, useTranslation]);

  const copyDialogue = useCallback(async () => {
    const text = buildDialogueText({
      segments: state.segments,
      speakerNames: state.speakerNames,
      includeTimestamps: true,
      useTranslation,
    });
    if (!text) return;
    try {
      await globalThis.navigator?.clipboard?.writeText(text);
      setState(prev => ({ ...prev, status: { message: 'Copied speaker dialogue script to clipboard.', error: false } }));
    } catch {
      setState(prev => ({ ...prev, status: { message: 'Could not copy automatically. Download .txt instead.', error: true } }));
    }
  }, [state.segments, state.speakerNames, useTranslation]);

  const getTtsScript = useCallback(
    () => buildTtsScriptFromSegments({ segments: state.segments, useTranslation }),
    [state.segments, useTranslation]
  );

  const asyncActions = useSubtitleAsyncActions({ state, setState, gateway, abortRef, refreshHealth });

  return {
    videoRef,
    health,
    refreshHealth,
    state,
    speakers,
    useTranslation,
    vttUrl,
    selectVideoFile,
    clearWorkspace,
    updateOption,
    updateSpeakerName,
    updateSegment,
    seekToSegment,
    exportFile,
    copyDialogue,
    getTtsScript,
    ...asyncActions,
  };
}
