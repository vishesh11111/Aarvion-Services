/**
 * Authentication + authorisation guards.
 *
 * `authenticate` verifies the access token and populates `req.auth`. It does not
 * hit the database: the token is short-lived and carries everything needed to
 * authorise. Revocation is handled at refresh time (≤15 minutes of lag), which
 * is the standard latency/consistency trade-off for stateless access tokens.
 * Immediate revocation is available via `revokeAllSessions` + a suspended-user
 * check, which `requireActiveUser` performs for sensitive routes.
 */
import type { NextFunction, Request, Response } from 'express';
import type { Role } from '../models';
import { UserModel, UserStatus, isValidObjectId } from '../models';
import { ACCESS_COOKIE, verifyAccessToken } from '../modules/auth/tokens';
import { assertAtLeast } from '../modules/auth/rbac';
import { ErrorCode, ForbiddenError, UnauthenticatedError } from '../lib/errors';
import { enrichRequestContext } from '../lib/request-context';
import { asyncHandler } from '../lib/http';

/**
 * Accepts either an `Authorization: Bearer` header (server-to-server, API
 * clients, the OpenAPI playground) or the httpOnly cookie set for browsers.
 */
const extractToken = (req: Request): string | null => {
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token.length > 0) return token;
  }
  const cookie = req.cookies?.[ACCESS_COOKIE];
  return typeof cookie === 'string' && cookie.length > 0 ? cookie : null;
};

export const authenticate = (req: Request, _res: Response, next: NextFunction): void => {
  const token = extractToken(req);
  if (!token) {
    next(new UnauthenticatedError('Authentication required'));
    return;
  }

  try {
    const claims = verifyAccessToken(token);
    req.auth = {
      userId: claims.sub,
      organizationId: claims.org,
      email: claims.email,
      role: claims.role,
    };
    // Makes every downstream log line attributable without extra plumbing.
    enrichRequestContext({ userId: claims.sub, organizationId: claims.org });
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Optional authentication: populates `req.auth` when a valid token is present,
 * but never rejects. Used by routes whose behaviour differs for signed-in users.
 */
export const optionalAuthenticate = (req: Request, _res: Response, next: NextFunction): void => {
  const token = extractToken(req);
  if (!token) return next();
  try {
    const claims = verifyAccessToken(token);
    req.auth = { userId: claims.sub, organizationId: claims.org, email: claims.email, role: claims.role };
    enrichRequestContext({ userId: claims.sub, organizationId: claims.org });
  } catch {
    // Ignore — the route is public.
  }
  next();
};

/** Narrowing accessor: throws rather than returning `undefined`. */
export const requireAuth = (req: Request) => {
  if (!req.auth) throw new UnauthenticatedError('Authentication required');
  return req.auth;
};

/** Guard factory for a minimum role. */
export const requireRole =
  (minimum: Role) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const auth = requireAuth(req);
      assertAtLeast(auth.role, minimum);
      next();
    } catch (error) {
      next(error);
    }
  };

/**
 * Verifies against the database that the account is still ACTIVE and still
 * belongs to the organization in the token. Costs one indexed read, so it is
 * applied only to destructive or privileged routes — not to every GET.
 */
export const requireActiveUser = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const auth = requireAuth(req);

  // A malformed id in a token would make Mongoose throw a CastError; reject it
  // as an invalid session instead, which is what it actually is.
  if (!isValidObjectId(auth.userId)) {
    throw new UnauthenticatedError('Session is no longer valid', ErrorCode.TOKEN_INVALID);
  }

  const user = await UserModel.findById(auth.userId)
    .select('status organizationId role')
    .lean();

  if (!user || String(user.organizationId) !== auth.organizationId) {
    throw new UnauthenticatedError('Session is no longer valid', ErrorCode.TOKEN_INVALID);
  }
  if (user.status !== UserStatus.ACTIVE) {
    throw new ForbiddenError('This account has been suspended');
  }
  // Role may have been downgraded since the token was minted; trust the database.
  req.auth = { ...auth, role: user.role };
  next();
});
