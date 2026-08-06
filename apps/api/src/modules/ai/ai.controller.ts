import type { Request, Response } from 'express';
import { z } from 'zod';
import { objectId } from '../../lib/validators';
import { AiInteractionModel, LeadActivityModel, LeadModel, toObjectId } from '../../models';
import { asyncHandler, sendSuccess } from '../../lib/http';
import { requireAuth } from '../../middleware/authenticate';
import { NotFoundError } from '../../lib/errors';
import { toTenantContext } from '../../types';
import { assertCan } from '../auth/rbac';
import { auditService, AuditAction } from '../audit/audit.service';
import { leadRepository } from '../leads/lead.repository';
import { leadService } from '../leads/lead.service';
import { listLeadsSchema } from '../leads/lead.schemas';
import { aiService } from './ai.service';

const ctxOf = (req: Request) => toTenantContext(requireAuth(req));

export const scoreLeadsSchema = z
  .object({
    /** Explicit ids, or omit to score the oldest unscored leads. */
    leadIds: z.array(objectId()).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    force: z.coerce.boolean().default(false),
  })
  .strict();

export const nlSearchSchema = z
  .object({ query: z.string().trim().min(3).max(500) })
  .strict();

export const aiController = {
  status: asyncHandler(async (req: Request, res: Response) => {
    const auth = requireAuth(req);
    sendSuccess(res, {
      ...aiService.status,
      usedToday: await aiService.usageToday(auth.organizationId),
    });
  }),

  /**
   * Scores leads on demand. With no `leadIds`, picks up the backlog of unscored
   * leads — which is what the "Score all" button in the UI calls.
   */
  scoreLeads: asyncHandler(async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    assertCan(ctx, 'AI_USE');

    const { leadIds, limit, force } = req.body as z.infer<typeof scoreLeadsSchema>;

    const leads = leadIds?.length
      ? await LeadModel.find({
          _id: { $in: leadIds.map(toObjectId) },
          organizationId: toObjectId(ctx.organizationId),
          deletedAt: null,
        })
      : await leadRepository.findUnscored(ctx.organizationId, limit);

    if (leads.length === 0) {
      sendSuccess(res, { scored: [], message: 'No leads required scoring' });
      return;
    }

    const result = await aiService.scoreLeads(ctx, leads, { force });

    auditService.record({
      organizationId: ctx.organizationId,
      actorId: ctx.userId,
      action: AuditAction.AI_SCORED,
      entityType: 'lead',
      metadata: { count: result.data.length, degraded: result.degraded },
    });

    sendSuccess(res, { scored: result.data }, 200, {
      degraded: result.degraded,
      ...(result.degradedReason ? { degradedReason: result.degradedReason } : {}),
      cached: result.cached,
    });
  }),

  /**
   * Natural-language search.
   *
   * Returns both the leads and the filters that produced them, so the UI can
   * show the user exactly what was searched and let them adjust it by hand —
   * an AI feature the user cannot inspect or correct is a liability.
   */
  search: asyncHandler(async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    assertCan(ctx, 'LEAD_READ');

    const { query } = req.body as z.infer<typeof nlSearchSchema>;
    const interpreted = await aiService.naturalLanguageSearch(ctx, query);

    // The model's filters go through exactly the same validation as a
    // hand-written query string. Anything invalid is dropped, not trusted.
    const parsed = listLeadsSchema.safeParse({ ...interpreted.data.filters, limit: 25 });
    const filters = parsed.success ? parsed.data : listLeadsSchema.parse({ limit: 25 });

    const results = await leadService.list(ctx, filters);

    auditService.record({
      organizationId: ctx.organizationId,
      actorId: ctx.userId,
      action: AuditAction.AI_SEARCH,
      entityType: 'lead',
      metadata: { query: query.slice(0, 200), degraded: interpreted.degraded },
    });

    sendSuccess(res, results.items, 200, {
      interpretation: interpreted.data.interpretation,
      appliedFilters: parsed.success ? interpreted.data.filters : {},
      filtersRejected: !parsed.success,
      nextCursor: results.nextCursor,
      hasMore: results.hasMore,
      limit: filters.limit,
      degraded: interpreted.degraded,
      ...(interpreted.degradedReason ? { degradedReason: interpreted.degradedReason } : {}),
      cached: interpreted.cached,
    });
  }),

  insights: asyncHandler(async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    assertCan(ctx, 'AI_USE');

    const leadId = req.params.id as string;
    const lead = await leadRepository.findById(ctx, leadId);
    if (!lead) throw new NotFoundError('Lead');

    const activities = await LeadActivityModel.find({
      leadId: toObjectId(leadId),
      organizationId: toObjectId(ctx.organizationId),
    })
      .select('type title createdAt')
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    const result = await aiService.leadInsights(ctx, lead, activities);

    sendSuccess(res, result.data, 200, {
      degraded: result.degraded,
      ...(result.degradedReason ? { degradedReason: result.degradedReason } : {}),
      cached: result.cached,
    });
  }),

  /** Per-feature AI usage for the last 30 days. Powers the admin usage panel. */
  usage: asyncHandler(async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    assertCan(ctx, 'ANALYTICS_READ');

    const since = new Date(Date.now() - 30 * 86_400_000);

    // A single `$facet` produces the per-feature breakdown and the totals from
    // one pass over the tenant's interactions, rather than three round-trips.
    const [result] = await AiInteractionModel.aggregate<{
      byFeature: Array<{
        _id: string;
        calls: number;
        averageLatencyMs: number | null;
        inputTokens: number;
        outputTokens: number;
      }>;
      totals: Array<{ calls: number; inputTokens: number; outputTokens: number }>;
      degraded: Array<{ count: number }>;
    }>([
      {
        $match: {
          organizationId: toObjectId(ctx.organizationId),
          createdAt: { $gte: since },
        },
      },
      {
        $facet: {
          byFeature: [
            {
              $group: {
                _id: '$feature',
                calls: { $sum: 1 },
                averageLatencyMs: { $avg: '$latencyMs' },
                inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
                outputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
              },
            },
            { $sort: { calls: -1 } },
          ],
          totals: [
            {
              $group: {
                _id: null,
                calls: { $sum: 1 },
                inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
                outputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
              },
            },
          ],
          degraded: [{ $match: { degraded: true } }, { $count: 'count' }],
        },
      },
    ]);

    const totals = result?.totals[0];

    sendSuccess(res, {
      periodDays: 30,
      totalCalls: totals?.calls ?? 0,
      totalInputTokens: totals?.inputTokens ?? 0,
      totalOutputTokens: totals?.outputTokens ?? 0,
      degradedCalls: result?.degraded[0]?.count ?? 0,
      usedToday: await aiService.usageToday(ctx.organizationId),
      dailyLimit: aiService.status.dailyLimit,
      byFeature: (result?.byFeature ?? []).map((row) => ({
        feature: row._id,
        calls: row.calls,
        averageLatencyMs: Math.round(row.averageLatencyMs ?? 0),
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
      })),
    });
  }),
};
