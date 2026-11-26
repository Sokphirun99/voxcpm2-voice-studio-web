/**
 * @fileoverview Pure domain helpers for validating, normalizing, and bounding project export history records.
 */

import { ValidationError } from './errors.js';

export const MAX_EXPORT_HISTORY = 50;
export const EXPORT_HISTORY_CATEGORIES = Object.freeze(['audio', 'subtitle', 'video']);

const MAX_ENTRY_ID_LEN = 64;
const MAX_FILENAME_LEN = 180;
const MAX_CODEC_LEN = 120;
const MAX_LANG_CODE_LEN = 24;
const MAX_LANG_LABEL_LEN = 64;
const RANDOM_FALLBACK_MODULUS = 100000;

function buildExportEntryId(rawId) {
  const cleaned = typeof rawId === 'string' ? rawId.trim() : '';
  if (cleaned) return cleaned.slice(0, MAX_ENTRY_ID_LEN);
  if (typeof globalThis.crypto?.randomUUID === 'function') return `exp-${globalThis.crypto.randomUUID()}`;
  return `exp-${Date.now()}-${Math.floor(Math.random() * RANDOM_FALLBACK_MODULUS)}`;
}

/**
 * Creates a validated, immutable export history entry for project persistence.
 * Inputs: `{ id, presetId, category, label, filename, format, codec, durationSeconds, sampleRate, languageCode, languageLabel, warningsCount, exportedAt }`.
 * Outputs: Frozen export history record.
 * Side effects: none.
 * Failure modes: throws ValidationError when `filename` is missing or blank.
 * @param {object} [spec] - Export record fields.
 * @returns {Readonly<object>} Frozen export history entry.
 */
export function createExportHistoryEntry(spec = {}) {
  const filename = typeof spec.filename === 'string' ? spec.filename.trim() : '';
  if (!filename) {
    throw new ValidationError('Export history filename is required.', 'filename', 'INVALID_EXPORT_FILENAME');
  }
  const category = EXPORT_HISTORY_CATEGORIES.includes(spec.category) ? spec.category : 'audio';
  const duration = Number(spec.durationSeconds);
  const sampleRate = Number(spec.sampleRate);
  const warnings = Number(spec.warningsCount);
  return Object.freeze({
    id: buildExportEntryId(spec.id),
    presetId: typeof spec.presetId === 'string' && spec.presetId.trim() ? spec.presetId.trim() : 'custom',
    category,
    label: String(spec.label || filename).trim(),
    filename: filename.slice(0, MAX_FILENAME_LEN),
    format: String(spec.format || 'WAV').trim().toUpperCase(),
    codec: String(spec.codec || '').trim().slice(0, MAX_CODEC_LEN),
    durationSeconds: Number.isFinite(duration) && duration >= 0 ? Math.round(duration * 100) / 100 : null,
    sampleRate: Number.isFinite(sampleRate) && sampleRate > 0 ? Math.round(sampleRate) : null,
    languageCode: String(spec.languageCode || '').trim().slice(0, MAX_LANG_CODE_LEN),
    languageLabel: String(spec.languageLabel || '').trim().slice(0, MAX_LANG_LABEL_LEN),
    warningsCount: Number.isFinite(warnings) ? Math.max(0, Math.round(warnings)) : 0,
    exportedAt: typeof spec.exportedAt === 'string' && spec.exportedAt.trim() ? spec.exportedAt : new Date().toISOString(),
  });
}

/**
 * Safely normalizes and bounds persisted export history arrays across schema upgrades and API roundtrips.
 * Inputs: `rawHistory` candidate array.
 * Outputs: Frozen array of up to `MAX_EXPORT_HISTORY` valid export history records.
 * Side effects: none.
 * Failure modes: skips invalid items rather than throwing on corrupt records.
 * @param {unknown} rawHistory - Raw persisted export history value.
 * @returns {ReadonlyArray<Readonly<object>>} Normalized bounded export history.
 */
export function normalizeExportHistory(rawHistory) {
  if (!Array.isArray(rawHistory) || !rawHistory.length) return Object.freeze([]);
  const normalized = [];
  for (const item of rawHistory) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    try {
      normalized.push(createExportHistoryEntry(item));
    } catch {
      continue;
    }
    if (normalized.length >= MAX_EXPORT_HISTORY) break;
  }
  return Object.freeze(normalized);
}

/**
 * Prepends a new export record to `history`, preserving immutability and the `MAX_EXPORT_HISTORY` cap.
 * Inputs: existing `history` array and new `spec` metadata.
 * Outputs: New frozen export history array (newest first).
 * Side effects: none.
 * Failure modes: throws ValidationError when `spec.filename` is empty.
 * @param {Array<object>} [history=[]] - Existing export history.
 * @param {object} [spec] - New export record metadata.
 * @returns {ReadonlyArray<Readonly<object>>} Updated export history.
 */
export function appendExportHistory(history = [], spec = {}) {
  const entry = createExportHistoryEntry(spec);
  const existing = normalizeExportHistory(history);
  return Object.freeze([entry, ...existing].slice(0, MAX_EXPORT_HISTORY));
}
