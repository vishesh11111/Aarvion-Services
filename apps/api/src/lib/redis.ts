/**
 * Redis connections.
 *
 * Three logical uses, two physical connection profiles:
 *   • `redis`      — shared connection for cache + rate limiting (request path).
 *   • `queueRedis` — BullMQ requires `maxRetriesPerRequest: null` and its own
 *                    connection; sharing the cache connection breaks blocking
 *                    commands (BRPOPLPUSH) used by the worker.
 *
 * Redis is treated as a *degradable* dependency for caching: if it is down the
 * API keeps serving (cache misses everywhere) rather than 500ing. It is a hard
 * dependency for the queue workers, which is the correct trade-off — losing a
 * cache is an inconvenience, losing a job is data loss.
 */
import IORedis, { type RedisOptions } from 'ioredis';
import { env } from '../config/env';
import { createLogger } from './logger';

const log = createLogger('redis');

const baseOptions: RedisOptions = {
  lazyConnect: false,
  connectTimeout: 10_000,
  retryStrategy: (times) => Math.min(times * 200, 5_000),
  reconnectOnError: (err) => {
    // Failover: a replica promoted to primary reports READONLY. Reconnect.
    if (err.message.includes('READONLY')) return 2;
    return false;
  },
};

const attachLogging = (client: IORedis, name: string): IORedis => {
  client.on('connect', () => log.info({ client: name }, 'redis connected'));
  client.on('ready', () => log.debug({ client: name }, 'redis ready'));
  client.on('error', (err) => log.error({ client: name, err: err.message }, 'redis error'));
  client.on('close', () => log.warn({ client: name }, 'redis connection closed'));
  return client;
};

/**
 * Request-path client: cache reads/writes and distributed rate-limit counters.
 *
 * `enableOfflineQueue: false` is the important setting here. With the queue on
 * (ioredis's default), a command issued while Redis is unreachable is buffered
 * and only rejects after the connect timeout — so a Redis outage turns every
 * API request into a multi-second stall before the fail-open path is even
 * reached. Failing immediately is what makes "degrade gracefully" actually fast.
 */
export const redis = attachLogging(
  new IORedis(env.REDIS_URL, {
    ...baseOptions,
    maxRetriesPerRequest: 3,
    enableOfflineQueue: false,
  }),
  'cache',
);

/**
 * BullMQ client factory. BullMQ mandates `maxRetriesPerRequest: null` and needs
 * the offline queue, because its blocking commands must survive a reconnect
 * rather than failing — dropping a job is data loss, not a cache miss.
 */
export const createQueueConnection = (name: string): IORedis =>
  attachLogging(
    new IORedis(env.REDIS_URL, {
      ...baseOptions,
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
    }),
    name,
  );

export const queueRedis = createQueueConnection('queue');

/* -------------------------------------------------------------------------- */
/* Cache helpers — every one fails open.                                       */
/* -------------------------------------------------------------------------- */

export const cache = {
  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await redis.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err) {
      log.warn({ key, err: (err as Error).message }, 'cache read failed — serving uncached');
      return null;
    }
  },

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      log.warn({ key, err: (err as Error).message }, 'cache write failed');
    }
  },

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await redis.del(...keys);
    } catch (err) {
      log.warn({ keys, err: (err as Error).message }, 'cache delete failed');
    }
  },

  /**
   * Delete by pattern using SCAN — never KEYS, which blocks the Redis event
   * loop for the duration of a full keyspace walk.
   */
  async delByPattern(pattern: string): Promise<void> {
    try {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = next;
        if (keys.length > 0) await redis.unlink(...keys);
      } while (cursor !== '0');
    } catch (err) {
      log.warn({ pattern, err: (err as Error).message }, 'cache pattern delete failed');
    }
  },

  /** Atomic increment with TTL applied on first write. Used for AI quotas. */
  async incrementWithTtl(key: string, ttlSeconds: number): Promise<number> {
    const results = await redis
      .multi()
      .incr(key)
      .expire(key, ttlSeconds, 'NX')
      .exec();
    const value = results?.[0]?.[1];
    return typeof value === 'number' ? value : Number(value ?? 0);
  },
};

/**
 * Waits for the cache client to finish connecting.
 *
 * Required because the client runs with `enableOfflineQueue: false` — commands
 * issued before the socket is ready fail immediately rather than being buffered.
 * That is the behaviour we want on the request path (fail fast, serve uncached),
 * but it means a startup health check racing the initial connection would report
 * Redis as down and abort the boot. Every process therefore waits here first.
 */
export const waitForRedisReady = async (timeoutMs = 15_000): Promise<void> => {
  if (redis.status === 'ready') return;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Redis did not become ready within ${timeoutMs}ms`));
    }, timeoutMs);

    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      // Transient errors are expected while connecting; only give up on timeout.
      log.debug({ err: error.message }, 'waiting for redis');
    };

    function cleanup(): void {
      clearTimeout(timer);
      redis.off('ready', onReady);
      redis.off('error', onError);
    }

    redis.once('ready', onReady);
    redis.on('error', onError);
  });
};

export const disconnectRedis = async (): Promise<void> => {
  await Promise.allSettled([redis.quit(), queueRedis.quit()]);
};
