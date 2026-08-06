/**
 * The single exit point for every failure in the API.
 *
 * Responsibilities:
 *   1. Map known error shapes (AppError, ZodError, Mongoose/MongoDB errors,
 *      body-parser errors) onto the documented wire format.
 *   2. Log operational failures at `warn` and genuine bugs at `error`, with the
 *      stack — but never send a stack or an internal message to the client in
 *      production.
 */
import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import mongoose from 'mongoose';
import { duplicateKeyFields, isDuplicateKeyError } from '../lib/db';
import { AppError, ErrorCode, type ErrorCodeValue } from '../lib/errors';
import { logger } from '../lib/logger';
import { env } from '../config/env';

interface Normalised {
  statusCode: number;
  code: ErrorCodeValue;
  message: string;
  details?: unknown;
  retryAfterSeconds?: number;
  /** false => log the stack, it is a bug we need to fix. */
  operational: boolean;
}

/** Zod issues -> `{ field: [messages] }`, which is what form UIs actually want. */
const formatZodIssues = (error: ZodError): Record<string, string[]> => {
  const fields: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_';
    (fields[key] ??= []).push(issue.message);
  }
  return fields;
};

const normalise = (err: unknown): Normalised => {
  if (err instanceof AppError) {
    return {
      statusCode: err.statusCode,
      code: err.code,
      message: err.message,
      details: err.details,
      retryAfterSeconds: err.retryAfterSeconds,
      operational: true,
    };
  }

  if (err instanceof ZodError) {
    return {
      statusCode: 400,
      code: ErrorCode.VALIDATION_ERROR,
      message: 'Request validation failed',
      details: { fields: formatZodIssues(err) },
      operational: true,
    };
  }

  /*
   * MongoDB duplicate key (error code 11000).
   *
   * This is how the deduplication guarantee surfaces: the unique index on
   * (organizationId, dedupeKey) rejected the write. Services that care translate
   * it into a domain-specific 409 with the existing record's id; anything that
   * reaches here gets the generic form.
   */
  if (isDuplicateKeyError(err)) {
    const fields = duplicateKeyFields(err);
    return {
      statusCode: 409,
      code: ErrorCode.CONFLICT,
      message: 'A record with these values already exists',
      details: fields.length > 0 ? { fields } : undefined,
      operational: true,
    };
  }

  /** Schema-level validation (enum, required, maxlength) rejected the document. */
  if (err instanceof mongoose.Error.ValidationError) {
    const fields: Record<string, string[]> = {};
    for (const [path, issue] of Object.entries(err.errors)) {
      fields[path] = [issue.message];
    }
    return {
      statusCode: 400,
      code: ErrorCode.VALIDATION_ERROR,
      message: 'Request validation failed',
      details: { source: 'body', fields },
      operational: true,
    };
  }

  /*
   * A malformed ObjectId reached a query. Zod validates ids at the edge, so this
   * normally means an id was constructed internally — but treating it as 404 is
   * both correct from the client's perspective (that resource does not exist)
   * and avoids confirming which ids are well-formed.
   */
  if (err instanceof mongoose.Error.CastError) {
    return {
      statusCode: 404,
      code: ErrorCode.NOT_FOUND,
      message: 'Resource not found',
      operational: true,
    };
  }

  if (err instanceof mongoose.Error.DocumentNotFoundError) {
    return {
      statusCode: 404,
      code: ErrorCode.NOT_FOUND,
      message: 'Resource not found',
      operational: true,
    };
  }

  /** The driver could not reach a server, or the primary stepped down. */
  const mongoErrorName = (err as Error)?.name ?? '';
  if (
    mongoErrorName === 'MongoServerSelectionError' ||
    mongoErrorName === 'MongoNetworkError' ||
    mongoErrorName === 'MongoNotConnectedError'
  ) {
    return {
      statusCode: 503,
      code: ErrorCode.SERVICE_UNAVAILABLE,
      message: 'Database is unavailable',
      retryAfterSeconds: 15,
      operational: true,
    };
  }

  // body-parser / raw-body failures arrive as plain Errors with a `type`.
  const anyErr = err as { type?: string; status?: number; message?: string };
  if (anyErr?.type === 'entity.too.large') {
    return {
      statusCode: 413,
      code: ErrorCode.PAYLOAD_TOO_LARGE,
      message: 'Request body too large',
      operational: true,
    };
  }
  if (anyErr?.type === 'entity.parse.failed') {
    return {
      statusCode: 400,
      code: ErrorCode.BAD_REQUEST,
      message: 'Malformed JSON in request body',
      operational: true,
    };
  }

  return {
    statusCode: 500,
    code: ErrorCode.INTERNAL_ERROR,
    message: 'Internal server error',
    operational: false,
  };
};

export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // Headers already flushed (e.g. mid-stream failure) — hand back to Express,
  // which will destroy the socket. Trying to write JSON here would throw.
  if (res.headersSent) {
    next(err);
    return;
  }

  const n = normalise(err);

  const logPayload = {
    err,
    statusCode: n.statusCode,
    code: n.code,
    method: req.method,
    path: req.originalUrl,
  };

  if (n.operational) {
    logger.warn(logPayload, n.message);
  } else {
    logger.error(logPayload, 'unhandled error');
  }

  if (n.retryAfterSeconds !== undefined) {
    res.setHeader('Retry-After', String(n.retryAfterSeconds));
  }

  const exposeInternals = !env.isProduction && !n.operational;

  res.status(n.statusCode).json({
    error: {
      code: n.code,
      message: n.message,
      ...(n.details !== undefined ? { details: n.details } : {}),
      // Development affordance only. Never reachable in production.
      ...(exposeInternals ? { debug: { message: (err as Error)?.message, stack: (err as Error)?.stack } } : {}),
    },
    requestId: req.id,
  });
};

/** Terminal 404 for unmatched routes. Registered after every router. */
export const notFoundHandler = (req: Request, res: Response): void => {
  res.status(404).json({
    error: {
      code: ErrorCode.NOT_FOUND,
      message: `Cannot ${req.method} ${req.path}`,
    },
    requestId: req.id,
  });
};
