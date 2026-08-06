/**
 * Scheduled housekeeping.
 *
 * Small, boring, and the reason the database does not slowly fill with dead
 * refresh tokens and orphaned upload files. Each task is idempotent and bounded,
 * so a missed run is caught up by the next one without a thundering herd.
 */
import { Worker, type Job } from 'bullmq';
import { LeadModel } from '../models';
import { createLogger } from '../lib/logger';
import { createQueueConnection } from '../lib/redis';
import { QueueName, type MaintenanceJobPayload } from '../queues';
import { authService } from '../modules/auth/auth.service';
import { importService } from '../modules/imports/import.service';

const log = createLogger('maintenance-worker');

/** Soft-deleted leads are recoverable for this long, then permanently removed. */
const SOFT_DELETE_RETENTION_DAYS = 30;

export const processMaintenanceJob = async (job: Job<MaintenanceJobPayload>): Promise<unknown> => {
  switch (job.data.task) {
    case 'prune-tokens':
      return { pruned: await authService.pruneExpiredTokens() };

    case 'purge-deleted-leads': {
      const cutoff = new Date(Date.now() - SOFT_DELETE_RETENTION_DAYS * 86_400_000);
      // Bounded per run: an unbounded DELETE on a large table takes a long lock.
      const { deletedCount } = await LeadModel.deleteMany({ deletedAt: { $lt: cutoff } });
      if (deletedCount > 0) log.info({ count: deletedCount }, 'purged soft-deleted leads past retention');
      return { purged: deletedCount };
    }

    case 'cleanup-uploads':
      return { cleaned: await importService.cleanupProcessedUploads() };

    default:
      log.warn({ task: job.data.task }, 'unknown maintenance task');
      return null;
  }
};

export const createMaintenanceWorker = (): Worker<MaintenanceJobPayload> => {
  const worker = new Worker<MaintenanceJobPayload>(QueueName.MAINTENANCE, processMaintenanceJob, {
    connection: createQueueConnection('maintenance-worker'),
    concurrency: 1,
  });

  worker.on('completed', (j, result) => log.info({ task: j.data.task, result }, 'maintenance task done'));
  worker.on('failed', (j, err) => log.error({ task: j?.data.task, err: err.message }, 'maintenance failed'));

  return worker;
};
