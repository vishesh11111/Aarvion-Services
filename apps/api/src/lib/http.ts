/**
 * HTTP response conventions.
 *
 * Every successful response is `{ data, meta? }`. Every failure is
 * `{ error: { code, message, details? }, requestId }`. Clients can therefore
 * write one response parser and one error handler, forever.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface PaginationMeta {
  /** Opaque cursor for the next page; null when this is the last page. */
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
  /** Total matching rows. Omitted on large result sets — see leads.repository. */
  total?: number;
}

export const sendSuccess = <T>(res: Response, data: T, status = 200, meta?: unknown): void => {
  res.status(status).json(meta === undefined ? { data } : { data, meta });
};

export const sendNoContent = (res: Response): void => {
  res.status(204).end();
};

/**
 * Wraps an async handler so a rejected promise reaches Express' error pipeline.
 *
 * Express 4 does not await handlers: an unhandled rejection inside one becomes a
 * hung request and an `unhandledRejection` on the process. Every async route in
 * this codebase goes through here.
 */
export const asyncHandler =
  <P = unknown, ResBody = unknown, ReqBody = unknown, ReqQuery = unknown>(
    handler: (
      req: Request<P, ResBody, ReqBody, ReqQuery>,
      res: Response<ResBody>,
      next: NextFunction,
    ) => Promise<unknown>,
  ): RequestHandler<P, ResBody, ReqBody, ReqQuery> =>
  (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };

/** Best-effort client IP, honouring the trust-proxy setting configured in app.ts. */
export const clientIp = (req: Request): string =>
  (req.ip ?? req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');

export const userAgent = (req: Request): string | undefined =>
  req.get('user-agent')?.slice(0, 400);
