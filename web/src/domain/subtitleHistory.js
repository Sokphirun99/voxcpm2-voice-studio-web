/**
 * @fileoverview Pure domain bounded Undo/Redo history stack for subtitle text, translation, speaker, and timeline edits.
 */

export const MAX_SUBTITLE_HISTORY_ENTRIES = 100;
export const UNDO_TYPING_COALESCE_MS = 800;

/**
 * Creates a clean empty Undo/Redo history structure.
 * Inputs: none.
 * Outputs: Frozen empty history object `{ past, future, lastEditMeta }`.
 * Side effects: none.
 * Failure modes: none.
 * @returns {Readonly<{ past: readonly object[], future: readonly object[], lastEditMeta: object|null }>} Empty history.
 */
export function createEmptySubtitleHistory() {
  return Object.freeze({
    past: Object.freeze([]),
    future: Object.freeze([]),
    lastEditMeta: null,
  });
}

/**
 * Captures an immutable snapshot of undoable subtitle workspace state.
 * Inputs: `{ segments, hasTranslation, translatedLanguage }`.
 * Outputs: Frozen history snapshot object.
 * Side effects: none.
 * Failure modes: coerces missing fields safely to empty defaults.
 * @param {object} [state={}] - Current subtitle state slice.
 * @returns {Readonly<{ segments: object[], hasTranslation: boolean, translatedLanguage: string }>} Snapshot.
 */
export function createSubtitleHistorySnapshot(state = {}) {
  return Object.freeze({
    segments: Array.isArray(state?.segments) ? state.segments : [],
    hasTranslation: Boolean(state?.hasTranslation),
    translatedLanguage: typeof state?.translatedLanguage === 'string' ? state.translatedLanguage : '',
  });
}

/**
 * Clears the typing-burst coalesce marker so the next edit creates a distinct Undo step.
 * Inputs: current history object.
 * Outputs: Updated history object with `lastEditMeta: null`.
 * Side effects: none.
 * Failure modes: returns an empty history if input is invalid.
 * @param {object|null|undefined} history - Current history state.
 * @returns {object} History with cleared coalesce marker.
 */
export function clearSubtitleHistoryCoalesce(history) {
  if (!history || typeof history !== 'object') return createEmptySubtitleHistory();
  if (!history.lastEditMeta) return history;
  return Object.freeze({ ...history, lastEditMeta: null });
}

function areSnapshotsEqual(a, b) {
  return a.segments === b.segments
    && a.hasTranslation === b.hasTranslation
    && a.translatedLanguage === b.translatedLanguage;
}

function shouldCoalesceBurst({ history, coalesceKey, now, coalesceWindowMs }) {
  if (!coalesceKey || !history.past.length) return false;
  const meta = history.lastEditMeta;
  if (!meta || meta.key !== coalesceKey) return false;
  return (now - meta.timestamp) >= 0 && (now - meta.timestamp) <= coalesceWindowMs;
}

/**
 * Pushes the pre-edit snapshot onto `past` (with optional typing-burst coalescing) and clears `future`.
 * Inputs: `history`, `prevState`, `nextState`, and optional `{ coalesceKey, now, maxEntries, coalesceWindowMs }`.
 * Outputs: Updated frozen history object.
 * Side effects: none.
 * Failure modes: returns `history` unchanged when `prevState` and `nextState` are identical.
 * @param {object|null|undefined} history - Current history state.
 * @param {object} prevState - State before mutation.
 * @param {object} nextState - State after mutation.
 * @param {{ coalesceKey?: string|null, now?: number, maxEntries?: number, coalesceWindowMs?: number }} [options] - Coalesce options.
 * @returns {object} Updated history state.
 */
export function pushSubtitleHistoryEntry(history, prevState, nextState, options = {}) {
  const safeHistory = history && Array.isArray(history.past) && Array.isArray(history.future)
    ? history
    : createEmptySubtitleHistory();
  const prevSnap = createSubtitleHistorySnapshot(prevState);
  const nextSnap = createSubtitleHistorySnapshot(nextState);
  if (areSnapshotsEqual(prevSnap, nextSnap)) return safeHistory;
  const {
    coalesceKey = null,
    now = Date.now(),
    maxEntries = MAX_SUBTITLE_HISTORY_ENTRIES,
    coalesceWindowMs = UNDO_TYPING_COALESCE_MS,
  } = options;
  const nextMeta = coalesceKey ? Object.freeze({ key: coalesceKey, timestamp: now }) : null;
  if (shouldCoalesceBurst({ history: safeHistory, coalesceKey, now, coalesceWindowMs })) {
    return Object.freeze({ past: safeHistory.past, future: Object.freeze([]), lastEditMeta: nextMeta });
  }
  const cap = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : MAX_SUBTITLE_HISTORY_ENTRIES;
  const nextPast = Object.freeze([...safeHistory.past, prevSnap].slice(-cap));
  return Object.freeze({ past: nextPast, future: Object.freeze([]), lastEditMeta: nextMeta });
}

function mergeLiveTakesOntoRestoredSegment(restoredSeg, liveSeg) {
  if (!liveSeg) return restoredSeg;
  const hasLiveTakes = Array.isArray(liveSeg.takes) && liveSeg.takes.length > 0;
  const hasSnapTakes = Array.isArray(restoredSeg.takes) && restoredSeg.takes.length > 0;
  if (liveSeg.takes === restoredSeg.takes || (!hasLiveTakes && !hasSnapTakes)) return restoredSeg;
  const liveTakes = hasLiveTakes ? liveSeg.takes : [];
  const nextStatus = hasLiveTakes
    ? 'ready'
    : (restoredSeg.status === 'ready' ? 'draft' : restoredSeg.status);
  return {
    ...restoredSeg,
    takes: liveTakes,
    ...(hasLiveTakes && liveSeg.voiceId !== undefined ? { voiceId: liveSeg.voiceId } : {}),
    ...(nextStatus !== undefined ? { status: nextStatus } : {}),
  };
}

/**
 * Reconciles persisted voice takes from live segments onto restored segments so text/timeline Undo/Redo never discards generated audio takes.
 * Inputs: `targetSegments` (from history) and `liveSegments` (current workspace segments).
 * Outputs: Segment array preserving live takes for existing cue IDs and snapshot takes for resurrected cues.
 * Side effects: none.
 * Failure modes: returns `[]` for invalid `targetSegments`.
 * @param {Array<object>} targetSegments - Segments from Undo/Redo target snapshot.
 * @param {Array<object>} liveSegments - Current live segments.
 * @returns {Array<object>} Reconciled segment list.
 */
export function restoreSubtitleSnapshotTakes(targetSegments, liveSegments) {
  if (!Array.isArray(targetSegments)) return [];
  const liveById = new Map((Array.isArray(liveSegments) ? liveSegments : []).map(seg => [seg?.id, seg]));
  return targetSegments.map(seg => mergeLiveTakesOntoRestoredSegment(seg, liveById.get(seg?.id)));
}

function stepSubtitleHistory(history, currentState, direction) {
  const safe = history && Array.isArray(history.past) && Array.isArray(history.future)
    ? history
    : createEmptySubtitleHistory();
  const source = direction === 'undo' ? safe.past : safe.future;
  const opposite = direction === 'undo' ? safe.future : safe.past;
  if (!source.length) return { applied: false, history: safe, snapshot: null };
  const target = source[source.length - 1];
  const nextSource = Object.freeze(source.slice(0, -1));
  const currentSnap = createSubtitleHistorySnapshot(currentState);
  const nextOpposite = Object.freeze([...opposite, currentSnap].slice(-MAX_SUBTITLE_HISTORY_ENTRIES));
  const nextHistory = Object.freeze({
    past: direction === 'undo' ? nextSource : nextOpposite,
    future: direction === 'undo' ? nextOpposite : nextSource,
    lastEditMeta: null,
  });
  const snapshot = Object.freeze({
    ...target,
    segments: restoreSubtitleSnapshotTakes(target.segments, currentState?.segments),
  });
  return { applied: true, history: nextHistory, snapshot };
}

/**
 * Applies one Undo step against the subtitle history stack.
 * Inputs: `history` and `currentState` (`{ segments, hasTranslation, translatedLanguage }`).
 * Outputs: `{ applied, history, snapshot }`.
 * Side effects: none.
 * Failure modes: returns `{ applied: false, history, snapshot: null }` when Undo stack is empty.
 * @param {object|null|undefined} history - Current history state.
 * @param {object} currentState - Current subtitle workspace state.
 * @returns {{ applied: boolean, history: object, snapshot: object|null }} Undo result.
 */
export function undoSubtitleHistory(history, currentState) {
  return stepSubtitleHistory(history, currentState, 'undo');
}

/**
 * Applies one Redo step against the subtitle history stack.
 * Inputs: `history` and `currentState` (`{ segments, hasTranslation, translatedLanguage }`).
 * Outputs: `{ applied, history, snapshot }`.
 * Side effects: none.
 * Failure modes: returns `{ applied: false, history, snapshot: null }` when Redo stack is empty.
 * @param {object|null|undefined} history - Current history state.
 * @param {object} currentState - Current subtitle workspace state.
 * @returns {{ applied: boolean, history: object, snapshot: object|null }} Redo result.
 */
export function redoSubtitleHistory(history, currentState) {
  return stepSubtitleHistory(history, currentState, 'redo');
}
