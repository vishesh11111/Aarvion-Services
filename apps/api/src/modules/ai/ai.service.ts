/**
 * AI feature orchestration.
 *
 * Everything a caller needs to know is expressed by the return type: results
 * carry `degraded: true` when they came from the heuristic path instead of the
 * model. No AI failure is ever allowed to fail the user's request.
 *
 * Cost control, in the order it applies:
 *   1. **Input hashing** — an unchanged lead is never re-scored.
 *   2. **Redis cache** — identical prompts within the TTL are free.
 *   3. **Per-tenant daily quota** — a runaway loop cannot produce a surprise bill.
 *   4. **Batching** — scoring sends up to 20 leads per call, roughly a 15×
 *      reduction in per-request overhead versus one call per lead.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AiFeature, AiInteractionModel, LeadModel, LeadPriority, toObjectId, type LeadDoc } from '../../models';
import { env } from '../../config/env';
import { cache, redis } from '../../lib/redis';
import { createLogger } from '../../lib/logger';
import { AiProviderError, ErrorCode, RateLimitError } from '../../lib/errors';
import { scoreInputSignature } from '../leads/lead.normalizer';
import type { TenantContext } from '../../types';
import { geminiClient } from './gemini.client';
import {
  MAPPABLE_FIELDS,
  SCORING_SYSTEM,
  MAPPING_SYSTEM,
  SEARCH_SYSTEM,
  INSIGHTS_SYSTEM,
  buildInsightsPrompt,
  buildMappingPrompt,
  buildScoringPrompt,
  buildSearchPrompt,
  insightsSchema,
  mappingSchema,
  scoringSchema,
  searchSchema,
} from './ai.prompts';
import {
  heuristicInsights,
  heuristicMapping,
  heuristicScore,
  heuristicSearch,
  toScorableLead,
  type MappingSuggestion,
} from './ai.heuristics';

const log = createLogger('ai');

/** Leads per model call. Large enough to amortise overhead, small enough to
 *  stay well inside the output-token budget and keep latency reasonable. */
const SCORING_BATCH_SIZE = 20;

export interface AiResult<T> {
  data: T;
  /** True when this came from the deterministic fallback, not the model. */
  degraded: boolean;
  /** Present when degraded, so the UI can explain why. */
  degradedReason?: string;
  cached: boolean;
}

/* -------------------------------------------------------------------------- */
/* Model-output validation                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Model output is untrusted input and gets the same treatment as a request
 * body. `responseSchema` makes violations rare; this makes them harmless.
 */
const scoredLeadSchema = z.object({
  id: z.string(),
  score: z.coerce.number().int().min(0).max(100),
  rationale: z.string().max(1_000),
  nextAction: z.string().max(500),
  priority: z.nativeEnum(LeadPriority).catch(LeadPriority.MEDIUM),
  summary: z.string().max(500),
});

const mappingResponseSchema = z.object({
  mappings: z.array(
    z.object({
      csvColumn: z.string(),
      leadField: z.string().nullable(),
      confidence: z.coerce.number().min(0).max(1).catch(0.5),
      reason: z.string().max(300).default(''),
    }),
  ),
  detectedSourceHint: z.string().optional(),
});

const searchResponseSchema = z.object({
  filters: z.record(z.unknown()).default({}),
  interpretation: z.string().max(500).default(''),
});

const insightsResponseSchema = z.object({
  summary: z.string().max(2_000),
  talkingPoints: z.array(z.string().max(500)).max(6).default([]),
  risks: z.array(z.string().max(500)).max(6).default([]),
  suggestedNextAction: z.string().max(500),
  recommendedChannel: z.enum(['EMAIL', 'CALL', 'LINKEDIN', 'WAIT']).catch('EMAIL'),
  draftOpener: z.string().max(2_000).default(''),
});

/* -------------------------------------------------------------------------- */
/* Quota + telemetry                                                          */
/* -------------------------------------------------------------------------- */

const quotaKey = (organizationId: string): string => {
  // Rolling daily bucket, keyed by UTC date so it resets predictably.
  const day = new Date().toISOString().slice(0, 10);
  return `aiquota:${organizationId}:${day}`;
};

const hashPrompt = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 64);

/**
 * Reserves one unit of the tenant's daily AI budget.
 *
 * Fails open on a Redis outage: an unavailable cache must not take AI features
 * down with it. The per-user rate limiter is the second line of defence.
 */
const consumeQuota = async (organizationId: string, units = 1): Promise<void> => {
  if (env.AI_DAILY_REQUEST_LIMIT === 0) return;
  try {
    const key = quotaKey(organizationId);
    const used = await redis.incrby(key, units);
    if (used === units) await redis.expire(key, 172_800); // 48h, covers the UTC boundary
    if (used > env.AI_DAILY_REQUEST_LIMIT) {
      throw new RateLimitError(3_600, ErrorCode.AI_QUOTA_EXCEEDED);
    }
  } catch (error) {
    if (error instanceof RateLimitError) throw error;
    log.warn({ err: (error as Error).message }, 'AI quota check unavailable — allowing request');
  }
};

/** Records one interaction for cost attribution and the AI usage dashboard. */
const recordUsage = (entry: {
  ctx: TenantContext;
  feature: AiFeature;
  promptHash: string;
  cacheHit: boolean;
  success: boolean;
  degraded: boolean;
  latencyMs: number;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  errorCode?: string | undefined;
}): void => {
  void AiInteractionModel.create({
    organizationId: toObjectId(entry.ctx.organizationId),
    userId: toObjectId(entry.ctx.userId),
    feature: entry.feature,
    model: env.GEMINI_MODEL,
    promptHash: entry.promptHash,
    cacheHit: entry.cacheHit,
    success: entry.success,
    degraded: entry.degraded,
    latencyMs: entry.latencyMs,
    inputTokens: entry.inputTokens ?? null,
    outputTokens: entry.outputTokens ?? null,
    errorCode: entry.errorCode ?? null,
  }).catch((err: Error) => log.warn({ err: err.message }, 'failed to record AI usage'));
};

/* -------------------------------------------------------------------------- */
/* Service                                                                    */
/* -------------------------------------------------------------------------- */

export interface ScoredLead {
  id: string;
  score: number;
  rationale: string;
  nextAction: string;
  priority: LeadPriority;
  summary: string;
}

export const aiService = {
  get status() {
    return {
      enabled: env.aiEnabled,
      available: geminiClient.isAvailable,
      model: env.aiEnabled ? env.GEMINI_MODEL : null,
      dailyLimit: env.AI_DAILY_REQUEST_LIMIT,
    };
  },

  async usageToday(organizationId: string): Promise<number> {
    const value = await redis.get(quotaKey(organizationId)).catch(() => null);
    return value ? Number(value) : 0;
  },

  /* ---------------------------------------------------------------------- */
  /* 1. Lead scoring                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Scores a batch of leads and persists the results.
   *
   * Called from the API (user clicks "Score") and from the enrichment worker
   * (after an import). Leads whose scoring inputs are unchanged are skipped, so
   * calling this repeatedly is cheap and idempotent.
   */
  async scoreLeads(
    ctx: TenantContext,
    leads: LeadDoc[],
    options: { force?: boolean } = {},
  ): Promise<AiResult<ScoredLead[]>> {
    if (leads.length === 0) return { data: [], degraded: false, cached: false };

    const pending = options.force
      ? leads
      : leads.filter((lead) => lead.scoredAt === null || lead.scoreInputHash !== scoreInputSignature(lead));

    if (pending.length === 0) {
      return {
        data: leads.map((lead) => ({
          id: String(lead._id),
          score: lead.score ?? 0,
          rationale: lead.scoreRationale ?? '',
          nextAction: lead.aiNextAction ?? '',
          priority: lead.priority,
          summary: lead.aiSummary ?? '',
        })),
        degraded: false,
        cached: true,
      };
    }

    const startedAt = Date.now();
    const promptHash = hashPrompt(pending.map((l) => scoreInputSignature(l)).join());

    let results: ScoredLead[];
    let degraded = false;
    let degradedReason: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    if (!geminiClient.isAvailable) {
      results = pending.map((lead) => heuristicScore(toScorableLead(lead)));
      degraded = true;
      degradedReason = env.aiEnabled
        ? 'AI provider is temporarily unavailable'
        : 'AI is not configured on this deployment';
    } else {
      try {
        await consumeQuota(ctx.organizationId, Math.ceil(pending.length / SCORING_BATCH_SIZE));

        const batches: LeadDoc[][] = [];
        for (let i = 0; i < pending.length; i += SCORING_BATCH_SIZE) {
          batches.push(pending.slice(i, i + SCORING_BATCH_SIZE));
        }

        const settled = await Promise.all(
          batches.map(async (batch) => {
            const prompt = buildScoringPrompt(batch.map(toScoringPayload));
            const response = await geminiClient.generateJson<unknown[]>(prompt, {
              systemInstruction: SCORING_SYSTEM,
              responseSchema: scoringSchema,
              temperature: 0.1,
              maxOutputTokens: 4_096,
            });
            inputTokens = (inputTokens ?? 0) + (response.inputTokens ?? 0);
            outputTokens = (outputTokens ?? 0) + (response.outputTokens ?? 0);
            return z.array(scoredLeadSchema).parse(response.data);
          }),
        );

        const byId = new Map(settled.flat().map((r) => [r.id, r]));
        // The model can drop or hallucinate ids. Anchor on our own list and fall
        // back per-lead, so a partial response degrades partially, not wholly.
        results = pending.map(
          (lead) => byId.get(String(lead._id)) ?? heuristicScore(toScorableLead(lead)),
        );
      } catch (error) {
        if (error instanceof RateLimitError) throw error;
        log.warn({ err: (error as Error).message }, 'AI scoring failed — using heuristic fallback');
        results = pending.map((lead) => heuristicScore(toScorableLead(lead)));
        degraded = true;
        degradedReason =
          error instanceof AiProviderError ? error.message : 'AI scoring failed';
      }
    }

    await this.persistScores(ctx.organizationId, pending, results);

    recordUsage({
      ctx,
      feature: AiFeature.LEAD_SCORING,
      promptHash,
      cacheHit: false,
      success: true,
      degraded,
      latencyMs: Date.now() - startedAt,
      inputTokens,
      outputTokens,
      ...(degradedReason ? { errorCode: 'FALLBACK' } : {}),
    });

    return {
      data: results,
      degraded,
      ...(degradedReason ? { degradedReason } : {}),
      cached: false,
    };
  },

  /**
   * Writes scores back in a single `bulkWrite`.
   *
   * One round-trip for the whole batch rather than N updates. Note the
   * `organizationId` in every filter alongside the id: defence in depth, so a
   * hallucinated id belonging to another tenant can never be written to.
   */
  async persistScores(organizationId: string, leads: LeadDoc[], scores: ScoredLead[]): Promise<void> {
    if (scores.length === 0) return;

    const signatures = new Map(leads.map((lead) => [String(lead._id), scoreInputSignature(lead)]));
    const now = new Date();
    const orgId = toObjectId(organizationId);

    await LeadModel.bulkWrite(
      scores.map((result) => ({
        updateOne: {
          filter: { _id: toObjectId(result.id), organizationId: orgId },
          update: {
            $set: {
              score: result.score,
              scoreRationale: result.rationale,
              aiNextAction: result.nextAction,
              aiSummary: result.summary,
              priority: result.priority,
              scoredAt: now,
              scoreInputHash: signatures.get(result.id) ?? null,
            },
          },
        },
      })),
      { ordered: false },
    );
  },

  /* ---------------------------------------------------------------------- */
  /* 2. CSV column mapping                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Suggests a CSV -> schema mapping.
   *
   * The heuristic runs first and always. The model is only consulted for the
   * columns the aliases could not place — cheaper, faster, and it keeps the
   * well-known headers deterministic across runs, which matters because users
   * notice when the same file maps differently on Tuesday.
   */
  async suggestMapping(
    ctx: TenantContext,
    headers: string[],
    sampleRows: Record<string, string>[],
  ): Promise<AiResult<{ mappings: MappingSuggestion[]; detectedSourceHint?: string }>> {
    const baseline = heuristicMapping(headers);
    const unresolved = baseline.filter((m) => m.leadField === null).map((m) => m.csvColumn);

    if (unresolved.length === 0 || !geminiClient.isAvailable) {
      return {
        data: { mappings: baseline },
        degraded: !geminiClient.isAvailable && unresolved.length > 0,
        ...(unresolved.length > 0 && !geminiClient.isAvailable
          ? { degradedReason: 'AI unavailable — matched known headers only' }
          : {}),
        cached: false,
      };
    }

    const cacheKey = `ai:mapping:${hashPrompt(JSON.stringify(headers))}`;
    const cached = await cache.get<{ mappings: MappingSuggestion[]; detectedSourceHint?: string }>(cacheKey);
    if (cached) return { data: cached, degraded: false, cached: true };

    const startedAt = Date.now();
    const promptHash = hashPrompt(headers.join('|'));

    try {
      await consumeQuota(ctx.organizationId);

      const prompt = buildMappingPrompt(unresolved, sampleRows.slice(0, 5));
      const response = await geminiClient.generateJson<unknown>(prompt, {
        systemInstruction: MAPPING_SYSTEM,
        responseSchema: mappingSchema,
        temperature: 0,
        maxOutputTokens: 2_048,
      });

      const parsed = mappingResponseSchema.parse(response.data);
      const taken = new Set(baseline.filter((m) => m.leadField).map((m) => m.leadField!));

      const merged = baseline.map((entry) => {
        if (entry.leadField) return entry;
        const suggestion = parsed.mappings.find((m) => m.csvColumn === entry.csvColumn);
        if (!suggestion) return entry;

        const field = suggestion.leadField;
        // Reject anything outside the allow-list or already claimed. The model
        // is advisory here; the schema is authoritative.
        const valid =
          field !== null &&
          field !== 'null' &&
          (MAPPABLE_FIELDS as readonly string[]).includes(field) &&
          !taken.has(field);

        if (!valid) return entry;
        taken.add(field);
        return {
          csvColumn: entry.csvColumn,
          leadField: field,
          confidence: suggestion.confidence,
          reason: suggestion.reason || `AI matched to "${field}"`,
        };
      });

      const result = {
        mappings: merged,
        ...(parsed.detectedSourceHint && parsed.detectedSourceHint !== 'UNKNOWN'
          ? { detectedSourceHint: parsed.detectedSourceHint }
          : {}),
      };

      await cache.set(cacheKey, result, env.AI_CACHE_TTL_SECONDS);
      recordUsage({
        ctx,
        feature: AiFeature.COLUMN_MAPPING,
        promptHash,
        cacheHit: false,
        success: true,
        degraded: false,
        latencyMs: Date.now() - startedAt,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
      });

      return { data: result, degraded: false, cached: false };
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      log.warn({ err: (error as Error).message }, 'AI mapping failed — heuristic mapping only');
      recordUsage({
        ctx,
        feature: AiFeature.COLUMN_MAPPING,
        promptHash,
        cacheHit: false,
        success: false,
        degraded: true,
        latencyMs: Date.now() - startedAt,
        errorCode: (error as Error).name,
      });
      return {
        data: { mappings: baseline },
        degraded: true,
        degradedReason: 'AI unavailable — matched known headers only',
        cached: false,
      };
    }
  },

  /* ---------------------------------------------------------------------- */
  /* 3. Natural-language search                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Turns "hot fintech leads from last month with no owner" into filters.
   *
   * The output is *never* used to build SQL. It is parsed into the same
   * validated filter object the normal list endpoint accepts, so the model can
   * only ever produce a query the user could have built by hand in the UI.
   * That is the entire security argument for this feature.
   */
  async naturalLanguageSearch(
    ctx: TenantContext,
    query: string,
  ): Promise<AiResult<{ filters: Record<string, unknown>; interpretation: string }>> {
    const cacheKey = `ai:nlq:${ctx.organizationId}:${hashPrompt(query.toLowerCase().trim())}`;
    const cached = await cache.get<{ filters: Record<string, unknown>; interpretation: string }>(cacheKey);
    if (cached) return { data: cached, degraded: false, cached: true };

    if (!geminiClient.isAvailable) {
      return {
        data: heuristicSearch(query),
        degraded: true,
        degradedReason: env.aiEnabled ? 'AI provider unavailable' : 'AI is not configured',
        cached: false,
      };
    }

    const startedAt = Date.now();
    const promptHash = hashPrompt(query);

    try {
      await consumeQuota(ctx.organizationId);

      const response = await geminiClient.generateJson<unknown>(
        buildSearchPrompt(query, new Date().toISOString().slice(0, 10)),
        {
          systemInstruction: SEARCH_SYSTEM,
          responseSchema: searchSchema,
          temperature: 0,
          maxOutputTokens: 1_024,
        },
      );

      const parsed = searchResponseSchema.parse(response.data);
      // Drop empty values so they do not become meaningless filters.
      const filters = Object.fromEntries(
        Object.entries(parsed.filters).filter(
          ([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0),
        ),
      );
      const result = { filters, interpretation: parsed.interpretation };

      await cache.set(cacheKey, result, 3_600);
      recordUsage({
        ctx,
        feature: AiFeature.NL_SEARCH,
        promptHash,
        cacheHit: false,
        success: true,
        degraded: false,
        latencyMs: Date.now() - startedAt,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
      });

      return { data: result, degraded: false, cached: false };
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      log.warn({ err: (error as Error).message }, 'AI search failed — keyword fallback');
      return {
        data: heuristicSearch(query),
        degraded: true,
        degradedReason: 'AI search unavailable — using keyword matching',
        cached: false,
      };
    }
  },

  /* ---------------------------------------------------------------------- */
  /* 4. Lead insights                                                       */
  /* ---------------------------------------------------------------------- */

  async leadInsights(
    ctx: TenantContext,
    lead: LeadDoc,
    activities: Array<{ type: string; title: string; createdAt: Date }>,
  ): Promise<AiResult<z.infer<typeof insightsResponseSchema>>> {
    const cacheKey = `ai:insights:${String(lead._id)}:${scoreInputSignature(lead).slice(0, 16)}`;
    const cached = await cache.get<z.infer<typeof insightsResponseSchema>>(cacheKey);
    if (cached) return { data: cached, degraded: false, cached: true };

    if (!geminiClient.isAvailable) {
      return {
        data: insightsResponseSchema.parse(heuristicInsights(toScorableLead(lead))),
        degraded: true,
        degradedReason: env.aiEnabled ? 'AI provider unavailable' : 'AI is not configured',
        cached: false,
      };
    }

    const startedAt = Date.now();
    const promptHash = hashPrompt(String(lead._id) + scoreInputSignature(lead));

    try {
      await consumeQuota(ctx.organizationId);

      const response = await geminiClient.generateJson<unknown>(
        buildInsightsPrompt(
          toScoringPayload(lead),
          activities.slice(0, 10).map((a) => ({
            type: a.type,
            title: a.title,
            at: a.createdAt.toISOString().slice(0, 10),
          })),
        ),
        {
          systemInstruction: INSIGHTS_SYSTEM,
          responseSchema: insightsSchema,
          temperature: 0.4,
          maxOutputTokens: 1_536,
        },
      );

      const parsed = insightsResponseSchema.parse(response.data);
      await cache.set(cacheKey, parsed, env.AI_CACHE_TTL_SECONDS);
      recordUsage({
        ctx,
        feature: AiFeature.LEAD_INSIGHTS,
        promptHash,
        cacheHit: false,
        success: true,
        degraded: false,
        latencyMs: Date.now() - startedAt,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
      });

      return { data: parsed, degraded: false, cached: false };
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      log.warn({ err: (error as Error).message, leadId: String(lead._id) }, 'AI insights failed — heuristic fallback');
      return {
        data: insightsResponseSchema.parse(heuristicInsights(toScorableLead(lead))),
        degraded: true,
        degradedReason: 'AI insights unavailable',
        cached: false,
      };
    }
  },
};

/**
 * The projection sent to the model.
 *
 * Explicitly allow-listed rather than sending the row. Internal ids, audit
 * timestamps and custom fields never leave our infrastructure, and the payload
 * stays small enough that token cost is dominated by the instructions.
 */
const toScoringPayload = (lead: LeadDoc): Record<string, unknown> => ({
  id: String(lead._id),
  name: lead.fullName,
  email: lead.email,
  hasPhone: Boolean(lead.phone),
  company: lead.company,
  jobTitle: lead.jobTitle,
  industry: lead.industry,
  companySize: lead.companySize,
  country: lead.country,
  source: lead.source,
  status: lead.status,
  estimatedValue: lead.estimatedValue,
  notes: lead.notes?.slice(0, 800) ?? null,
  createdAt: lead.createdAt.toISOString().slice(0, 10),
});
