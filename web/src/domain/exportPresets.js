/**
 * @fileoverview Pure domain export preset catalog, pre-export validation/warning evaluator,
 * filename/language/codec resolution, and bounded project export history management.
 */

import { DEFAULT_ASSEMBLY_PAUSE_SECONDS } from './audioAssembly.js';
import { detectDurationMismatches } from './durationMismatch.js';
import { ValidationError } from './errors.js';
import {
  MAX_EXPORT_HISTORY,
  appendExportHistory,
  createExportHistoryEntry,
  normalizeExportHistory,
} from './exportHistory.js';
import { getSegmentActiveTake, hasSegmentAudio } from './projectSegments.js';
import { resolveLanguageDisplayMeta } from './subtitleLanguages.js';
import { buildDubExportClips, selectOrderedSegments } from './subtitleTts.js';
import { pickSegmentText } from './subtitles.js';
import {
  DEFAULT_DUB_MIX_SETTINGS,
  DEFAULT_DUB_SUBTITLE_MODE,
  DUB_MIX_BOUNDS,
  VIDEO_AUDIO_MODES,
  VIDEO_EXPORT_AUDIO_MODE_OPTIONS,
  VIDEO_SUBTITLE_MODES,
  VIDEO_SUBTITLE_MODE_OPTIONS,
  assertVideoAudioMode,
  assertVideoSubtitleMode,
  clampDubMixField,
  formatGainDbLabel,
  formatGainPercentLabel,
  formatVideoAudioModeSummary,
  formatVideoSubtitleModeSummary,
  hasCustomDubMixSettings,
  normalizeDubMixSettings,
  normalizeVideoAudioMode,
  normalizeVideoSubtitleMode,
  resolveCanonicalVideoAudioMode,
  resolveCanonicalVideoSubtitleMode,
  validateDubMixSettings,
} from './videoDubExport.js';

export {
  DEFAULT_DUB_MIX_SETTINGS,
  DEFAULT_DUB_SUBTITLE_MODE,
  DUB_MIX_BOUNDS,
  MAX_EXPORT_HISTORY,
  VIDEO_AUDIO_MODES,
  VIDEO_EXPORT_AUDIO_MODE_OPTIONS,
  VIDEO_SUBTITLE_MODES,
  VIDEO_SUBTITLE_MODE_OPTIONS,
  appendExportHistory,
  assertVideoAudioMode,
  assertVideoSubtitleMode,
  clampDubMixField,
  createExportHistoryEntry,
  formatGainDbLabel,
  formatGainPercentLabel,
  formatVideoAudioModeSummary,
  formatVideoSubtitleModeSummary,
  hasCustomDubMixSettings,
  normalizeDubMixSettings,
  normalizeExportHistory,
  normalizeVideoAudioMode,
  normalizeVideoSubtitleMode,
  resolveCanonicalVideoAudioMode,
  resolveCanonicalVideoSubtitleMode,
  validateDubMixSettings,
};
export const DEFAULT_WAV_SAMPLE_RATE = 48000;
export const DEFAULT_WAV_BITS = 16;
export const DEFAULT_EXPORT_STEM = 'subtitle';
export const DEFAULT_TTS_STEM = 'voxcpm2-narration';
export const DUB_AAC_BITRATE_LABEL = 'AAC 192 kbps @ 48 kHz';
export const MAX_DUB_EXPORT_CLIPS = 120;
const WAV_BYTES_PER_SECOND = DEFAULT_WAV_SAMPLE_RATE * 2;
const WAV_HEADER_BYTES = 44;
const ESTIMATED_MP4_BYTES_PER_SECOND = 320000;

const CATEGORY_AUDIO = 'audio';
const CATEGORY_SUBTITLE = 'subtitle';
const CATEGORY_VIDEO = 'video';
const MAX_STEM_LENGTH = 80;
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;
const COLLAPSE_SPACE = /\s+/g;
const MP4_EXT_PATTERN = /\.mp4$/i;
const KNOWN_EXPORT_EXT_PATTERN = /\.(mp4|mov|m4v|webm|mkv|avi|mp3|wav|m4a|aac|ogg|flac|srt|vtt|txt)$/i;
const SUBTITLE_TEXT_MODES = Object.freeze(new Set(['original', 'translated', 'bilingual']));
const PRESET_SUFFIXES = Object.freeze({
  tts_narration_wav: '-narration.wav',
  subtitle_voiceover_wav: '-voiceover.wav',
  subtitle_aligned_wav: '-time-aligned-dub.wav',
  subtitle_srt: '.srt',
  subtitle_vtt: '.vtt',
  subtitle_txt: '.txt',
  video_burned_mp4: '-subtitled.mp4',
  video_dubbed_mp4: '-dubbed.mp4',
});

export const EXPORT_PRESET_CATEGORIES = Object.freeze([CATEGORY_AUDIO, CATEGORY_SUBTITLE, CATEGORY_VIDEO]);

export const EXPORT_PRESET_IDS = Object.freeze({
  TTS_NARRATION_WAV: 'tts_narration_wav',
  SUBTITLE_VOICEOVER_WAV: 'subtitle_voiceover_wav',
  SUBTITLE_ALIGNED_WAV: 'subtitle_aligned_wav',
  SUBTITLE_SRT: 'subtitle_srt',
  SUBTITLE_VTT: 'subtitle_vtt',
  SUBTITLE_TXT: 'subtitle_txt',
  VIDEO_BURNED_MP4: 'video_burned_mp4',
  VIDEO_DUBBED_MP4: 'video_dubbed_mp4',
});

/**
 * Authoritative catalog of supported audio, subtitle, and video export workflows.
 */
export const EXPORT_PRESETS = Object.freeze([
  Object.freeze({
    id: EXPORT_PRESET_IDS.TTS_NARRATION_WAV,
    category: CATEGORY_AUDIO,
    workspace: 'tts',
    label: 'Narration Master WAV',
    shortLabel: 'Narration .wav',
    format: 'WAV',
    extension: '.wav',
    codec: 'PCM 16-bit LE WAV',
    channels: 1,
    sampleRate: DEFAULT_WAV_SAMPLE_RATE,
    description: 'Uncompressed 48 kHz mono PCM WAV for editors, DAWs, and external media players.',
  }),
  Object.freeze({
    id: EXPORT_PRESET_IDS.SUBTITLE_ALIGNED_WAV,
    category: CATEGORY_AUDIO,
    workspace: CATEGORY_SUBTITLE,
    label: 'Time-Aligned Dub Track WAV',
    shortLabel: 'Aligned Dub .wav',
    format: 'WAV',
    extension: '.wav',
    codec: 'PCM 16-bit LE WAV',
    channels: 1,
    sampleRate: DEFAULT_WAV_SAMPLE_RATE,
    description: 'Dubbed voiceover aligned to exact subtitle cue timestamps with silence padding.',
  }),
  Object.freeze({
    id: EXPORT_PRESET_IDS.SUBTITLE_VOICEOVER_WAV,
    category: CATEGORY_AUDIO,
    workspace: CATEGORY_SUBTITLE,
    label: 'Sequential Voiceover WAV',
    shortLabel: 'Voiceover .wav',
    format: 'WAV',
    extension: '.wav',
    codec: 'PCM 16-bit LE WAV',
    channels: 1,
    sampleRate: DEFAULT_WAV_SAMPLE_RATE,
    description: 'Generated subtitle lines concatenated sequentially with speaker pauses.',
  }),
  Object.freeze({
    id: EXPORT_PRESET_IDS.SUBTITLE_SRT,
    category: CATEGORY_SUBTITLE,
    workspace: CATEGORY_SUBTITLE,
    label: 'SubRip Subtitles (.srt)',
    shortLabel: 'SubRip .srt',
    format: 'SRT',
    extension: '.srt',
    codec: 'UTF-8 text',
    channels: null,
    sampleRate: null,
    description: 'Universal timecoded caption file for VLC, Premiere Pro, DaVinci Resolve, and YouTube.',
  }),
  Object.freeze({
    id: EXPORT_PRESET_IDS.SUBTITLE_VTT,
    category: CATEGORY_SUBTITLE,
    workspace: CATEGORY_SUBTITLE,
    label: 'WebVTT Subtitles (.vtt)',
    shortLabel: 'WebVTT .vtt',
    format: 'VTT',
    extension: '.vtt',
    codec: 'UTF-8 text (Kind + BCP-47 Language)',
    channels: null,
    sampleRate: null,
    description: 'HTML5 video caption track with embedded BCP-47 Language header and cue sanitization.',
  }),
  Object.freeze({
    id: EXPORT_PRESET_IDS.SUBTITLE_TXT,
    category: CATEGORY_SUBTITLE,
    workspace: CATEGORY_SUBTITLE,
    label: 'Dialogue Script (.txt)',
    shortLabel: 'Script .txt',
    format: 'TXT',
    extension: '.txt',
    codec: 'UTF-8 text',
    channels: null,
    sampleRate: null,
    description: 'Readable speaker-grouped transcript with timestamps for review and voice acting.',
  }),
  Object.freeze({
    id: EXPORT_PRESET_IDS.VIDEO_BURNED_MP4,
    category: CATEGORY_VIDEO,
    workspace: CATEGORY_SUBTITLE,
    label: 'Burned-In Subtitled MP4',
    shortLabel: 'Burned MP4',
    format: 'MP4',
    extension: '.mp4',
    codec: `H.264 (yuv420p) + ${DUB_AAC_BITRATE_LABEL}`,
    channels: 2,
    sampleRate: DEFAULT_WAV_SAMPLE_RATE,
    description: 'Hard-coded styled captions rendered onto H.264 yuv420p MP4 (+faststart) with language tag.',
  }),
  Object.freeze({
    id: EXPORT_PRESET_IDS.VIDEO_DUBBED_MP4,
    category: CATEGORY_VIDEO,
    workspace: CATEGORY_SUBTITLE,
    label: 'Time-Aligned Dubbed MP4',
    shortLabel: 'Dubbed MP4',
    format: 'MP4',
    extension: '.mp4',
    codec: `H.264/HEVC (hvc1/yuv420p) + ${DUB_AAC_BITRATE_LABEL}`,
    channels: 2,
    sampleRate: DEFAULT_WAV_SAMPLE_RATE,
    description: 'Video track paired with timed AI dubbed audio mix (duck, mute, or keep original) and language tag.',
  }),
]);

const PRESET_BY_ID = new Map(EXPORT_PRESETS.map(p => [p.id, p]));

function sanitizeCandidateStem(raw, stripAnyExtension) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  const withoutExt = stripAnyExtension ? trimmed.replace(/\.[^./\\]+$/, '') : trimmed.replace(KNOWN_EXPORT_EXT_PATTERN, '');
  return withoutExt
    .replace(INVALID_FILENAME_CHARS, '-')
    .replace(COLLAPSE_SPACE, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, MAX_STEM_LENGTH);
}

/**
 * Sanitizes an arbitrary filename or project title into a portable cross-platform base stem.
 * Inputs: `{ filenameStem, videoFileName, projectTitle, fallback }`.
 * Outputs: Safe stem string without path separators, file extension, or trailing dots.
 * Side effects: none.
 * Failure modes: returns `fallback` when all inputs sanitize to empty.
 * @param {{ filenameStem?: string, videoFileName?: string, projectTitle?: string, fallback?: string }} [spec] - Stem candidates.
 * @returns {string} Sanitized filename stem.
 */
export function resolveExportFilenameStem({ filenameStem = '', videoFileName = '', projectTitle = '', fallback = DEFAULT_EXPORT_STEM } = {}) {
  const candidates = [
    [filenameStem, false],
    [videoFileName, true],
    [projectTitle, false],
  ];
  for (const [raw, stripAny] of candidates) {
    const cleaned = sanitizeCandidateStem(raw, stripAny);
    if (cleaned) return cleaned;
  }
  return fallback;
}

/**
 * Formats an exact export filename for a given preset id and naming context.
 * Inputs: `presetId` and `{ filenameStem, videoFileName, projectTitle, languageCode, includeLanguageSuffix, suffixOverride }`.
 * Outputs: Filename string ending in `.wav`, `.srt`, `.vtt`, `.txt`, or `.mp4`.
 * Side effects: none.
 * Failure modes: throws ValidationError on unknown presetId.
 * @param {string} presetId - One of `EXPORT_PRESET_IDS`.
 * @param {object} [spec] - Naming context.
 * @returns {string} Download filename.
 */
export function formatPresetFilename(presetId, spec = {}) {
  const preset = PRESET_BY_ID.get(presetId);
  if (!preset) throw new ValidationError(`Unknown export preset '${presetId}'.`, 'presetId', 'UNKNOWN_EXPORT_PRESET');
  const fallback = preset.workspace === 'tts' ? DEFAULT_TTS_STEM : DEFAULT_EXPORT_STEM;
  const stem = resolveExportFilenameStem({ ...spec, fallback });
  const suffix = typeof spec.suffixOverride === 'string' && spec.suffixOverride ? spec.suffixOverride : PRESET_SUFFIXES[presetId];
  const langTag = spec.includeLanguageSuffix && spec.languageCode ? `.${spec.languageCode}` : '';
  if (preset.category === CATEGORY_SUBTITLE && langTag) return `${stem}${langTag}${preset.extension}`;
  return `${stem}${suffix}`;
}

function resolveLanguageMode(ctx) {
  if (SUBTITLE_TEXT_MODES.has(ctx.languageMode)) return ctx.languageMode;
  if (ctx.bilingual) return 'bilingual';
  if (ctx.useTranslation) return 'translated';
  return 'original';
}

/**
 * Resolves the effective language tag and mode flags (`useTranslation`, `bilingual`) for an export context.
 * Inputs: `{ languageMode, useTranslation, bilingual, detectedLanguage, translatedLanguage, selectedTargetLanguage, sourceLanguage }`.
 * Outputs: `{ languageMode, useTranslation, bilingual, rawLanguageCode, bcp47, label }`.
 * Side effects: none.
 * Failure modes: gracefully defaults `bcp47` to `''` and `label` to `'Undetermined'`.
 * @param {object} [ctx] - Language context.
 * @returns {{ languageMode: string, useTranslation: boolean, bilingual: boolean, rawLanguageCode: string, bcp47: string, label: string }} Language descriptor.
 */
export function resolvePresetLanguageInfo(ctx = {}) {
  const mode = resolveLanguageMode(ctx);
  const useTranslation = mode === 'translated' || mode === 'bilingual';
  const bilingual = mode === 'bilingual';
  const srcLang = ctx.detectedLanguage || ctx.sourceLanguage || '';
  const tgtLang = ctx.translatedLanguage || ctx.selectedTargetLanguage || '';
  const rawCode = useTranslation ? (tgtLang || srcLang) : srcLang;
  const meta = resolveLanguageDisplayMeta(rawCode);
  return { languageMode: mode, useTranslation, bilingual, rawLanguageCode: rawCode, bcp47: meta.bcp47, label: meta.label };
}

function resolveAudioLanguageInfo(ctx, fallbackLangInfo) {
  const explicitSpeech = typeof ctx.speechLanguage === 'string' ? ctx.speechLanguage.trim() : '';
  if (!explicitSpeech || explicitSpeech === 'auto') return fallbackLangInfo;
  const meta = resolveLanguageDisplayMeta(explicitSpeech);
  return { ...fallbackLangInfo, rawLanguageCode: explicitSpeech, bcp47: meta.bcp47, label: meta.label };
}

function resolveSubtitleDuration(segments) {
  if (!Array.isArray(segments) || !segments.length) return 0;
  return segments.reduce((maxEnd, seg) => {
    const end = Number(seg?.end);
    return Number.isFinite(end) && end > maxEnd ? end : maxEnd;
  }, 0);
}

function hasValidCueInterval(seg) {
  const start = Number(seg?.start);
  const end = Number(seg?.end);
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start;
}

function countRenderedCueTexts(segments, useTranslation, bilingual) {
  let rendered = 0;
  let translatedCount = 0;
  let missingTranslation = 0;
  let invalidTimingCount = 0;
  let hasArrowToken = false;
  for (const seg of segments) {
    const hasOrig = Boolean(String(seg?.text || '').trim());
    const hasTrans = Boolean(String(seg?.translatedText || '').trim());
    if (hasTrans) translatedCount += 1;
    const text = pickSegmentText(seg, useTranslation, bilingual);
    if (!text) continue;
    rendered += 1;
    if (!hasValidCueInterval(seg)) invalidTimingCount += 1;
    if (text.includes('-->')) hasArrowToken = true;
    if (useTranslation && hasOrig && !hasTrans) missingTranslation += 1;
  }
  return { rendered, translatedCount, missingTranslation, invalidTimingCount, hasArrowToken };
}

function collectSubtitleAudioTargets(segments, clips, selectedIds) {
  const allWithClips = segments.filter(s => Boolean(clips[s?.id]?.blob));
  const selectedWithClips = selectOrderedSegments(segments, selectedIds).filter(s => Boolean(clips[s?.id]?.blob));
  if (selectedWithClips.length > 0) return { scope: 'selected', matched: selectedWithClips, allGeneratedCount: allWithClips.length };
  return { scope: 'all', matched: allWithClips, allGeneratedCount: allWithClips.length };
}

function resolveAudioClipDuration(targets, segmentClips, aligned) {
  if (!targets.length || !segmentClips) return 0;
  let total = 0;
  let maxEnd = 0;
  for (const seg of targets) {
    const clip = segmentClips[seg.id];
    if (!clip?.blob) continue;
    const dur = Number(clip.durationSeconds) || 0;
    total += dur;
    const clipEnd = Math.max((Number(seg.start) || 0) + dur, Number(seg.end) || 0);
    if (clipEnd > maxEnd) maxEnd = clipEnd;
  }
  return aligned ? maxEnd : total;
}

function estimateTtsSegmentsDuration(nonEmptySegments) {
  if (!nonEmptySegments.length) return 0;
  let total = 0;
  for (let i = 0; i < nonEmptySegments.length; i += 1) {
    const take = getSegmentActiveTake(nonEmptySegments[i]);
    const dur = Number(take?.duration ?? take?.durationSeconds ?? take?.audioDurationSeconds);
    if (Number.isFinite(dur) && dur > 0) total += dur;
    if (i < nonEmptySegments.length - 1) {
      const pause = Number(nonEmptySegments[i]?.pauseDuration);
      total += Number.isFinite(pause) && pause >= 0 ? pause : DEFAULT_ASSEMBLY_PAUSE_SECONDS;
    }
  }
  return total;
}

/**
 * Formats an estimated byte size into a compact human-readable string (`B`, `KB`, or `MB`).
 * @param {number|null|undefined} bytes - Estimated byte count.
 * @returns {string|null} Formatted size label or null when unavailable.
 */
export function formatEstimatedFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes < 1024) return `~${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `~${(bytes / 1024).toFixed(1)} KB`;
  return `~${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function estimateWavBytes(durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  return Math.round(durationSeconds * WAV_BYTES_PER_SECOND) + WAV_HEADER_BYTES;
}

function estimateSubtitleBytes(segments, useTranslation, bilingual) {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  let total = 16;
  for (const seg of segments) {
    const text = pickSegmentText(seg, useTranslation, bilingual);
    if (!text) continue;
    const textBytes = encoder ? encoder.encode(text).length : text.length * 2;
    total += textBytes + 34;
  }
  return total > 16 ? total : null;
}

function estimateVideoBytes(ctx, durationSeconds) {
  if (Number.isFinite(ctx.videoFileSize) && ctx.videoFileSize > 0) return Math.round(ctx.videoFileSize);
  if (Number.isFinite(durationSeconds) && durationSeconds > 0) return Math.round(durationSeconds * ESTIMATED_MP4_BYTES_PER_SECOND);
  return null;
}

function resolvePresetQualityLabel(preset, videoMeta = null) {
  if (preset.category === CATEGORY_AUDIO) return 'Lossless 48 kHz 16-bit PCM';
  if (preset.category === CATEGORY_SUBTITLE) return 'UTF-8 clean text';
  if (videoMeta?.subtitleMode === VIDEO_SUBTITLE_MODES.BURNED) return 'H.264 high-compatibility · AAC 192 kbps';
  return 'MP4 (H.264/HEVC) · AAC 192 kbps';
}

function buildExpectedOutput({ preset, filename, durationSeconds, language, codecOverride = '', videoMeta = null, estimatedSizeBytes = null }) {
  const safeBytes = Number.isFinite(estimatedSizeBytes) && estimatedSizeBytes > 0 ? Math.round(estimatedSizeBytes) : null;
  return Object.freeze({
    filename,
    format: preset.format,
    codec: codecOverride || preset.codec,
    quality: resolvePresetQualityLabel(preset, videoMeta),
    locationLabel: 'Browser downloads folder',
    estimatedSizeBytes: safeBytes,
    estimatedSizeLabel: formatEstimatedFileSize(safeBytes),
    sampleRate: preset.sampleRate,
    channels: preset.channels,
    durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.round(durationSeconds * 100) / 100 : null,
    languageCode: language.bcp47,
    languageLabel: language.label,
    audioMode: videoMeta?.audioMode || null,
    audioModeLabel: videoMeta?.audioModeLabel || null,
    subtitleMode: videoMeta?.subtitleMode || null,
    subtitleModeLabel: videoMeta?.subtitleModeLabel || null,
  });
}

function evaluateTtsNarrationPreset(preset, ctx, langInfo) {
  const activeRecording = ctx.ttsRecording || null;
  const ttsSegments = Array.isArray(ctx.ttsSegments) ? ctx.ttsSegments : [];
  const nonEmpty = ttsSegments.filter(s => Boolean(s?.text?.trim()));
  const readyCount = nonEmpty.filter(s => hasSegmentAudio(s)).length;
  const omittedCount = nonEmpty.length - readyCount;
  const blockers = [];
  const warnings = [];
  if (!activeRecording && readyCount === 0) blockers.push('Generate audio or assemble narration before exporting WAV.');
  else if (readyCount > 0 && omittedCount > 0) {
    blockers.push(`Generate takes for ${omittedCount} remaining segment${omittedCount === 1 ? '' : 's'} before exporting assembled narration WAV.`);
  } else if (omittedCount > 0 && nonEmpty.length > 0) {
    warnings.push(`${omittedCount} script segment${omittedCount === 1 ? ' is' : 's are'} missing a generated take.`);
  }
  if (!activeRecording?.isAssembled && readyCount > 0 && omittedCount === 0) {
    warnings.push('Narration WAV will be assembled from segment takes on export.');
  } else if (activeRecording && !activeRecording.isAssembled && nonEmpty.length > 1 && readyCount === 0) {
    warnings.push('Active take is a single segment take. Assemble all segments for complete narration.');
  }
  const activeDur = Number(activeRecording?.audioDurationSeconds ?? activeRecording?.duration) || 0;
  const duration = activeDur > 0 ? activeDur : estimateTtsSegmentsDuration(nonEmpty);
  const filename = formatPresetFilename(preset.id, { ...ctx, languageCode: langInfo.bcp47 });
  const estimatedSizeBytes = (readyCount === 0 && Number(activeRecording?.blob?.size) > 0)
    ? activeRecording.blob.size
    : estimateWavBytes(duration);
  return { ...preset, available: blockers.length === 0, blockers, warnings, expectedOutput: buildExpectedOutput({ preset, filename, durationSeconds: duration, language: langInfo, estimatedSizeBytes }) };
}

function resolveSubtitleAudioWarningsAndBlockers({ segments, targetInfo, isAligned, ctx }) {
  const blockers = [];
  const warnings = [];
  if (!segments.length) blockers.push('Load and transcribe or add subtitle cues first.');
  else if (targetInfo.allGeneratedCount === 0) blockers.push('Generate voiceover clips for at least one cue first.');
  if (targetInfo.scope === 'selected' && targetInfo.matched.length < targetInfo.allGeneratedCount) {
    warnings.push(`Only the ${targetInfo.matched.length} selected cue${targetInfo.matched.length === 1 ? '' : 's'} will be exported.`);
  } else if (targetInfo.allGeneratedCount > 0 && targetInfo.allGeneratedCount < segments.length) {
    warnings.push(`Only ${targetInfo.allGeneratedCount} of ${segments.length} cues have generated audio takes.`);
  }
  if (isAligned && targetInfo.allGeneratedCount > 0) {
    const mismatchReport = detectDurationMismatches({
      segments, segmentClips: ctx.segmentClips || {}, mediaDuration: Number(ctx.videoDuration) || 0,
      spillApprovals: ctx.spillApprovals || {}, selectedIds: ctx.selectedIds, targetOnly: true,
    });
    if (mismatchReport.unresolved.length > 0) {
      blockers.push(`Resolve ${mismatchReport.unresolved.length} speech duration mismatch${mismatchReport.unresolved.length === 1 ? '' : 'es'} before exporting time-aligned WAV.`);
    }
  }
  return { blockers, warnings };
}

function evaluateSubtitleAudioPreset(preset, ctx, langInfo) {
  const segments = Array.isArray(ctx.segments) ? ctx.segments : [];
  const clips = ctx.segmentClips || {};
  const isAligned = preset.id === EXPORT_PRESET_IDS.SUBTITLE_ALIGNED_WAV;
  const targetInfo = collectSubtitleAudioTargets(segments, clips, ctx.selectedIds);
  const { blockers, warnings } = resolveSubtitleAudioWarningsAndBlockers({ segments, targetInfo, isAligned, ctx });
  const mediaDur = Number(ctx.videoDuration) || 0;
  const clipDur = resolveAudioClipDuration(targetInfo.matched, clips, isAligned);
  const estDur = isAligned ? Math.max(mediaDur, clipDur) : clipDur;
  const audioLang = resolveAudioLanguageInfo(ctx, langInfo);
  const filename = formatPresetFilename(preset.id, { ...ctx, languageCode: audioLang.bcp47 });
  const expectedOutput = buildExpectedOutput({
    preset, filename, durationSeconds: estDur, language: audioLang, estimatedSizeBytes: estimateWavBytes(estDur),
  });
  return { ...preset, available: blockers.length === 0, blockers, warnings, expectedOutput };
}

function evaluateSubtitleTextPreset(preset, ctx, langInfo) {
  const segments = Array.isArray(ctx.segments) ? ctx.segments : [];
  const stats = countRenderedCueTexts(segments, langInfo.useTranslation, langInfo.bilingual);
  const blockers = [];
  const warnings = [];
  if (stats.rendered === 0) blockers.push('Add or transcribe at least one subtitle cue before exporting.');
  else if (!ctx.hasTranslation && (langInfo.useTranslation || langInfo.bilingual) && stats.translatedCount === 0) {
    blockers.push('Translate at least one subtitle cue before exporting translated or bilingual subtitles.');
  } else if (stats.missingTranslation > 0) {
    warnings.push(`${stats.missingTranslation} cue${stats.missingTranslation === 1 ? '' : 's'} lack translations and will fall back to original text.`);
  }
  if (preset.id === EXPORT_PRESET_IDS.SUBTITLE_VTT && !langInfo.bcp47) {
    warnings.push('Language is undetermined; WebVTT header will omit Language metadata.');
  }
  if (preset.id !== EXPORT_PRESET_IDS.SUBTITLE_TXT && stats.hasArrowToken) {
    warnings.push('Cue text contains "-->" and will be converted to "→" to protect subtitle players.');
  }
  const durationSeconds = resolveSubtitleDuration(segments);
  const filename = formatPresetFilename(preset.id, { ...ctx, languageCode: langInfo.bcp47 });
  const estimatedSizeBytes = estimateSubtitleBytes(segments, langInfo.useTranslation, langInfo.bilingual);
  const expectedOutput = buildExpectedOutput({ preset, filename, durationSeconds, language: langInfo, estimatedSizeBytes });
  return { ...preset, available: blockers.length === 0, blockers, warnings, expectedOutput };
}

function collectCommonVideoBlockers(ctx) {
  const blockers = [];
  if (ctx.isAudioOnly) blockers.push('Source file is audio-only; MP4 video export requires a video source.');
  else if (!ctx.hasLinkedVideo && !ctx.jobId) blockers.push('Re-link or upload the source video file before exporting MP4.');
  else if (!ctx.hasLinkedVideo) blockers.push('Source video is not linked in this browser session. Re-link the video file to export MP4.');
  else if (!ctx.jobId) blockers.push('Upload/transcribe the linked video to prepare an active media job before exporting MP4.');
  return blockers;
}

function evaluateVideoBurnedPreset(preset, ctx, langInfo) {
  const segments = Array.isArray(ctx.segments) ? ctx.segments : [];
  const stats = countRenderedCueTexts(segments, langInfo.useTranslation, langInfo.bilingual);
  const blockers = collectCommonVideoBlockers(ctx);
  const warnings = [];
  if (ctx.burnInSupported === false) blockers.push('Installed FFmpeg lacks libass support for burning captions.');
  if (stats.rendered === 0) blockers.push('Add or transcribe at least one subtitle cue to burn into MP4.');
  else if (stats.invalidTimingCount > 0) {
    blockers.push(`Fix ${stats.invalidTimingCount} subtitle cue${stats.invalidTimingCount === 1 ? '' : 's'} with zero or negative duration before burning video.`);
  } else if (!ctx.hasTranslation && (langInfo.useTranslation || langInfo.bilingual) && stats.translatedCount === 0) {
    blockers.push('Translate at least one subtitle cue before burning translated or bilingual subtitles.');
  } else if (stats.missingTranslation > 0) {
    warnings.push(`${stats.missingTranslation} cue${stats.missingTranslation === 1 ? '' : 's'} lack translations and will render original text.`);
  }
  if (ctx.hasAudioStream === false) warnings.push('Source video has no audio stream; exported MP4 will be silent.');
  if (ctx.videoSize?.width && ctx.videoSize?.height && ((ctx.videoSize.width % 2 !== 0) || (ctx.videoSize.height % 2 !== 0))) {
    warnings.push('Odd video dimensions will be aligned to even pixels for universal H.264 yuv420p playback.');
  }
  const durationSeconds = Number(ctx.videoDuration) || resolveSubtitleDuration(segments);
  const filename = formatPresetFilename(preset.id, { ...ctx, languageCode: langInfo.bcp47 });
  const videoMeta = {
    audioMode: VIDEO_AUDIO_MODES.ORIGINAL,
    audioModeLabel: 'Original audio',
    subtitleMode: VIDEO_SUBTITLE_MODES.BURNED,
    subtitleModeLabel: formatVideoSubtitleModeSummary(VIDEO_SUBTITLE_MODES.BURNED, langInfo),
  };
  return {
    ...preset,
    available: blockers.length === 0,
    blockers,
    warnings,
    expectedOutput: buildExpectedOutput({
      preset, filename, durationSeconds, language: langInfo, videoMeta, estimatedSizeBytes: estimateVideoBytes(ctx, durationSeconds),
    }),
  };
}

function resolveDubVideoSuffix(audioMode, subtitleMode) {
  if (audioMode === VIDEO_AUDIO_MODES.ORIGINAL) {
    if (subtitleMode === VIDEO_SUBTITLE_MODES.BURNED) return '-subtitled.mp4';
    if (subtitleMode === VIDEO_SUBTITLE_MODES.SOFT) return '-captioned.mp4';
    return '-original.mp4';
  }
  if (subtitleMode === VIDEO_SUBTITLE_MODES.BURNED) return '-dubbed-subtitled.mp4';
  if (subtitleMode === VIDEO_SUBTITLE_MODES.SOFT) return '-dubbed-captioned.mp4';
  return PRESET_SUFFIXES.video_dubbed_mp4;
}

/**
 * Resolves the exact MP4 stream codec summary for a dubbed video export given its subtitle mode.
 * Inputs: `subtitleMode` (`'none' | 'burned' | 'soft'`) and optional `defaultCodec`.
 * Outputs: human-readable codec string matching the actual FFmpeg muxing pipeline.
 * Side effects: none.
 * Failure modes: defaults cleanly to the standard H.264/HEVC + AAC codec descriptor.
 * @param {string} subtitleMode - Video subtitle mode.
 * @param {string} [defaultCodec] - Base video+audio codec label.
 * @returns {string} Exact codec summary.
 */
export function resolveDubVideoCodec(subtitleMode, defaultCodec = `H.264/HEVC (hvc1/yuv420p) + ${DUB_AAC_BITRATE_LABEL}`) {
  if (subtitleMode === VIDEO_SUBTITLE_MODES.BURNED) return `H.264 (yuv420p) + ${DUB_AAC_BITRATE_LABEL}`;
  if (subtitleMode === VIDEO_SUBTITLE_MODES.SOFT) return `${defaultCodec} + mov_text`;
  return defaultCodec;
}

function appendDubAudioMessages({ audioMode, dubClips, segments, ctx, blockers, warnings }) {
  if (!audioMode) {
    blockers.push('Select a supported video audio mode (original, replace/mute, duck, or keep/mix).');
    return;
  }
  if (audioMode !== VIDEO_AUDIO_MODES.REPLACE && ctx.hasAudioStream === false) {
    blockers.push('Source video has no original audio track; select Replacement dubbing (mute original) instead.');
  }
  if (audioMode === VIDEO_AUDIO_MODES.ORIGINAL) {
    if (dubClips.length > 0) warnings.push('Original audio mode is selected; generated dubbed voice clips will not be mixed.');
    return;
  }
  if (dubClips.length === 0) blockers.push('Generate at least one dubbed voice clip before exporting dubbed MP4.');
  else if (dubClips.length > MAX_DUB_EXPORT_CLIPS) blockers.push(`Dubbed MP4 supports up to ${MAX_DUB_EXPORT_CLIPS} voice clips per export.`);
  const mismatch = dubClips.length > 0
    ? detectDurationMismatches({
      segments, segmentClips: ctx.segmentClips || {}, mediaDuration: Number(ctx.videoDuration) || 0,
      spillApprovals: ctx.spillApprovals || {}, selectedIds: ctx.selectedIds, targetOnly: true,
    })
    : { unresolved: [] };
  if (mismatch.unresolved.length > 0) {
    blockers.push(`Resolve ${mismatch.unresolved.length} speech duration mismatch${mismatch.unresolved.length === 1 ? '' : 'es'} before exporting dubbed MP4.`);
  }
  if (audioMode === VIDEO_AUDIO_MODES.REPLACE) warnings.push('Original video audio track will be muted in the exported dubbed MP4.');
  if (dubClips.length > 0 && dubClips.length < segments.length) warnings.push(`${dubClips.length} of ${segments.length} cues will receive dubbed voices.`);
}

function appendDubSubtitleMessages({ subtitleMode, segments, langInfo, ctx, blockers, warnings }) {
  if (!subtitleMode) {
    blockers.push('Select a supported video subtitle mode (none, burned, or soft).');
    return;
  }
  if (subtitleMode === VIDEO_SUBTITLE_MODES.NONE) return;
  const stats = countRenderedCueTexts(segments, langInfo.useTranslation, langInfo.bilingual);
  if (subtitleMode === VIDEO_SUBTITLE_MODES.BURNED && ctx.burnInSupported === false) {
    blockers.push('Installed FFmpeg lacks libass support for burning captions.');
  }
  if (stats.rendered === 0) {
    blockers.push(`Add or transcribe at least one subtitle cue to ${subtitleMode === VIDEO_SUBTITLE_MODES.BURNED ? 'burn into' : 'embed into'} MP4.`);
  } else if (stats.invalidTimingCount > 0) {
    blockers.push(`Fix ${stats.invalidTimingCount} subtitle cue${stats.invalidTimingCount === 1 ? '' : 's'} with zero or negative duration before exporting video subtitles.`);
  } else if (!ctx.hasTranslation && (langInfo.useTranslation || langInfo.bilingual) && stats.translatedCount === 0) {
    blockers.push('Translate at least one subtitle cue before exporting translated or bilingual video subtitles.');
  } else if (stats.missingTranslation > 0) {
    warnings.push(`${stats.missingTranslation} cue${stats.missingTranslation === 1 ? '' : 's'} lack translations and will fall back to original text.`);
  }
  if (subtitleMode === VIDEO_SUBTITLE_MODES.BURNED && ctx.videoSize?.width && ctx.videoSize?.height && ((ctx.videoSize.width % 2 !== 0) || (ctx.videoSize.height % 2 !== 0))) {
    warnings.push('Odd video dimensions will be aligned to even pixels for universal H.264 yuv420p playback.');
  }
  if (subtitleMode === VIDEO_SUBTITLE_MODES.SOFT) {
    warnings.push('Embedded MP4 subtitle track (mov_text) can be toggled on/off in players; burn-in box/color styling applies only to Burned-in mode.');
  }
}

function collectDubVideoMessages({ segments, dubClips, audioMode, subtitleMode, langInfo, ctx }) {
  const blockers = collectCommonVideoBlockers(ctx);
  const warnings = [];
  if (ctx.dubMixSettings !== undefined && ctx.dubMixSettings !== null) {
    try {
      validateDubMixSettings(ctx.dubMixSettings);
    } catch (err) {
      blockers.push(err.message);
    }
  }
  appendDubAudioMessages({ audioMode, dubClips, segments, ctx, blockers, warnings });
  appendDubSubtitleMessages({ subtitleMode, segments, langInfo, ctx, blockers, warnings });
  const nameLower = String(ctx.videoFileName || '').toLowerCase();
  if (nameLower && !MP4_EXT_PATTERN.test(nameLower)) {
    warnings.push('Non-MP4 source container will be converted or hvc1-tagged into MP4 (H.264/HEVC + AAC) for QuickTime/VLC/browser playback.');
  }
  return { blockers, warnings };
}

function evaluateVideoDubbedPreset(preset, ctx, langInfo) {
  const segments = Array.isArray(ctx.segments) ? ctx.segments : [];
  const rawAudio = ctx.dubAudioMode === undefined || ctx.dubAudioMode === null || ctx.dubAudioMode === '' ? VIDEO_AUDIO_MODES.DUCK : ctx.dubAudioMode;
  const rawSub = ctx.dubSubtitleMode === undefined || ctx.dubSubtitleMode === null || ctx.dubSubtitleMode === '' ? DEFAULT_DUB_SUBTITLE_MODE : ctx.dubSubtitleMode;
  const audioMode = resolveCanonicalVideoAudioMode(rawAudio);
  const subtitleMode = resolveCanonicalVideoSubtitleMode(rawSub);
  const dubClips = buildDubExportClips(segments, ctx.selectedIds, ctx.segmentClips || {}, {
    spillApprovals: ctx.spillApprovals || {},
    mediaDuration: Number(ctx.videoDuration) || 0,
  });
  const { blockers, warnings } = collectDubVideoMessages({ segments, dubClips, audioMode, subtitleMode, langInfo, ctx });
  const safeAudio = audioMode || VIDEO_AUDIO_MODES.DUCK;
  const safeSub = subtitleMode || DEFAULT_DUB_SUBTITLE_MODE;
  const durationSeconds = Number(ctx.videoDuration) || resolveSubtitleDuration(segments);
  const audioLang = safeAudio === VIDEO_AUDIO_MODES.ORIGINAL
    ? resolvePresetLanguageInfo({ languageMode: 'original', detectedLanguage: ctx.detectedLanguage, sourceLanguage: ctx.sourceLanguage })
    : resolveAudioLanguageInfo(ctx, langInfo);
  const suffixOverride = resolveDubVideoSuffix(safeAudio, safeSub);
  const filename = formatPresetFilename(preset.id, { ...ctx, languageCode: audioLang.bcp47, suffixOverride });
  const videoMeta = {
    audioMode: safeAudio,
    audioModeLabel: formatVideoAudioModeSummary(safeAudio, ctx.dubMixSettings),
    subtitleMode: safeSub,
    subtitleModeLabel: formatVideoSubtitleModeSummary(safeSub, langInfo),
  };
  const expectedOutput = buildExpectedOutput({
    preset, filename, durationSeconds, language: audioLang,
    codecOverride: resolveDubVideoCodec(safeSub, preset.codec), videoMeta,
    estimatedSizeBytes: estimateVideoBytes(ctx, durationSeconds),
  });
  return { ...preset, available: blockers.length === 0, blockers, warnings, expectedOutput };
}

/**
 * Evaluates a single export preset against live workspace state to produce blockers, warnings, and expected output.
 * Inputs: `presetId` and workspace `context` object.
 * Outputs: Evaluated preset object `{ ...preset, available, blockers, warnings, expectedOutput }`.
 * Side effects: none.
 * Failure modes: throws ValidationError when `presetId` is unknown.
 * @param {string} presetId - Target preset id.
 * @param {object} [context] - Workspace snapshot/state.
 * @returns {Readonly<object>} Evaluated preset report.
 */
export function evaluateExportPreset(presetId, context = {}) {
  const preset = PRESET_BY_ID.get(presetId);
  if (!preset) throw new ValidationError(`Unknown export preset '${presetId}'.`, 'presetId', 'UNKNOWN_EXPORT_PRESET');
  const langInfo = resolvePresetLanguageInfo(context);
  switch (presetId) {
    case EXPORT_PRESET_IDS.TTS_NARRATION_WAV:
      return Object.freeze(evaluateTtsNarrationPreset(preset, context, langInfo));
    case EXPORT_PRESET_IDS.SUBTITLE_VOICEOVER_WAV:
    case EXPORT_PRESET_IDS.SUBTITLE_ALIGNED_WAV:
      return Object.freeze(evaluateSubtitleAudioPreset(preset, context, langInfo));
    case EXPORT_PRESET_IDS.SUBTITLE_SRT:
    case EXPORT_PRESET_IDS.SUBTITLE_VTT:
    case EXPORT_PRESET_IDS.SUBTITLE_TXT:
      return Object.freeze(evaluateSubtitleTextPreset(preset, context, langInfo));
    case EXPORT_PRESET_IDS.VIDEO_BURNED_MP4:
      return Object.freeze(evaluateVideoBurnedPreset(preset, context, langInfo));
    case EXPORT_PRESET_IDS.VIDEO_DUBBED_MP4:
      return Object.freeze(evaluateVideoDubbedPreset(preset, context, langInfo));
    default:
      throw new ValidationError(`Unsupported export preset '${presetId}'.`, 'presetId', 'UNKNOWN_EXPORT_PRESET');
  }
}

/**
 * Evaluates all presets matching `context.workspace` (`'tts'`, `'subtitle'`, or all when omitted).
 * Inputs: workspace `context`.
 * Outputs: Frozen array of evaluated preset reports.
 * Side effects: none.
 * Failure modes: never throws on missing optional state fields.
 * @param {object} [context] - Workspace state.
 * @returns {ReadonlyArray<Readonly<object>>} Evaluated presets.
 */
export function evaluateExportPresets(context = {}) {
  const workspace = context?.workspace === 'tts' || context?.workspace === 'subtitle' ? context.workspace : '';
  const list = workspace ? EXPORT_PRESETS.filter(p => p.workspace === workspace) : EXPORT_PRESETS;
  return Object.freeze(list.map(preset => evaluateExportPreset(preset.id, context)));
}

/**
 * Records a completed export for a known preset, filling metadata from the preset catalog.
 * Inputs: existing `history`, `presetId`, and override `spec` (`filename`, `durationSeconds`, `languageCode`, etc.).
 * Outputs: New frozen export history array (newest first, capped at `MAX_EXPORT_HISTORY`).
 * Side effects: none.
 * Failure modes: throws ValidationError when `filename` is missing.
 * @param {Array<object>} [history=[]] - Current project export history.
 * @param {string} [presetId='custom'] - Preset id from `EXPORT_PRESET_IDS`.
 * @param {object} [spec={}] - Completed export metadata.
 * @returns {ReadonlyArray<Readonly<object>>} Updated export history.
 */
export function recordPresetExport(history = [], presetId = 'custom', spec = {}) {
  const preset = PRESET_BY_ID.get(presetId) || null;
  return appendExportHistory(history, {
    presetId: preset?.id || presetId,
    category: preset?.category || spec.category,
    label: preset?.label || spec.label,
    format: preset?.format || spec.format,
    codec: preset?.codec || spec.codec,
    sampleRate: spec.sampleRate ?? preset?.sampleRate ?? null,
    ...spec,
  });
}
