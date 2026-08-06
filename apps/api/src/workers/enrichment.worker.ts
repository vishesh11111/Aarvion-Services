/**
 * AI enrichment worker.
 *
 * Scores leads out of band. Running this in the background rather than inline is
 * what makes AI scoring viable on a 50k-row import: the user sees their leads
 * immediately and the scores fill in behind them.
 *
 * Concurrency is deliberately low (`AI_WORKER_CONCURRENCY`, default 2). The
 * bottleneck is the provider's rate limit, not our CPU, and stampeding it just
 * converts throughput into 429s.
 */
import { Worker, type Job } from 'bullmq';
import { Role } from '../models';
import { LeadModel, toObjectId } from '../models';
import { env } from '../config/env';
import { createLogger } from '../lib/logger';
import { createQueueConnection } from '../lib/redis';
import { QueueName, enrichmentQueue, type EnrichmentJobPayload } from '../queues';
import { aiService } from '../modules/ai/ai.service';
import { RateLimitError } from '../lib/errors';
import type { TenantContext } from '../types';

const log = createLogger('enrichment-worker');

/** Leads pulled per job run. Bounded so one tenant's backlog cannot monopolise
 *  the worker for an unbounded stretch. */
const MAX_LEADS_PER_RUN = 200;

export const processEnrichmentJob = async (job: Job<EnrichmentJobPayload>): Promise<number> => {
  const { organizationId, userId, leadIds, importJobId } = job.data;

  const leads = await LeadModel.find({
    organizationId: toObjectId(organizationId),
    deletedAt: null,
    ...(leadIds?.length ? { _id: { $in: leadIds.map(toObjectId) } } : {}),
    ...(importJobId ? { importJobId: toObjectId(importJobId) } : {}),
    // Only unscored leads unless specific ids were requested.
    ...(leadIds?.length ? {} : { scoredAt: null }),
  })
    .sort({ createdAt: -1 })
    .limit(MAX_LEADS_PER_RUN);

  if (leads.length === 0) {
    log.debug({ organizationId, importJobId }, 'nothing to enrich');
    return 0;
  }

  // The worker acts on behalf of the organization, not a session. ADMIN is the
  // right level: enough to write scores, not enough to imply a real user's
  // permissions were used.
  const ctx: TenantContext = { organizationId, userId, role: Role.ADMIN };

  try {
    const result = await aiService.scoreLeads(ctx, leads);
    log.info(
      { organizationId, count: result.data.length, degraded: result.degraded },
      'leads scored',
    );

    // More backlog left: chain another job rather than looping here, so the
    // queue stays observable and other tenants get a turn between runs.
    if (leads.length === MAX_LEADS_PER_RUN) {
      const remaining = await LeadModel.countDocuments({
        organizationId: toObjectId(organizationId),
        deletedAt: null,
        scoredAt: null,
        ...(importJobId ? { importJobId: toObjectId(importJobId) } : {}),
      });
      if (remaining > 0) {
        await enrichmentQueue.add(
          'score-continued',
          { organizationId, userId, ...(importJobId ? { importJobId } : {}) },
          { delay: 2_000 },
        );
      }
    }

    return result.data.length;
  } catch (error) {
    // Quota exhaustion is not a failure to retry — the budget will not free up
    // by trying again in 15 seconds. Log and stop.
    if (error instanceof RateLimitError) {
      log.warn({ organizationId }, 'AI quota exhausted — enrichment deferred to next window');
      return 0;
    }
    throw error;
  }
};

export const createEnrichmentWorker = (): Worker<EnrichmentJobPayload> => {
  const worker = new Worker<EnrichmentJobPayload>(QueueName.ENRICHMENT, processEnrichmentJob, {
    connection: createQueueConnection('enrichment-worker'),
    concurrency: env.AI_WORKER_CONCURRENCY,
    lockDuration: 3 * 60_000,
    // Global cap across all tenants, so a burst of imports cannot exceed the
    // provider's requests-per-minute allowance.
    limiter: { max: 30, duration: 60_000 },
  });

  worker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'enrichment job failed'),
  );

  return worker;
};
