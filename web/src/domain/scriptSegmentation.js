/**
 * @fileoverview Pure domain single-speaker script segmentation preserving one consistent voice on long text.
 */

import { ValidationError } from './errors.js';
import {
  MAX_PAUSE_MS,
  MIN_PAUSE_MS,
  PAUSE_MARKER_SOURCE,
  clampPauseMs,
  hasPauseMarkers,
  parsePauseMarkerMs,
  preservePauseMarkers,
  stripPauseMarkers,
} from './pauseMarkers.js';
import { MAX_SCRIPT_LENGTH, countGraphemes } from './presets.js';

export { MAX_PAUSE_MS, MIN_PAUSE_MS, clampPauseMs, hasPauseMarkers, preservePauseMarkers, stripPauseMarkers };
export const DEFAULT_MAX_CHUNK_GRAPHEMES = 180;

const SENTENCE_SPLIT_PATTERN = /(?<=[។៕.!?;\n])\s+/u;
const CLAUSE_SPLIT_PATTERN = /(?<=[,،、])\s+|\s+/u;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Slices a single overlong token at grapheme boundaries without splitting combining characters.
 * @param {string} word - Oversized token.
 * @param {number} maxGraphemes - Maximum grapheme count per piece.
 * @returns {string[]} Grapheme-safe slices.
 */
function sliceWordByGraphemes(word, maxGraphemes) {
  const pieces = [];
  let current = '';
  let count = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(word)) {
    if (count >= maxGraphemes) { pieces.push(current); current = ''; count = 0; }
    current += segment;
    count += 1;
  }
  if (current) pieces.push(current);
  return pieces;
}

/**
 * Appends a token to the active clause buffer or flushes when exceeding `maxGraphemes`.
 * @param {{ chunks: string[], buffer: string }} state - Mutable accumulator.
 * @param {string} token - Next word/clause token.
 * @param {number} maxGraphemes - Maximum graphemes per chunk.
 * @returns {string} Updated buffer.
 */
function pushTokenToClause(state, token, maxGraphemes) {
  if (countGraphemes(token) > maxGraphemes) {
    if (state.buffer) state.chunks.push(state.buffer);
    state.chunks.push(...sliceWordByGraphemes(token, maxGraphemes));
    return '';
  }
  const candidate = state.buffer ? `${state.buffer} ${token}` : token;
  if (countGraphemes(candidate) <= maxGraphemes) return candidate;
  state.chunks.push(state.buffer);
  return token;
}

/**
 * Splits an oversized sentence along clause or whitespace boundaries into bounded pieces.
 * @param {string} sentence - Long sentence text.
 * @param {number} maxGraphemes - Maximum graphemes per chunk.
 * @returns {string[]} Bounded clause strings.
 */
function splitLongClause(sentence, maxGraphemes) {
  if (countGraphemes(sentence) <= maxGraphemes) return [sentence];
  const state = { chunks: [], buffer: '' };
  for (const token of sentence.split(CLAUSE_SPLIT_PATTERN).filter(Boolean)) {
    state.buffer = pushTokenToClause(state, token, maxGraphemes);
  }
  if (state.buffer) state.chunks.push(state.buffer);
  return state.chunks;
}

/**
 * Packs adjacent sentence/clause pieces up to `maxGraphemes` for solid anchors and fewer round-trips.
 * @param {string[]} pieces - Atomic sentence/clause pieces.
 * @param {number} maxGraphemes - Maximum graphemes per merged chunk.
 * @returns {string[]} Balanced chunks.
 */
function mergeShortChunks(pieces, maxGraphemes) {
  const merged = [];
  for (const piece of pieces) {
    const previous = merged[merged.length - 1];
    const combined = previous ? `${previous} ${piece}` : piece;
    if (previous && countGraphemes(combined) <= maxGraphemes) {
      merged[merged.length - 1] = combined;
    } else {
      merged.push(piece);
    }
  }
  return merged;
}

/**
 * Splits a single marker-free text block into bounded natural sentences/clauses.
 * @param {string} plainText - Marker-free trimmed text.
 * @param {number} maxGraphemes - Max graphemes per chunk.
 * @returns {string[]} Ordered bounded text chunks.
 */
function segmentPlainText(plainText, maxGraphemes) {
  const atomic = plainText
    .split(SENTENCE_SPLIT_PATTERN)
    .map(part => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .flatMap(sentence => splitLongClause(sentence, maxGraphemes));
  return mergeShortChunks(atomic, maxGraphemes);
}

/**
 * Splits a script on `[pause 0.5s]` / `[pause 800ms]` markers into spoken parts with the pause that follows each.
 * Adjacent markers add up (then clamp strictly to `MAX_PAUSE_MS`); leading markers before any text are dropped.
 * @param {string} text - Script containing optional markers.
 * @returns {Array<{ text: string, pauseAfterMs: number|null }>} Spoken parts in order.
 */
function splitOnPauseMarkers(text) {
  const parts = [];
  const pushText = raw => {
    const spoken = raw.trim();
    if (spoken) parts.push({ text: spoken, pauseAfterMs: null });
  };
  let cursor = 0;
  for (const match of text.matchAll(new RegExp(PAUSE_MARKER_SOURCE, 'gi'))) {
    pushText(text.slice(cursor, match.index));
    const previous = parts[parts.length - 1];
    if (previous) {
      previous.pauseAfterMs = Math.min(MAX_PAUSE_MS, (previous.pauseAfterMs ?? 0) + parsePauseMarkerMs(match[1], match[2]));
    }
    cursor = match.index + match[0].length;
  }
  pushText(text.slice(cursor));
  return parts;
}

/**
 * Segments a single-speaker script and attaches the explicit silence requested by inline pause markers.
 * Inputs: raw script (markers `[pause 0.5s]` or `[pause 800ms]`, clamped to 100..5000 ms) and optional `maxGraphemes`.
 * Outputs: non-empty ordered array of `{ text, pauseAfterMs }`; `pauseAfterMs` is `null` where the default gap applies,
 * and the final segment is always `null` because pauses only separate spoken audio (leading/trailing markers are dropped).
 * Side effects: none.
 * Failure modes: throws ValidationError when text is empty, contains only pause tags, or exceeds `MAX_SCRIPT_LENGTH`.
 * Notes: chunk text never contains marker text, so the engine only receives words to speak.
 * @param {string} rawText - Script to segment.
 * @param {number} [maxGraphemes=DEFAULT_MAX_CHUNK_GRAPHEMES] - Max graphemes per chunk.
 * @returns {Array<{ text: string, pauseAfterMs: number|null }>} Ordered chunks with trailing pauses.
 */
export function segmentScriptWithPauses(rawText, maxGraphemes = DEFAULT_MAX_CHUNK_GRAPHEMES) {
  const normalized = typeof rawText === 'string' ? rawText.replace(/\r\n/g, '\n').trim() : '';
  if (!normalized) throw new ValidationError('Enter text to generate speech.', 'script', 'EMPTY_SCRIPT');
  if (countGraphemes(normalized) > MAX_SCRIPT_LENGTH) {
    throw new ValidationError(`Keep your script under ${MAX_SCRIPT_LENGTH.toLocaleString()} characters.`, 'script', 'SCRIPT_TOO_LONG');
  }
  const parts = splitOnPauseMarkers(normalized);
  if (parts.length === 0) throw new ValidationError('Enter text to generate speech.', 'script', 'EMPTY_SCRIPT');
  const segments = parts.flatMap(part => {
    const chunks = segmentPlainText(part.text, maxGraphemes);
    return chunks.map((text, index) => ({ text, pauseAfterMs: index === chunks.length - 1 ? part.pauseAfterMs : null }));
  });
  segments[segments.length - 1].pauseAfterMs = null;
  return segments;
}

/**
 * Splits a single-speaker script into bounded natural sentences/clauses for voice consistency.
 * Inputs: raw script text and optional `maxGraphemes` limit.
 * Outputs: non-empty array of bounded text chunks (inline pause tags are stripped and act as chunk boundaries).
 * Side effects: none.
 * Failure modes: throws ValidationError when text is empty or exceeds `MAX_SCRIPT_LENGTH`.
 * @param {string} rawText - Script to segment.
 * @param {number} [maxGraphemes=DEFAULT_MAX_CHUNK_GRAPHEMES] - Max graphemes per chunk.
 * @returns {string[]} Ordered text chunks.
 */
export function segmentSingleSpeakerScript(rawText, maxGraphemes = DEFAULT_MAX_CHUNK_GRAPHEMES) {
  return segmentScriptWithPauses(rawText, maxGraphemes).map(segment => segment.text);
}
