/**
 * @fileoverview Pure domain character-based generation validation and prompt sanitization rules.
 */

import { ValidationError } from './errors.js';
import { expandKhmerNumbers, normalizeKhmerUnicode } from './khmerText.js';

export const MAX_SCRIPT_LENGTH = 2000;
export const MAX_DESCRIPTION_LENGTH = 300;
export const MIN_GUIDANCE = 1;
export const MAX_GUIDANCE = 3;
export const MIN_STEPS = 4;
export const MAX_STEPS = 20;
export const DEFAULT_STEPS = 10;
export const MAX_SEED = 4294967295;

export const STYLE_MODES = Object.freeze({
  AUTO: 'auto',
  NATURAL: 'natural',
  FORMAL: 'formal',
  WARM: 'warm',
  STORY: 'story',
  CALM: 'calm',
  CUSTOM: 'custom',
});

export const STYLE_PRESET_OPTIONS = Object.freeze([
  { id: STYLE_MODES.AUTO, label: 'Auto (follow writing format)', prompt: '' },
  { id: STYLE_MODES.NATURAL, label: 'Natural (voice default)', prompt: '' },
  { id: STYLE_MODES.FORMAL, label: 'Formal / News briefing', prompt: 'Clear, composed news broadcast delivery with steady articulation' },
  { id: STYLE_MODES.WARM, label: 'Warm & conversational', prompt: 'Warm, friendly conversational tone with natural relaxed phrasing' },
  { id: STYLE_MODES.STORY, label: 'Expressive storytelling', prompt: 'Expressive storytelling cadence with vivid emotion and clear pauses' },
  { id: STYLE_MODES.CALM, label: 'Calm & deliberate', prompt: 'Calm, gentle, unhurried pace with crisp articulation' },
  { id: STYLE_MODES.CUSTOM, label: 'Custom style prompt…', prompt: '' },
]);

const FORMAL_PROSE_MIN_GRAPHEMES = 120;
const QUOTE_CUE_PATTERN = /[«»“”"]/;
const EXCLAMATION_CUE_PATTERN = /[!！]/;
const QUESTION_CUE_PATTERN = /[?？]/;
const STRUCTURE_CUE_PATTERN = /(?:^|\n)\s*(?:[-•*]|\d+[.)។])\s|៖/m;
const FORMAL_SENTENCE_PATTERN = /[។៕]/g;
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
 * Infers a VoxCPM2 style instruction from script punctuation and layout cues.
 * Inputs: raw or normalized script text.
 * Outputs: style control string matching the script format, or `''` for simple neutral sentences.
 * Side effects: none.
 * Failure modes: returns `''` for non-string or empty input.
 * @param {unknown} rawScript - Script text to inspect.
 * @returns {string} Inferred style cue or `''`.
 */
export function inferScriptStyleInstruction(rawScript) {
  if (typeof rawScript !== 'string') return '';
  const text = rawScript.trim();
  if (!text) return '';
  if (QUOTE_CUE_PATTERN.test(text)) return 'Expressive narrative dialogue tone with natural conversational shifts';
  if (EXCLAMATION_CUE_PATTERN.test(text)) return 'Expressive, energetic upbeat delivery matching enthusiastic punctuation';
  if (QUESTION_CUE_PATTERN.test(text)) return 'Natural inquisitive tone with rising inflection at questions';
  if (STRUCTURE_CUE_PATTERN.test(text)) return 'Clear, structured presenter cadence with brief pauses between points';
  const stops = text.match(FORMAL_SENTENCE_PATTERN)?.length || 0;
  if (stops >= 2 || (stops >= 1 && countGraphemes(text) >= FORMAL_PROSE_MIN_GRAPHEMES)) {
    return 'Steady, articulate natural cadence matching formal prose';
  }
  return '';
}

/**
 * Resolves the active style cue for a selected `styleMode`, custom prompt, and script.
 * Inputs: `{ styleMode, customStyle, script }`.
 * Outputs: sanitized style cue string or `''`.
 * Side effects: none.
 * Failure modes: returns `''` for unrecognized style modes or empty custom text.
 * @param {{ styleMode?: string, customStyle?: string, script?: string }} [spec] - Style resolution spec.
 * @returns {string} Resolved style instruction without parentheses.
 */
export function resolveStyleInstruction({ styleMode = STYLE_MODES.NATURAL, customStyle = '', script = '' } = {}) {
  if (styleMode === STYLE_MODES.NATURAL) return '';
  if (styleMode === STYLE_MODES.CUSTOM) return stripParentheses(customStyle);
  if (styleMode === STYLE_MODES.AUTO) return inferScriptStyleInstruction(script);
  const preset = STYLE_PRESET_OPTIONS.find(item => item.id === styleMode);
  return preset ? stripParentheses(preset.prompt) : '';
}

/**
 * Combines a character baseline description with an optional style cue within `MAX_DESCRIPTION_LENGTH`.
 * @param {string} baseVoice - Character baseline voice description.
 * @param {string} styleText - Non-empty style cue.
 * @returns {string} Merged description string.
 */
function combineVoiceAndStyle(baseVoice, styleText) {
  const merged = `${baseVoice}, ${styleText}`;
  return countGraphemes(merged) <= MAX_DESCRIPTION_LENGTH ? merged : baseVoice;
}

/**
 * Builds the VoxCPM2 control instruction for a single speaking character.
 * Inputs: `{ character, hasLockedAudio, usePromptText, styleInstruction }`.
 * Outputs: combined voice/style prompt or empty string when exact-cloning or unstyled locked voice.
 * Side effects: none.
 * Failure modes: throws ValidationError when an unpinned character has no speaking description or style exceeds `MAX_DESCRIPTION_LENGTH`.
 * @param {{ character?: { description?: string }|null, hasLockedAudio?: boolean, usePromptText?: boolean, styleInstruction?: string }} params - Instruction params.
 * @returns {string} Control instruction string.
 */
export function buildCharacterInstruction({ character, hasLockedAudio = false, usePromptText = false, styleInstruction = '' }) {
  if (usePromptText) return '';
  const cleanStyle = stripParentheses(styleInstruction);
  if (countGraphemes(cleanStyle) > MAX_DESCRIPTION_LENGTH) {
    throw new ValidationError(`Keep the style instruction under ${MAX_DESCRIPTION_LENGTH} characters.`, 'style', 'STYLE_TOO_LONG');
  }
  if (hasLockedAudio) return cleanStyle;
  const cleaned = stripParentheses(character?.description || '');
  if (!cleaned) {
    throw new ValidationError('Select a character with a voice description or upload a voice sample.', 'character', 'MISSING_CHARACTER_VOICE');
  }
  if (countGraphemes(cleaned) > MAX_DESCRIPTION_LENGTH) {
    throw new ValidationError(`Keep the character description under ${MAX_DESCRIPTION_LENGTH} characters.`, 'description', 'DESCRIPTION_TOO_LONG');
  }
  return cleanStyle ? combineVoiceAndStyle(cleaned, cleanStyle) : cleaned;
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
 * Validates script text against non-empty and grapheme length bounds, optionally expanding Khmer numbers/time.
 * @param {unknown} rawScript - Raw script input.
 * @param {{ autoFormatKhmer?: boolean }} [options] - Normalization flags.
 * @returns {string} Normalized script text.
 */
function validateScriptText(rawScript, { autoFormatKhmer = false } = {}) {
  const normalized = normalizeKhmerUnicode(rawScript);
  if (!normalized) throw new ValidationError('Enter text to generate speech.', 'script', 'EMPTY_SCRIPT');
  const text = autoFormatKhmer ? expandKhmerNumbers(normalized) : normalized;
  if (countGraphemes(text) > MAX_SCRIPT_LENGTH) {
    throw new ValidationError(`Keep your script under ${MAX_SCRIPT_LENGTH.toLocaleString()} characters.`, 'script', 'SCRIPT_TOO_LONG');
  }
  return text;
}

/**
 * Validates and normalizes generation inputs into a clean command object.
 * Inputs: raw generation options and optional `seedGenerator`.
 * Outputs: `{ text, instruction, usePromptText, promptText, guidance, steps, seed }`.
 * Side effects: none.
 * Failure modes: throws ValidationError when any field violates domain rules.
 * @param {Record<string, unknown>} input - Raw input fields.
 * @param {() => number} [seedGenerator] - Optional random seed generator.
 * @returns {{ text: string, instruction: string, usePromptText: boolean, promptText: string, guidance: number, steps: number, seed: number }} Validated payload.
 */
export function validateGenerationInput(input, seedGenerator = () => crypto.getRandomValues(new Uint32Array(1))[0]) {
  const text = validateScriptText(input?.script, { autoFormatKhmer: Boolean(input?.autoFormatKhmer) });
  if (!input?.character?.id) {
    throw new ValidationError('Select a speaking character before generating speech.', 'character', 'MISSING_CHARACTER');
  }
  const hasLockedAudio = Boolean(input?.hasLockedAudio);
  const cloneConfig = resolveExactCloneOptions({ hasLockedAudio, exactClone: input?.exactClone, promptText: input?.promptText });
  const styleInstruction = resolveStyleInstruction({ styleMode: input?.styleMode ?? STYLE_MODES.NATURAL, customStyle: input?.customStyle, script: text });
  return {
    text,
    instruction: buildCharacterInstruction({ character: input.character, hasLockedAudio, usePromptText: cloneConfig.usePromptText, styleInstruction }),
    ...cloneConfig,
    guidance: parseBoundedNumber({ raw: input?.guidance, min: MIN_GUIDANCE, max: MAX_GUIDANCE, integer: false, field: 'guidance' }),
    steps: parseBoundedNumber({ raw: input?.steps ?? DEFAULT_STEPS, min: MIN_STEPS, max: MAX_STEPS, integer: true, field: 'steps' }),
    seed: resolveSeed(input?.seed, seedGenerator),
  };
}
