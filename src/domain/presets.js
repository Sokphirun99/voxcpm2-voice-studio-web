/**
 * @fileoverview Pure domain character-based generation validation and prompt sanitization rules.
 */

import { ValidationError } from './errors.js';

export const MAX_SCRIPT_LENGTH = 2000;
export const MAX_DESCRIPTION_LENGTH = 300;
export const MIN_GUIDANCE = 1;
export const MAX_GUIDANCE = 3;
export const MIN_STEPS = 4;
export const MAX_STEPS = 20;
export const DEFAULT_STEPS = 10;
export const MAX_SEED = 4294967295;

const PARENTHESES_PATTERN = /[()（）]/g;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Removes half-width and full-width parentheses that VoxCPM2 reserves for prompt wrapping.
 * Inputs: raw string.
 * Outputs: whitespace-normalized string free of parentheses.
 * Side effects: none.
 * Failure modes: returns empty string for non-string input.
 * @param {unknown} text - User-supplied description text.
 * @returns {string} Sanitized string.
 */
export function stripParentheses(text) {
  if (typeof text !== 'string') return '';
  return text.replace(PARENTHESES_PATTERN, '').replace(/\s+/g, ' ').trim();
}

/**
 * Counts visual grapheme clusters so multi-codepoint scripts like Khmer count fairly.
 * Inputs: text string.
 * Outputs: non-negative integer grapheme count.
 * Side effects: none.
 * Failure modes: returns 0 for non-string or empty input.
 * @param {unknown} text - Text to measure.
 * @returns {number} Grapheme count.
 */
export function countGraphemes(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  let count = 0;
  for (const _segment of GRAPHEME_SEGMENTER.segment(text)) count += 1;
  return count;
}

/**
 * Builds the VoxCPM2 control instruction for a single speaking character.
 * Inputs: `{ character, hasLockedAudio, usePromptText }`.
 * Outputs: character design prompt on first generation, or empty string when cloning locked audio.
 * Side effects: none.
 * Failure modes: throws ValidationError when an unpinned character has no speaking description.
 * @param {{ character?: { description?: string }|null, hasLockedAudio?: boolean, usePromptText?: boolean }} params - Instruction params.
 * @returns {string} Control instruction string.
 */
export function buildCharacterInstruction({ character, hasLockedAudio = false, usePromptText = false }) {
  if (usePromptText || hasLockedAudio) return '';
  const cleaned = stripParentheses(character?.description || '');
  if (!cleaned) {
    throw new ValidationError('Select a character with a voice description or upload a voice sample.', 'character', 'MISSING_CHARACTER_VOICE');
  }
  if (countGraphemes(cleaned) > MAX_DESCRIPTION_LENGTH) {
    throw new ValidationError(`Keep the character description under ${MAX_DESCRIPTION_LENGTH} characters.`, 'description', 'DESCRIPTION_TOO_LONG');
  }
  return cleaned;
}

/**
 * Parses and validates a bounded numeric parameter.
 * @param {{ raw: unknown, min: number, max: number, integer: boolean, field: string }} spec - Constraint spec.
 * @returns {number} Validated number.
 */
function parseBoundedNumber({ raw, min, max, integer, field }) {
  const value = Number(raw);
  const isValidType = integer ? Number.isInteger(value) : Number.isFinite(value);
  if (!isValidType || value < min || value > max) {
    throw new ValidationError(`${field} must be between ${min} and ${max}.`, field, `INVALID_${field.toUpperCase()}`);
  }
  return value;
}

/**
 * Resolves an optional seed string/number or generates one via the injected seed generator.
 * @param {unknown} rawSeed - Blank value or numeric string/number.
 * @param {() => number} seedGenerator - RNG function returning a uint32 seed.
 * @returns {number} Validated unsigned 32-bit integer seed.
 */
function resolveSeed(rawSeed, seedGenerator) {
  const normalized = typeof rawSeed === 'string' ? rawSeed.trim() : rawSeed;
  if (normalized === '' || normalized === null || normalized === undefined) {
    return seedGenerator();
  }
  return parseBoundedNumber({ raw: normalized, min: 0, max: MAX_SEED, integer: true, field: 'seed' });
}

/**
 * Resolves exact-clone prompt text settings when cloning from a locked voice sample.
 * @param {{ hasLockedAudio: boolean, exactClone?: unknown, promptText?: unknown }} input - Prompt options.
 * @returns {{ usePromptText: boolean, promptText: string }} Validated prompt cloning config.
 */
function resolveExactCloneOptions({ hasLockedAudio, exactClone, promptText }) {
  const usePromptText = Boolean(hasLockedAudio && exactClone);
  const cleanedPrompt = typeof promptText === 'string' ? promptText.trim() : '';
  if (usePromptText && !cleanedPrompt) {
    throw new ValidationError('Enter the transcript of the uploaded voice sample or uncheck Exact match.', 'promptText', 'EMPTY_PROMPT_TEXT');
  }
  return { usePromptText, promptText: usePromptText ? cleanedPrompt : '' };
}

/**
 * Validates script text against non-empty and grapheme length bounds.
 * @param {unknown} rawScript - Raw script input.
 * @returns {string} Trimmed script text.
 */
function validateScriptText(rawScript) {
  const text = typeof rawScript === 'string' ? rawScript.trim() : '';
  if (!text) throw new ValidationError('Enter text to generate speech.', 'script', 'EMPTY_SCRIPT');
  if (countGraphemes(text) > MAX_SCRIPT_LENGTH) {
    throw new ValidationError(`Keep your script under ${MAX_SCRIPT_LENGTH.toLocaleString()} characters.`, 'script', 'SCRIPT_TOO_LONG');
  }
  return text;
}

/**
 * Validates and normalizes generation inputs into a clean command object.
 * Inputs: raw generation options `{ script, character, hasLockedAudio, exactClone, promptText, guidance, steps, seed }` and optional `seedGenerator`.
 * Outputs: `{ text, instruction, usePromptText, promptText, guidance, steps, seed }`.
 * Side effects: none.
 * Failure modes: throws ValidationError when any field violates domain rules.
 * @param {Record<string, unknown>} input - Raw input fields.
 * @param {() => number} [seedGenerator] - Optional random seed generator.
 * @returns {{ text: string, instruction: string, usePromptText: boolean, promptText: string, guidance: number, steps: number, seed: number }} Validated payload.
 */
export function validateGenerationInput(input, seedGenerator = () => crypto.getRandomValues(new Uint32Array(1))[0]) {
  const text = validateScriptText(input?.script);
  if (!input?.character?.id) {
    throw new ValidationError('Select a speaking character before generating speech.', 'character', 'MISSING_CHARACTER');
  }
  const hasLockedAudio = Boolean(input?.hasLockedAudio);
  const cloneConfig = resolveExactCloneOptions({ hasLockedAudio, exactClone: input?.exactClone, promptText: input?.promptText });
  return {
    text,
    instruction: buildCharacterInstruction({ character: input.character, hasLockedAudio, usePromptText: cloneConfig.usePromptText }),
    ...cloneConfig,
    guidance: parseBoundedNumber({ raw: input?.guidance, min: MIN_GUIDANCE, max: MAX_GUIDANCE, integer: false, field: 'guidance' }),
    steps: parseBoundedNumber({ raw: input?.steps ?? DEFAULT_STEPS, min: MIN_STEPS, max: MAX_STEPS, integer: true, field: 'steps' }),
    seed: resolveSeed(input?.seed, seedGenerator),
  };
}
