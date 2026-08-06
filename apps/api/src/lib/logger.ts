/**
 * Structured logging.
 *
 * JSON in production (so Loki/Datadog/CloudWatch can parse it), pretty-printed
 * in development. Every log line carries a `requestId` when emitted from within
 * a request, via the AsyncLocalStorage context in `request-context.ts`.
 */
import pino, { type LoggerOptions } from 'pino';
import { env } from '../config/env';
import { getRequestContext } from './request-context';

/**
 * Keys whose values must never reach a log sink. Pino's redact paths are
 * applied to the merged log object.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'password',
  'passwordHash',
  'currentPassword',
  'newPassword',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  '*.password',
  '*.passwordHash',
  '*.token',
];

const options: LoggerOptions = {
  level: env.LOG_LEVEL,
  redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  base: { service: 'aarvion-api', env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    // Emit `level: "info"` rather than `level: 30`; most log platforms expect
    // the string form and it costs nothing.
    level: (label) => ({ level: label }),
  },
  /**
   * Automatically attach the correlation id of the in-flight request to every
   * log line, including ones emitted deep inside services that know nothing
   * about HTTP.
   */
  mixin() {
    const ctx = getRequestContext();
    if (!ctx) return {};
    return {
      requestId: ctx.requestId,
      ...(ctx.userId ? { userId: ctx.userId } : {}),
      ...(ctx.organizationId ? { organizationId: ctx.organizationId } : {}),
    };
  },
};

/**
 * Chooses the log destination.
 *
 * Pretty-printing is a developer convenience provided by `pino-pretty`, which is
 * a devDependency and therefore absent from the production image. Selecting it
 * purely on `NODE_ENV` means that running the production image with
 * `NODE_ENV=development` — a completely reasonable thing to do while debugging a
 * deployment — crashes the process at import time, before any log line explains
 * why.
 *
 * So the transport is attempted and falls back to plain JSON if the module is
 * not installed. Logging must never be the reason a service cannot start.
 */
const createDestination = () => {
  if (env.isProduction || env.isTest) return pino.destination({ sync: false });

  try {
    require.resolve('pino-pretty');
    return pino.transport({
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service,env' },
    });
  } catch {
    return pino.destination({ sync: false });
  }
};

export const logger = pino(options, createDestination());

/** Child logger bound to a subsystem, e.g. `createLogger('import-worker')`. */
export const createLogger = (component: string) => logger.child({ component });
