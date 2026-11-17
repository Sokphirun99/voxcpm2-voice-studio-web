/**
 * @fileoverview Pure domain Narakeet-style per-person speaking Character catalog and validation rules.
 */

import { ValidationError } from './errors.js';
import { MAX_DESCRIPTION_LENGTH, countGraphemes, stripParentheses } from './presets.js';

export const MAX_VOICE_NAME_LENGTH = 60;
export const DEFAULT_CLONED_DESCRIPTION = 'Single custom speaker voice cloned from uploaded audio sample';
const VALID_CATEGORIES = new Set(['female', 'male', 'character']);
const CATEGORY_GROUP_LABELS = [
  ['female', 'Female'],
  ['male', 'Male'],
  ['character', 'Character'],
];

export const BUILT_IN_VOICES = [
  {
    id: 'char-nisa',
    name: 'Nisa',
    role: 'Warm & natural',
    category: 'female',
    voiceScope: 'single',
    defaultSeed: 104729,
    traits: '1 person · Female · Warm mid-register',
    description: 'One adult woman speaking alone, warm balanced mid-register voice, clear calm articulation',
    isBuiltIn: true,
  },
  {
    id: 'char-malis',
    name: 'Malis',
    role: 'Clear newsroom',
    category: 'female',
    voiceScope: 'single',
    defaultSeed: 350377,
    traits: '1 person · Female · Focused & crisp',
    description: 'One adult woman speaking alone, bright focused clear voice, steady neutral cadence',
    isBuiltIn: true,
  },
  {
    id: 'char-bopha',
    name: 'Bopha',
    role: 'Soft & gentle',
    category: 'female',
    voiceScope: 'single',
    defaultSeed: 611953,
    traits: '1 person · Female · Soft & soothing',
    description: 'One adult woman speaking alone, soft gentle airy voice, calm soothing tone',
    isBuiltIn: true,
  },
  {
    id: 'char-amber',
    name: 'Amber',
    role: 'Bright & cheerful',
    category: 'female',
    voiceScope: 'single',
    defaultSeed: 991949,
    traits: '1 person · Female · Young & lively',
    description: 'One young woman speaking alone, bright cheerful warm voice, lively clear tone',
    isBuiltIn: true,
  },
  {
    id: 'char-clara',
    name: 'Clara',
    role: 'Casual everyday',
    category: 'female',
    voiceScope: 'single',
    defaultSeed: 112291,
    traits: '1 person · Female · Relaxed & natural',
    description: 'One young woman speaking alone, natural relaxed everyday voice, steady natural tone',
    isBuiltIn: true,
  },
  {
    id: 'char-sovath',
    name: 'Sovath',
    role: 'Deep & calm',
    category: 'male',
    voiceScope: 'single',
    defaultSeed: 224737,
    traits: '1 person · Male · Deep resonant',
    description: 'One mature man speaking alone, deep resonant chest voice, calm measured pace',
    isBuiltIn: true,
  },
  {
    id: 'char-kiri',
    name: 'Kiri',
    role: 'Friendly & warm',
    category: 'male',
    voiceScope: 'single',
    defaultSeed: 479909,
    traits: '1 person · Male · Mellow & approachable',
    description: 'One adult man speaking alone, mellow friendly warm voice, gentle clear articulation',
    isBuiltIn: true,
  },
  {
    id: 'char-dara',
    name: 'Dara',
    role: 'Energetic presenter',
    category: 'male',
    voiceScope: 'single',
    defaultSeed: 746773,
    traits: '1 person · Male · Crisp & youthful',
    description: 'One young man speaking alone, crisp bright mid-register voice, confident clear tone',
    isBuiltIn: true,
  },
  {
    id: 'char-sokha',
    name: 'Sokha',
    role: 'Expressive storyteller',
    category: 'male',
    voiceScope: 'single',
    defaultSeed: 882377,
    traits: '1 person · Male · Rich baritone',
    description: 'One adult man speaking alone, rich expressive baritone voice, steady natural rhythm',
    isBuiltIn: true,
  },
  {
    id: 'char-andrew',
    name: 'Andrew',
    role: 'Wise elder',
    category: 'male',
    voiceScope: 'single',
    defaultSeed: 129970,
    traits: '1 person · Male · Older & steady',
    description: 'One older man speaking alone, warm slightly gravelly voice, unhurried steady tone',
    isBuiltIn: true,
  },
  {
    id: 'char-alicia',
    name: 'Alicia',
    role: 'Curious child',
    category: 'character',
    voiceScope: 'single',
    defaultSeed: 154858,
    traits: '1 person · Character · Light & youthful',
    description: 'One young girl character speaking alone, light high playful voice, clear articulation',
    isBuiltIn: true,
  },
  {
    id: 'char-starship',
    name: 'Starship Interface',
    role: 'Synthetic AI',
    category: 'character',
    voiceScope: 'single',
    defaultSeed: 179424,
    traits: '1 person · Character · Even synthetic pitch',
    description: 'One synthetic AI voice speaking alone, clean even pitch, calm neutral cadence',
    isBuiltIn: true,
  },
];

export const DEFAULT_CHARACTER_ID = BUILT_IN_VOICES[0].id;

/**
 * Formats a concise Narakeet-style option label for a speaking character.
 * Inputs: character entry object and optional `{ isLocked }` display flag.
 * Outputs: display label `"Name — Role"` (with `" (Locked)"` suffix when locked) or `"Name"`.
 * Side effects: none.
 * Failure modes: returns `'Unnamed character'` if input has no valid name.
 * @param {object} character - Character entry.
 * @param {{ isLocked?: boolean }} [options] - Optional label display flags.
 * @returns {string} Formatted dropdown option label.
 */
export function formatCharacterOptionLabel(character, { isLocked = false } = {}) {
  const name = typeof character?.name === 'string' ? character.name.trim() : '';
  if (!name) return 'Unnamed character';
  const role = typeof character?.role === 'string' ? character.role.trim() : '';
  const base = role ? `${name} — ${role}` : name;
  return isLocked ? `${base} (Locked)` : base;
}

/**
 * Groups characters into labeled `<optgroup>` tuples for the Character selector.
 * Inputs: combined character array (saved + built-in).
 * Outputs: non-empty `[groupLabel, characters[]]` pairs.
 * Side effects: none.
 * Failure modes: returns empty array for non-array input.
 * @param {Array<object>} characters - Combined character list.
 * @returns {Array<[string, Array<object>]>} Grouped character sections.
 */
export function groupCharactersByCategory(characters) {
  if (!Array.isArray(characters)) return [];
  const saved = characters.filter(item => !item.isBuiltIn);
  const groups = saved.length ? [['Saved characters', saved]] : [];
  for (const [key, label] of CATEGORY_GROUP_LABELS) {
    const items = characters.filter(item => item.isBuiltIn && item.category === key);
    if (items.length) groups.push([label, items]);
  }
  return groups;
}

/**
 * Finds the active character by ID or falls back safely to the default character.
 * Inputs: character array and candidate ID.
 * Outputs: matching character entity or `BUILT_IN_VOICES[0]`.
 * Side effects: none.
 * Failure modes: always returns a valid character object when `characters` is non-empty.
 * @param {Array<object>} characters - Combined character list.
 * @param {string|null|undefined} id - Selected character ID.
 * @returns {object} Resolved character entity.
 */
export function findCharacterById(characters, id) {
  const list = Array.isArray(characters) && characters.length ? characters : BUILT_IN_VOICES;
  return list.find(item => item.id === id) || list.find(item => item.id === DEFAULT_CHARACTER_ID) || list[0];
}

/**
 * Validates and normalizes a persisted saved character entry.
 * Inputs: arbitrary raw object from persistence.
 * Outputs: normalized saved character object or `null` if invalid.
 * Side effects: none.
 * Failure modes: returns `null` rather than throwing on malformed entries.
 * @param {unknown} raw - Raw entry value.
 * @returns {object|null} Normalized entry or null.
 */
export function normalizeSavedEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const description = stripParentheses(raw.description ?? raw.prompt);
  const category = VALID_CATEGORIES.has(raw.category) ? raw.category : 'female';
  if (!raw.id || !name || !description) return null;
  const role = typeof raw.role === 'string' && raw.role.trim() ? raw.role.trim() : 'Custom character';
  const traits = typeof raw.traits === 'string' && raw.traits.trim() ? raw.traits.trim() : '1 person · Saved character';
  return { id: String(raw.id), name, role, category, voiceScope: 'single', traits, description, isBuiltIn: false };
}

/**
 * Validates user input and constructs a new custom character entity.
 * Inputs: `{ name, category, description, hasVoiceClip }` and unique `id`.
 * Outputs: normalized character entry object.
 * Side effects: none.
 * Failure modes: throws ValidationError for blank/oversized name or description.
 * @param {{ name: string, category?: string, description?: string, hasVoiceClip?: boolean }} input - Raw form input.
 * @param {string} id - Unique identifier for the new entry.
 * @returns {object} Validated saved character entity.
 */
export function createSavedVoiceEntry(input, id) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name) throw new ValidationError('Enter a name for this character.', 'voiceName', 'EMPTY_VOICE_NAME');
  if (countGraphemes(name) > MAX_VOICE_NAME_LENGTH) {
    throw new ValidationError(`Character name must be under ${MAX_VOICE_NAME_LENGTH} characters.`, 'voiceName', 'VOICE_NAME_TOO_LONG');
  }
  const cleaned = stripParentheses(input?.description);
  const description = cleaned || (input?.hasVoiceClip ? DEFAULT_CLONED_DESCRIPTION : '');
  if (!description) throw new ValidationError('Describe how this person speaks or attach a voice sample.', 'description', 'EMPTY_DESCRIPTION');
  if (countGraphemes(description) > MAX_DESCRIPTION_LENGTH) {
    throw new ValidationError(`Description must be under ${MAX_DESCRIPTION_LENGTH} characters.`, 'description', 'DESCRIPTION_TOO_LONG');
  }
  const category = VALID_CATEGORIES.has(input?.category) ? input.category : 'female';
  return { id, name, role: 'Custom character', category, voiceScope: 'single', traits: '1 person · Saved character', description, isBuiltIn: false };
}

/**
 * Checks whether a single character entry satisfies active search, source, and category filters.
 * @param {object} voice - Library entry.
 * @param {{ words: string[], source: string, category: string }} criteria - Active criteria.
 * @returns {boolean} True if entry matches.
 */
function matchesCriteria(voice, { words, source, category }) {
  if (source === 'saved' && voice.isBuiltIn) return false;
  if (source === 'builtin' && !voice.isBuiltIn) return false;
  if (category && voice.category !== category) return false;
  if (words.length === 0) return true;
  const haystack = `${voice.id} ${voice.name} ${voice.role || ''} ${voice.traits} ${voice.description} ${voice.category}`.toLowerCase();
  return words.every(word => haystack.includes(word));
}

/**
 * Filters combined saved and built-in character entries by search terms, source, and category.
 * Inputs: character entry array and filter object `{ search, source, category }`.
 * Outputs: matching character entries in order.
 * Side effects: none.
 * Failure modes: returns empty array for invalid character lists.
 * @param {Array<object>} voicesList - Combined character entries.
 * @param {{ search?: string, source?: string, category?: string }} [filters] - UI filter state.
 * @returns {Array<object>} Matching entries.
 */
export function filterLibraryVoices(voicesList, filters = {}) {
  if (!Array.isArray(voicesList)) return [];
  const search = typeof filters.search === 'string' ? filters.search : '';
  const words = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const criteria = { words, source: filters.source || '', category: filters.category || '' };
  return voicesList.filter(voice => matchesCriteria(voice, criteria));
}
