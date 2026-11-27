/**
 * @fileoverview Pure domain pronunciation dictionary: validation of glossary rules and literal, longest-first term replacement.
 */

import { ValidationError } from './errors.js';
import { normalizeKhmerUnicode } from './khmerText.js';

export const MAX_GLOSSARY_RULES = 200;
export const MAX_GLOSSARY_TERM_LENGTH = 120;

const MAX_RULE_ID_LENGTH = 64;
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;
const LATIN_EDGE = /[A-Za-z0-9]/;
const KHMER_CLUSTER_EDGE = /[\u1780-\u17D3]/;
const NOT_AFTER_LATIN = '(?<![A-Za-z0-9])';
const NOT_BEFORE_LATIN = '(?![A-Za-z0-9])';
// Dependent vowels, signs and the coeng subscript marker continue a Khmer cluster.
const NOT_AFTER_COENG = '(?<!\\u17D2)';
const NOT_BEFORE_KHMER_MARK = '(?![\\u17B6-\\u17D3\\u17DD])';

/**
 * Escapes every regex metacharacter so a glossary term is always matched literally.
 * Inputs: raw string term.
 * Outputs: regex-escaped literal pattern.
 * Side effects: none.
 * Failure modes: throws TypeError if term is not a string.
 * @param {string} term - Raw glossary term.
 * @returns {string} Regex-safe literal pattern.
 */
export function escapeRegexLiteral(term) {
  return term.replace(REGEX_METACHARACTERS, '\\$&');
}

/**
 * Counts Unicode code points (not UTF-16 units) so astral characters count once.
 * @param {string} text - Text to measure.
 * @returns {number} Code point count.
 */
function countCodePoints(text) {
  return Array.from(text).length;
}

/**
 * Validates and cleans one glossary term field.
 * @param {unknown} raw - Candidate term; `undefined` is treated as empty.
 * @param {string} field - `source` or `replacement` for error context.
 * @returns {string} Trimmed, Unicode-normalized term (may be empty).
 */
function normalizeTerm(raw, field) {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') {
    throw new ValidationError(`Pronunciation rule ${field} must be text.`, 'rules', 'INVALID_GLOSSARY_TERM');
  }
  const term = normalizeKhmerUnicode(raw);
  if (countCodePoints(term) > MAX_GLOSSARY_TERM_LENGTH) {
    throw new ValidationError(`Keep each pronunciation ${field} under ${MAX_GLOSSARY_TERM_LENGTH} characters.`, 'rules', 'GLOSSARY_TERM_TOO_LONG');
  }
  return term;
}

/**
 * Validates and normalizes a single raw rule.
 * @param {unknown} raw - Candidate rule object.
 * @param {number} index - Position used to derive a fallback id.
 * @returns {{ id: string, source: string, replacement: string, enabled: boolean }} Normalized rule.
 */
function normalizeRule(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('Each pronunciation rule must be an object.', 'rules', 'INVALID_GLOSSARY_RULE');
  }
  const source = normalizeTerm(raw.source, 'source');
  if (!source) throw new ValidationError('Enter the word or phrase to replace.', 'rules', 'EMPTY_GLOSSARY_SOURCE');
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new ValidationError('Pronunciation rule enabled flag must be true or false.', 'rules', 'INVALID_GLOSSARY_RULE');
  }
  const rawId = typeof raw.id === 'string' ? raw.id.trim().slice(0, MAX_RULE_ID_LENGTH) : '';
  return {
    id: rawId || `rule-${index + 1}`,
    source,
    replacement: normalizeTerm(raw.replacement, 'replacement'),
    enabled: raw.enabled !== false,
  };
}

/**
 * Validates and normalizes the persisted pronunciation dictionary.
 * Inputs: raw rule list `[{ id?, source, replacement?, enabled? }]`.
 * Outputs: new array of `{ id, source, replacement, enabled }` rules in input order.
 * Side effects: none.
 * Failure modes: throws ValidationError for non-array input, more than 200 rules, empty source,
 * terms over 120 characters, non-text terms, or duplicate sources (`field: 'rules'`, machine `code`).
 * @param {unknown} rawRules - Candidate rules.
 * @returns {Array<{ id: string, source: string, replacement: string, enabled: boolean }>} Normalized rules.
 */
export function normalizeGlossaryRules(rawRules) {
  if (!Array.isArray(rawRules)) {
    throw new ValidationError('Pronunciation rules must be a list.', 'rules', 'INVALID_GLOSSARY_RULES');
  }
  if (rawRules.length > MAX_GLOSSARY_RULES) {
    throw new ValidationError(`Keep pronunciation rules to ${MAX_GLOSSARY_RULES} or fewer.`, 'rules', 'GLOSSARY_TOO_MANY_RULES');
  }
  const seenSources = new Set();
  return rawRules.map((raw, index) => {
    const rule = normalizeRule(raw, index);
    if (seenSources.has(rule.source)) {
      throw new ValidationError(`"${rule.source}" already has a pronunciation rule.`, 'rules', 'DUPLICATE_GLOSSARY_SOURCE');
    }
    seenSources.add(rule.source);
    return rule;
  });
}

/**
 * Builds the lookbehind guard for a term's first character.
 * Latin/digit edges must start a token; Khmer edges must not continue a coeng subscript.
 * @param {string} firstChar - First character of the term.
 * @returns {string} Regex fragment (possibly empty).
 */
function buildLeadingGuard(firstChar) {
  if (LATIN_EDGE.test(firstChar)) return NOT_AFTER_LATIN;
  return KHMER_CLUSTER_EDGE.test(firstChar) ? NOT_AFTER_COENG : '';
}

/**
 * Builds the lookahead guard for a term's last character.
 * @param {string} lastChar - Last character of the term.
 * @returns {string} Regex fragment (possibly empty).
 */
function buildTrailingGuard(lastChar) {
  if (LATIN_EDGE.test(lastChar)) return NOT_BEFORE_LATIN;
  return KHMER_CLUSTER_EDGE.test(lastChar) ? NOT_BEFORE_KHMER_MARK : '';
}

/**
 * Builds one regex alternative that matches `source` literally with script-aware edge guards.
 * Inputs: non-empty glossary source term.
 * Outputs: regex source fragment guarding Latin token edges and Khmer cluster edges.
 * Side effects: none.
 * Failure modes: throws TypeError if source is empty or not a string.
 * @param {string} source - Non-empty glossary source term.
 * @returns {string} Regex source fragment.
 */
export function buildTermPattern(source) {
  const chars = Array.from(source);
  return `${buildLeadingGuard(chars[0])}${escapeRegexLiteral(source)}${buildTrailingGuard(chars[chars.length - 1])}`;
}

/**
 * Selects usable rules: enabled, non-empty source, first occurrence of each source wins.
 * @param {unknown} rules - Candidate rule list.
 * @returns {Map<string, string>} Source term to literal replacement.
 */
function collectActiveReplacements(rules) {
  const replacements = new Map();
  if (!Array.isArray(rules)) return replacements;
  for (const rule of rules) {
    const isUsable = rule && rule.enabled !== false && typeof rule.source === 'string' && rule.source.length > 0;
    if (isUsable && !replacements.has(rule.source)) {
      replacements.set(rule.source, typeof rule.replacement === 'string' ? rule.replacement : '');
    }
  }
  return replacements;
}

/**
 * Applies enabled pronunciation rules to text in one literal, longest-term-first pass.
 * Inputs: text and rules (`{ source, replacement, enabled? }`).
 * Outputs: rewritten text; the input is never mutated and replaced text is never re-scanned.
 * Side effects: none.
 * Failure modes: none — disabled, empty, or malformed rules are skipped; non-string text returns `''`.
 * Notes: sources are escaped; replacements are returned by a function so `$&`, `$$`, `$1` stay literal.
 * Latin/digit term edges only match at token boundaries (so "AI" never rewrites "MAIN"), and Khmer
 * term edges never split a coeng/vowel cluster. Khmer has no spaces, so no other boundary is imposed.
 * @param {string} text - Script text to rewrite.
 * @param {Array<{ source: string, replacement?: string, enabled?: boolean }>} rules - Pronunciation rules.
 * @returns {string} Text with pronunciation overrides applied.
 */
export function applyPronunciationRules(text, rules) {
  if (typeof text !== 'string') return '';
  const replacements = collectActiveReplacements(rules);
  if (replacements.size === 0 || text.length === 0) return text;
  const sources = Array.from(replacements.keys()).sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const pattern = new RegExp(sources.map(buildTermPattern).join('|'), 'g');
  return text.replace(pattern, matched => replacements.get(matched));
}
