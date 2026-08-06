/**
 * Rate limiting.
 *
 * Counters live in Redis, not in process memory, because the API runs as N
 * replicas behind a load balancer — an in-memory limiter would give an attacker
 * N× the intended budget and would reset on every deploy.
 *
 * Keying strategy:
 *   • authenticated requests  -> user id  (fair per-account budget)
 *   • anonymous requests      -> client IP
 * Keying purely by IP would throttle every user behind one corporate NAT
 * together; keying purely by user would leave login endpoints unprotected.
 */
import rateLimit, { type Options, type RateLimitRequestHandler } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import type { Request, RequestHandler, Response } from 'express';
import { redis } from '../lib/redis';
import { env } from '../config/env';
import { ErrorCode } from '../lib/errors';
import { clientIp } from '../lib/http';
import { createLogger } from '../lib/logger';

const log = createLogger('rate-limit');

/**
 * Placeholder SHA returned when `SCRIPT LOAD` genuinely cannot reach Redis.
 *
 * rate-limit-redis loads its Lua scripts during `init()` and does not await
 * those promises. If our bridge rejects — or returns something that is not a
 * SHA string — the library throws inside an unobserved promise, producing an
 * unhandled rejection. Combined with the `uncaughtException` policy in
 * server.ts, a *cache* outage could turn into a process restart loop.
 *
 * The subsequent `EVALSHA` then fails with NOSCRIPT, and that call *is* awaited
 * by the limiter, where `passOnStoreError` lets the request through. Failure
 * ends up on the path designed to handle it.
 *
 * Note that this SHA is cached by the library for the life of the store, so a
 * poisoned load disables rate limiting until restart. That is why the store is
 * created lazily (below) rather than at import time — the common case of
 * "Redis simply is not connected yet at boot" must never reach here.
 */
const UNAVAILABLE_SHA = '0'.repeat(40);

/** Bridges rate-limit-redis to our ioredis client, failing open on any error. */
const makeStore = (prefix: string) =>
  new RedisStore({
    prefix: `rl:${prefix}:`,
    sendCommand: async (...args: string[]) => {
      try {
        return (await redis.call(...(args as [string, ...string[]]))) as never;
      } catch (error) {
        const isScriptLoad = args[0]?.toUpperCase() === 'SCRIPT';
        log.warn(
          { prefix, command: args[0], err: (error as Error).message },
          'rate-limit store unavailable — failing open',
        );
        return (isScriptLoad ? UNAVAILABLE_SHA : undefined) as never;
      }
    },
  });

/**
 * Defers limiter construction to the first request.
 *
 * `new RateLimit(...)` calls `store.init()` immediately, which issues
 * `SCRIPT LOAD`. At module-import time the Redis client is still connecting and
 * the cache client runs with `enableOfflineQueue: false`, so that command fails
 * instantly — permanently caching the placeholder SHA above and silently
 * disabling rate limiting for the life of the process.
 *
 * By the time a first request arrives, `server.ts` has already verified Redis is
 * reachable. Building the limiter then is enough to make the ordering correct
 * without adding startup coupling between this module and the bootstrap.
 */
const lazyLimiter = (factory: () => RateLimitRequestHandler): RequestHandler => {
  let limiter: RateLimitRequestHandler | undefined;
  return (req, res, next) => {
    limiter ??= factory();
    limiter(req, res, next);
  };
};

const handler = (req: Request, res: Response): void => {
  const retryAfter = Number(res.getHeader('Retry-After')) || Math.ceil(env.RATE_LIMIT_WINDOW_MS / 1000);
  log.warn({ path: req.originalUrl, ip: clientIp(req), userId: req.auth?.userId }, 'rate limit exceeded');
  res.status(429).json({
    error: {
      code: ErrorCode.RATE_LIMITED,
      message: 'Too many requests — slow down',
      details: { retryAfterSeconds: retryAfter },
    },
    requestId: req.id,
  });
};

const baseOptions = (prefix: string): Partial<Options> => ({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: makeStore(prefix),
  handler,
  // If Redis is unreachable the limiter would otherwise reject everything.
  // Availability wins here: log loudly and let the request through.
  passOnStoreError: true,
  keyGenerator: (req: Request) => req.auth?.userId ?? clientIp(req),
});

/** Global limiter applied to the whole `/api/v1` surface. */
export const globalLimiter: RequestHandler = lazyLimiter(() =>
  rateLimit({
    ...baseOptions('global'),
    limit: env.RATE_LIMIT_MAX,
    // Health checks must never be throttled — a throttled probe looks like an
    // outage to the orchestrator and triggers a pod restart loop.
    skip: (req) => req.path.startsWith('/health') || req.method === 'OPTIONS',
  }),
);

/**
 * Aggressive limiter for credential endpoints (login, register, refresh, password
 * reset). Always keyed by IP: keying by user id would let an attacker enumerate
 * accounts with a fresh budget per guessed email.
 */
export const authLimiter: RequestHandler = lazyLimiter(() =>
  rateLimit({
    ...baseOptions('auth'),
    windowMs: 15 * 60 * 1000,
    limit: env.AUTH_RATE_LIMIT_MAX,
    keyGenerator: (req: Request) => clientIp(req),
    // Successful logins do not consume budget; only failures do. This keeps a
    // legitimate user from locking themselves out by signing in on many devices.
    skipSuccessfulRequests: true,
  }),
);

/**
 * Refresh-token rotation.
 *
 * Separate from `authLimiter` on purpose. Refresh is not a credential-guessing
 * endpoint — the token is 256 bits of opaque randomness and reuse already
 * revokes the entire family — but it *is* a normal background operation: every
 * active session refreshes every 15 minutes, and clients attempt one whenever
 * they see a 401.
 *
 * Sharing the login budget meant a few expired-session page loads exhausted it
 * and then blocked sign-in, since login reads the same counter. Keyed by IP, so
 * the budget is sized for an office behind one NAT address rather than one user.
 */
export const refreshLimiter: RequestHandler = lazyLimiter(() =>
  rateLimit({
    ...baseOptions('refresh'),
    windowMs: 15 * 60 * 1000,
    limit: 100,
    keyGenerator: (req: Request) => clientIp(req),
  }),
);

/** LLM calls cost money and are slow. Tighter budget, keyed per user. */
export const aiLimiter: RequestHandler = lazyLimiter(() =>
  rateLimit({ ...baseOptions('ai'), windowMs: 60_000, limit: 20 }),
);

/** File uploads: expensive to accept, so limited per user per hour. */
export const uploadLimiter: RequestHandler = lazyLimiter(() =>
  rateLimit({ ...baseOptions('upload'), windowMs: 60 * 60 * 1000, limit: 30 }),
);
