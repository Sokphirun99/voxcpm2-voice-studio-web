/**
 * @fileoverview Pure domain module for stable editable script segments, status lifecycle, and Khmer Unicode grapheme cluster integrity.
 */

import { ValidationError } from './errors.js';
import { normalizeKhmerUnicode } from './khmerText.js';
import { createProjectSegment, createSegmentTake, generateProjectId } from './projects.js';
import {
  MAX_PAUSE_MS,
  SENTENCE_SPLIT_PATTERN,
  splitOnPauseMarkers,
} from './scriptSegmentation.js';

export const SEGMENT_STATUSES = Object.freeze(['draft', 'ready', 'outdated', 'error']);
export const DEFAULT_SEGMENT_STATUS = 'draft';
export const DEFAULT_PAUSE_SECONDS = 0.5;
export const MAX_PAUSE_SECONDS = 5.0;
export const MIN_PAUSE_SECONDS = 0.1;

const KHMER_COMBINING_START = 0x17b6;
const KHMER_COMBINING_END = 0x17d3;
const KHMER_COENG = 0x17d2;
const SPACE_CODE_MAX = 0x20;
const MS_IN_SECOND = 1000;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Splits a text into grapheme clusters preserving complex multi-codepoint scripts.
 * Inputs: raw text string.
 * Outputs: array of grapheme cluster strings.
 * Side effects: none.
 * Failure modes: returns empty array for non-string or empty input.
 * @param {string} text - Input text.
 * @returns {string[]} Grapheme clusters.
 */
export function splitGraphemeClusters(text) {
  if (typeof text !== 'string' || !text) return [];
  const clusters = [];
  for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) {
    clusters.push(segment);
  }
  return clusters;
}

/**
 * Counts visual grapheme clusters in text.
 * Inputs: raw text string.
 * Outputs: integer count.
 * Side effects: none.
 * Failure modes: returns 0 for non-string or empty input.
 * @param {string} text - Input text.
 * @returns {number} Cluster count.
 */
export function countGraphemeClusters(text) {
  if (typeof text !== 'string' || !text) return 0;
  let count = 0;
  for (const _item of GRAPHEME_SEGMENTER.segment(text)) count += 1;
  return count;
}

/**
 * Slices text strictly at grapheme cluster boundaries.
 * Inputs: text, startIndex, optional length.
 * Outputs: sliced string preserving clusters.
 * Side effects: none.
 * Failure modes: returns empty string if text is invalid or indices out of bounds.
 * @param {string} text - Input text.
 * @param {number} start - Start cluster index.
 * @param {number} [length] - Optional slice length.
 * @returns {string} Sliced text.
 */
export function sliceGraphemeClusters(text, start, length) {
  const clusters = splitGraphemeClusters(text);
  const end = length !== undefined ? start + length : undefined;
  return clusters.slice(start, end).join('');
}

function isClusterClean(cluster) {
  if (cluster.charCodeAt(cluster.length - 1) === KHMER_COENG) return false;
  const first = cluster.charCodeAt(0);
  if (first >= KHMER_COMBINING_START && first <= KHMER_COMBINING_END) return false;
  if (first <= SPACE_CODE_MAX && cluster.length > 1) {
    const second = cluster.charCodeAt(1);
    if (second >= KHMER_COMBINING_START && second <= KHMER_COMBINING_END) return false;
  }
  return true;
}

/**
 * Checks whether text maintains grapheme cluster integrity without orphaned coeng or isolated combining marks.
 * Inputs: text string.
 * Outputs: boolean true if intact.
 * Side effects: none.
 * Failure modes: returns false for non-string.
 * @param {string} text - Text to inspect.
 * @returns {boolean} Whether text integrity is intact.
 */
export function isGraphemeClusterIntact(text) {
  if (typeof text !== 'string') return false;
  if (!text) return true;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) {
    if (!isClusterClean(segment)) return false;
  }
  return true;
}

/**
 * Asserts a valid segment status.
 * Inputs: candidate status.
 * Outputs: validated status string.
 * Side effects: none.
 * Failure modes: throws ValidationError if invalid.
 * @param {unknown} status - Candidate status.
 * @returns {string} Validated status.
 */
export function assertSegmentStatus(status) {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (!SEGMENT_STATUSES.includes(normalized)) {
    throw new ValidationError(
      `Segment status must be one of: ${SEGMENT_STATUSES.join(', ')}.`,
      'status',
      'INVALID_SEGMENT_STATUS'
    );
  }
  return normalized;
}

/**
 * Checks whether a specific take's recorded text, voice, or Stage 3 pronunciation signature differs from current state.
 * Inputs: take entity, segment entity, optional `{ pronunciationSignature }`.
 * Outputs: boolean true if take is outdated.
 * Side effects: none.
 * Failure modes: returns false for missing or invalid inputs.
 * @param {object} take - SegmentTake entity.
 * @param {object} segment - ProjectSegment entity.
 * @param {{ pronunciationSignature?: string }} [options] - Optional Stage 3 pronunciation comparison state.
 * @returns {boolean} Whether take is outdated.
 */
export function isTakeOutdated(take, segment, options = {}) {
  if (!take || !segment) return false;
  const takeText = take.text ?? take.settings?.text;
  if (typeof takeText === 'string' && takeText.trim() !== (segment.text || '').trim()) {
    return true;
  }
  const takeVoice = take.voiceId !== undefined ? take.voiceId : take.settings?.voiceId;
  if (takeVoice !== undefined) {
    const normTakeVoice = takeVoice || null;
    const normSegVoice = segment.voiceId || null;
    if (normTakeVoice !== normSegVoice) return true;
  }
  const expectedSig = options?.pronunciationSignature;
  if (expectedSig !== undefined) {
    const takeSig = take.settings?.pronunciationSignature;
    if (takeSig !== undefined ? takeSig !== expectedSig : expectedSig !== '') {
      return true;
    }
  }
  return false;
}

/**
 * Computes the lifecycle status for a project segment.
 * Inputs: segment object, optional `{ pronunciationSignature }`.
 * Outputs: 'draft' | 'ready' | 'outdated' | 'error'.
 * Side effects: none.
 * Failure modes: returns 'draft' for null/empty.
 * @param {object} segment - Project segment.
 * @param {{ pronunciationSignature?: string }} [options] - Optional Stage 3 pronunciation signature.
 * @returns {string} Derived status.
 */
export function computeSegmentStatus(segment, options = {}) {
  if (!segment) return DEFAULT_SEGMENT_STATUS;
  if (segment.status === 'error') return 'error';
  const takes = Array.isArray(segment.takes) ? segment.takes : [];
  if (takes.length === 0) return DEFAULT_SEGMENT_STATUS;
  const activeTake = takes.find(t => t.isSelected) || takes[takes.length - 1];
  if (!activeTake) return DEFAULT_SEGMENT_STATUS;
  if (isTakeOutdated(activeTake, segment, options)) return 'outdated';
  const hasRecorded = Boolean(activeTake.text || activeTake.settings?.text || activeTake.voiceId || activeTake.settings?.voiceId);
  return hasRecorded ? 'ready' : (segment.status === 'outdated' ? 'outdated' : 'ready');
}

/**
 * Checks whether a segment is marked as outdated.
 * Inputs: segment object.
 * Outputs: boolean.
 * Side effects: none.
 * Failure modes: returns false for null/empty.
 * @param {object} segment - Segment to inspect.
 * @returns {boolean} Whether segment is outdated.
 */
export function isSegmentOutdated(segment) {
  return computeSegmentStatus(segment) === 'outdated';
}

/**
 * Checks whether a segment has a ready active take.
 * Inputs: segment object.
 * Outputs: boolean.
 * Side effects: none.
 * Failure modes: returns false for null/empty.
 * @param {object} segment - Segment to inspect.
 * @returns {boolean} Whether segment is ready.
 */
export function isSegmentReady(segment) {
  return computeSegmentStatus(segment) === 'ready';
}

/**
 * Creates an editable ProjectSegment entity with stable id and status.
 * Inputs: segment specification object.
 * Outputs: frozen ProjectSegment entity.
 * Side effects: none.
 * Failure modes: throws ValidationError on missing id or invalid properties.
 * @param {object} spec - Segment specification.
 * @returns {Readonly<object>} Frozen ProjectSegment.
 */
export function createEditableSegment(spec = {}) {
  const id = spec.id || generateProjectId();
  const text = typeof spec.text === 'string' ? spec.text : '';
  const status = spec.status ? assertSegmentStatus(spec.status) : DEFAULT_SEGMENT_STATUS;
  const rawSegment = createProjectSegment({
    id,
    text,
    translatedText: typeof spec.translatedText === 'string' ? spec.translatedText : '',
    start: spec.start ?? null,
    end: spec.end ?? null,
    speaker: spec.speaker ?? null,
    speakerId: spec.speakerId ?? spec.speaker ?? null,
    speakerName: spec.speakerName ?? null,
    voiceId: spec.voiceId ?? null,
    takes: spec.takes ?? [],
    pauseDuration: spec.pauseDuration ?? null,
    status,
  });
  const computed = computeSegmentStatus({ ...rawSegment, status });
  return Object.freeze({ ...rawSegment, status: computed });
}

function resolveUpdatedStatus(segment, updates) {
  if (updates.status !== undefined) return assertSegmentStatus(updates.status);
  const textChanged = updates.text !== undefined && updates.text.trim() !== segment.text.trim();
  const voiceChanged = updates.voiceId !== undefined && updates.voiceId !== segment.voiceId;
  const hasTakes = Array.isArray(segment.takes) && segment.takes.length > 0;
  if ((textChanged || voiceChanged) && hasTakes) return 'outdated';
  return segment.status || DEFAULT_SEGMENT_STATUS;
}

/**
 * Updates a segment's content in place while preserving its stable UUID and takes.
 * Inputs: target segment and update fields.
 * Outputs: new frozen ProjectSegment entity.
 * Side effects: none.
 * Failure modes: throws ValidationError if segment is missing or updates invalid.
 * @param {object} segment - Existing segment to update.
 * @param {object} updates - Fields to change ({ text, voiceId, pauseDuration, status, takes }).
 * @returns {Readonly<object>} Updated frozen ProjectSegment.
 */
export function updateSegmentContent(segment, updates = {}) {
  if (!segment || typeof segment !== 'object' || !segment.id) {
    throw new ValidationError('Valid segment is required.', 'segment', 'INVALID_SEGMENT');
  }
  const nextStatus = resolveUpdatedStatus(segment, updates);
  return createEditableSegment({
    ...segment,
    ...updates,
    id: segment.id,
    takes: updates.takes ?? segment.takes,
    status: nextStatus,
  });
}

/**
 * Updates a single segment in an array by ID without altering other segments.
 * Inputs: segments array, target segmentId, updates object.
 * Outputs: new array with the target segment replaced and other segments strictly identical.
 * Side effects: none.
 * Failure modes: returns a copy of segments if segmentId is not found.
 * @param {object[]} segments - Array of ProjectSegments.
 * @param {string} segmentId - ID of segment to update.
 * @param {object} updates - Properties to update.
 * @returns {object[]} New array of segments.
 */
export function updateSegmentInList(segments, segmentId, updates) {
  if (!Array.isArray(segments)) return [];
  return segments.map(seg => {
    if (seg.id !== segmentId) return seg;
    return updateSegmentContent(seg, updates);
  });
}

function buildLcsMatrix(oldList, newList) {
  const rows = oldList.length + 1;
  const cols = newList.length + 1;
  const matrix = Array.from({ length: rows }, () => new Int32Array(cols));
  for (let r = 1; r < rows; r += 1) {
    for (let c = 1; c < cols; c += 1) {
      if (oldList[r - 1].text.trim() === newList[c - 1].text.trim()) {
        matrix[r][c] = matrix[r - 1][c - 1] + 1;
      } else {
        matrix[r][c] = Math.max(matrix[r - 1][c], matrix[r][c - 1]);
      }
    }
  }
  return matrix;
}

function backtrackLcs(matrix, oldList, newList) {
  const matches = [];
  let r = oldList.length;
  let c = newList.length;
  while (r > 0 && c > 0) {
    if (oldList[r - 1].text.trim() === newList[c - 1].text.trim()) {
      matches.push({ oldIdx: r - 1, newIdx: c - 1 });
      r -= 1;
      c -= 1;
    } else if (matrix[r - 1][c] >= matrix[r][c - 1]) {
      r -= 1;
    } else {
      c -= 1;
    }
  }
  return matches.reverse();
}

/**
 * Computes longest common subsequence matches between old segments and new parsed chunks.
 * Inputs: old segment list and new chunk list.
 * Outputs: array of { oldIdx, newIdx } exact matches.
 * Side effects: none.
 * Failure modes: returns empty array if either list is empty.
 * @param {Array<{ text: string }>} oldList - Existing items.
 * @param {Array<{ text: string }>} newList - New items.
 * @returns {Array<{ oldIdx: number, newIdx: number }>} Matched index pairs.
 */
export function computeLcsMatches(oldList, newList) {
  if (!oldList.length || !newList.length) return [];
  const matrix = buildLcsMatrix(oldList, newList);
  return backtrackLcs(matrix, oldList, newList);
}

function reconcileMatchedPair(existingSeg, chunk) {
  if (existingSeg.pauseDuration === chunk.pauseDuration) return existingSeg;
  return updateSegmentContent(existingSeg, { pauseDuration: chunk.pauseDuration });
}

function reconcileGapPair(chunk, existingSeg, options) {
  if (existingSeg) {
    return updateSegmentContent(existingSeg, {
      text: chunk.text,
      pauseDuration: chunk.pauseDuration,
    });
  }
  return createEditableSegment({
    id: generateProjectId(),
    text: chunk.text,
    pauseDuration: chunk.pauseDuration,
    voiceId: options.defaultVoiceId || null,
    speaker: options.defaultSpeaker || null,
    status: DEFAULT_SEGMENT_STATUS,
  });
}

function reconcileSlice({ chunkSlice, existingSlice, options }) {
  const result = [];
  const maxLen = Math.max(chunkSlice.length, existingSlice.length);
  for (let i = 0; i < maxLen; i += 1) {
    if (i < chunkSlice.length) {
      result.push(reconcileGapPair(chunkSlice[i], existingSlice[i] || null, options));
    }
  }
  return result;
}

function splitPartIntoChunks(part) {
  const sentences = part.text.split(SENTENCE_SPLIT_PATTERN).map(s => s.trim()).filter(Boolean);
  return sentences.map((sentence, idx) => ({
    text: sentence,
    pauseDuration: idx === sentences.length - 1 && part.pauseAfterMs != null ? part.pauseAfterMs / MS_IN_SECOND : null,
  }));
}

function parseScriptToChunks(rawScript) {
  const clean = normalizeKhmerUnicode(rawScript);
  if (!clean.trim()) return [];
  const parts = splitOnPauseMarkers(clean);
  return parts.flatMap(splitPartIntoChunks);
}

function applyLcsMatches({ matches, existing, chunks, options }) {
  const result = [];
  let prevOld = 0;
  let prevNew = 0;
  for (const match of matches) {
    const chunkSlice = chunks.slice(prevNew, match.newIdx);
    const existingSlice = existing.slice(prevOld, match.oldIdx);
    result.push(...reconcileSlice({ chunkSlice, existingSlice, options }));
    result.push(reconcileMatchedPair(existing[match.oldIdx], chunks[match.newIdx]));
    prevOld = match.oldIdx + 1;
    prevNew = match.newIdx + 1;
  }
  const tailChunks = chunks.slice(prevNew);
  const tailExisting = existing.slice(prevOld);
  result.push(...reconcileSlice({ chunkSlice: tailChunks, existingSlice: tailExisting, options }));
  return result;
}

/**
 * Reconciles incoming script text against existing segments preserving stable IDs and takes.
 * Inputs: existing segments array, raw script string, optional configuration.
 * Outputs: reconciled array of ProjectSegment entities.
 * Side effects: none.
 * Failure modes: returns empty array for blank script.
 * @param {object[]} existingSegments - Current project segments.
 * @param {string} rawScript - Raw script string.
 * @param {object} [options] - Configuration ({ defaultVoiceId, defaultSpeaker }).
 * @returns {object[]} Reconciled segments.
 */
export function reconcileScriptToSegments(existingSegments, rawScript, options = {}) {
  const existing = Array.isArray(existingSegments) ? existingSegments : [];
  const chunks = parseScriptToChunks(rawScript);
  if (chunks.length === 0) return [];
  if (existing.length === 0) {
    return chunks.map(c => reconcileGapPair(c, null, options));
  }
  const matches = computeLcsMatches(existing, chunks);
  return applyLcsMatches({ matches, existing, chunks, options });
}

/**
 * Converts a raw script string into stable editable ProjectSegment entities.
 * Inputs: raw script string, optional options ({ defaultVoiceId, defaultSpeaker }).
 * Outputs: array of ProjectSegment entities.
 * Side effects: none.
 * Failure modes: returns empty array if rawScript is blank.
 * @param {string} rawScript - Raw script text.
 * @param {object} [options] - Options.
 * @returns {object[]} ProjectSegment entities.
 */
export function scriptToSegments(rawScript, options = {}) {
  return reconcileScriptToSegments([], rawScript, options);
}

function formatSegmentPause(pauseSeconds) {
  if (!pauseSeconds || pauseSeconds <= 0) return '';
  const rounded = Math.round(pauseSeconds * 10) / 10;
  return ` [pause ${rounded}s]`;
}

/**
 * Serializes an array of segments into a continuous script with inline pause markers.
 * Inputs: ordered array of ProjectSegment objects.
 * Outputs: script text string.
 * Side effects: none.
 * Failure modes: returns empty string for empty array.
 * @param {object[]} segments - Ordered segments.
 * @returns {string} Script with pause tags.
 */
export function segmentsToScript(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return '';
  return segments
    .map((seg, idx) => {
      const text = (seg.text || '').trim();
      if (!text) return '';
      const pause = idx < segments.length - 1 ? formatSegmentPause(seg.pauseDuration) : '';
      return `${text}${pause}`;
    })
    .filter(Boolean)
    .join('\n');
}

function resolveTakeContext(fallbackVoiceOrContext, recordingId) {
  if (typeof fallbackVoiceOrContext === 'string') {
    return { fallbackVoice: fallbackVoiceOrContext, recordingId };
  }
  return fallbackVoiceOrContext && typeof fallbackVoiceOrContext === 'object' ? fallbackVoiceOrContext : {};
}

function buildTakeSettings(seg, chunk, context, voiceId) {
  return {
    text: seg.text,
    voiceId,
    seed: chunk?.seed ?? context.seed ?? null,
    anchorVersion: context.anchorVersion ?? 1,
    guidance: context.guidance ?? null,
    steps: context.steps ?? null,
    styleMode: context.styleMode ?? null,
    customStyle: context.customStyle || '',
    ...(context.pronunciationSignature !== undefined ? { pronunciationSignature: context.pronunciationSignature } : {}),
    ...(context.settings || {}),
  };
}

function buildTakeForSegment(seg, chunk, fallbackVoiceOrContext, recordingId) {
  const context = resolveTakeContext(fallbackVoiceOrContext, recordingId);
  const duration = chunk?.durationSeconds ?? chunk?.audioDurationSeconds ?? chunk?.duration ?? 1.0;
  const takeId = chunk?.takeId || context.takeId || `take-${context.recordingId || 'rec'}-${seg.id}`;
  const validDuration = typeof duration === 'number' && duration > 0 ? duration : 1.0;
  const voiceId = chunk?.voiceId || seg.voiceId || context.fallbackVoice || context.voiceId || null;
  return createSegmentTake({
    id: takeId,
    audioAssetId: chunk?.audioAssetId || context.audioAssetId || null,
    duration: validDuration,
    isSelected: true,
    settings: buildTakeSettings(seg, chunk, context, voiceId),
    blob: chunk?.blob || context.blob || null,
    audioUrl: chunk?.audioUrl || context.audioUrl || null,
  });
}

/**
 * Attaches newly generated recording takes to segments, transitioning their status to ready.
 * Inputs: segments array, recording object, options ({ voiceId }).
 * Outputs: updated array of ProjectSegment entities with active take attached.
 * Side effects: none.
 * Failure modes: returns segments unchanged if segments or recording is invalid.
 * @param {object[]} segments - Target segments.
 * @param {object} recording - Generated recording containing chunks or audio metadata.
 * @param {object} [options] - Options ({ voiceId }).
 * @returns {object[]} Updated segments with ready status.
 */
export function attachTakesToSegments(segments, recording, options = {}) {
  if (!Array.isArray(segments) || segments.length === 0 || !recording?.id) {
    return Array.isArray(segments) ? segments : [];
  }
  const voiceId = options.voiceId || recording.characterId || null;
  const chunks = Array.isArray(recording.chunks) ? recording.chunks : [];
  return segments.map((seg, idx) => {
    const chunk = chunks[idx] || (idx === 0 ? recording : null);
    const take = buildTakeForSegment(seg, chunk, { ...options, fallbackVoice: voiceId, recordingId: recording.id });
    const prevTakes = Array.isArray(seg.takes) ? seg.takes.map(t => ({ ...t, isSelected: false })) : [];
    return createEditableSegment({
      ...seg,
      voiceId: seg.voiceId || voiceId,
      takes: [...prevTakes, take],
      status: 'ready',
    });
  });
}

/**
 * Attaches a newly generated take to a specific segment, leaving all other segments untouched.
 * Inputs: segments array, segment ID, recording/chunk object, options ({ voiceId }).
 * Outputs: updated array of segments with the target segment set to ready and new take selected.
 * Side effects: none.
 * Failure modes: returns copy of segments if segmentId is not found or recording invalid.
 * @param {object[]} segments - Segments list.
 * @param {string} segmentId - ID of target segment.
 * @param {object} recording - Generated recording object.
 * @param {object} [options] - Options ({ voiceId }).
 * @returns {object[]} New array of segments.
 */
export function attachTakeToSegment(segments, segmentId, recording, options = {}) {
  if (!Array.isArray(segments) || !segmentId || !recording?.id) {
    return Array.isArray(segments) ? [...segments] : [];
  }
  const index = segments.findIndex(seg => seg.id === segmentId);
  if (index < 0) return [...segments];
  const target = segments[index];
  const voiceId = options.voiceId || recording.characterId || target.voiceId || null;
  const chunk = Array.isArray(recording.chunks) && recording.chunks.length > 0 ? recording.chunks[0] : recording;
  const take = buildTakeForSegment(target, chunk, { ...options, fallbackVoice: voiceId, recordingId: recording.id });
  const prevTakes = Array.isArray(target.takes) ? target.takes.map(t => ({ ...t, isSelected: false })) : [];
  const updated = createEditableSegment({
    ...target,
    voiceId: target.voiceId || voiceId,
    takes: [...prevTakes, take],
    status: 'ready',
  });
  return [...segments.slice(0, index), updated, ...segments.slice(index + 1)];
}

/**
 * Selects an existing take within a segment, setting isSelected=true and demoting others.
 * Inputs: target segment, take ID to select.
 * Outputs: updated segment entity.
 * Side effects: none.
 * Failure modes: returns segment unchanged if takeId is not found.
 * @param {object} segment - Segment entity.
 * @param {string} takeId - Target take ID.
 * @returns {object} Updated segment.
 */
export function selectSegmentTake(segment, takeId) {
  if (!segment || !Array.isArray(segment.takes) || !takeId) return segment;
  const exists = segment.takes.some(t => t.id === takeId);
  if (!exists) return segment;
  const takes = segment.takes.map(t => (t.id === takeId ? { ...t, isSelected: true } : { ...t, isSelected: false }));
  const candidate = { ...segment, takes };
  return createEditableSegment({ ...candidate, status: computeSegmentStatus(candidate) });
}

/**
 * Removes a take from a segment, re-electing the last remaining take if the removed one was selected.
 * Inputs: target segment, take ID to remove.
 * Outputs: updated segment entity.
 * Side effects: none.
 * Failure modes: returns segment unchanged if takeId is not found.
 * @param {object} segment - Segment entity.
 * @param {string} takeId - Take ID to delete.
 * @returns {object} Updated segment.
 */
export function removeSegmentTake(segment, takeId) {
  if (!segment || !Array.isArray(segment.takes) || !takeId) return segment;
  const remaining = segment.takes.filter(t => t.id !== takeId);
  if (remaining.length === segment.takes.length) return segment;
  if (remaining.length === 0) {
    return createEditableSegment({ ...segment, takes: [], status: 'draft' });
  }
  const hasSelected = remaining.some(t => t.isSelected);
  const takes = hasSelected
    ? remaining
    : remaining.map((t, idx) => (idx === remaining.length - 1 ? { ...t, isSelected: true } : t));
  const candidate = { ...segment, takes };
  return createEditableSegment({ ...candidate, status: computeSegmentStatus(candidate) });
}

/**
 * Finds a take by ID within a segment.
 * Inputs: segment entity, target take ID.
 * Outputs: SegmentTake or null.
 * Side effects: none.
 * Failure modes: returns null if not found.
 * @param {object} segment - Segment entity.
 * @param {string} takeId - Take ID.
 * @returns {object|null} Take or null.
 */
export function getSegmentTake(segment, takeId) {
  if (!segment || !Array.isArray(segment.takes) || !takeId) return null;
  return segment.takes.find(t => t.id === takeId) || null;
}

/**
 * Selects a take on a specific segment in a list of segments.
 * Inputs: segments array, target segmentId, takeId to select.
 * Outputs: new array with target segment updated.
 * Side effects: none.
 * Failure modes: returns copy of segments if segment or take not found.
 * @param {object[]} segments - Segments array.
 * @param {string} segmentId - Target segment ID.
 * @param {string} takeId - Take ID to select.
 * @returns {object[]} New array of segments.
 */
export function selectSegmentTakeInList(segments, segmentId, takeId) {
  if (!Array.isArray(segments) || !segmentId || !takeId) {
    return Array.isArray(segments) ? [...segments] : [];
  }
  return segments.map(seg => (seg.id === segmentId ? selectSegmentTake(seg, takeId) : seg));
}

/**
 * Removes a take from a specific segment in a list of segments.
 * Inputs: segments array, target segmentId, takeId to remove.
 * Outputs: new array with take removed from target segment.
 * Side effects: none.
 * Failure modes: returns copy of segments if segment or take not found.
 * @param {object[]} segments - Segments array.
 * @param {string} segmentId - Target segment ID.
 * @param {string} takeId - Take ID to remove.
 * @returns {object[]} New array of segments.
 */
export function removeSegmentTakeInList(segments, segmentId, takeId) {
  if (!Array.isArray(segments) || !segmentId || !takeId) {
    return Array.isArray(segments) ? [...segments] : [];
  }
  return segments.map(seg => (seg.id === segmentId ? removeSegmentTake(seg, takeId) : seg));
}

/**
 * Cycles the selected take of a segment forward (+1) or backward (-1).
 * Inputs: segment entity, optional direction (+1 or -1).
 * Outputs: updated ProjectSegment entity with new active take.
 * Side effects: none.
 * Failure modes: returns segment unchanged if takes array has 0 or 1 items.
 * @param {object} segment - Segment entity.
 * @param {number} [direction=1] - Cycle direction step.
 * @returns {object} Updated segment entity.
 */
export function cycleSegmentTake(segment, direction = 1) {
  if (!segment || !Array.isArray(segment.takes) || segment.takes.length <= 1) {
    return segment;
  }
  const takes = segment.takes;
  const currentIndex = takes.findIndex(t => t.isSelected);
  const baseIndex = currentIndex >= 0 ? currentIndex : takes.length - 1;
  const numDir = Number.isFinite(direction) ? Math.trunc(direction) : 1;
  const step = numDir % takes.length;
  const nextIndex = (baseIndex + step + takes.length) % takes.length;
  return selectSegmentTake(segment, takes[nextIndex].id);
}

/**
 * Cycles the selected take for a specific segment in a segments list.
 * Inputs: segments array, segmentId, optional direction.
 * Outputs: new array of segments with cycled take.
 * Side effects: none.
 * Failure modes: returns copy of segments if segmentId is not found.
 * @param {object[]} segments - Segments array.
 * @param {string} segmentId - Target segment ID.
 * @param {number} [direction=1] - Step direction (+1 or -1).
 * @returns {object[]} New array of segments.
 */
export function cycleSegmentTakeInList(segments, segmentId, direction = 1) {
  if (!Array.isArray(segments) || !segmentId) {
    return Array.isArray(segments) ? [...segments] : [];
  }
  return segments.map(seg => (seg.id === segmentId ? cycleSegmentTake(seg, direction) : seg));
}

/**
 * Resolves the active selected take of a segment.
 * Inputs: segment object.
 * Outputs: active SegmentTake or null.
 * Side effects: none.
 * Failure modes: returns null if segment has no takes.
 * @param {object} segment - Segment entity.
 * @returns {object|null} Active take or null.
 */
export function getSegmentActiveTake(segment) {
  if (!segment || !Array.isArray(segment.takes) || segment.takes.length === 0) return null;
  return segment.takes.find(t => t.isSelected) || segment.takes[segment.takes.length - 1];
}

/**
 * Checks if a segment has playable audio available.
 * Inputs: segment object.
 * Outputs: boolean true if segment has active take with audio.
 * Side effects: none.
 * Failure modes: returns false for invalid input.
 * @param {object} segment - Segment entity.
 * @returns {boolean} Whether segment has playable audio.
 */
export function hasSegmentAudio(segment) {
  const take = getSegmentActiveTake(segment);
  return Boolean(take && (take.blob || take.audioUrl || take.audioAssetId));
}

/**
 * Finds a segment by its stable ID within a segment collection.
 * Inputs: segments array, segment ID.
 * Outputs: matched segment or null.
 * Side effects: none.
 * Failure modes: returns null if not found.
 * @param {object[]} segments - Segments array.
 * @param {string} segmentId - ID to look up.
 * @returns {object|null} Matched segment.
 */
export function findSegmentById(segments, segmentId) {
  if (!Array.isArray(segments) || !segmentId) return null;
  return segments.find(seg => seg.id === segmentId) || null;
}

function collectClusterBoundaries(text) {
  const boundaries = [0];
  for (const { index } of GRAPHEME_SEGMENTER.segment(text)) {
    if (index > 0) boundaries.push(index);
  }
  boundaries.push(text.length);
  return boundaries;
}

function filterSafeBoundaries(text, boundaries) {
  return boundaries.filter(b => (
    isGraphemeClusterIntact(text.slice(0, b)) && isGraphemeClusterIntact(text.slice(b))
  ));
}

function findNearestBoundary(safeBoundaries, targetOffset) {
  if (safeBoundaries.length === 0) return 0;
  let best = safeBoundaries[0];
  let minDiff = Math.abs(targetOffset - best);
  for (const b of safeBoundaries) {
    const diff = Math.abs(targetOffset - b);
    if (diff < minDiff) {
      minDiff = diff;
      best = b;
    }
  }
  return best;
}

/**
 * Snaps a character offset to the nearest safe grapheme cluster boundary without splitting combining marks or coeng.
 * Inputs: text string, candidate raw offset.
 * Outputs: integer safe boundary index.
 * Side effects: none.
 * Failure modes: returns 0 if text is empty or non-string.
 * @param {string} text - Input text.
 * @param {number} rawOffset - Candidate cursor offset.
 * @returns {number} Safe grapheme boundary index.
 */
export function snapToGraphemeBoundary(text, rawOffset) {
  if (typeof text !== 'string' || !text) return 0;
  const numOffset = typeof rawOffset === 'number' && !Number.isNaN(rawOffset) ? rawOffset : 0;
  const clamped = Math.max(0, Math.min(text.length, numOffset));
  const boundaries = collectClusterBoundaries(text);
  const safeBoundaries = filterSafeBoundaries(text, boundaries);
  return findNearestBoundary(safeBoundaries, clamped);
}

function buildDraftSplitHalf(segment, id, text, pauseDuration) {
  return createEditableSegment({
    ...segment,
    id,
    text,
    takes: [],
    status: DEFAULT_SEGMENT_STATUS,
    pauseDuration,
  });
}

/**
 * Splits a segment into two segments at an offset, snapping to safe grapheme boundaries and invalidating takes.
 * Inputs: existing ProjectSegment, candidate offset.
 * Outputs: tuple of two frozen ProjectSegment entities in draft status.
 * Side effects: none.
 * Failure modes: throws ValidationError if segment is invalid.
 * @param {object} segment - Segment to split.
 * @param {number} [offset] - Split offset.
 * @returns {Readonly<[object, object]>} Two new segments.
 */
export function splitSegment(segment, offset) {
  if (!segment || typeof segment !== 'object' || !segment.id) {
    throw new ValidationError('Valid segment is required to split.', 'segment', 'INVALID_SEGMENT');
  }
  const defaultOffset = Math.floor((segment.text || '').length / 2);
  const targetOffset = (typeof offset === 'number' && !Number.isNaN(offset)) ? offset : defaultOffset;
  const safeOffset = snapToGraphemeBoundary(segment.text, targetOffset);
  const t1 = (segment.text || '').slice(0, safeOffset).trimEnd();
  const t2 = (segment.text || '').slice(safeOffset).trimStart();
  const first = buildDraftSplitHalf(segment, segment.id, t1, null);
  const second = buildDraftSplitHalf(segment, generateProjectId(), t2, segment.pauseDuration ?? null);
  return Object.freeze([first, second]);
}

/**
 * Splits a segment by ID within an array, replacing it with two draft segments.
 * Inputs: segments array, segment ID, split offset.
 * Outputs: new array with the target segment split into two.
 * Side effects: none.
 * Failure modes: returns shallow copy if segmentId is not found.
 * @param {object[]} segments - Array of segments.
 * @param {string} segmentId - ID of segment to split.
 * @param {number} [offset] - Split offset.
 * @returns {object[]} New array of segments.
 */
export function splitSegmentInList(segments, segmentId, offset) {
  if (!Array.isArray(segments)) return [];
  const index = segments.findIndex(s => s.id === segmentId);
  if (index === -1) return [...segments];
  const [first, second] = splitSegment(segments[index], offset);
  return [...segments.slice(0, index), first, second, ...segments.slice(index + 1)];
}

function joinSegmentTexts(firstText, secondText, pauseDuration) {
  const t1 = (firstText || '').trim();
  const t2 = (secondText || '').trim();
  if (!t1) return t2;
  if (!t2) return t1;
  if (pauseDuration && pauseDuration > 0) {
    const pauseTag = formatSegmentPause(pauseDuration);
    return `${t1}${pauseTag} ${t2}`;
  }
  return `${t1} ${t2}`;
}

/**
 * Merges two adjacent segments into one, joining text naturally and resetting takes to draft.
 * Inputs: first segment, second segment.
 * Outputs: new frozen ProjectSegment entity in draft status.
 * Side effects: none.
 * Failure modes: throws ValidationError if either segment is missing.
 * @param {object} firstSegment - Preceding segment.
 * @param {object} secondSegment - Succeeding segment.
 * @returns {Readonly<object>} Merged draft segment.
 */
export function mergeAdjacentSegments(firstSegment, secondSegment) {
  if (!firstSegment?.id || !secondSegment?.id) {
    throw new ValidationError('Two valid segments are required for merge.', 'segments', 'INVALID_SEGMENTS');
  }
  const mergedText = joinSegmentTexts(firstSegment.text, secondSegment.text, firstSegment.pauseDuration);
  return createEditableSegment({
    id: firstSegment.id,
    text: mergedText,
    voiceId: firstSegment.voiceId || secondSegment.voiceId || null,
    speaker: firstSegment.speaker || secondSegment.speaker || null,
    pauseDuration: secondSegment.pauseDuration ?? null,
    takes: [],
    status: DEFAULT_SEGMENT_STATUS,
  });
}

function resolveSegmentIndex(segments, indexOrId) {
  if (typeof indexOrId === 'number') return indexOrId;
  return segments.findIndex(seg => seg.id === indexOrId);
}

/**
 * Merges segment at index (or by ID) with its immediate successor in an array.
 * Inputs: segments array, index or ID of first segment.
 * Outputs: new array with the two segments replaced by a single merged segment.
 * Side effects: none.
 * Failure modes: returns copy of segments if index is invalid or at the end.
 * @param {object[]} segments - Array of segments.
 * @param {number|string} indexOrId - First segment index or ID.
 * @returns {object[]} New array of segments.
 */
export function mergeSegments(segments, indexOrId) {
  if (!Array.isArray(segments) || segments.length < 2) return Array.isArray(segments) ? [...segments] : [];
  const index = resolveSegmentIndex(segments, indexOrId);
  if (index < 0 || index >= segments.length - 1) return [...segments];
  const merged = mergeAdjacentSegments(segments[index], segments[index + 1]);
  return [...segments.slice(0, index), merged, ...segments.slice(index + 2)];
}

export const mergeSegmentsInList = mergeSegments;

/**
 * Reorders segments by moving an item from sourceIndex to targetIndex while preserving IDs and takes.
 * Inputs: segments array, source index, target index.
 * Outputs: new array with the segment repositioned.
 * Side effects: none.
 * Failure modes: returns copy of segments if indices are out of bounds.
 * @param {object[]} segments - Array of segments.
 * @param {number} sourceIndex - Current index of segment.
 * @param {number} targetIndex - Target index for segment.
 * @returns {object[]} New array of segments.
 */
export function reorderSegments(segments, sourceIndex, targetIndex) {
  if (!Array.isArray(segments)) return [];
  if (!Number.isInteger(sourceIndex) || !Number.isInteger(targetIndex)) return [...segments];
  if (sourceIndex === targetIndex) return [...segments];
  if (sourceIndex < 0 || sourceIndex >= segments.length) return [...segments];
  if (targetIndex < 0 || targetIndex >= segments.length) return [...segments];
  const next = [...segments];
  const [moved] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, moved);
  return next;
}

/**
 * Moves a segment one position up, preserving all IDs and takes intact.
 * Inputs: segments array, segment index or ID.
 * Outputs: new array with the segment moved up.
 * Side effects: none.
 * Failure modes: returns copy of segments if already at the top or not found.
 * @param {object[]} segments - Array of segments.
 * @param {number|string} indexOrId - Segment index or ID.
 * @returns {object[]} New array of segments.
 */
export function moveSegmentUp(segments, indexOrId) {
  if (!Array.isArray(segments)) return [];
  const index = resolveSegmentIndex(segments, indexOrId);
  if (index <= 0) return [...segments];
  return reorderSegments(segments, index, index - 1);
}

/**
 * Moves a segment one position down, preserving all IDs and takes intact.
 * Inputs: segments array, segment index or ID.
 * Outputs: new array with the segment moved down.
 * Side effects: none.
 * Failure modes: returns copy of segments if already at the bottom or not found.
 * @param {object[]} segments - Array of segments.
 * @param {number|string} indexOrId - Segment index or ID.
 * @returns {object[]} New array of segments.
 */
export function moveSegmentDown(segments, indexOrId) {
  if (!Array.isArray(segments)) return [];
  const index = resolveSegmentIndex(segments, indexOrId);
  if (index < 0 || index >= segments.length - 1) return [...segments];
  return reorderSegments(segments, index, index + 1);
}

/**
 * Inserts a new editable segment at target index with a stable UUID and draft status.
 * Inputs: segments array, target index (or undefined/null to append), optional spec.
 * Outputs: new array with inserted segment.
 * Side effects: none.
 * Failure modes: returns array with new segment if input array is valid.
 * @param {object[]} segments - Array of segments.
 * @param {number} [targetIndex] - Insertion index.
 * @param {object} [spec] - Segment specification.
 * @returns {object[]} New array with inserted segment.
 */
export function insertSegment(segments, targetIndex, spec = {}) {
  if (!Array.isArray(segments)) return [];
  const len = segments.length;
  const clamped = typeof targetIndex === 'number' && !Number.isNaN(targetIndex)
    ? Math.max(0, Math.min(len, targetIndex))
    : len;
  const newSegment = createEditableSegment({
    ...spec,
    id: spec.id || generateProjectId(),
    text: spec.text || '',
    voiceId: spec.voiceId || null,
    speaker: spec.speaker || null,
    pauseDuration: spec.pauseDuration ?? null,
    takes: [],
    status: DEFAULT_SEGMENT_STATUS,
  });
  return [...segments.slice(0, clamped), newSegment, ...segments.slice(clamped)];
}

export const addSegment = insertSegment;

/**
 * Removes a segment by ID from an array, preserving IDs and takes of all remaining segments.
 * Inputs: segments array, segment ID to delete.
 * Outputs: new array without the target segment.
 * Side effects: none.
 * Failure modes: returns copy of segments if segmentId is not found.
 * @param {object[]} segments - Array of segments.
 * @param {string} segmentId - ID of segment to delete.
 * @returns {object[]} New array without the specified segment.
 */
export function deleteSegment(segments, segmentId) {
  if (!Array.isArray(segments)) return [];
  const next = segments.filter(seg => seg.id !== segmentId);
  return next.length === segments.length ? [...segments] : next;
}

/**
 * Assigns a specific character voice to a segment, marking takes outdated if voice changed.
 * Inputs: segment object, target voice ID, optional speaker name.
 * Outputs: new frozen ProjectSegment entity.
 * Side effects: none.
 * Failure modes: throws ValidationError if segment is invalid or voiceId is empty.
 * @param {object} segment - Target segment.
 * @param {string} voiceId - Character voice ID.
 * @param {string|null} [speakerName] - Optional character name.
 * @returns {Readonly<object>} Updated segment entity.
 */
export function assignSegmentVoice(segment, voiceId, speakerName = null) {
  if (!segment || typeof segment !== 'object' || !segment.id) {
    throw new ValidationError('Valid segment is required.', 'segment', 'INVALID_SEGMENT');
  }
  const cleanVoice = typeof voiceId === 'string' ? voiceId.trim() : '';
  if (!cleanVoice) {
    throw new ValidationError('Voice ID is required.', 'voiceId', 'INVALID_VOICE_ID');
  }
  return updateSegmentContent(segment, {
    voiceId: cleanVoice,
    speakerId: cleanVoice,
    speakerName: typeof speakerName === 'string' ? speakerName.trim() : null,
  });
}

/**
 * Assigns a character voice to a target segment in an array, preserving other segments unchanged.
 * Inputs: segments array, segment ID, voice ID, optional speaker name.
 * Outputs: new array of segments.
 * Side effects: none.
 * Failure modes: returns copy of segments if segmentId is not found.
 * @param {object[]} segments - Segments array.
 * @param {string} segmentId - Target segment ID.
 * @param {string} voiceId - Character voice ID.
 * @param {string|null} [speakerName] - Character name.
 * @returns {object[]} New array of segments.
 */
export function assignSegmentVoiceInList(segments, segmentId, voiceId, speakerName = null) {
  if (!Array.isArray(segments) || !segmentId || !voiceId) {
    return Array.isArray(segments) ? [...segments] : [];
  }
  return segments.map(seg => {
    if (seg.id !== segmentId) return seg;
    return assignSegmentVoice(seg, voiceId, speakerName);
  });
}

/**
 * Checks whether a collection of segments contains multiple distinct character voices.
 * Inputs: segments array, optional fallback voice ID.
 * Outputs: boolean true if two or more distinct voice IDs are assigned.
 * Side effects: none.
 * Failure modes: returns false for invalid or empty array.
 * @param {object[]} segments - Segments array.
 * @param {string|null} [fallbackVoiceId] - Fallback voice ID for unassigned segments.
 * @returns {boolean} Whether script is multi-speaker.
 */
export function isMultiSpeakerScript(segments, fallbackVoiceId = null) {
  if (!Array.isArray(segments) || segments.length <= 1) return false;
  const distinct = new Set();
  for (const seg of segments) {
    const voice = seg?.voiceId || fallbackVoiceId;
    if (voice) distinct.add(voice);
    if (distinct.size > 1) return true;
  }
  return false;
}

/**
 * Collects ordered unique character voice IDs assigned across a collection of segments.
 * Inputs: segments array, optional fallback voice ID.
 * Outputs: string array of unique voice IDs in appearance order.
 * Side effects: none.
 * Failure modes: returns empty array for non-array input.
 * @param {object[]} segments - Segments array.
 * @param {string|null} [fallbackVoiceId] - Fallback voice ID.
 * @returns {string[]} Ordered unique voice IDs.
 */
export function getScriptVoiceIds(segments, fallbackVoiceId = null) {
  if (!Array.isArray(segments)) return [];
  const ordered = [];
  const seen = new Set();
  for (const seg of segments) {
    const voice = seg?.voiceId || fallbackVoiceId;
    if (voice && !seen.has(voice)) {
      seen.add(voice);
      ordered.push(voice);
    }
  }
  return ordered;
}

