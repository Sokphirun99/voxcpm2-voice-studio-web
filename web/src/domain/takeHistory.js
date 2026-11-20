/**
 * @fileoverview Pure bounded session take-history helpers for TTS A/B comparison.
 */

export const MAX_SESSION_TAKES = 8;

/**
 * Normalizes a candidate take list into recordings carrying a non-empty string ID.
 * @param {unknown} takes - Candidate session take list.
 * @returns {object[]} Filtered take list preserving input order.
 */
function normalizeTakes(takes) {
  if (!Array.isArray(takes)) return [];
  return takes.filter(take => take && typeof take.id === 'string' && take.id.length > 0);
}

/**
 * Appends a recording to the bounded session history, replacing any duplicate ID and evicting the oldest take.
 * Inputs: current take list and the newly generated recording.
 * Outputs: new chronological take list capped at `MAX_SESSION_TAKES`.
 * Side effects: none; the input list is never mutated.
 * Failure modes: ignores recordings without a usable string ID and returns a normalized current list.
 * @param {object[]} takes - Current chronological session takes.
 * @param {object} recording - Newly generated recording.
 * @returns {object[]} Updated chronological take list.
 */
export function pushTakeHistory(takes, recording) {
  const current = normalizeTakes(takes);
  if (!recording || typeof recording.id !== 'string' || !recording.id) return current;
  const withoutDuplicate = current.filter(take => take.id !== recording.id);
  return [...withoutDuplicate, recording].slice(-MAX_SESSION_TAKES);
}

/**
 * Removes a take from session history by ID.
 * Inputs: current take list and target take ID.
 * Outputs: new take list without the matching recording.
 * Side effects: none; the input list is never mutated.
 * Failure modes: returns an unchanged copy when the ID is missing or unknown.
 * @param {object[]} takes - Current session takes.
 * @param {string} takeId - Take identifier to remove.
 * @returns {object[]} Remaining chronological takes.
 */
export function removeTakeFromHistory(takes, takeId) {
  return normalizeTakes(takes).filter(take => take.id !== takeId);
}

/**
 * Finds the selected take, falling back to the newest take when the selection is missing or stale.
 * Inputs: current take list and active take ID.
 * Outputs: matching recording, newest recording, or null for an empty history.
 * Side effects: none.
 * Failure modes: safely returns null for invalid or empty lists.
 * @param {object[]} takes - Current session takes.
 * @param {string|null} activeTakeId - Selected take identifier.
 * @returns {object|null} Active or fallback recording.
 */
export function findActiveTake(takes, activeTakeId) {
  const current = normalizeTakes(takes);
  if (current.length === 0) return null;
  return current.find(take => take.id === activeTakeId) || current[current.length - 1];
}
