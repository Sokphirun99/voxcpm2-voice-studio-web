/**
 * @fileoverview Pure domain parsing, clamping, stripping, and masking for inline TTS `[pause ...]` markers.
 */

export const MIN_PAUSE_MS = 100;
export const MAX_PAUSE_MS = 5000;
export const PAUSE_MARKER_SOURCE = String.raw`\[\s*pause\s+(\d+(?:\.\d+)?|\.\d+)\s*(ms|s)\s*\]`;

const MS_PER_SECOND = 1000;
const MARKER_TOKEN_BASE = 0xE100;
const MAX_PRESERVED_MARKERS = 512;

/**
 * Clamps a pause duration strictly into the supported `100ms..5000ms` window as whole milliseconds.
 * Inputs: numeric pause duration in milliseconds.
 * Outputs: integer milliseconds in `[100, 5000]`.
 * Side effects: none.
 * Failure modes: non-finite values clamp to `MIN_PAUSE_MS`.
 * @param {number} ms - Requested pause in milliseconds.
 * @returns {number} Clamped integer milliseconds.
 */
export function clampPauseMs(ms) {
  if (!Number.isFinite(ms)) return MIN_PAUSE_MS;
  return Math.min(MAX_PAUSE_MS, Math.max(MIN_PAUSE_MS, Math.round(ms)));
}

/**
 * Converts a matched pause marker amount and unit (`s` or `ms`) into clamped milliseconds.
 * Inputs: numeric amount string and unit string (`s` or `ms`, case-insensitive).
 * Outputs: clamped integer milliseconds in `[100, 5000]`.
 * Side effects: none.
 * Failure modes: unparseable amounts clamp to `MIN_PAUSE_MS`.
 * @param {string} amount - Numeric text such as `0.5` or `800`.
 * @param {string} unit - Time unit (`s` or `ms`).
 * @returns {number} Clamped pause in milliseconds.
 */
export function parsePauseMarkerMs(amount, unit) {
  const value = Number.parseFloat(amount);
  const rawMs = String(unit || '').toLowerCase() === 's' ? value * MS_PER_SECOND : value;
  return clampPauseMs(rawMs);
}

/**
 * Checks whether text contains at least one valid inline `[pause ...]` marker.
 * Inputs: candidate script text.
 * Outputs: boolean indicating presence of a pause marker.
 * Side effects: none.
 * Failure modes: returns false for non-string input.
 * @param {unknown} text - Candidate text.
 * @returns {boolean} True when a valid pause marker is present.
 */
export function hasPauseMarkers(text) {
  return typeof text === 'string' && new RegExp(PAUSE_MARKER_SOURCE, 'i').test(text);
}

/**
 * Removes every valid inline `[pause ...]` marker so literal tag text never reaches speech synthesis or verification.
 * Inputs: script or chunk text.
 * Outputs: marker-free text with collapsed inline spaces and trimmed lines.
 * Side effects: none.
 * Failure modes: returns `''` for non-string input; unrecognized bracket text stays intact.
 * @param {unknown} text - Text possibly containing pause markers.
 * @returns {string} Marker-free text.
 */
export function stripPauseMarkers(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(new RegExp(PAUSE_MARKER_SOURCE, 'gi'), ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * Runs `transform` on `text` while shielding valid `[pause ...]` tags from accidental text rewrites.
 * Inputs: source text and pure string `transform` callback.
 * Outputs: transformed string with original pause markers restored verbatim.
 * Side effects: none.
 * Failure modes: skips masking when no pause markers are present; caps preserved markers at 512.
 * @param {string} text - Input script text.
 * @param {(masked: string) => string} transform - Pure transformation applied outside pause markers.
 * @returns {string} Transformed string with pause markers preserved.
 */
export function preservePauseMarkers(text, transform) {
  if (typeof text !== 'string' || !text || !hasPauseMarkers(text)) return transform(text);
  const tokens = [];
  let nextCode = MARKER_TOKEN_BASE;
  const masked = text.replace(new RegExp(PAUSE_MARKER_SOURCE, 'gi'), marker => {
    while (text.includes(String.fromCodePoint(nextCode))) nextCode += 1;
    if (tokens.length >= MAX_PRESERVED_MARKERS) return marker;
    const token = String.fromCodePoint(nextCode++);
    tokens.push([token, marker]);
    return token;
  });
  let restored = transform(masked);
  for (const [token, marker] of tokens) restored = restored.replace(token, () => marker);
  return restored;
}
