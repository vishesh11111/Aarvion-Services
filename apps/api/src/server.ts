/**
 * API process entry point.
 *
 * Responsibilities beyond "listen on a port":
 *   • verify critical dependencies before accepting traffic, so a broken deploy
 *     fails at rollout instead of on the first user request;
 *   • shut down gracefully — stop accepting connections, drain in-flight
 *     requests, then close the pools. A hard exit mid-request is a 502 for a
 *     real user on every single deploy;
 *   • treat an uncaught exception as fatal. A process in an unknown state
 *     serving traffic is worse than a process that restarts.
 */
import type { Server } from 'node:http';
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { connectDatabase, disconnectDatabase, pingDatabase } from './lib/db';
import { redis, disconnectRedis, waitForRedisReady } from './lib/redis';
import { closeQueues, scheduleMaintenanceJobs } from './queues';
import { ensureUploadDir } from './middleware/upload';

/** How long to let in-flight requests finish before forcing exit. */
const SHUTDOWN_GRACE_MS = 15_000;

const verifyDependencies = async (): Promise<void> => {
  await connectDatabase();
  await pingDatabase();
  logger.info('mongodb reachable');

  await waitForRedisReady();
  await redis.ping();
  logger.info('redis reachable');
};

const start = async (): Promise<void> => {
  try {
    await verifyDependencies();
    await ensureUploadDir();
    await scheduleMaintenanceJobs();
  } catch (error) {
    logger.fatal({ err: error }, 'startup checks failed — refusing to serve traffic');
    process.exit(1);
  }

  const app = createApp();

  const server: Server = app.listen(env.API_PORT, () => {
    logger.info(
      {
        port: env.API_PORT,
        env: env.NODE_ENV,
        aiEnabled: env.aiEnabled,
        docs: `http://localhost:${env.API_PORT}/api/v1/docs`,
      },
      'aarvion api listening',
    );
    if (!env.aiEnabled) {
      logger.warn('GEMINI_API_KEY is not set — AI features will serve deterministic fallbacks');
    }
  });

  // Slightly above the typical 60s ALB/nginx idle timeout, so the proxy closes
  // idle connections first. The reverse causes intermittent 502s.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  /* ---------------------------- shutdown ---------------------------------- */

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    // Force-exit if draining hangs — a stuck shutdown blocks the whole rollout.
    const killTimer = setTimeout(() => {
      logger.error('graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    killTimer.unref();

    // 1. Stop accepting new connections, let in-flight requests finish.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    logger.info('http server closed');

    // 2. Release the pools only once nothing is using them.
    await Promise.allSettled([closeQueues(), disconnectDatabase(), disconnectRedis()]);
    logger.info('connections closed');

    clearTimeout(killTimer);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception — exiting');
    void shutdown('uncaughtException');
  });
};

void start();
