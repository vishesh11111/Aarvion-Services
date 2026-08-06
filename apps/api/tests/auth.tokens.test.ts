/**
 * Token minting, verification and hashing.
 *
 * The negative cases matter more than the positive ones here: a token layer that
 * accepts what it should reject fails silently and completely.
 */
import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { Role } from '../src/models';
import {
  generateRefreshToken,
  hashRefreshToken,
  parseDuration,
  safeEqual,
  signAccessToken,
  verifyAccessToken,
} from '../src/modules/auth/tokens';
import { UnauthenticatedError } from '../src/lib/errors';

const claims = {
  sub: 'user-1',
  org: 'org-1',
  email: 'jane@acme.com',
  role: Role.ADMIN,
};

describe('access tokens', () => {
  it('round-trips the claims', () => {
    const verified = verifyAccessToken(signAccessToken(claims));
    expect(verified).toEqual(claims);
  });

  it('rejects a token signed with a different secret', () => {
    const forged = jwt.sign(claims, 'a-completely-different-secret-value-here', {
      issuer: 'aarvion-crm',
      audience: 'aarvion-crm-api',
    });
    expect(() => verifyAccessToken(forged)).toThrow(UnauthenticatedError);
  });

  it('rejects an unsigned token', () => {
    // `alg: none` is the canonical JWT bypass. Pinning `algorithms: ['HS256']`
    // at verification is what stops it.
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`;
    expect(() => verifyAccessToken(unsigned)).toThrow(UnauthenticatedError);
  });

  it('rejects a token issued for a different audience', () => {
    const wrongAudience = jwt.sign(claims, process.env.JWT_ACCESS_SECRET!, {
      issuer: 'aarvion-crm',
      audience: 'some-other-service',
    });
    expect(() => verifyAccessToken(wrongAudience)).toThrow(UnauthenticatedError);
  });

  it('reports expiry with a distinguishable code', () => {
    // The client uses this code to decide whether to refresh rather than to
    // sign the user out.
    const expired = jwt.sign(claims, process.env.JWT_ACCESS_SECRET!, {
      issuer: 'aarvion-crm',
      audience: 'aarvion-crm-api',
      expiresIn: '-1s',
    });
    try {
      verifyAccessToken(expired);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as UnauthenticatedError).code).toBe('TOKEN_EXPIRED');
    }
  });

  it('rejects garbage', () => {
    expect(() => verifyAccessToken('not.a.token')).toThrow(UnauthenticatedError);
    expect(() => verifyAccessToken('')).toThrow(UnauthenticatedError);
  });
});

describe('refresh tokens', () => {
  it('generates high-entropy, unique values', () => {
    const tokens = new Set(Array.from({ length: 500 }, generateRefreshToken));
    expect(tokens.size).toBe(500);
    // 32 random bytes, base64url encoded.
    expect(generateRefreshToken()).toHaveLength(43);
  });

  it('uses a URL-safe alphabet', () => {
    // These end up in cookies; `+` and `/` would need escaping.
    expect(generateRefreshToken()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('hashes deterministically to a fixed width', () => {
    const token = generateRefreshToken();
    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
    expect(hashRefreshToken(token)).toHaveLength(64);
  });

  it('never stores the raw token', () => {
    const token = generateRefreshToken();
    expect(hashRefreshToken(token)).not.toContain(token);
  });
});

describe('safeEqual', () => {
  it('compares equal strings as equal', () => {
    expect(safeEqual('abc123', 'abc123')).toBe(true);
  });

  it('rejects differing strings and differing lengths', () => {
    expect(safeEqual('abc123', 'abc124')).toBe(false);
    expect(safeEqual('abc', 'abcdef')).toBe(false);
  });
});

describe('parseDuration', () => {
  it('parses each supported unit', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('30d')).toBe(2_592_000_000);
  });

  it('defaults a bare number to seconds', () => {
    expect(parseDuration('60')).toBe(60_000);
  });

  it('throws on an unparseable value rather than silently returning NaN', () => {
    // A NaN TTL would produce a cookie that expires immediately — a bug that
    // looks like "users get logged out randomly".
    expect(() => parseDuration('soon')).toThrow();
    expect(() => parseDuration('10 weeks')).toThrow();
  });
});
