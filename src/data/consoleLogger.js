/**
 * @fileoverview Structured JSON console adapter implementing the domain LoggerPort.
 */

const SERVICE_NAME = 'voice-studio';

/**
 * Formats an unknown caught error into a readable message string.
 * @param {unknown} error - Caught error value or string.
 * @returns {string} Message text.
 */
function formatErrorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

/**
 * Writes a structured JSON log record to the matching console method.
 * @param {'DEBUG'|'INFO'|'WARN'|'ERROR'} severity - Log severity.
 * @param {string} location - Module/function origin.
 * @param {string} message - Short event summary.
 * @param {Record<string, unknown>} [context] - Safe metadata excluding secrets and user text.
 */
function emitLog(severity, location, message, context = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    severity,
    service: SERVICE_NAME,
    location,
    message,
    ...context,
  };
  const writer = severity === 'ERROR' ? console.error : severity === 'WARN' ? console.warn : console.debug;
  try {
    writer(JSON.stringify(entry));
  } catch {
    writer(`${entry.timestamp} [${severity}] ${location}: ${message}`);
  }
}

/**
 * Creates a structured JSON LoggerPort backed by browser console.
 * Inputs: none.
 * Outputs: LoggerPort `{ debug, warn, error }`.
 * Side effects: logs JSON lines to `console`.
 * Failure modes: never throws.
 * @returns {import('../domain/ports.js').LoggerPort & { warn: Function }} Logger instance.
 */
export function createConsoleLogger() {
  return {
    debug(location, message, context = {}) {
      emitLog('DEBUG', location, message, context);
    },
    warn(location, message, context = {}) {
      emitLog('WARN', location, message, context);
    },
    error(location, error, context = {}) {
      emitLog('ERROR', location, formatErrorMessage(error), context);
    },
  };
}
