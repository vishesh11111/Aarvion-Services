/**
 * Worker process entry point.
 *
 * Runs in its own container, separate from the API. That separation is the
 * point: a 200k-row import saturating the event loop must not add latency to
 * user-facing requests, and the two scale on completely different signals —
 * the API on request rate, the workers on queue depth.
 */
import type { Worker } from 'bullmq';
import { logger } from './lib/logger';
import { connectDatabase, disconnectDatabase, pingDatabase } from './lib/db';
import { redis, disconnectRedis, waitForRedisReady } from './lib/redis';
import { env } from './config/env';
import { ensureUploadDir } from './middleware/upload';
import { createImportWorker } from './workers/import.worker';
import { createEnrichmentWorker } from './workers/enrichment.worker';
import { createMaintenanceWorker } from './workers/maintenance.worker';

const SHUTDOWN_GRACE_MS = 60_000; // an in-flight import batch deserves time to finish

const start = async (): Promise<void> => {
  try {
    await connectDatabase();
    await pingDatabase();
    await waitForRedisReady();
    await redis.ping();
    await ensureUploadDir();
  } catch (error) {
    logger.fatal({ err: error }, 'worker startup checks failed');
    process.exit(1);
  }

  const workers: Worker[] = [
    createImportWorker() as Worker,
    createEnrichmentWorker() as Worker,
    createMaintenanceWorker() as Worker,
  ];

  logger.info(
    {
      importConcurrency: env.IMPORT_WORKER_CONCURRENCY,
      aiConcurrency: env.AI_WORKER_CONCURRENCY,
      aiEnabled: env.aiEnabled,
    },
    'aarvion workers started',
  );

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'draining workers');

    const killTimer = setTimeout(() => {
      logger.error('worker shutdown timed out — forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    killTimer.unref();

    // `close()` waits for active jobs to finish rather than abandoning them.
    // An abandoned import job would be re-delivered and partially re-applied.
    await Promise.allSettled(workers.map((worker) => worker.close()));
    logger.info('workers drained');

    await Promise.allSettled([disconnectDatabase(), disconnectRedis()]);

    clearTimeout(killTimer);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) =>
    logger.error({ err: reason }, 'unhandled rejection in worker'),
  );
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception in worker — exiting');
    void shutdown('uncaughtException');
  });
};

void start();
