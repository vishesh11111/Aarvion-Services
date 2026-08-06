/**
 * Analytics endpoints.
 *
 * Every figure is computed by an aggregation pipeline on the server — nothing is
 * pulled into Node and reduced in JavaScript. Results are cached per tenant for
 * five minutes: these are dashboard reads that tolerate being slightly stale,
 * and they are the most expensive queries the application runs.
 *
 * All pipelines go through `leadRepository.aggregate`, which prepends the tenant
 * `$match`. That is not a convenience — `$match` in an aggregation does *not*
 * cast a string to ObjectId the way `find()` does, so a hand-written pipeline
 * passing the raw id would silently match nothing and render an empty dashboard
 * rather than an error.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { LeadStatus, PIPELINE_ORDER } from '../../models';
import { cache } from '../../lib/redis';
import { asyncHandler, sendSuccess } from '../../lib/http';
import { authenticate, requireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import { toTenantContext } from '../../types';
import { assertCan } from '../auth/rbac';
import { leadRepository } from '../leads/lead.repository';

const ANALYTICS_CACHE_TTL = 300;

const rangeSchema = z
  .object({ days: z.coerce.number().int().min(1).max(365).default(30) })
  .strict();

export const analyticsRouter: Router = Router();

analyticsRouter.use(authenticate);

/** Reads through the cache, tagging the response so cache behaviour is visible. */
const cached = async <T>(res: Response, key: string, compute: () => Promise<T>): Promise<T> => {
  const hit = await cache.get<T>(key);
  if (hit) {
    res.setHeader('x-cache', 'HIT');
    return hit;
  }
  const value = await compute();
  await cache.set(key, value, ANALYTICS_CACHE_TTL);
  res.setHeader('x-cache', 'MISS');
  return value;
};

/**
 * Daily lead volume, split by whether the lead was won.
 *
 * `$densify` fills in days with no leads so the series has one point per day.
 * Without it, absent days would silently compress the x-axis and misrepresent
 * the trend — the chart would look smooth while hiding the gaps. (`$densify`
 * requires MongoDB 5.1+; Atlas is well past that.)
 */
analyticsRouter.get(
  '/timeseries',
  validate({ query: rangeSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = toTenantContext(requireAuth(req));
    assertCan(ctx, 'ANALYTICS_READ');

    const { days } = req.query as unknown as z.infer<typeof rangeSchema>;
    const key = `analytics:${ctx.organizationId}:timeseries:${days}`;

    const data = await cached(res, key, async () => {
      const start = new Date();
      start.setUTCHours(0, 0, 0, 0);
      start.setUTCDate(start.getUTCDate() - (days - 1));

      const rows = await leadRepository.aggregate<{ _id: string; created: number; won: number }>(ctx, [
        { $match: { createdAt: { $gte: start } } },
        {
          $group: {
            // Bucket by calendar day in UTC so the series is stable regardless
            // of where the server happens to be running.
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
            created: { $sum: 1 },
            won: { $sum: { $cond: [{ $eq: ['$status', LeadStatus.WON] }, 1, 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ]);

      // Zero-fill in application code rather than with $densify: it is a handful
      // of lines, works on every MongoDB version, and keeps the pipeline simple.
      const byDate = new Map(rows.map((row) => [row._id, row]));
      return Array.from({ length: days }, (_, index) => {
        const day = new Date(start);
        day.setUTCDate(start.getUTCDate() + index);
        const date = day.toISOString().slice(0, 10);
        const row = byDate.get(date);
        return { date, created: row?.created ?? 0, won: row?.won ?? 0 };
      });
    });

    sendSuccess(res, data);
  }),
);

/** Funnel counts in pipeline order, with the conversion rate between stages. */
analyticsRouter.get(
  '/funnel',
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = toTenantContext(requireAuth(req));
    assertCan(ctx, 'ANALYTICS_READ');

    const data = await cached(res, `analytics:${ctx.organizationId}:funnel`, async () => {
      const rows = await leadRepository.aggregate<{
        _id: LeadStatus;
        count: number;
        value: number;
      }>(ctx, [
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            value: { $sum: { $ifNull: ['$estimatedValue', 0] } },
          },
        },
      ]);

      const byStatus = new Map(rows.map((row) => [row._id, row]));
      let previous: number | null = null;

      const stages = PIPELINE_ORDER.map((status) => {
        const count = byStatus.get(status)?.count ?? 0;
        const conversionFromPrevious =
          previous === null ? null : previous === 0 ? 0 : Math.round((count / previous) * 1000) / 10;
        previous = count;
        return {
          status,
          count,
          value: byStatus.get(status)?.value ?? 0,
          conversionFromPrevious,
        };
      });

      return {
        stages,
        lost: byStatus.get(LeadStatus.LOST)?.count ?? 0,
        disqualified: byStatus.get(LeadStatus.DISQUALIFIED)?.count ?? 0,
      };
    });

    sendSuccess(res, data);
  }),
);

/** Score distribution in ten buckets — shows whether scoring actually discriminates. */
analyticsRouter.get(
  '/score-distribution',
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = toTenantContext(requireAuth(req));
    assertCan(ctx, 'ANALYTICS_READ');

    const data = await cached(res, `analytics:${ctx.organizationId}:scores`, async () => {
      const rows = await leadRepository.aggregate<{ _id: number; count: number }>(ctx, [
        { $match: { score: { $ne: null } } },
        {
          $group: {
            // A score of exactly 100 must land in the 90-99 bucket, not an
            // eleventh one — hence the $min clamp.
            _id: { $min: [{ $floor: { $divide: ['$score', 10] } }, 9] },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]);

      const byBucket = new Map(rows.map((row) => [row._id, row.count]));
      return Array.from({ length: 10 }, (_, i) => ({
        range: `${i * 10}-${i * 10 + 9}`,
        min: i * 10,
        count: byBucket.get(i) ?? 0,
      }));
    });

    sendSuccess(res, data);
  }),
);

/** Per-rep performance. Drives the leaderboard on the dashboard. */
analyticsRouter.get(
  '/by-owner',
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = toTenantContext(requireAuth(req));
    assertCan(ctx, 'ANALYTICS_READ');

    const rows = await leadRepository.aggregate<{
      _id: unknown;
      name: string | null;
      total: number;
      won: number;
      avgScore: number | null;
    }>(ctx, [
      {
        $group: {
          _id: '$ownerId',
          total: { $sum: 1 },
          won: { $sum: { $cond: [{ $eq: ['$status', LeadStatus.WON] }, 1, 0] } },
          avgScore: { $avg: '$score' },
        },
      },
      { $sort: { total: -1 } },
      { $limit: 25 },
      // `$lookup` is the aggregation equivalent of a LEFT JOIN. Bounded to 25
      // groups by the preceding $limit, so it resolves at most 25 users.
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'owner',
          pipeline: [{ $project: { name: 1 } }],
        },
      },
      {
        $project: {
          total: 1,
          won: 1,
          avgScore: 1,
          name: { $ifNull: [{ $first: '$owner.name' }, null] },
        },
      },
    ]);

    sendSuccess(
      res,
      rows.map((row) => ({
        ownerId: row._id ? String(row._id) : null,
        name: row.name ?? 'Unassigned',
        total: row.total,
        won: row.won,
        winRate: row.total > 0 ? Math.round((row.won / row.total) * 1000) / 10 : 0,
        averageScore: row.avgScore !== null ? Math.round(row.avgScore) : null,
      })),
    );
  }),
);

/** Top tags and industries — a quick read on where the pipeline is concentrated. */
analyticsRouter.get(
  '/segments',
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = toTenantContext(requireAuth(req));
    assertCan(ctx, 'ANALYTICS_READ');

    // One `$facet` so both breakdowns come from a single pass over the tenant's
    // documents rather than two independent scans.
    const [result] = await leadRepository.aggregate<{
      tags: Array<{ _id: string; count: number }>;
      industries: Array<{ _id: string; count: number }>;
    }>(ctx, [
      {
        $facet: {
          tags: [
            // `$unwind` on the tags array turns one lead with three tags into
            // three documents, which is what makes the grouping possible.
            { $unwind: '$tags' },
            { $group: { _id: '$tags', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 15 },
          ],
          industries: [
            { $match: { industry: { $ne: null } } },
            { $group: { _id: '$industry', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 10 },
          ],
        },
      },
    ]);

    sendSuccess(res, {
      tags: (result?.tags ?? []).map((row) => ({ tag: row._id, count: row.count })),
      industries: (result?.industries ?? []).map((row) => ({
        industry: row._id,
        count: row.count,
      })),
    });
  }),
);
