/**
 * @fileoverview Pure domain single-speaker script segmentation preserving one consistent voice on long text.
 */

import { ValidationError } from './errors.js';
import { MAX_SCRIPT_LENGTH, countGraphemes } from './presets.js';

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
 * Splits a single-speaker script into bounded natural sentences/clauses for voice consistency.
 * Inputs: raw script text and optional `maxGraphemes` limit.
 * Outputs: non-empty array of bounded text chunks.
 * Side effects: none.
 * Failure modes: throws ValidationError when text is empty or exceeds `MAX_SCRIPT_LENGTH`.
 * @param {string} rawText - Script to segment.
 * @param {number} [maxGraphemes=DEFAULT_MAX_CHUNK_GRAPHEMES] - Max graphemes per chunk.
 * @returns {string[]} Ordered text chunks.
 */
export function segmentSingleSpeakerScript(rawText, maxGraphemes = DEFAULT_MAX_CHUNK_GRAPHEMES) {
  const normalized = typeof rawText === 'string' ? rawText.replace(/\r\n/g, '\n').trim() : '';
  if (!normalized) throw new ValidationError('Enter text to generate speech.', 'script', 'EMPTY_SCRIPT');
  if (countGraphemes(normalized) > MAX_SCRIPT_LENGTH) {
    throw new ValidationError(`Keep your script under ${MAX_SCRIPT_LENGTH.toLocaleString()} characters.`, 'script', 'SCRIPT_TOO_LONG');
  }
  const atomic = normalized
    .split(SENTENCE_SPLIT_PATTERN)
    .map(part => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .flatMap(sentence => splitLongClause(sentence, maxGraphemes));
  return mergeShortChunks(atomic, maxGraphemes);
}
