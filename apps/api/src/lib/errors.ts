/**
 * Error taxonomy.
 *
 * Every failure the API can produce is one of these. The error handler
 * (`middleware/error-handler.ts`) is the single place that turns them into HTTP
 * responses, so the wire format is guaranteed consistent:
 *
 *   { "error": { "code": "LEAD_NOT_FOUND", "message": "...", "details": {...} },
 *     "requestId": "..." }
 *
 * `code` is a stable machine-readable string. Clients branch on `code`, never on
 * `message` — messages are for humans and may be reworded at any time.
 */

/** Stable, documented error codes. Additive changes only. */
export const ErrorCode = {
  // 400
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
  INVALID_FILE: 'INVALID_FILE',
  // 401
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  // 403
  FORBIDDEN: 'FORBIDDEN',
  INSUFFICIENT_ROLE: 'INSUFFICIENT_ROLE',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  // 404
  NOT_FOUND: 'NOT_FOUND',
  // 409
  CONFLICT: 'CONFLICT',
  DUPLICATE_LEAD: 'DUPLICATE_LEAD',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  // 413 / 415
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  // 422
  UNPROCESSABLE: 'UNPROCESSABLE',
  // 429
  RATE_LIMITED: 'RATE_LIMITED',
  AI_QUOTA_EXCEEDED: 'AI_QUOTA_EXCEEDED',
  // 500 / 502 / 503
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  AI_PROVIDER_ERROR: 'AI_PROVIDER_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface AppErrorOptions {
  /** Structured, client-safe context (field errors, retry hints, ...). */
  details?: unknown;
  /** Underlying error, logged but never serialised to the client. */
  cause?: unknown;
  /** Seconds the client should wait before retrying. Emits Retry-After. */
  retryAfterSeconds?: number;
}

/**
 * Base class for every *expected* failure. Anything that isn't an AppError is
 * treated as a bug: logged at `error` level and reported as 500 with a generic
 * message, so internal details never leak to callers.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCodeValue;
  readonly details?: unknown;
  readonly retryAfterSeconds?: number;
  /** Expected errors are logged at warn; unexpected ones at error. */
  readonly isOperational = true;

  constructor(
    statusCode: number,
    code: ErrorCodeValue,
    message: string,
    options: AppErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    if (options.details !== undefined) this.details = options.details;
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
    Error.captureStackTrace?.(this, new.target);
  }
}

/* -------------------------------------------------------------------------- */
/* Concrete errors — thin constructors so call sites read as prose.            */
/* -------------------------------------------------------------------------- */

export class ValidationError extends AppError {
  constructor(message = 'Request validation failed', details?: unknown) {
    super(400, ErrorCode.VALIDATION_ERROR, message, { details });
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, code: ErrorCodeValue = ErrorCode.BAD_REQUEST, details?: unknown) {
    super(400, code, message, { details });
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication required', code: ErrorCodeValue = ErrorCode.UNAUTHENTICATED) {
    super(401, code, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action', details?: unknown) {
    super(403, ErrorCode.FORBIDDEN, message, { details });
  }
}

export class InsufficientRoleError extends AppError {
  constructor(required: string[], actual: string) {
    super(403, ErrorCode.INSUFFICIENT_ROLE, `This action requires one of: ${required.join(', ')}`, {
      details: { requiredRoles: required, yourRole: actual },
    });
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource', code: ErrorCodeValue = ErrorCode.NOT_FOUND) {
    super(404, code, `${resource} not found`);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code: ErrorCodeValue = ErrorCode.CONFLICT, details?: unknown) {
    super(409, code, message, { details });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(limitBytes: number) {
    super(413, ErrorCode.PAYLOAD_TOO_LARGE, `Upload exceeds the ${limitBytes} byte limit`, {
      details: { limitBytes },
    });
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(accepted: string[]) {
    super(415, ErrorCode.UNSUPPORTED_MEDIA_TYPE, `Unsupported file type. Accepted: ${accepted.join(', ')}`, {
      details: { accepted },
    });
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfterSeconds: number, code: ErrorCodeValue = ErrorCode.RATE_LIMITED) {
    super(429, code, 'Too many requests — slow down', { retryAfterSeconds });
  }
}

export class AiProviderError extends AppError {
  constructor(message = 'The AI provider is unavailable', details?: unknown) {
    super(502, ErrorCode.AI_PROVIDER_ERROR, message, { details });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable', retryAfterSeconds = 30) {
    super(503, ErrorCode.SERVICE_UNAVAILABLE, message, { retryAfterSeconds });
  }
}

/** Narrowing helper used by the error handler and by tests. */
export const isAppError = (error: unknown): error is AppError =>
  error instanceof AppError || (error instanceof Error && (error as AppError).isOperational === true);
