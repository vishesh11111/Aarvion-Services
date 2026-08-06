/**
 * Job queues (BullMQ on Redis).
 *
 * Why a queue at all: a 200k-row CSV takes minutes to import. Doing that inside
 * the HTTP request would hold a connection open past every sane proxy timeout,
 * lose all progress on a deploy, and let one large upload starve the API's event
 * loop. The upload endpoint therefore does one thing — persist the file and
 * enqueue — and returns 202 immediately.
 *
 * Queues are defined here (shared by the API, which enqueues, and the worker
 * process, which consumes) so job names and payload types cannot drift apart.
 */
import { Queue, type JobsOptions } from 'bullmq';
import { queueRedis } from '../lib/redis';
import { createLogger } from '../lib/logger';

const log = createLogger('queues');

export const QueueName = {
  IMPORT: 'lead-import',
  ENRICHMENT: 'lead-enrichment',
  MAINTENANCE: 'maintenance',
} as const;

/* --- payloads ------------------------------------------------------------ */

export interface ImportJobPayload {
  importJobId: string;
  organizationId: string;
  userId: string;
}

export interface EnrichmentJobPayload {
  organizationId: string;
  userId: string;
  /** Explicit ids, or omitted to drain the tenant's unscored backlog. */
  leadIds?: string[];
  importJobId?: string;
}

export interface MaintenanceJobPayload {
  task: 'prune-tokens' | 'purge-deleted-leads' | 'cleanup-uploads';
}

/**
 * Defaults chosen for a data-processing workload:
 *   • `attempts: 3` with exponential backoff — transient DB/Redis blips retry,
 *     but a genuinely malformed file fails fast rather than looping.
 *   • completed jobs are kept briefly so the UI can read the final state, then
 *     age out; failures are kept much longer because that is what gets debugged.
 */
const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 86_400 },
};

export const importQueue = new Queue<ImportJobPayload>(QueueName.IMPORT, {
  connection: queueRedis,
  defaultJobOptions,
});

export const enrichmentQueue = new Queue<EnrichmentJobPayload>(QueueName.ENRICHMENT, {
  connection: queueRedis,
  defaultJobOptions: {
    ...defaultJobOptions,
    // AI calls are billable; retrying three times multiplies the cost of a
    // systemic provider failure for no benefit.
    attempts: 2,
    backoff: { type: 'exponential', delay: 15_000 },
  },
});

export const maintenanceQueue = new Queue<MaintenanceJobPayload>(QueueName.MAINTENANCE, {
  connection: queueRedis,
  defaultJobOptions: { attempts: 1, removeOnComplete: { count: 50 } },
});

/**
 * Registers the recurring maintenance jobs. Idempotent — BullMQ deduplicates
 * repeatable jobs by name + pattern, so calling this on every boot of every
 * replica is safe and does not multiply the schedule.
 */
export const scheduleMaintenanceJobs = async (): Promise<void> => {
  await Promise.all([
    maintenanceQueue.add(
      'prune-tokens',
      { task: 'prune-tokens' },
      { repeat: { pattern: '0 3 * * *' }, jobId: 'prune-tokens' }, // 03:00 daily
    ),
    maintenanceQueue.add(
      'purge-deleted-leads',
      { task: 'purge-deleted-leads' },
      { repeat: { pattern: '30 3 * * *' }, jobId: 'purge-deleted-leads' },
    ),
    maintenanceQueue.add(
      'cleanup-uploads',
      { task: 'cleanup-uploads' },
      { repeat: { pattern: '0 4 * * *' }, jobId: 'cleanup-uploads' },
    ),
  ]);
  log.info('maintenance jobs scheduled');
};

export const closeQueues = async (): Promise<void> => {
  await Promise.allSettled([importQueue.close(), enrichmentQueue.close(), maintenanceQueue.close()]);
};
