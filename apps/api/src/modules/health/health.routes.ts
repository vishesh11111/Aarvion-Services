/**
 * Health and readiness probes.
 *
 * The distinction matters to an orchestrator and is routinely got wrong:
 *
 *   • /health/live   — "is this process alive?" Never touches a dependency.
 *                      If this checked MongoDB, a database blip would make
 *                      Kubernetes kill every healthy pod simultaneously.
 *   • /health/ready  — "should this instance receive traffic?" Checks the
 *                      dependencies it cannot serve without.
 *   • /health        — human-readable roll-up for dashboards and on-call.
 */
import { Router, type Request, type Response } from 'express';
import { pingDatabase } from '../../lib/db';
import { redis } from '../../lib/redis';
import { asyncHandler } from '../../lib/http';
import { env } from '../../config/env';
import { geminiClient } from '../ai/gemini.client';
import { importQueue } from '../../queues';

export const healthRouter: Router = Router();

const startedAt = Date.now();
const version = process.env.APP_VERSION ?? '1.0.0';

type CheckStatus = 'ok' | 'degraded' | 'down';

interface Check {
  status: CheckStatus;
  latencyMs?: number;
  detail?: string;
}

const timed = async (fn: () => Promise<unknown>): Promise<Check> => {
  const start = Date.now();
  try {
    await fn();
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (error) {
    return { status: 'down', latencyMs: Date.now() - start, detail: (error as Error).message.slice(0, 200) };
  }
};

/** Liveness: intentionally trivial and dependency-free. */
healthRouter.get('/live', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) });
});

/**
 * Readiness. MongoDB is required; Redis is required because without it the
 * queue cannot accept imports and rate limiting is unenforced.
 */
healthRouter.get(
  '/ready',
  asyncHandler(async (_req: Request, res: Response) => {
    const [database, cacheCheck] = await Promise.all([
      timed(() => pingDatabase()),
      timed(() => redis.ping()),
    ]);

    const ready = database.status === 'ok' && cacheCheck.status === 'ok';
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      checks: { database, redis: cacheCheck },
    });
  }),
);

/** Full status, including optional dependencies that only degrade the service. */
healthRouter.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const [database, cacheCheck, queueDepth] = await Promise.all([
      timed(() => pingDatabase()),
      timed(() => redis.ping()),
      importQueue.getJobCounts('waiting', 'active', 'failed').catch(() => null),
    ]);

    // AI being unavailable is explicitly *not* an outage — every feature has a
    // deterministic fallback, so it downgrades to `degraded` at worst.
    const ai: Check = !env.aiEnabled
      ? { status: 'degraded', detail: 'not configured' }
      : geminiClient.isAvailable
        ? { status: 'ok' }
        : { status: 'degraded', detail: 'circuit breaker open' };

    const critical = [database.status, cacheCheck.status];
    const status: CheckStatus = critical.includes('down')
      ? 'down'
      : ai.status === 'degraded'
        ? 'degraded'
        : 'ok';

    res.status(status === 'down' ? 503 : 200).json({
      status,
      version,
      environment: env.NODE_ENV,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      checks: { database, redis: cacheCheck, ai },
      queues: queueDepth ? { import: queueDepth } : undefined,
      timestamp: new Date().toISOString(),
    });
  }),
);
