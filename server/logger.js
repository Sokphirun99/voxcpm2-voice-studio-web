/**
 * @fileoverview Structured JSON logger for the Voice Studio backend storage service.
 */

const SERVICE_NAME = 'voice-studio-storage';

/**
 * Formats and emits one structured JSON log record to stdout/stderr.
 * Inputs: `{ severity, message, requestId, context }`.
 * Outputs: none.
 * Side effects: writes a single JSON line to `console.error` or `console.log`.
 * Failure modes: degrades safely if context contains circular references.
 * @param {{ severity: 'DEBUG'|'INFO'|'WARN'|'ERROR', message: string, requestId?: string, context?: Record<string, unknown> }} entry - Log payload.
 */
export function writeStructuredLog({ severity, message, requestId = 'system', context = {} }) {
  const payload = {
    timestamp: new Date().toISOString(),
    severity,
    service: SERVICE_NAME,
    requestId,
    message,
    ...context,
  };
  let line;
  try {
    line = JSON.stringify(payload);
  } catch (stringifyError) {
    line = JSON.stringify({
      timestamp: payload.timestamp,
      severity,
      service: SERVICE_NAME,
      requestId,
      message,
      serializationError: stringifyError?.message || 'Could not serialize log payload.',
    });
  }
  if (severity === 'ERROR') console.error(line);
  else console.log(line);
}

/**
 * Creates a request-scoped structured logger helper.
 * Inputs: optional default `requestId`.
 * Outputs: `{ info, warn, error, debug }` methods.
 * Side effects: writes structured JSON lines to process output.
 * Failure modes: none.
 * @param {string} [defaultRequestId='system'] - Fallback correlation ID.
 * @returns {object} Structured logger interface.
 */
export function createServerLogger(defaultRequestId = 'system') {
  return {
    debug: (message, context, requestId = defaultRequestId) => writeStructuredLog({ severity: 'DEBUG', message, requestId, context }),
    info: (message, context, requestId = defaultRequestId) => writeStructuredLog({ severity: 'INFO', message, requestId, context }),
    warn: (message, context, requestId = defaultRequestId) => writeStructuredLog({ severity: 'WARN', message, requestId, context }),
    error: (message, context, requestId = defaultRequestId) => writeStructuredLog({ severity: 'ERROR', message, requestId, context }),
  };
}
