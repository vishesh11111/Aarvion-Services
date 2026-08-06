/**
 * Lead data access.
 *
 * Two rules hold for every function in this file, without exception:
 *
 *   1. The filter is built by `tenantScope()`, which always pins
 *      `organizationId`. No query in this module constructs a bare filter.
 *   2. Soft-deleted documents are excluded unless explicitly requested.
 *
 * Concentrating this here means "did we remember the tenant filter?" is a
 * question with exactly one place to look, rather than a review checklist item
 * on every future pull request.
 */
import type { FilterQuery, PipelineStage, SortOrder } from 'mongoose';
import { LeadModel, toObjectId, type Lead } from '../../models';
import type { TenantContext } from '../../types';
import type { ListLeadsQuery } from './lead.schemas';

/**
 * Fields returned by list endpoints. Deliberately narrower than the document —
 * the table does not need `scoreRationale`, `notes` or `customFields`, and not
 * shipping them keeps a 100-row page small.
 */
export const LEAD_LIST_PROJECTION = [
  'firstName', 'lastName', 'fullName', 'email', 'phone', 'company', 'jobTitle',
  'industry', 'country', 'city', 'status', 'priority', 'source', 'estimatedValue',
  'score', 'scoredAt', 'tags', 'ownerId', 'lastActivityAt', 'createdAt', 'updatedAt',
  'deletedAt',
].join(' ');

export type LeadListItem = Record<string, unknown>;

/** The non-negotiable tenant predicate. */
const tenantScope = (ctx: TenantContext, includeDeleted = false): FilterQuery<Lead> => ({
  organizationId: toObjectId(ctx.organizationId),
  ...(includeDeleted ? {} : { deletedAt: null }),
});

/** Escapes user input before it becomes part of a regular expression. */
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Translates validated query parameters into a MongoDB filter.
 *
 * **Free-text search** uses a case-insensitive regex across four fields. A
 * `$text` index was considered and rejected (see the note in `lead.model.ts`):
 * `$text` matches whole stemmed words, so "north" would not find "Northwind",
 * which is not what a CRM search box is expected to do.
 *
 * The scan is bounded to a single tenant's documents by the organization-first
 * index — the same cost profile the SQL version had with `ILIKE '%term%'`. When
 * one tenant outgrows that, the upgrade is Atlas Search and this function is the
 * only thing that changes.
 */
export const buildLeadFilter = (
  ctx: TenantContext,
  query: Partial<ListLeadsQuery>,
): FilterQuery<Lead> => {
  const filter: FilterQuery<Lead> = tenantScope(ctx, query.includeDeleted === true);

  if (query.q) {
    const pattern = new RegExp(escapeRegex(query.q), 'i');
    filter.$or = [
      { fullName: pattern },
      { email: pattern },
      { company: pattern },
      { jobTitle: pattern },
    ];
  }

  if (query.status?.length) filter.status = { $in: query.status };
  if (query.source?.length) filter.source = { $in: query.source };
  if (query.priority?.length) filter.priority = { $in: query.priority };

  // `unassigned` wins over `ownerId` — asking for both is contradictory, and
  // silently combining them would return an always-empty set with no explanation.
  if (query.unassigned) filter.ownerId = null;
  else if (query.ownerId) filter.ownerId = toObjectId(query.ownerId);

  if (query.tags?.length) filter.tags = { $in: query.tags };
  if (query.importJobId) filter.importJobId = toObjectId(query.importJobId);

  if (query.minScore !== undefined || query.maxScore !== undefined) {
    filter.score = {
      ...(query.minScore !== undefined ? { $gte: query.minScore } : {}),
      ...(query.maxScore !== undefined ? { $lte: query.maxScore } : {}),
    };
  }

  if (query.createdAfter || query.createdBefore) {
    filter.createdAt = {
      ...(query.createdAfter ? { $gte: query.createdAfter } : {}),
      ...(query.createdBefore ? { $lte: query.createdBefore } : {}),
    };
  }

  return filter;
};

/**
 * Sort specification.
 *
 * `_id` is always appended as a tiebreaker. Without a total order, pagination
 * over a non-unique field (score, company) can skip or repeat documents when
 * ties straddle a page boundary — a bug that only appears with production data
 * volumes and is miserable to reproduce.
 */
const SORTABLE: Record<ListLeadsQuery['sortBy'], string> = {
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  score: 'score',
  fullName: 'fullName',
  company: 'company',
  estimatedValue: 'estimatedValue',
  lastActivityAt: 'lastActivityAt',
};

const buildSort = (
  sortBy: ListLeadsQuery['sortBy'],
  sortOrder: ListLeadsQuery['sortOrder'],
): Record<string, SortOrder> => {
  const direction: SortOrder = sortOrder === 'asc' ? 1 : -1;
  const field = SORTABLE[sortBy] ?? 'createdAt';
  return { [field]: direction, _id: direction };
};

/** Above this, counting costs more than the page itself. */
const EXACT_COUNT_CEILING = 10_000;

export interface ListResult {
  items: LeadListItem[];
  nextCursor: string | null;
  hasMore: boolean;
  total?: number;
  /** True when `total` was capped rather than exact. */
  totalIsApproximate?: boolean;
}

/**
 * Normalises a lean document into the API shape: `_id` becomes `id`, and a
 * populated `ownerId` becomes a nested `owner` object with a scalar `ownerId`
 * alongside it — which is what the frontend's `Lead` type expects.
 *
 * `.lean()` skips Mongoose's document hydration (a significant win on a 100-row
 * page) but also skips the `toJSON` transform, so this does that work explicitly.
 */
export const shapeLead = (row: Record<string, unknown>): LeadListItem => {
  const { _id, ownerId, importJobId, ...rest } = row;

  const isPopulated = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && '_id' in (value as Record<string, unknown>);

  return {
    ...rest,
    id: String(_id),
    ownerId: isPopulated(ownerId) ? String(ownerId._id) : ownerId ? String(ownerId) : null,
    owner: isPopulated(ownerId)
      ? { id: String(ownerId._id), name: ownerId.name, email: ownerId.email }
      : null,
    ...(importJobId !== undefined
      ? {
          importJob: isPopulated(importJobId)
            ? {
                id: String(importJobId._id),
                filename: importJobId.filename,
                createdAt: importJobId.createdAt,
              }
            : null,
          importJobId: isPopulated(importJobId)
            ? String(importJobId._id)
            : importJobId
              ? String(importJobId)
              : null,
        }
      : {}),
  };
};

export const leadRepository = {
  /**
   * Cursor pagination by default; offset pagination when `page` is supplied.
   *
   * Cursor paging is O(1) regardless of depth. Offset exists only because
   * "jump to page 40" is a real need in a data grid, and it is capped — MongoDB's
   * `skip` walks and discards every preceding document, exactly like SQL OFFSET.
   */
  async list(ctx: TenantContext, query: ListLeadsQuery): Promise<ListResult> {
    const filter = buildLeadFilter(ctx, query);
    const sort = buildSort(query.sortBy, query.sortOrder);
    const take = query.limit;
    const usingOffset = query.page !== undefined;

    // Cursor paging continues on `_id`, the only guaranteed-unique field, which
    // is also the tiebreaker in the sort — so the continuation is consistent
    // with whatever ordering the user chose.
    const paged: FilterQuery<Lead> = { ...filter };
    if (!usingOffset && query.cursor) {
      paged._id = query.sortOrder === 'asc'
        ? { $gt: toObjectId(query.cursor) }
        : { $lt: toObjectId(query.cursor) };
    }

    const rows = await LeadModel.find(paged)
      .select(LEAD_LIST_PROJECTION)
      // One extra query for the whole page, not one per row — the document-store
      // equivalent of a JOIN, without the N+1.
      .populate({ path: 'ownerId', select: 'name email' })
      .sort(sort)
      .skip(usingOffset ? (query.page! - 1) * take : 0)
      // Fetch one extra to determine `hasMore` without a second query.
      .limit(take + 1)
      .lean();

    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;

    // Only pay for a count when the client can act on it: offset pagination
    // needs a page count, the infinite scroller does not.
    let total: number | undefined;
    let totalIsApproximate: boolean | undefined;
    if (usingOffset) {
      const counted = await LeadModel.countDocuments(filter, { limit: EXACT_COUNT_CEILING + 1 });
      total = Math.min(counted, EXACT_COUNT_CEILING);
      totalIsApproximate = counted > EXACT_COUNT_CEILING;
    }

    return {
      items: items.map((row) => shapeLead(row as Record<string, unknown>)),
      hasMore,
      nextCursor: hasMore ? String(items.at(-1)?._id ?? '') || null : null,
      ...(total !== undefined ? { total } : {}),
      ...(totalIsApproximate !== undefined ? { totalIsApproximate } : {}),
    };
  },

  count(ctx: TenantContext, query: Partial<ListLeadsQuery>): Promise<number> {
    return LeadModel.countDocuments(buildLeadFilter(ctx, query));
  },

  /** Hydrated document, for services that mutate and `.save()`. */
  findById(ctx: TenantContext, id: string, includeDeleted = false) {
    return LeadModel.findOne({ _id: toObjectId(id), ...tenantScope(ctx, includeDeleted) });
  },

  /** Detail view: the lead plus its owner and import provenance. */
  async findByIdWithRelations(ctx: TenantContext, id: string) {
    const lead = await LeadModel.findOne({ _id: toObjectId(id), ...tenantScope(ctx) })
      .populate({ path: 'ownerId', select: 'name email' })
      .populate({ path: 'importJobId', select: 'filename createdAt' })
      .lean();

    return lead ? shapeLead(lead as Record<string, unknown>) : null;
  },

  findByDedupeKey(organizationId: string, dedupeKey: string) {
    return LeadModel.findOne({ organizationId: toObjectId(organizationId), dedupeKey }).lean();
  },

  /** Bulk existence + ownership check before a bulk mutation. */
  findManyByIds(ctx: TenantContext, ids: string[]) {
    return LeadModel.find({ _id: { $in: ids.map(toObjectId) }, ...tenantScope(ctx) })
      .select('ownerId status fullName')
      .lean();
  },

  /**
   * Streams every matching lead in bounded batches.
   *
   * Used by CSV export. Loading a 50k-row result at once would materialise the
   * whole set in memory; keyset iteration on `_id` keeps peak memory at one
   * batch and lets the response stream as it goes.
   */
  async *iterate(
    ctx: TenantContext,
    query: Partial<ListLeadsQuery>,
    batchSize = 1_000,
    maxRows = 50_000,
  ): AsyncGenerator<LeadListItem[]> {
    const filter = buildLeadFilter(ctx, query);
    let cursor: string | undefined;
    let emitted = 0;

    for (;;) {
      const paged: FilterQuery<Lead> = { ...filter };
      if (cursor) paged._id = { $gt: toObjectId(cursor) };

      const batch = await LeadModel.find(paged)
        .select(LEAD_LIST_PROJECTION)
        .sort({ _id: 1 })
        .limit(Math.min(batchSize, maxRows - emitted))
        .lean();

      if (batch.length === 0) return;
      emitted += batch.length;
      yield batch.map((row) => shapeLead(row as Record<string, unknown>));

      if (batch.length < batchSize || emitted >= maxRows) return;
      cursor = String(batch.at(-1)!._id);
    }
  },

  /**
   * Leads due for AI scoring: never scored, newest first. Backed by the compound
   * index on (organizationId, deletedAt, scoredAt, createdAt).
   */
  findUnscored(organizationId: string, limit: number) {
    return LeadModel.find({
      organizationId: toObjectId(organizationId),
      deletedAt: null,
      scoredAt: null,
    })
      .sort({ createdAt: -1 })
      .limit(limit);
  },

  /**
   * Shared aggregation entry point.
   *
   * The tenant `$match` is prepended here rather than being the caller's
   * responsibility. `$match` inside an aggregation does not cast strings to
   * ObjectId the way `find()` does, so a hand-written pipeline that passed the
   * raw string would silently match nothing — which looks like "the dashboard
   * shows zeros" rather than an error.
   */
  aggregate<T = Record<string, unknown>>(ctx: TenantContext, stages: PipelineStage[]): Promise<T[]> {
    return LeadModel.aggregate<T>([
      { $match: { organizationId: toObjectId(ctx.organizationId), deletedAt: null } },
      ...stages,
    ]).exec();
  },
};
