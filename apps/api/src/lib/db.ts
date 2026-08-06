/**
 * MongoDB connection and transaction support.
 *
 * One connection pool per process, opened at startup and closed on shutdown.
 * Mongoose maintains the pool internally; the important part of this file is the
 * configuration around it and the transaction helper.
 */
import mongoose, { type ClientSession } from 'mongoose';
import { env } from '../config/env';
import { createLogger } from './logger';

// Importing the barrel registers every schema before any query can run.
import '../models';

const log = createLogger('mongo');

/**
 * Mongoose global settings.
 *
 * `strictQuery: 'throw'` makes an unknown field in a filter an error rather than
 * a silent no-op. That matters enormously for multi-tenancy: a typo'd
 * `organisationId` (British spelling) would otherwise be dropped from the filter
 * and return every tenant's data. Failing loudly is the only acceptable
 * behaviour.
 */
mongoose.set('strictQuery', 'throw');

/*
 * `sanitizeFilter` is deliberately NOT enabled globally.
 *
 * It defends against query-selector injection by wrapping object values in
 * `$eq` — but it cannot distinguish a `{ $gte: 70 }` this codebase constructed
 * from one an attacker smuggled in, so it breaks every legitimate operator
 * query. (`?minScore=70` becomes `{ score: { $eq: { $gte: 70 } } }`, which then
 * fails to cast.)
 *
 * The actual defence is at the edge, and it is stronger: every query parameter
 * is parsed by Zod before it reaches a filter, which coerces it to a primitive —
 * `z.coerce.number()` for scores, `z.enum` for statuses, an ObjectId check for
 * ids. A value that arrives as `{"$ne": null}` fails validation with a 400 and
 * never reaches the database layer at all. No filter in this codebase is built
 * from a raw request object.
 */

if (env.LOG_LEVEL === 'trace') {
  mongoose.set('debug', (collection: string, method: string, query: unknown) => {
    log.trace({ collection, method, query }, 'mongo command');
  });
}

let connecting: Promise<typeof mongoose> | null = null;

export const connectDatabase = async (): Promise<typeof mongoose> => {
  if (mongoose.connection.readyState === 1) return mongoose;
  // Concurrent callers (server + worker bootstrap paths, tests) share one attempt.
  connecting ??= mongoose.connect(env.MONGODB_URI, {
    // Pool sizing is per process. Total across all replicas must stay under the
    // cluster's connection limit — Atlas M0/M10 tiers are much lower than people
    // expect, and exhausting it produces intermittent failures only at peak.
    maxPoolSize: env.MONGO_POOL_SIZE,
    minPoolSize: 1,
    // Fail fast rather than hanging a request for 30s on an unreachable cluster.
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 45_000,
    // Writes are acknowledged by a majority before returning. On a replica set
    // this is what makes a confirmed write survive a primary failover — the
    // difference between "we saved your lead" being true and being probable.
    writeConcern: { w: 'majority' },
    retryWrites: true,
    autoIndex: false, // indexes are managed explicitly; see scripts/sync-indexes.ts
  });

  try {
    await connecting;
  } catch (error) {
    connecting = null;
    throw error;
  }

  return mongoose;
};

mongoose.connection.on('connected', () => log.info('mongodb connected'));
mongoose.connection.on('disconnected', () => log.warn('mongodb disconnected'));
mongoose.connection.on('reconnected', () => log.info('mongodb reconnected'));
mongoose.connection.on('error', (err: Error) => log.error({ err: err.message }, 'mongodb error'));

export const disconnectDatabase = async (): Promise<void> => {
  connecting = null;
  await mongoose.disconnect().catch(() => undefined);
};

export const isDatabaseConnected = (): boolean => mongoose.connection.readyState === 1;

/** Round-trips the server. Used by the readiness probe. */
export const pingDatabase = async (): Promise<void> => {
  const admin = mongoose.connection.db?.admin();
  if (!admin) throw new Error('database connection is not established');
  await admin.ping();
};

/* -------------------------------------------------------------------------- */
/* Transactions                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Whether this deployment supports multi-document transactions.
 *
 * MongoDB requires a replica set or sharded cluster. Atlas always provides one;
 * a bare `mongod` started for a quick local test does not. Rather than crashing
 * on a developer's laptop, we detect the capability once and fall back to
 * running the operations without a session.
 *
 * The fallback is a genuine reduction in atomicity, so it logs a warning — it is
 * a development affordance, not something to rely on in production. The
 * docker-compose stack configures a single-node replica set precisely so the
 * local environment matches production here.
 */
let transactionsSupported: boolean | null = null;

const TRANSACTION_UNSUPPORTED = /Transaction numbers are only allowed|replica set|not supported/i;

export const withTransaction = async <T>(fn: (session?: ClientSession) => Promise<T>): Promise<T> => {
  if (transactionsSupported === false) return fn();

  const session = await mongoose.startSession();
  try {
    let result: T;
    // `withTransaction` retries automatically on transient transaction errors
    // and on "unknown commit result" — the two failure modes that make
    // hand-rolled commit loops subtly wrong.
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    transactionsSupported = true;
    return result!;
  } catch (error) {
    const message = (error as Error).message ?? '';
    if (transactionsSupported === null && TRANSACTION_UNSUPPORTED.test(message)) {
      transactionsSupported = false;
      log.warn(
        'this MongoDB deployment does not support transactions (standalone server) — ' +
          'multi-document operations will run without atomicity. Use a replica set in production.',
      );
      return fn();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

/** Duplicate-key violation on a unique index (MongoDB error code 11000). */
export const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: number }).code === 11000;

/** Extracts the field(s) that collided, for a useful 409 body. */
export const duplicateKeyFields = (error: unknown): string[] => {
  const pattern = (error as { keyPattern?: Record<string, unknown> })?.keyPattern;
  return pattern ? Object.keys(pattern) : [];
};

export { mongoose };
