/**
 * Schema validation middleware.
 *
 * Validated values are written back onto the request, so handlers consume
 * parsed, coerced, typed data — `req.query.page` is a number, not a string, and
 * unknown keys have been stripped (mass-assignment protection comes for free).
 */
import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { ValidationError } from '../lib/errors';

export interface RequestSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

const formatIssues = (error: ZodError, source: keyof RequestSchemas) => {
  const fields: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : source;
    (fields[key] ??= []).push(issue.message);
  }
  return { source, fields };
};

export const validate =
  (schemas: RequestSchemas) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params) as typeof req.params;
      if (schemas.query) {
        // Express 5 makes req.query a getter; assigning via defineProperty keeps
        // this middleware forward-compatible with both major versions.
        const parsed = schemas.query.parse(req.query);
        Object.defineProperty(req, 'query', { value: parsed, writable: true, configurable: true });
      }
      if (schemas.body) req.body = schemas.body.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const source: keyof RequestSchemas = schemas.body
          ? 'body'
          : schemas.query
            ? 'query'
            : 'params';
        next(new ValidationError('Request validation failed', formatIssues(error, source)));
        return;
      }
      next(error);
    }
  };

/** Convenience type: infers the handler's body type from its schema. */
export type Infer<T extends ZodTypeAny> = z.infer<T>;
