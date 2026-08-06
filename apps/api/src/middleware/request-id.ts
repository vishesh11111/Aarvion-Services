/**
 * Assigns a correlation id to every request and opens the AsyncLocalStorage
 * context that the logger reads from.
 *
 * An inbound `x-request-id` is honoured (so a trace spans the Next.js BFF and
 * the API) but sanitised first — it ends up in logs and in a response header,
 * and an unvalidated client-controlled string in a log file is how log-injection
 * happens.
 */
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { runWithRequestContext } from '../lib/request-context';

const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

export const requestId = (req: Request, res: Response, next: NextFunction): void => {
  const inbound = req.get('x-request-id');
  const id = inbound && SAFE_ID.test(inbound) ? inbound : randomUUID();

  req.id = id;
  res.setHeader('x-request-id', id);

  runWithRequestContext({ requestId: id }, () => next());
};
