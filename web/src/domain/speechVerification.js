/**
 * @fileoverview Pure domain helpers for Whisper Khmer speech verification badges and language detection.
 */

const KHMER_SCRIPT_PATTERN = /[\u1780-\u17FF]/;

const VERIFY_REASON_LABELS = Object.freeze({
  whisper_fallback: 'Whisper recovery',
  high_oov: 'Whisper check',
  double_check: 'Whisper double-check',
});

/**
 * Checks whether a text string contains any Khmer Unicode script characters.
 * Inputs: arbitrary `text` string.
 * Outputs: boolean.
 * Side effects: none.
 * Failure modes: returns `false` for non-string or empty input.
 * @param {unknown} text - Candidate script or subtitle text.
 * @returns {boolean} True when Khmer characters are present.
 */
export function hasKhmerScript(text) {
  return typeof text === 'string' && KHMER_SCRIPT_PATTERN.test(text);
}

/**
 * Selects `'km'` when text contains Khmer script and `'auto'` otherwise for round-trip speech QA.
 * Inputs: `text` script string.
 * Outputs: `'km'` or `'auto'`.
 * Side effects: none.
 * Failure modes: defaults to `'km'` when blank.
 * @param {unknown} text - Expected spoken script.
 * @returns {'km' | 'auto'} Verification ASR language code.
 */
export function resolveVerificationLanguage(text) {
  if (typeof text !== 'string' || !text.trim()) return 'km';
  return hasKhmerScript(text) ? 'km' : 'auto';
}

/**
 * Formats a `/verify-speech` response into an accessible badge tone, integer percentage, and label.
 * Inputs: `{ verdict, similarity }` verification payload.
 * Outputs: `{ tone, percent, label }`.
 * Side effects: none.
 * Failure modes: degrades safely to `{ tone: 'fail', percent: 0, label: 'Mismatch · 0%' }` on invalid numbers.
 * @param {{ verdict?: string, similarity?: number }|null} result - Verification API payload.
 * @returns {{ tone: 'pass' | 'warn' | 'fail', percent: number, label: string }} Formatted summary badge.
 */
export function formatVerificationSummary(result) {
  const raw = Number(result?.similarity);
  const clamped = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
  const percent = Math.round(clamped * 100);
  const verdict = result?.verdict;
  if (verdict === 'pass') return { tone: 'pass', percent, label: `Verified · ${percent}%` };
  if (verdict === 'warn') return { tone: 'warn', percent, label: `Check pronunciation · ${percent}%` };
  return { tone: 'fail', percent, label: `Mismatch · ${percent}%` };
}

/**
 * Maps a segment `verifyReason` code into a concise UI chip label.
 * Inputs: `reason` string from `/transcribe` segment metadata.
 * Outputs: display label string.
 * Side effects: none.
 * Failure modes: defaults to `'Whisper suggestion'` for unknown reasons.
 * @param {string} reason - Backend verification reason code.
 * @returns {string} Concise human-readable label.
 */
export function formatVerifyReasonLabel(reason) {
  return VERIFY_REASON_LABELS[reason] || 'Whisper suggestion';
}
