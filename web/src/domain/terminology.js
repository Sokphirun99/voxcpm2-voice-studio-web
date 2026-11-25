/**
 * @fileoverview Pure domain terminology library supporting reusable approved terms,
 * per-project overrides, and strictly isolated correction stages:
 *   1. Spelling / Source Orthography (`spelling`, `name` variants -> term)
 *   2. Translation Enforcement (`translation`, `name` translation / preserveInTranslation)
 *   3. TTS Pronunciation (`pronunciation`, `name` pronunciation -> spoken text only)
 *   4. Subtitle Cue Validation (unapproved spelling variants & translation term compliance)
 */

import { ValidationError } from './errors.js';
import { normalizeKhmerUnicode } from './khmerText.js';
import { preservePauseMarkers } from './pauseMarkers.js';
import { buildTermPattern, normalizeGlossaryRules } from './pronunciationRules.js';
import { isSameSubtitleLanguage, normalizeTargetLanguageCode } from './subtitleLanguages.js';

export const TERM_CATEGORIES = Object.freeze({
  SPELLING: 'spelling',
  TRANSLATION: 'translation',
  NAME: 'name',
  PRONUNCIATION: 'pronunciation',
});

export const TERM_STATUSES = Object.freeze({
  DRAFT: 'draft',
  APPROVED: 'approved',
});

export const CORRECTION_STAGES = Object.freeze({
  SPELLING: 'spelling',
  TRANSLATION: 'translation',
  PRONUNCIATION: 'pronunciation',
});

export const TERM_SCOPES = Object.freeze({
  GLOBAL: 'global',
  PROJECT: 'project',
});

export const MAX_TERMINOLOGY_TERMS = 500;
export const MAX_TERMINOLOGY_TEXT_LENGTH = 160;
export const MAX_TERMINOLOGY_NOTES_LENGTH = 300;
export const MAX_TERMINOLOGY_VARIANTS = 25;

const MAX_TERM_ID_LENGTH = 64;
const VALID_CATEGORIES = new Set(Object.values(TERM_CATEGORIES));
const VALID_STATUSES = new Set(Object.values(TERM_STATUSES));

const OVERRIDE_PATCH_KEYS = Object.freeze([
  'disabled',
  'status',
  'enabled',
  'term',
  'variants',
  'translation',
  'preserveInTranslation',
  'pronunciation',
  'sourceLanguage',
  'targetLanguage',
  'caseSensitive',
  'notes',
  'updatedAt',
]);

/**
 * Counts Unicode code points rather than UTF-16 code units.
 * @param {string} value - Input string.
 * @returns {number} Code point length.
 */
function countCodePoints(value) {
  return Array.from(value).length;
}

/**
 * Validates and Unicode-normalizes a terminology text field.
 * @param {unknown} raw - Candidate field value.
 * @param {string} field - Field name for error messages.
 * @param {number} [maxLength=MAX_TERMINOLOGY_TEXT_LENGTH] - Code point limit.
 * @returns {string} Trimmed normalized string.
 */
function normalizeTextField(raw, field, maxLength = MAX_TERMINOLOGY_TEXT_LENGTH) {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') {
    throw new ValidationError(`Terminology ${field} must be text.`, 'terminology', 'INVALID_TERMINOLOGY_TERM');
  }
  const normalized = normalizeKhmerUnicode(raw);
  if (countCodePoints(normalized) > maxLength) {
    throw new ValidationError(`Keep terminology ${field} under ${maxLength} characters.`, 'terminology', 'TERMINOLOGY_TEXT_TOO_LONG');
  }
  return normalized;
}

/**
 * Validates an optional language filter code (`''`, `'any'`, or `'auto'` become `''`).
 * @param {unknown} raw - Raw language code.
 * @param {string} field - Field label.
 * @returns {string} Canonical language filter or `''` for any language.
 */
function normalizeLanguageFilter(raw, field) {
  const cleaned = normalizeTextField(raw, field, 32);
  if (!cleaned) return '';
  const lowered = cleaned.toLowerCase();
  if (lowered === 'any' || lowered === 'all' || lowered === 'auto') return '';
  return cleaned;
}

/**
 * Checks whether a normalized rule language filter matches an active workspace language.
 * @param {string} ruleLang - Rule language filter (`''` matches any language).
 * @param {string} activeLang - Active language tag (`''` or `'auto'` matches global-language rules only).
 * @returns {boolean} True when the rule applies to `activeLang`.
 */
export function doesTerminologyLanguageMatch(ruleLang, activeLang) {
  const cleanRule = normalizeLanguageFilter(ruleLang, 'language');
  if (!cleanRule) return true;
  const cleanActive = normalizeLanguageFilter(activeLang, 'language');
  if (!cleanActive) return false;
  if (cleanRule.toLowerCase() === cleanActive.toLowerCase()) return true;
  return isSameSubtitleLanguage(cleanRule, cleanActive) || isSameSubtitleLanguage(cleanActive, cleanRule);
}

/**
 * Normalizes source-language spelling variants for `spelling` and `name` entries.
 * @param {unknown} rawVariants - Array or comma/newline-delimited string.
 * @param {string} canonicalTerm - Primary canonical term.
 * @returns {readonly string[]} Frozen list of unique non-empty variants.
 */
function normalizeVariantsList(rawVariants, canonicalTerm) {
  if (rawVariants === undefined || rawVariants === null) return Object.freeze([]);
  const items = Array.isArray(rawVariants)
    ? rawVariants
    : typeof rawVariants === 'string'
      ? rawVariants.split(/[,\n]/)
      : null;
  if (!items) {
    throw new ValidationError('Terminology variants must be a list of phrases.', 'terminology', 'INVALID_TERMINOLOGY_VARIANTS');
  }
  if (items.length > MAX_TERMINOLOGY_VARIANTS) {
    throw new ValidationError(`Keep spelling variants to ${MAX_TERMINOLOGY_VARIANTS} or fewer per term.`, 'terminology', 'TOO_MANY_TERMINOLOGY_VARIANTS');
  }
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const clean = normalizeTextField(item, 'variant');
    if (!clean || clean === canonicalTerm || seen.has(clean)) continue;
    seen.add(clean);
    result.push(clean);
  }
  return Object.freeze(result);
}

/**
 * Validates optional boolean flags consistently without coercing arbitrary strings.
 * @param {unknown} raw - Raw flag value.
 * @param {boolean} fallback - Default when omitted.
 * @param {string} field - Field name for error context.
 * @returns {boolean} Normalized boolean.
 */
function normalizeBooleanField(raw, fallback, field) {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'boolean') {
    throw new ValidationError(`Terminology ${field} flag must be true or false.`, 'terminology', 'INVALID_TERMINOLOGY_TERM');
  }
  return raw;
}

/**
 * Validates category-specific fields so irrelevant stages never leak into stored definitions.
 * @param {object} parsed - Parsed raw fields.
 * @returns {object} Stage-scoped normalized properties.
 */
function sanitizeStageSpecificFields({ category, term, variants, translation, preserveInTranslation, pronunciation }) {
  const allowsSpelling = category === TERM_CATEGORIES.SPELLING || category === TERM_CATEGORIES.NAME;
  const allowsTranslation = category === TERM_CATEGORIES.TRANSLATION || category === TERM_CATEGORIES.NAME;
  const allowsPronunciation = category === TERM_CATEGORIES.PRONUNCIATION || category === TERM_CATEGORIES.NAME;
  if (category === TERM_CATEGORIES.TRANSLATION && !translation) {
    throw new ValidationError(`Enter an approved translation for "${term}".`, 'terminology', 'EMPTY_TERMINOLOGY_TRANSLATION');
  }
  return {
    variants: allowsSpelling ? variants : Object.freeze([]),
    translation: allowsTranslation ? translation : '',
    preserveInTranslation: category === TERM_CATEGORIES.NAME ? preserveInTranslation : false,
    pronunciation: allowsPronunciation ? pronunciation : '',
  };
}

function parseTermMeta(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('Each terminology entry must be an object.', 'terminology', 'INVALID_TERMINOLOGY_TERM');
  }
  const category = typeof raw.category === 'string' ? raw.category.trim().toLowerCase() : '';
  if (!VALID_CATEGORIES.has(category)) {
    throw new ValidationError('Terminology category must be spelling, translation, name, or pronunciation.', 'terminology', 'INVALID_TERMINOLOGY_CATEGORY');
  }
  const status = raw.status === undefined || raw.status === null ? TERM_STATUSES.DRAFT : String(raw.status).trim().toLowerCase();
  if (!VALID_STATUSES.has(status)) {
    throw new ValidationError('Terminology status must be draft or approved.', 'terminology', 'INVALID_TERMINOLOGY_STATUS');
  }
  const term = normalizeTextField(raw.term, 'term');
  if (!term) {
    throw new ValidationError('Enter a canonical word or phrase for the terminology entry.', 'terminology', 'EMPTY_TERMINOLOGY_TERM');
  }
  const rawId = typeof raw.id === 'string' ? raw.id.trim().slice(0, MAX_TERM_ID_LENGTH) : '';
  return { id: rawId || `term-${index + 1}`, category, status, term };
}

/**
 * Validates and normalizes a single terminology entry.
 * Inputs: raw term object and optional list index for fallback ID generation.
 * Outputs: frozen normalized terminology entry with stage-scoped fields.
 * Side effects: none.
 * Failure modes: throws ValidationError (`field: 'terminology'`) for invalid category, status,
 * empty term, missing translation on `translation` entries, or length violations.
 * @param {unknown} raw - Candidate term object.
 * @param {number} [index=0] - List position fallback.
 * @returns {object} Frozen normalized terminology entry.
 */
export function normalizeTerminologyTerm(raw, index = 0) {
  const meta = parseTermMeta(raw, index);
  const stageFields = sanitizeStageSpecificFields({
    category: meta.category,
    term: meta.term,
    variants: normalizeVariantsList(raw.variants, meta.term),
    translation: normalizeTextField(raw.translation, 'translation'),
    preserveInTranslation: normalizeBooleanField(raw.preserveInTranslation, false, 'preserveInTranslation'),
    pronunciation: normalizeTextField(raw.pronunciation, 'pronunciation'),
  });
  return Object.freeze({
    ...meta,
    enabled: normalizeBooleanField(raw.enabled, true, 'enabled'),
    ...stageFields,
    sourceLanguage: normalizeLanguageFilter(raw.sourceLanguage, 'sourceLanguage'),
    targetLanguage: normalizeLanguageFilter(raw.targetLanguage, 'targetLanguage'),
    caseSensitive: normalizeBooleanField(raw.caseSensitive, false, 'caseSensitive'),
    notes: normalizeTextField(raw.notes, 'notes', MAX_TERMINOLOGY_NOTES_LENGTH),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt.trim().slice(0, 48) : '',
  });
}

/**
 * Builds the deduplication signature preventing duplicate conflicting entries inside the same list.
 * @param {object} entry - Normalized terminology entry.
 * @returns {string} Composite identity key.
 */
function buildEntryIdentityKey(entry) {
  const canonicalTarget = entry.targetLanguage ? normalizeTargetLanguageCode(entry.targetLanguage) : '';
  return [
    entry.category,
    entry.term.toLowerCase(),
    entry.sourceLanguage.toLowerCase(),
    canonicalTarget.toLowerCase(),
  ].join('\0');
}

/**
 * Validates and normalizes an array of terminology entries.
 * Inputs: candidate term array.
 * Outputs: frozen array of frozen normalized terms.
 * Side effects: none.
 * Failure modes: throws ValidationError on non-array input, exceeding 500 terms, duplicate IDs,
 * or duplicate `(category, term, sourceLanguage, targetLanguage)` entries.
 * @param {unknown} rawTerms - Candidate terminology list.
 * @returns {readonly object[]} Frozen normalized terms.
 */
export function normalizeTerminologyList(rawTerms) {
  if (!Array.isArray(rawTerms)) {
    throw new ValidationError('Terminology entries must be a list.', 'terminology', 'INVALID_TERMINOLOGY_LIST');
  }
  if (rawTerms.length > MAX_TERMINOLOGY_TERMS) {
    throw new ValidationError(`Keep terminology entries to ${MAX_TERMINOLOGY_TERMS} or fewer.`, 'terminology', 'TERMINOLOGY_TOO_MANY_TERMS');
  }
  const seenIds = new Set();
  const seenKeys = new Set();
  const normalized = rawTerms.map((raw, index) => {
    const entry = normalizeTerminologyTerm(raw, index);
    if (seenIds.has(entry.id)) {
      throw new ValidationError(`Duplicate terminology id "${entry.id}".`, 'terminology', 'DUPLICATE_TERMINOLOGY_ID');
    }
    const key = buildEntryIdentityKey(entry);
    if (seenKeys.has(key)) {
      throw new ValidationError(`"${entry.term}" already exists in ${entry.category} terminology.`, 'terminology', 'DUPLICATE_TERMINOLOGY_TERM');
    }
    seenIds.add(entry.id);
    seenKeys.add(key);
    return entry;
  });
  return Object.freeze(normalized);
}

/**
 * Returns a fresh empty per-project terminology override container.
 * Inputs: none.
 * Outputs: `{ overrides: {}, projectTerms: [] }`.
 * Side effects: none.
 * Failure modes: none.
 * @returns {{ overrides: Record<string, object>, projectTerms: readonly object[] }} Empty container.
 */
export function createEmptyProjectTerminology() {
  return Object.freeze({
    overrides: Object.freeze({}),
    projectTerms: Object.freeze([]),
  });
}

function createUniqueTermId(prefix, existingTerms) {
  const usedIds = new Set((existingTerms || []).map(item => item.id));
  const suffix = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID().slice(0, 8)
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  let candidate = `${prefix}-${suffix}`;
  let seq = (existingTerms?.length || 0) + 1;
  while (usedIds.has(candidate)) {
    candidate = `${prefix}-${suffix}-${seq}`;
    seq += 1;
  }
  return candidate;
}

function assignOverrideStatusAndFlags(rawPatch, patch) {
  if (rawPatch.disabled !== undefined) patch.disabled = normalizeBooleanField(rawPatch.disabled, false, 'disabled');
  if (rawPatch.enabled !== undefined) patch.enabled = normalizeBooleanField(rawPatch.enabled, true, 'enabled');
  if (rawPatch.preserveInTranslation !== undefined) {
    patch.preserveInTranslation = normalizeBooleanField(rawPatch.preserveInTranslation, false, 'preserveInTranslation');
  }
  if (rawPatch.caseSensitive !== undefined) {
    patch.caseSensitive = normalizeBooleanField(rawPatch.caseSensitive, false, 'caseSensitive');
  }
  if (rawPatch.status !== undefined) {
    const status = String(rawPatch.status).trim().toLowerCase();
    if (!VALID_STATUSES.has(status)) {
      throw new ValidationError('Override status must be draft or approved.', 'terminology', 'INVALID_TERMINOLOGY_STATUS');
    }
    patch.status = status;
  }
}

function assignOverrideTextAndLang(rawPatch, patch, fallbackTerm) {
  if (rawPatch.term !== undefined) {
    const clean = normalizeTextField(rawPatch.term, 'term');
    if (!clean) throw new ValidationError('Override term cannot be empty.', 'terminology', 'EMPTY_TERMINOLOGY_TERM');
    patch.term = clean;
  }
  if (rawPatch.variants !== undefined) patch.variants = normalizeVariantsList(rawPatch.variants, patch.term || fallbackTerm);
  if (rawPatch.translation !== undefined) patch.translation = normalizeTextField(rawPatch.translation, 'translation');
  if (rawPatch.pronunciation !== undefined) patch.pronunciation = normalizeTextField(rawPatch.pronunciation, 'pronunciation');
  if (rawPatch.sourceLanguage !== undefined) patch.sourceLanguage = normalizeLanguageFilter(rawPatch.sourceLanguage, 'sourceLanguage');
  if (rawPatch.targetLanguage !== undefined) patch.targetLanguage = normalizeLanguageFilter(rawPatch.targetLanguage, 'targetLanguage');
  if (rawPatch.notes !== undefined) patch.notes = normalizeTextField(rawPatch.notes, 'notes', MAX_TERMINOLOGY_NOTES_LENGTH);
  if (typeof rawPatch.updatedAt === 'string') patch.updatedAt = rawPatch.updatedAt.trim().slice(0, 48);
}

/**
 * Normalizes a partial override patch targeting one global term inside a project.
 * @param {unknown} rawPatch - Candidate override fields.
 * @param {string} [fallbackTerm=''] - Canonical term fallback for variant deduplication.
 * @returns {object} Frozen normalized override patch.
 */
function normalizeOverridePatch(rawPatch, fallbackTerm = '') {
  if (!rawPatch || typeof rawPatch !== 'object' || Array.isArray(rawPatch)) {
    throw new ValidationError('Project terminology override must be an object.', 'terminology', 'INVALID_TERMINOLOGY_OVERRIDE');
  }
  const patch = {};
  assignOverrideStatusAndFlags(rawPatch, patch);
  assignOverrideTextAndLang(rawPatch, patch, fallbackTerm);
  return Object.freeze(patch);
}

function normalizeOverridesMap(rawOverrides) {
  if (!rawOverrides || typeof rawOverrides !== 'object' || Array.isArray(rawOverrides)) {
    throw new ValidationError('Project terminology overrides must be a dictionary.', 'terminology', 'INVALID_PROJECT_TERMINOLOGY');
  }
  const overrides = {};
  for (const [termId, patch] of Object.entries(rawOverrides)) {
    const cleanId = String(termId || '').trim().slice(0, MAX_TERM_ID_LENGTH);
    if (!cleanId) continue;
    const normalizedPatch = normalizeOverridePatch(patch);
    if (Object.keys(normalizedPatch).length > 0) overrides[cleanId] = normalizedPatch;
  }
  return Object.freeze(overrides);
}

/**
 * Validates and normalizes per-project terminology metadata (`{ overrides, projectTerms }`).
 * Inputs: raw project terminology object (optional/null returns empty container).
 * Outputs: frozen `{ overrides, projectTerms }`.
 * Side effects: none.
 * Failure modes: throws ValidationError for invalid override maps or malformed project terms.
 * @param {unknown} raw - Raw project terminology container.
 * @returns {{ overrides: Record<string, object>, projectTerms: readonly object[] }} Normalized container.
 */
export function normalizeProjectTerminology(raw) {
  if (raw === undefined || raw === null) return createEmptyProjectTerminology();
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('Project terminology settings must be an object.', 'terminology', 'INVALID_PROJECT_TERMINOLOGY');
  }
  const overrides = normalizeOverridesMap(raw.overrides ?? {});
  const projectTerms = raw.projectTerms === undefined ? Object.freeze([]) : normalizeTerminologyList(raw.projectTerms);
  return Object.freeze({ overrides, projectTerms });
}

/**
 * Safely merges a project override onto one global term, keeping category integrity intact.
 * @param {object} globalTerm - Normalized global term.
 * @param {object | undefined} overridePatch - Normalized override patch.
 * @param {number} index - Position index.
 * @returns {object} Effective resolved term with scope metadata.
 */
export function mergeGlobalWithOverride(globalTerm, overridePatch, index = 0) {
  if (!overridePatch) {
    return Object.freeze({ ...globalTerm, scope: TERM_SCOPES.GLOBAL, isOverridden: false, isDisabledInProject: false });
  }
  if (overridePatch.disabled === true) {
    return Object.freeze({
      ...globalTerm,
      enabled: false,
      scope: TERM_SCOPES.GLOBAL,
      isOverridden: true,
      isDisabledInProject: true,
    });
  }
  const mergedInput = { ...globalTerm };
  for (const key of OVERRIDE_PATCH_KEYS) {
    if (key !== 'disabled' && overridePatch[key] !== undefined) mergedInput[key] = overridePatch[key];
  }
  const normalized = normalizeTerminologyTerm(mergedInput, index);
  return Object.freeze({ ...normalized, scope: TERM_SCOPES.GLOBAL, isOverridden: true, isDisabledInProject: false });
}

/**
 * Resolves effective terminology for a project by merging global reusable terms with project overrides
 * and appending project-local terms.
 * Inputs: global term array and optional project terminology container `{ overrides, projectTerms }`.
 * Outputs: frozen array of resolved terms tagged with `scope`, `isOverridden`, and `isDisabledInProject`.
 * Side effects: none.
 * Failure modes: throws ValidationError if normalized inputs are malformed.
 * @param {unknown} globalTerms - Reusable global terminology entries.
 * @param {unknown} [projectTerminology] - Optional per-project overrides/projectTerms.
 * @returns {readonly object[]} Effective resolved terminology list.
 */
export function resolveEffectiveTerminology(globalTerms, projectTerminology = null) {
  const safeGlobal = Array.isArray(globalTerms) ? normalizeTerminologyList(globalTerms) : Object.freeze([]);
  const safeProject = normalizeProjectTerminology(projectTerminology);
  const resolvedGlobals = safeGlobal.map((entry, idx) =>
    mergeGlobalWithOverride(entry, safeProject.overrides[entry.id], idx)
  );
  const resolvedProject = safeProject.projectTerms.map(entry =>
    Object.freeze({ ...entry, scope: TERM_SCOPES.PROJECT, isOverridden: false, isDisabledInProject: false })
  );
  return Object.freeze([...resolvedGlobals, ...resolvedProject]);
}

/**
 * Applies or updates a per-project override for a global term ID.
 * Inputs: project terminology container, target global term ID, partial override fields, and optional `globalTerms` for merged validation.
 * Outputs: new normalized project terminology container.
 * Side effects: none.
 * Failure modes: throws ValidationError if termId is empty or merged override fields are invalid.
 * @param {unknown} projectTerminology - Existing project container.
 * @param {string} termId - Global term identifier.
 * @param {object} patch - Override patch object.
 * @param {readonly object[]|null} [globalTerms=null] - Optional global terms to validate merged category invariants.
 * @returns {{ overrides: Record<string, object>, projectTerms: readonly object[] }} Updated container.
 */
export function setProjectTermOverride(projectTerminology, termId, patch, globalTerms = null, { replace = false } = {}) {
  const current = normalizeProjectTerminology(projectTerminology);
  const cleanId = String(termId || '').trim().slice(0, MAX_TERM_ID_LENGTH);
  if (!cleanId) {
    throw new ValidationError('Select a global term to override.', 'terminology', 'INVALID_TERMINOLOGY_ID');
  }
  const globalMatch = Array.isArray(globalTerms) ? globalTerms.find(item => item?.id === cleanId) : null;
  const basePatch = replace ? {} : (current.overrides[cleanId] || {});
  const nextPatch = normalizeOverridePatch({
    ...basePatch,
    ...(patch || {}),
    updatedAt: patch?.updatedAt || new Date().toISOString(),
  }, globalMatch?.term || '');
  if (globalMatch) mergeGlobalWithOverride(globalMatch, nextPatch, 0);
  return normalizeProjectTerminology({
    overrides: { ...current.overrides, [cleanId]: nextPatch },
    projectTerms: current.projectTerms,
  });
}

/**
 * Clears a project override, reverting that term to the reusable global definition.
 * Inputs: project terminology container and global term ID.
 * Outputs: new normalized project terminology container.
 * Side effects: none.
 * Failure modes: none.
 * @param {unknown} projectTerminology - Existing project container.
 * @param {string} termId - Global term ID to restore.
 * @returns {{ overrides: Record<string, object>, projectTerms: readonly object[] }} Updated container.
 */
export function clearProjectTermOverride(projectTerminology, termId) {
  const current = normalizeProjectTerminology(projectTerminology);
  const cleanId = String(termId || '').trim().slice(0, MAX_TERM_ID_LENGTH);
  if (!cleanId || !current.overrides[cleanId]) return current;
  const nextOverrides = { ...current.overrides };
  delete nextOverrides[cleanId];
  return normalizeProjectTerminology({ overrides: nextOverrides, projectTerms: current.projectTerms });
}

/**
 * Adds or updates a project-only term inside `projectTerminology.projectTerms`.
 * Inputs: project terminology container and raw term payload.
 * Outputs: new normalized project terminology container.
 * Side effects: none.
 * Failure modes: throws ValidationError on invalid fields or duplicate term identity.
 * @param {unknown} projectTerminology - Existing container.
 * @param {object} rawTerm - Term to insert or update.
 * @returns {{ overrides: Record<string, object>, projectTerms: readonly object[] }} Updated container.
 */
export function upsertProjectTerm(projectTerminology, rawTerm) {
  const current = normalizeProjectTerminology(projectTerminology);
  const candidateId = typeof rawTerm?.id === 'string' && rawTerm.id.trim()
    ? rawTerm.id.trim()
    : createUniqueTermId('proj-term', current.projectTerms);
  const candidate = normalizeTerminologyTerm({ ...rawTerm, id: candidateId }, current.projectTerms.length);
  const existingIndex = current.projectTerms.findIndex(item => item.id === candidate.id);
  const nextTerms = existingIndex >= 0
    ? current.projectTerms.map((item, idx) => (idx === existingIndex ? candidate : item))
    : [...current.projectTerms, candidate];
  return normalizeProjectTerminology({ overrides: current.overrides, projectTerms: nextTerms });
}

/**
 * Removes a project-only term by ID.
 * Inputs: project terminology container and term ID.
 * Outputs: updated container.
 * Side effects: none.
 * Failure modes: none.
 * @param {unknown} projectTerminology - Existing container.
 * @param {string} termId - Project term ID.
 * @returns {{ overrides: Record<string, object>, projectTerms: readonly object[] }} Updated container.
 */
export function removeProjectTerm(projectTerminology, termId) {
  const current = normalizeProjectTerminology(projectTerminology);
  const cleanId = String(termId || '').trim();
  const nextTerms = current.projectTerms.filter(item => item.id !== cleanId);
  if (nextTerms.length === current.projectTerms.length) return current;
  return normalizeProjectTerminology({ overrides: current.overrides, projectTerms: nextTerms });
}

/**
 * Promotes a project-only term into the reusable global library with a clean global ID.
 * Inputs: project container, project term ID, and current global terms list.
 * Outputs: `{ globalTerms, projectTerminology, promotedTerm }`.
 * Side effects: none.
 * Failure modes: throws ValidationError if the project term is missing or conflicts globally.
 * @param {unknown} projectTerminology - Current project container.
 * @param {string} projectTermId - ID of term inside `projectTerms`.
 * @param {unknown} globalTerms - Current global library terms.
 * @returns {{ globalTerms: readonly object[], projectTerminology: object, promotedTerm: object }} Promotion result.
 */
export function promoteProjectTermToGlobal(projectTerminology, projectTermId, globalTerms) {
  const currentProject = normalizeProjectTerminology(projectTerminology);
  const currentGlobals = Array.isArray(globalTerms) ? normalizeTerminologyList(globalTerms) : Object.freeze([]);
  const target = currentProject.projectTerms.find(item => item.id === projectTermId);
  if (!target) {
    throw new ValidationError('Selected project term was not found.', 'terminology', 'TERMINOLOGY_NOT_FOUND');
  }
  const usedIds = new Set(currentGlobals.map(item => item.id));
  const baseId = target.id.startsWith('proj-') ? target.id.slice(5) : target.id;
  const globalId = baseId && !usedIds.has(baseId) ? baseId : createUniqueTermId('global', currentGlobals);
  const promotedTerm = normalizeTerminologyTerm({ ...target, id: globalId, updatedAt: new Date().toISOString() }, currentGlobals.length);
  const nextGlobals = normalizeTerminologyList([...currentGlobals, promotedTerm]);
  const nextProject = removeProjectTerm(currentProject, target.id);
  return { globalTerms: nextGlobals, projectTerminology: nextProject, promotedTerm };
}

/**
 * Orders entries so project-scoped rules take precedence over global rules when patterns collide.
 * @param {readonly object[]} effectiveTerms - Resolved terms.
 * @returns {object[]} Precedence-ordered active approved terms.
 */
function filterApprovedActiveTerms(effectiveTerms) {
  if (!Array.isArray(effectiveTerms)) return [];
  const active = effectiveTerms.filter(entry =>
    entry &&
    entry.status === TERM_STATUSES.APPROVED &&
    entry.enabled !== false &&
    entry.isDisabledInProject !== true
  );
  return [
    ...active.filter(entry => entry.scope === TERM_SCOPES.PROJECT),
    ...active.filter(entry => entry.scope !== TERM_SCOPES.PROJECT),
  ];
}

function appendEntrySpellingRules(entry, sourceLanguage, seenKeys, rules) {
  const isSpelling = entry.category === TERM_CATEGORIES.SPELLING || entry.category === TERM_CATEGORIES.NAME;
  if (!isSpelling || !Array.isArray(entry.variants) || entry.variants.length === 0) return;
  if (!doesTerminologyLanguageMatch(entry.sourceLanguage, sourceLanguage)) return;
  for (const variant of entry.variants) {
    const key = entry.caseSensitive ? variant : variant.toLowerCase();
    if (!variant || seenKeys.has(key)) continue;
    seenKeys.add(key);
    rules.push(Object.freeze({
      termId: entry.id,
      category: entry.category,
      scope: entry.scope || TERM_SCOPES.GLOBAL,
      source: variant,
      target: entry.term,
      caseSensitive: Boolean(entry.caseSensitive),
    }));
  }
}

/**
 * Stage 1 Selector: extracts approved source-spelling rules ONLY (`spelling` and `name` variants -> term).
 * Never reads `translation` or `pronunciation`.
 * Inputs: effective resolved terminology entries and optional `{ sourceLanguage }`.
 * Outputs: frozen list of `{ termId, category, scope, source, target, caseSensitive }`.
 * Side effects: none.
 * Failure modes: none (invalid or unapproved items are skipped).
 * @param {readonly object[]} effectiveTerms - Resolved terminology list.
 * @param {{ sourceLanguage?: string }} [options] - Optional active source language code.
 * @returns {readonly object[]} Stage 1 spelling rules.
 */
export function selectSpellingRules(effectiveTerms, { sourceLanguage = '' } = {}) {
  const ordered = filterApprovedActiveTerms(effectiveTerms);
  const rules = [];
  const seenKeys = new Set();
  for (const entry of ordered) {
    appendEntrySpellingRules(entry, sourceLanguage, seenKeys, rules);
  }
  return Object.freeze(rules);
}

function appendEntryTranslationRule(entry, { sourceLanguage, targetLanguage }, seenKeys, rules) {
  if (entry.category !== TERM_CATEGORIES.TRANSLATION && entry.category !== TERM_CATEGORIES.NAME) return;
  const targetText = entry.translation || (entry.category === TERM_CATEGORIES.NAME && entry.preserveInTranslation ? entry.term : '');
  if (!targetText) return;
  if (!doesTerminologyLanguageMatch(entry.sourceLanguage, sourceLanguage)) return;
  if (!doesTerminologyLanguageMatch(entry.targetLanguage, targetLanguage)) return;
  const key = entry.caseSensitive ? entry.term : entry.term.toLowerCase();
  if (seenKeys.has(key)) return;
  seenKeys.add(key);
  rules.push(Object.freeze({
    termId: entry.id,
    category: entry.category,
    scope: entry.scope || TERM_SCOPES.GLOBAL,
    source: entry.term,
    target: targetText,
    preserveInTranslation: Boolean(entry.preserveInTranslation),
    caseSensitive: Boolean(entry.caseSensitive),
  }));
}

/**
 * Stage 2 Selector: extracts approved translation rules ONLY (`translation` and qualifying `name` entries).
 * Never reads `pronunciation` or `variants`.
 * Inputs: effective resolved terminology entries and `{ sourceLanguage?, targetLanguage? }`.
 * Outputs: frozen list of `{ termId, category, scope, source, target, preserveInTranslation, caseSensitive }`.
 * Side effects: none.
 * Failure modes: none.
 * @param {readonly object[]} effectiveTerms - Resolved terminology list.
 * @param {{ sourceLanguage?: string, targetLanguage?: string }} [options] - Active language pair.
 * @returns {readonly object[]} Stage 2 translation rules.
 */
export function selectTranslationRules(effectiveTerms, { sourceLanguage = '', targetLanguage = '' } = {}) {
  const ordered = filterApprovedActiveTerms(effectiveTerms);
  const rules = [];
  const seenKeys = new Set();
  for (const entry of ordered) {
    appendEntryTranslationRule(entry, { sourceLanguage, targetLanguage }, seenKeys, rules);
  }
  return Object.freeze(rules);
}

function collectDisabledPronunciationKeys(effectiveTerms, sourceLanguage) {
  const disabledKeys = new Set();
  if (!Array.isArray(effectiveTerms)) return disabledKeys;
  for (const entry of effectiveTerms) {
    if (!entry) continue;
    const isPronCategory = entry.category === TERM_CATEGORIES.PRONUNCIATION || entry.category === TERM_CATEGORIES.NAME;
    if (!isPronCategory || !doesTerminologyLanguageMatch(entry.sourceLanguage, sourceLanguage)) continue;
    if (entry.isDisabledInProject === true || entry.enabled === false) {
      disabledKeys.add(entry.term);
      disabledKeys.add(entry.term.toLowerCase());
    }
  }
  return disabledKeys;
}

function appendEntryPronunciationRule(entry, sourceLanguage, seenKeys, rules) {
  const isPronEntry = entry.category === TERM_CATEGORIES.PRONUNCIATION;
  const isNamedPron = entry.category === TERM_CATEGORIES.NAME && entry.pronunciation !== '';
  if (!isPronEntry && !isNamedPron) return;
  if (!doesTerminologyLanguageMatch(entry.sourceLanguage, sourceLanguage)) return;
  const key = entry.caseSensitive ? entry.term : entry.term.toLowerCase();
  if (seenKeys.has(key)) return;
  seenKeys.add(key);
  rules.push(Object.freeze({
    id: entry.id,
    source: entry.term,
    replacement: entry.pronunciation,
    enabled: true,
    caseSensitive: Boolean(entry.caseSensitive),
  }));
}

function appendLegacyGlossaryFallbacks(glossaryRules, disabledKeys, seenKeys, rules) {
  if (!Array.isArray(glossaryRules)) return;
  for (const rule of glossaryRules) {
    if (!rule || rule.enabled === false || typeof rule.source !== 'string' || !rule.source) continue;
    if (disabledKeys.has(rule.source) || disabledKeys.has(rule.source.toLowerCase())) continue;
    if (seenKeys.has(rule.source) || seenKeys.has(rule.source.toLowerCase())) continue;
    seenKeys.add(rule.source);
    rules.push(Object.freeze({
      id: rule.id || `legacy-${rules.length + 1}`,
      source: rule.source,
      replacement: typeof rule.replacement === 'string' ? rule.replacement : '',
      enabled: true,
      caseSensitive: true,
    }));
  }
}

/**
 * Stage 3 Selector: extracts approved TTS pronunciation rules ONLY (`pronunciation` and named entries with `pronunciation`),
 * merged cleanly with optional legacy glossary rules (approved terminology wins on identical source phrase, and
 * project-disabled terms block legacy fallback with the same term).
 * Never reads `translation` or `variants`.
 * Inputs: effective resolved terms and optional `{ sourceLanguage?, glossaryRules? }`.
 * Outputs: frozen list of `{ id, source, replacement, enabled: true, caseSensitive? }` rules.
 * Side effects: none.
 * Failure modes: none.
 * @param {readonly object[]} effectiveTerms - Resolved terminology list.
 * @param {{ sourceLanguage?: string, glossaryRules?: Array<object> }} [options] - Language filter and fallback legacy rules.
 * @returns {readonly object[]} Stage 3 TTS pronunciation rules.
 */
export function selectPronunciationRules(effectiveTerms, { sourceLanguage = '', glossaryRules = [] } = {}) {
  const ordered = filterApprovedActiveTerms(effectiveTerms);
  const disabledKeys = collectDisabledPronunciationKeys(effectiveTerms, sourceLanguage);
  const rules = [];
  const seenKeys = new Set();
  for (const entry of ordered) {
    appendEntryPronunciationRule(entry, sourceLanguage, seenKeys, rules);
  }
  appendLegacyGlossaryFallbacks(glossaryRules, disabledKeys, seenKeys, rules);
  return Object.freeze(rules);
}

function sortRulesByLengthAndPriority(group) {
  return [...group].sort((a, b) => b.source.length - a.source.length || a.priority - b.priority);
}

function collectGroupMatches(text, group, caseSensitive) {
  if (group.length === 0) return [];
  const sorted = sortRulesByLengthAndPriority(group);
  const pattern = new RegExp(sorted.map(rule => buildTermPattern(rule.source)).join('|'), caseSensitive ? 'g' : 'gi');
  const hits = [];
  for (const match of text.matchAll(pattern)) {
    const matched = match[0];
    const matchedRule = sorted.find(rule => (
      caseSensitive ? rule.source === matched : rule.source.toLowerCase() === matched.toLowerCase()
    ));
    if (matchedRule) hits.push({ start: match.index, end: match.index + matched.length, matched, rule: matchedRule });
  }
  return hits;
}

function applyAcceptedMatches(text, candidates) {
  candidates.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || a.rule.priority - b.rule.priority);
  const parts = [];
  const matches = [];
  let cursor = 0;
  for (const cand of candidates) {
    if (cand.start < cursor) continue;
    parts.push(text.slice(cursor, cand.start));
    const replacement = cand.rule.isIdentityGuard
      ? cand.matched
      : (cand.rule.target !== undefined ? cand.rule.target : (cand.rule.replacement ?? ''));
    if (!cand.rule.isIdentityGuard && cand.matched !== replacement) {
      matches.push({ rule: cand.rule, matched: cand.matched, target: replacement });
    }
    parts.push(replacement);
    cursor = cand.end;
  }
  parts.push(text.slice(cursor));
  return { text: parts.join(''), matches };
}

/**
 * Builds a single-pass longest-first boundary-guarded matcher/replacer for `{ source, target/replacement, caseSensitive }`.
 * Runs case-sensitive (`g`) and case-insensitive (`gi`) groups separately before merging non-overlapping spans so
 * a failed case-sensitive alternative never shadows a shorter case-insensitive match.
 * @param {string} text - Input text to scan.
 * @param {readonly object[]} rules - Normalized stage rules with `source` and `target` or `replacement`.
 * @param {boolean} [preferCaseInsensitiveDefault=false] - Default sensitivity flag when omitted.
 * @returns {{ text: string, matches: Array<{ rule: object, matched: string, target: string }> }} Replacement result + match details.
 */
function runSinglePassRuleScan(text, rules, preferCaseInsensitiveDefault = false) {
  if (typeof text !== 'string' || !text || !Array.isArray(rules) || rules.length === 0) {
    return { text: typeof text === 'string' ? text : '', matches: [] };
  }
  const csGroup = [];
  const ciGroup = [];
  rules.forEach((rule, priority) => {
    const sensitive = rule.caseSensitive ?? !preferCaseInsensitiveDefault;
    (sensitive ? csGroup : ciGroup).push({ ...rule, priority });
  });
  const candidates = [...collectGroupMatches(text, csGroup, true), ...collectGroupMatches(text, ciGroup, false)];
  if (candidates.length === 0) return { text, matches: [] };
  return applyAcceptedMatches(text, candidates);
}

/**
 * Protects canonical/target phrases from partial re-matching by shorter source rules inside the same pass.
 * @param {readonly object[]} rules - Stage rules (`source`, `target`, `caseSensitive`).
 * @returns {readonly object[]} Rules plus non-colliding identity guards.
 */
function withTargetIdentityGuards(rules) {
  const csSources = new Set(rules.filter(r => r.caseSensitive).map(r => r.source));
  const ciSources = new Set(rules.filter(r => !r.caseSensitive).map(r => r.source.toLowerCase()));
  const guards = [];
  const seenGuards = new Set();
  for (const rule of rules) {
    const target = rule.target;
    if (!target) continue;
    const key = rule.caseSensitive ? target : target.toLowerCase();
    const covered = csSources.has(target) || ciSources.has(target.toLowerCase());
    if (covered || seenGuards.has(key)) continue;
    seenGuards.add(key);
    guards.push({ source: target, target, caseSensitive: rule.caseSensitive, isIdentityGuard: true });
  }
  return guards.length > 0 ? [...rules, ...guards] : rules;
}

/**
 * Stage 1 Applicator: applies approved source spelling corrections ONLY (`spelling` and `name` variants -> term).
 * Does not touch `translation` or `pronunciation`. Preserves `[pause ...]` markers intact.
 * Inputs: source text, effective terminology list, and optional `{ sourceLanguage }`.
 * Outputs: corrected source text string.
 * Side effects: none.
 * Failure modes: returns empty string for non-string input.
 * @param {string} text - Source transcript or script text.
 * @param {readonly object[]} effectiveTerms - Resolved terminology list.
 * @param {{ sourceLanguage?: string }} [options] - Active source language.
 * @returns {string} Spelling-corrected source text.
 */
export function applySpellingTerms(text, effectiveTerms, { sourceLanguage = '' } = {}) {
  if (typeof text !== 'string' || !text) return typeof text === 'string' ? text : '';
  const rules = selectSpellingRules(effectiveTerms, { sourceLanguage });
  if (rules.length === 0) return text;
  const guarded = withTargetIdentityGuards(rules);
  const rewritten = preservePauseMarkers(text, masked => runSinglePassRuleScan(masked, guarded).text);
  return rewritten === text ? text : normalizeKhmerUnicode(rewritten);
}

/**
 * Stage 2 Applicator: replaces any untranslated canonical source terms appearing in translated text with their
 * approved Stage 2 target translations (`translation` / `name`). Never injects pronunciation strings or rewrites source text.
 * Inputs: translated text, effective terms, and `{ sourceLanguage?, targetLanguage? }`.
 * Outputs: updated translated text string.
 * Side effects: none.
 * Failure modes: returns empty string for non-string input.
 * @param {string} translatedText - Target-language subtitle or sentence text.
 * @param {readonly object[]} effectiveTerms - Resolved terminology list.
 * @param {{ sourceLanguage?: string, targetLanguage?: string }} [options] - Language pair.
 * @returns {string} Translation-enforced text.
 */
export function applyTranslationTerms(translatedText, effectiveTerms, { sourceLanguage = '', targetLanguage = '' } = {}) {
  if (typeof translatedText !== 'string' || !translatedText) {
    return typeof translatedText === 'string' ? translatedText : '';
  }
  const rules = selectTranslationRules(effectiveTerms, { sourceLanguage, targetLanguage });
  if (rules.length === 0) return translatedText;
  return runSinglePassRuleScan(translatedText, withTargetIdentityGuards(rules)).text;
}

/**
 * Stage 3 Applicator: applies approved TTS pronunciation rules (and fallback legacy glossary rules) for speech synthesis.
 * Preserves `[pause ...]` tags untouched; never mutates visible UI scripts or subtitle cues.
 * Inputs: spoken script text, effective terminology list, and optional `{ sourceLanguage?, glossaryRules? }`.
 * Outputs: TTS engine input string.
 * Side effects: none.
 * Failure modes: returns empty string for non-string input.
 * @param {string} text - Normalized speech text.
 * @param {readonly object[]} effectiveTerms - Resolved terminology list.
 * @param {{ sourceLanguage?: string, glossaryRules?: Array<object> }} [options] - Language filter and fallback glossary.
 * @returns {string} Speech-ready text with TTS pronunciation overrides applied.
 */
export function applyTtsPronunciationTerms(text, effectiveTerms, { sourceLanguage = '', glossaryRules = [] } = {}) {
  if (typeof text !== 'string' || !text) return typeof text === 'string' ? text : '';
  const rules = selectPronunciationRules(effectiveTerms, { sourceLanguage, glossaryRules });
  if (rules.length === 0) return text;
  const rewritten = preservePauseMarkers(text, masked => runSinglePassRuleScan(masked, rules, false).text);
  return rewritten === text ? text : normalizeKhmerUnicode(rewritten);
}

/**
 * Checks whether a target phrase is already present in text respecting script-aware boundaries.
 * @param {string} haystack - Text to inspect.
 * @param {string} needle - Expected target phrase.
 * @param {boolean} caseSensitive - Case sensitivity flag.
 * @returns {boolean} True when `needle` appears intact in `haystack`.
 */
function containsBoundaryPhrase(haystack, needle, caseSensitive) {
  if (!haystack || !needle) return false;
  const flags = caseSensitive ? '' : 'i';
  const pattern = new RegExp(buildTermPattern(needle), flags);
  return pattern.test(haystack);
}

/**
 * Stage 4 Cue Diagnostic: returns separate spelling vs translation terminology findings for a single subtitle cue.
 * Never mixes pronunciation rules into subtitle text diagnostics.
 * Inputs: cue `{ text, translatedText? }`, effective terms, and `{ sourceLanguage?, targetLanguage? }`.
 * Outputs: `{ spellingMatches: Array<object>, translationGaps: Array<object> }`.
 * Side effects: none.
 * Failure modes: none.
 * @param {{ text?: string, translatedText?: string }} segment - Subtitle cue.
 * @param {readonly object[]} effectiveTerms - Resolved terminology list.
 * @param {{ sourceLanguage?: string, targetLanguage?: string }} [options] - Active languages.
 * @returns {{ spellingMatches: Array<object>, translationGaps: Array<object> }} Stage-separated findings.
 */
export function inspectSegmentTerminology(segment, effectiveTerms, { sourceLanguage = '', targetLanguage = '' } = {}) {
  const sourceText = String(segment?.text || '');
  const translatedText = String(segment?.translatedText || '');
  const spellingRules = selectSpellingRules(effectiveTerms, { sourceLanguage });
  const guardedSpelling = spellingRules.length > 0 ? withTargetIdentityGuards(spellingRules) : [];
  const spellingMatches = sourceText && guardedSpelling.length > 0
    ? runSinglePassRuleScan(sourceText, guardedSpelling).matches
    : [];

  const translationGaps = [];
  if (sourceText.trim() && translatedText.trim() && targetLanguage) {
    const translationRules = selectTranslationRules(effectiveTerms, { sourceLanguage, targetLanguage });
    for (const rule of translationRules) {
      const sourceHasTerm = containsBoundaryPhrase(sourceText, rule.source, rule.caseSensitive);
      if (!sourceHasTerm) continue;
      const targetHasTranslation = containsBoundaryPhrase(translatedText, rule.target, rule.caseSensitive);
      if (!targetHasTranslation) translationGaps.push(rule);
    }
  }
  return { spellingMatches, translationGaps };
}

/**
 * Computes a deterministic signature of all active Stage 3 pronunciation rules for staleness tracking.
 * Inputs: effective terms, optional legacy glossary rules, and optional source language filter.
 * Outputs: stable string hash/signature.
 * Side effects: none.
 * Failure modes: none.
 * @param {readonly object[]} effectiveTerms - Resolved terminology list.
 * @param {Array<object>} [glossaryRules=[]] - Legacy glossary fallback rules.
 * @param {string} [sourceLanguage=''] - Spoken output language.
 * @returns {string} Deterministic pronunciation signature.
 */
export function buildPronunciationSignature(effectiveTerms, glossaryRules = [], sourceLanguage = '') {
  const rules = selectPronunciationRules(effectiveTerms, { sourceLanguage, glossaryRules });
  if (rules.length === 0) return '';
  return rules
    .map(rule => `${rule.source}\u0001${rule.replacement}\u0001${rule.caseSensitive ? '1' : '0'}`)
    .join('\u0002');
}

export { normalizeGlossaryRules };
