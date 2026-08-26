/**
 * A single error taxonomy for the whole platform.
 *
 * Errors carry the HTTP status, a stable machine code, and whether a retry is
 * worth attempting — the agent loop and the AI gateway both branch on that flag
 * so that expensive model calls are never blindly retried.
 */

export class AppError extends Error {
  constructor(message, { status = 500, code = 'internal_error', retryable = false, details = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

export const badRequest = (message, details) => new AppError(message, { status: 400, code: 'bad_request', details });
export const unauthorized = (message = 'Authentication required') => new AppError(message, { status: 401, code: 'unauthorized' });
export const forbidden = (message = 'You do not have access to this resource') => new AppError(message, { status: 403, code: 'forbidden' });
export const notFound = (message = 'Not found') => new AppError(message, { status: 404, code: 'not_found' });
export const conflict = (message, details) => new AppError(message, { status: 409, code: 'conflict', details });
export const payloadTooLarge = (message = 'Request body is too large') => new AppError(message, { status: 413, code: 'payload_too_large' });
export const validationFailed = (details) => new AppError('Request validation failed', { status: 422, code: 'validation_failed', details });
export const rateLimited = (message, details) => new AppError(message, { status: 429, code: 'rate_limited', retryable: true, details });
export const quotaExceeded = (message, details) => new AppError(message, { status: 402, code: 'quota_exceeded', details });
export const notConfigured = (what) => new AppError(`${what} is not configured on this deployment`, { status: 503, code: 'not_configured' });
export const upstreamFailed = (message, details) => new AppError(message, { status: 502, code: 'upstream_failed', retryable: true, details });
export const timedOut = (message = 'Operation timed out') => new AppError(message, { status: 504, code: 'timeout', retryable: true });
export const cancelled = (message = 'Operation was cancelled') => new AppError(message, { status: 499, code: 'cancelled' });

/** Normalise anything thrown anywhere into an AppError. */
export function toAppError(error) {
  if (error instanceof AppError) return error;
  if (error?.name === 'AbortError') return cancelled();
  return new AppError(error?.message || 'Unexpected error', { status: 500, code: 'internal_error', cause: error });
}

export default AppError;
