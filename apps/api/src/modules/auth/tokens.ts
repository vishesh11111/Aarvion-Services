/**
 * Token minting, verification and cookie transport.
 *
 * Design:
 *   • Access token — short-lived (15m) stateless JWT. Carries tenant + role so
 *     the hot path needs zero database round-trips to authorise a request.
 *   • Refresh token — long-lived (30d), opaque to the client, stored *hashed*
 *     in MongoDB and rotated on every use. A database read on refresh is fine;
 *     it happens once per 15 minutes per session.
 *
 * Rotation + reuse detection: each refresh belongs to a `familyId`. Presenting a
 * token that has already been rotated means the token was captured, so the whole
 * family is revoked and every session in that chain dies. This is the standard
 * mitigation from OAuth 2.0 BCP §4.13.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';
import type { CookieOptions, Response } from 'express';
import type { Role } from '../../models';
import { env } from '../../config/env';
import { ErrorCode, UnauthenticatedError } from '../../lib/errors';

const ISSUER = 'aarvion-crm';
const AUDIENCE = 'aarvion-crm-api';

export const ACCESS_COOKIE = 'aarvion_at';
export const REFRESH_COOKIE = 'aarvion_rt';
/**
 * Non-sensitive session hint, readable by JavaScript and by the Next.js edge
 * middleware. Contains no credential — only the fact that a session exists and
 * when it expires — so the frontend can route optimistically instead of
 * flashing the login page every time the 15-minute access cookie lapses.
 * Forging it grants nothing: the API still requires a real access token.
 */
export const SESSION_HINT_COOKIE = 'aarvion_sid';

export interface AccessTokenClaims {
  sub: string;
  org: string;
  email: string;
  role: Role;
}

/** Intersection, not `extends`: JwtPayload declares `sub?: string` while our
 *  claims require it, and an interface cannot narrow an inherited property. */
type AccessJwtPayload = JwtPayload & AccessTokenClaims;

export const signAccessToken = (claims: AccessTokenClaims): string =>
  jwt.sign(claims, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL,
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithm: 'HS256',
  } as SignOptions);

/**
 * Verifies an access token.
 *
 * `algorithms` is pinned explicitly. Without it, jsonwebtoken would accept any
 * algorithm named in the token header — the classic `alg: none` / HS-vs-RS
 * confusion attack.
 */
export const verifyAccessToken = (token: string): AccessTokenClaims => {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    }) as AccessJwtPayload;

    if (!payload.sub || !payload.org || !payload.role) {
      throw new UnauthenticatedError('Malformed token', ErrorCode.TOKEN_INVALID);
    }
    return { sub: payload.sub, org: payload.org, email: payload.email, role: payload.role };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new UnauthenticatedError('Access token expired', ErrorCode.TOKEN_EXPIRED);
    }
    if (error instanceof UnauthenticatedError) throw error;
    throw new UnauthenticatedError('Invalid access token', ErrorCode.TOKEN_INVALID);
  }
};

/* -------------------------------------------------------------------------- */
/* Refresh tokens                                                             */
/* -------------------------------------------------------------------------- */

/**
 * 256 bits of CSPRNG entropy, base64url encoded. Deliberately *not* a JWT: an
 * opaque random string cannot be forged even if a signing secret leaks, and it
 * carries no claims to go stale.
 */
export const generateRefreshToken = (): string => randomBytes(32).toString('base64url');

/**
 * Refresh tokens are stored as SHA-256 digests. bcrypt is unnecessary here —
 * the token already has full entropy, so there is nothing to brute-force, and
 * SHA-256 keeps the lookup a single indexed equality scan.
 */
export const hashRefreshToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** Constant-time comparison for any secret we compare in-process. */
export const safeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
};

/** `30d` / `15m` / `900` -> milliseconds. */
export const parseDuration = (value: string): number => {
  const match = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2] ?? 's';
  const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return amount * (multipliers[unit] ?? 1000);
};

export const refreshTokenTtlMs = (): number => parseDuration(env.JWT_REFRESH_TTL);
export const accessTokenTtlMs = (): number => parseDuration(env.JWT_ACCESS_TTL);

/* -------------------------------------------------------------------------- */
/* Cookie transport                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Tokens travel in httpOnly cookies, not in a JSON body the SPA stores in
 * localStorage. localStorage is readable by any XSS payload; an httpOnly cookie
 * is not. CSRF is handled by SameSite plus the fact that every mutating route
 * requires a JSON content type and a CORS-allowed origin.
 */
const cookieBase = (): CookieOptions => ({
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: env.COOKIE_SAMESITE,
  path: '/',
  ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
});

export const setAuthCookies = (res: Response, accessToken: string, refreshToken: string): void => {
  res.cookie(ACCESS_COOKIE, accessToken, { ...cookieBase(), maxAge: accessTokenTtlMs() });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...cookieBase(),
    maxAge: refreshTokenTtlMs(),
    // Scope the refresh cookie to the endpoints that consume it so it is not
    // attached to every ordinary API call.
    path: '/api/v1/auth',
  });
  res.cookie(SESSION_HINT_COOKIE, String(Date.now() + refreshTokenTtlMs()), {
    ...cookieBase(),
    httpOnly: false,
    maxAge: refreshTokenTtlMs(),
  });
};

export const clearAuthCookies = (res: Response): void => {
  res.clearCookie(ACCESS_COOKIE, { ...cookieBase() });
  res.clearCookie(REFRESH_COOKIE, { ...cookieBase(), path: '/api/v1/auth' });
  res.clearCookie(SESSION_HINT_COOKIE, { ...cookieBase(), httpOnly: false });
};
