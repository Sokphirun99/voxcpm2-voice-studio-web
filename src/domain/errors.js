/**
 * @fileoverview Typed structured error classes for domain validation, synthesis, and storage.
 */

/**
 * Error thrown when user-supplied generation or voice-library inputs fail domain validation.
 */
export class ValidationError extends Error {
  /**
   * Creates a ValidationError.
   * Inputs: human-readable message, field key, optional machine code.
   * Outputs: ValidationError instance.
   * Side effects: none.
   * Failure modes: none.
   * @param {string} message - User-facing validation message.
   * @param {string} field - Associated input field name.
   * @param {string} [code='VALIDATION_ERROR'] - Machine error code.
   */
  constructor(message, field, code = 'VALIDATION_ERROR') {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.code = code;
  }
}

/**
 * Error thrown when speech synthesis or reference upload fails.
 */
export class SynthesisError extends Error {
  /**
   * Creates a SynthesisError.
   * Inputs: human-readable message and metadata `{ code, status, cause }`.
   * Outputs: SynthesisError instance.
   * Side effects: none.
   * Failure modes: none.
   * @param {string} message - User-facing error message free of stack traces.
   * @param {{ code?: string, status?: number, cause?: unknown }} [meta] - Failure metadata.
   */
  constructor(message, meta = {}) {
    super(message, { cause: meta.cause });
    this.name = 'SynthesisError';
    this.code = meta.code || 'SYNTHESIS_FAILED';
    this.status = meta.status;
  }
}

/**
 * Error thrown when an in-flight synthesis request is cancelled by the user.
 */
export class SynthesisCancelledError extends Error {
  /**
   * Creates a SynthesisCancelledError.
   * Inputs: optional cancellation message.
   * Outputs: SynthesisCancelledError instance.
   * Side effects: none.
   * Failure modes: none.
   * @param {string} [message='Generation cancelled.'] - Status notice.
   */
  constructor(message = 'Generation cancelled.') {
    super(message);
    this.name = 'SynthesisCancelledError';
    this.code = 'CANCELLED';
  }
}

/**
 * Error thrown when voice library persistence fails.
 */
export class StorageError extends Error {
  /**
   * Creates a StorageError.
   * Inputs: human-readable message and optional underlying cause.
   * Outputs: StorageError instance.
   * Side effects: none.
   * Failure modes: none.
   * @param {string} message - User-facing storage error.
   * @param {unknown} [cause] - Caught cause.
   */
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'StorageError';
    this.code = 'STORAGE_ERROR';
  }
}
