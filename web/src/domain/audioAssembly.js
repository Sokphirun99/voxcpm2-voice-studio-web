/**
 * @fileoverview Pure domain module for assembling ordered audio narration from project segments and takes.
 */

import { SynthesisError, ValidationError } from './errors.js';
import { getSegmentActiveTake } from './projectSegments.js';
import {
  concatenateWavBlobsWithPauses,
  inspectWavBuffer,
  tryReadWavDurationSeconds,
} from './wavCodec.js';

export const DEFAULT_ASSEMBLY_PAUSE_SECONDS = 0.2;
export const EXPECTED_AUDIO_FORMAT = 1; // PCM
export const EXPECTED_BITS_PER_SAMPLE = 16;
export const DEFAULT_NARRATION_FILENAME = 'voxcpm2-assembled-narration.wav';

const MS_PER_SECOND = 1000;
const SLUG_SANITIZE_REGEX = /[^\p{L}\p{M}\p{N}._-]+/gu;
const SLUG_TRIM_REGEX = /^-+|-+$/g;

/**
 * Finds all 1-based segment positions that lack an active audio take.
 * Inputs: array of ProjectSegments.
 * Outputs: array of 1-based indices of omitted segments.
 * Side effects: none.
 * Failure modes: returns empty array for non-array input.
 * @param {object[]} segments - Project segments.
 * @returns {number[]} 1-based omitted segment indices.
 */
export function findOmittedSegmentIndices(segments) {
  if (!Array.isArray(segments)) return [];
  const omitted = [];
  segments.forEach((seg, idx) => {
    const text = (seg?.text || '').trim();
    if (!text) return;
    const take = getSegmentActiveTake(seg);
    if (!take) omitted.push(idx + 1);
  });
  return omitted;
}

function formatMissingTakesMessage(omitted) {
  if (omitted.length === 1) {
    return `Segment #${omitted[0]} has no audio take. Generate all segments before assembling narration.`;
  }
  return `Segments #${omitted.join(', #')} have no audio takes. Generate all segments before assembling narration.`;
}

/**
 * Asserts that segments collection has valid text and no missing takes.
 * Inputs: segments array.
 * Outputs: active segments with text.
 * Side effects: none.
 * Failure modes: throws ValidationError if empty or any segment lacks audio.
 * @param {object[]} segments - Project segments.
 * @returns {object[]} Active segments.
 */
export function assertCompleteSegments(segments) {
  const active = (segments || []).filter(s => (s?.text || '').trim().length > 0);
  if (active.length === 0) {
    throw new ValidationError('No script segments available to assemble.', 'script', 'EMPTY_SEGMENTS');
  }
  const omitted = findOmittedSegmentIndices(segments);
  if (omitted.length > 0) {
    throw new ValidationError(formatMissingTakesMessage(omitted), 'segments', 'MISSING_SEGMENT_TAKE');
  }
  return active;
}

/**
 * Validates PCM encoding and bit depth of parsed WAV format metadata.
 * Inputs: parsed format info and 0-based segment index.
 * Outputs: none.
 * Side effects: none.
 * Failure modes: throws SynthesisError on non-PCM or unsupported bit depth.
 * @param {object} info - WAV format metadata.
 * @param {number} index - 0-based segment index.
 */
export function assertPcmFormat(info, index) {
  if (info.audioFormat !== EXPECTED_AUDIO_FORMAT) {
    throw new SynthesisError(`Segment #${index + 1} is not PCM audio.`, { code: 'WAV_FORMAT_MISMATCH' });
  }
  if (info.bitsPerSample !== EXPECTED_BITS_PER_SAMPLE) {
    throw new SynthesisError(
      `Segment #${index + 1} has unsupported bit depth: expected ${EXPECTED_BITS_PER_SAMPLE}-bit PCM, got ${info.bitsPerSample}-bit.`,
      { code: 'WAV_FORMAT_MISMATCH' }
    );
  }
}

/**
 * Validates that current segment format matches baseline sample rate, channels, and bit depth.
 * Inputs: base format info, current format info, 0-based index.
 * Outputs: none.
 * Side effects: none.
 * Failure modes: throws SynthesisError with exact mismatch details.
 * @param {object} base - Baseline format info.
 * @param {object} current - Current segment format info.
 * @param {number} index - 0-based segment index.
 */
export function assertMatchingWaveFormats(base, current, index) {
  assertPcmFormat(current, index);
  if (current.sampleRate !== base.sampleRate) {
    throw new SynthesisError(
      `Segment #${index + 1} has mismatched sample rate: expected ${base.sampleRate} Hz, received ${current.sampleRate} Hz.`,
      { code: 'WAV_FORMAT_MISMATCH' }
    );
  }
  if (current.numChannels !== base.numChannels) {
    throw new SynthesisError(
      `Segment #${index + 1} has mismatched channels: expected ${base.numChannels}, received ${current.numChannels}.`,
      { code: 'WAV_FORMAT_MISMATCH' }
    );
  }
}

/**
 * Resolves binary WAV Blob from take via local blob, assetFetcher, or audioUrl.
 * Inputs: take entity and optional assetFetcher callback.
 * Outputs: Promise resolving to Blob or null.
 * Side effects: network or storage fetch if needed.
 * Failure modes: returns null if unresolvable.
 * @param {object} take - Segment take.
 * @param {Function|null} assetFetcher - Binary asset retriever.
 * @returns {Promise<Blob|null>} Audio blob.
 */
export async function resolveTakeAudioBlob(take, assetFetcher) {
  if (take?.blob && typeof take.blob.arrayBuffer === 'function') return take.blob;
  if (take?.audioAssetId && assetFetcher) {
    const res = await assetFetcher(take.audioAssetId);
    const bytes = res?.bytes || res;
    if (bytes) return new Blob([bytes], { type: 'audio/wav' });
  }
  if (take?.audioUrl && typeof fetch === 'function') {
    try {
      const resp = await fetch(take.audioUrl);
      if (resp.ok) return await resp.blob();
    } catch {
      return null;
    }
  }
  return null;
}

function resolveSegmentPauseDuration(seg, defaultPauseSeconds) {
  const isCustom = typeof seg.pauseDuration === 'number' && seg.pauseDuration >= 0;
  return isCustom ? seg.pauseDuration : defaultPauseSeconds;
}

/**
 * Prepares ordered assembly entry from segment and resolved take audio.
 * Inputs: segment, index, assetFetcher, defaultPauseSeconds, allSegments.
 * Outputs: Promise resolving to assembly entry.
 * Side effects: resolves take audio buffer.
 * Failure modes: throws SynthesisError if take audio cannot be resolved.
 * @param {{ seg: object, idx: number, assetFetcher?: Function|null, defaultPauseSeconds: number, allSegments?: object[] }} spec - Entry spec.
 * @returns {Promise<object>} Assembly entry.
 */
export async function buildAssemblyEntry({ seg, idx, assetFetcher, defaultPauseSeconds, allSegments }) {
  const take = getSegmentActiveTake(seg);
  const blob = await resolveTakeAudioBlob(take, assetFetcher);
  const position = Array.isArray(allSegments) && allSegments.indexOf(seg) >= 0
    ? allSegments.indexOf(seg) + 1
    : idx + 1;
  if (!blob) {
    throw new SynthesisError(`Missing audio for segment #${position}.`, { code: 'UNRESOLVED_TAKE_AUDIO' });
  }
  const pauseSec = resolveSegmentPauseDuration(seg, defaultPauseSeconds);
  const pauseAfterMs = Math.round(pauseSec * MS_PER_SECOND);
  return { blob, pauseAfterMs, segmentId: seg.id, text: seg.text, take, segment: seg };
}

/**
 * Pre-validates WAV formats of all assembly entries before concatenation begins.
 * Inputs: array of assembly entries.
 * Outputs: Promise settling when all formats pass.
 * Side effects: reads arrayBuffer from each entry blob.
 * Failure modes: throws SynthesisError on format mismatch or corrupted header.
 * @param {Array<{ blob: Blob }>} entries - Assembly entries.
 * @returns {Promise<void>}
 */
export async function validateAssemblyTakeFormats(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  const buffers = await Promise.all(entries.map(entry => entry.blob.arrayBuffer()));
  const baseInfo = inspectWavBuffer(buffers[0]);
  assertPcmFormat(baseInfo, 0);

  for (let i = 1; i < buffers.length; i++) {
    const info = inspectWavBuffer(buffers[i]);
    assertMatchingWaveFormats(baseInfo, info, i);
  }
}

/**
 * Formats a clean narration export filename from project title or default fallback.
 * Inputs: project title string and optional fallback name.
 * Outputs: sanitized filename string ending in .wav.
 * Side effects: none.
 * Failure modes: returns fallback when title is empty or non-string.
 * @param {string|null} [title] - Project title.
 * @param {string} [fallback] - Fallback filename.
 * @returns {string} Sanitized filename.
 */
export function formatNarrationExportFilename(title, fallback = DEFAULT_NARRATION_FILENAME) {
  if (typeof title !== 'string' || !title.trim()) return fallback;
  const slug = title.trim().toLowerCase().replace(SLUG_SANITIZE_REGEX, '-').replace(SLUG_TRIM_REGEX, '');
  return slug ? `${slug}-narration.wav` : fallback;
}

function resolveNarrationIdentity(chunks, character) {
  const distinctVoices = Array.from(new Set(chunks.map(c => c.voiceId).filter(Boolean)));
  if (distinctVoices.length > 1) {
    return { characterId: 'multi-speaker', characterName: 'Multiple speakers', isMultiSpeaker: true };
  }
  const singleId = distinctVoices[0] || character?.id || null;
  const singleName = character?.name || singleId || 'Voice';
  return { characterId: singleId, characterName: singleName, isMultiSpeaker: false };
}

function mapAssemblyEntryToChunk(entry, idx) {
  return {
    index: idx,
    segmentId: entry.segmentId,
    text: entry.text,
    duration: entry.take.duration,
    durationSeconds: entry.take.duration,
    pauseAfterMs: entry.pauseAfterMs,
    blob: entry.blob,
    takeId: entry.take.id,
    seed: entry.take.settings?.seed ?? null,
    voiceId: entry.segment?.voiceId || entry.take?.settings?.voiceId || null,
    speakerId: entry.segment?.speakerId || entry.segment?.speaker || null,
    speakerName: entry.segment?.speakerName || null,
  };
}

function resolveNarrationBlobUrl(blob) {
  return typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
    ? URL.createObjectURL(blob)
    : null;
}

function createAssembledRecording(spec) {
  const { combinedBlob, duration, entries, character, mastered, filename } = spec;
  const chunks = entries.map(mapAssemblyEntryToChunk);
  const identity = resolveNarrationIdentity(chunks, character);
  return {
    id: `take-narration-${Date.now()}`,
    blob: combinedBlob,
    audioUrl: resolveNarrationBlobUrl(combinedBlob),
    duration,
    audioDurationSeconds: duration,
    transcript: entries.map(e => e.text).join('\n'),
    characterId: identity.characterId,
    characterName: identity.characterName,
    isMultiSpeaker: identity.isMultiSpeaker,
    chunks,
    isRestitched: true,
    isAssembled: true,
    isNarration: true,
    filename,
    fromCache: false,
    mastered,
  };
}

async function readBlobDurationSeconds(blob) {
  if (!blob || typeof blob.arrayBuffer !== 'function') return 0;
  const buffer = await blob.arrayBuffer();
  return tryReadWavDurationSeconds(buffer);
}

async function applyAudioMastering({ audioMaster, blob, signal, options }) {
  if (options.masterAudio === false || !audioMaster) {
    return { blob, mastered: false };
  }
  const res = await audioMaster.masterWav(blob, { signal });
  return { blob: res.blob, mastered: res.mastered };
}

async function resolveAssemblyEntries(segments, assetFetcher, defaultPauseSec, allSegments) {
  const entries = await Promise.all(
    segments.map((seg, idx) => buildAssemblyEntry({ seg, idx, assetFetcher, defaultPauseSeconds: defaultPauseSec, allSegments }))
  );
  await validateAssemblyTakeFormats(entries);
  return entries;
}

/**
 * Assembles all selected segment takes in exact order with calibrated pauses and format validation.
 * Inputs: assembly parameters ({ segments, character, options, assetFetcher, audioMaster, signal, projectTitle }).
 * Outputs: Promise resolving to { recording, blob, filename }.
 * Side effects: reads buffers, stitches WAV slices, applies optional mastering.
 * Failure modes: throws ValidationError on omitted takes, SynthesisError on format mismatch.
 * @param {object} params - Assembly parameters.
 * @returns {Promise<{ recording: object, blob: Blob, filename: string }>} Assembled narration.
 */
export async function assembleAudioNarration(params) {
  const { segments, character, options = {}, assetFetcher = null, audioMaster = null, signal, projectTitle, filename: explicitFilename = '' } = params || {};
  const activeSegments = assertCompleteSegments(segments);
  const defaultPauseSec = typeof options.defaultPauseSeconds === 'number'
    ? options.defaultPauseSeconds
    : DEFAULT_ASSEMBLY_PAUSE_SECONDS;
  const entries = await resolveAssemblyEntries(activeSegments, assetFetcher, defaultPauseSec, segments);

  const stitchedBlob = await concatenateWavBlobsWithPauses(entries, Math.round(defaultPauseSec * MS_PER_SECOND));
  const { blob: finalBlob, mastered } = await applyAudioMastering({ audioMaster, blob: stitchedBlob, signal, options });

  const duration = await readBlobDurationSeconds(finalBlob);
  const cleanOverride = typeof explicitFilename === 'string' && explicitFilename.trim()
    ? explicitFilename.trim()
    : (typeof options.filename === 'string' && options.filename.trim() ? options.filename.trim() : '');
  const filename = cleanOverride || formatNarrationExportFilename(projectTitle || options.projectTitle);
  const recording = createAssembledRecording({ combinedBlob: finalBlob, duration, entries, character, mastered, filename });
  return { recording, blob: finalBlob, filename };
}

export { assembleTimelineAlignedVoiceover } from './subtitleTts.js';
