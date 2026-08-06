/**
 * Lead business logic.
 *
 * Everything that is a *rule* rather than a *query* lives here: duplicate
 * resolution, permission checks that need the document, activity timeline
 * writes, cache invalidation, and merge semantics.
 */
import type { ClientSession, UpdateQuery } from 'mongoose';
import {
  ActivityType,
  LeadActivityModel,
  LeadModel,
  LeadSource,
  LeadStatus,
  Role,
  UserModel,
  toObjectId,
  valuesOf,
  type Lead,
  type LeadDoc,
} from '../../models';
import { isDuplicateKeyError, withTransaction } from '../../lib/db';
import { cache } from '../../lib/redis';
import { createLogger } from '../../lib/logger';
import { ConflictError, ErrorCode, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors';
import { auditService, AuditAction } from '../audit/audit.service';
import { assertCan, canMutateLead } from '../auth/rbac';
import type { TenantContext } from '../../types';
import { leadRepository, shapeLead, type LeadListItem, type ListResult } from './lead.repository';
import {
  buildFullName,
  cleanString,
  dedupeKeyFor,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  normalizeTags,
  normalizeUrl,
} from './lead.normalizer';
import type {
  BulkUpdateInput,
  CreateActivityInput,
  CreateLeadInput,
  ListLeadsQuery,
  MergeLeadsInput,
  UpdateLeadInput,
} from './lead.schemas';

const log = createLogger('leads');

/* -------------------------------------------------------------------------- */
/* Caching                                                                    */
/* -------------------------------------------------------------------------- */

const STATS_CACHE_TTL = 60;
const statsCacheKey = (organizationId: string) => `stats:${organizationId}`;

/**
 * Any mutation invalidates the tenant's derived-data caches. We invalidate by
 * tenant prefix rather than surgically patching cached aggregates — cheap, and
 * impossible to get subtly wrong.
 */
const invalidateTenantCaches = async (organizationId: string): Promise<void> => {
  await Promise.all([
    cache.del(statsCacheKey(organizationId)),
    cache.delByPattern(`analytics:${organizationId}:*`),
  ]);
};

/* -------------------------------------------------------------------------- */
/* Normalisation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Applies the same cleaning rules the CSV importer uses, so a lead typed into
 * the UI and the same lead imported from a file produce identical documents —
 * and therefore collide on the dedupe key, as they should.
 */
const normalizeCreateInput = (input: CreateLeadInput) => {
  const firstName = normalizeName(input.firstName);
  const lastName = normalizeName(input.lastName);
  const company = cleanString(input.company, 200);
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);
  const fullName = buildFullName(firstName, lastName, email ?? company);

  return {
    firstName: firstName ?? null,
    lastName: lastName ?? null,
    fullName,
    email: email ?? null,
    phone: phone ?? null,
    company: company ?? null,
    jobTitle: cleanString(input.jobTitle, 160) ?? null,
    website: normalizeUrl(input.website) ?? null,
    industry: cleanString(input.industry, 120) ?? null,
    companySize: cleanString(input.companySize, 40) ?? null,
    city: cleanString(input.city, 120) ?? null,
    state: cleanString(input.state, 120) ?? null,
    country: cleanString(input.country, 120) ?? null,
    status: input.status,
    priority: input.priority,
    source: input.source,
    sourceDetail: cleanString(input.sourceDetail, 200) ?? null,
    estimatedValue: input.estimatedValue ?? null,
    tags: normalizeTags(input.tags),
    notes: cleanString(input.notes, 5_000) ?? null,
    customFields: input.customFields ?? {},
  };
};

/** Fields whose change requires the dedupe key to be recomputed. */
const IDENTITY_FIELDS = ['email', 'phone', 'firstName', 'lastName', 'company'] as const;

const touchesIdentity = (patch: UpdateLeadInput): boolean =>
  IDENTITY_FIELDS.some((field) => field in patch);

/** Serialises a hydrated document through the same shaper the list path uses. */
const present = (doc: LeadDoc): LeadListItem =>
  shapeLead(doc.toObject({ transform: false }) as Record<string, unknown>);

/* -------------------------------------------------------------------------- */
/* Service                                                                    */
/* -------------------------------------------------------------------------- */

export const leadService = {
  async list(ctx: TenantContext, query: ListLeadsQuery): Promise<ListResult> {
    assertCan(ctx, 'LEAD_READ');
    // Only admins and owners may look at the recycle bin.
    const effective: ListLeadsQuery = {
      ...query,
      includeDeleted: query.includeDeleted && (ctx.role === Role.ADMIN || ctx.role === Role.OWNER),
    };
    return leadRepository.list(ctx, effective);
  },

  async getById(ctx: TenantContext, id: string) {
    assertCan(ctx, 'LEAD_READ');

    const lead = await leadRepository.findByIdWithRelations(ctx, id);
    if (!lead) throw new NotFoundError('Lead');

    // The timeline lives in its own collection (see lead-activity.model for why
    // it is not embedded), so it is fetched alongside.
    const activities = await LeadActivityModel.find({
      leadId: toObjectId(id),
      organizationId: toObjectId(ctx.organizationId),
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate({ path: 'userId', select: 'name' })
      .lean();

    return {
      ...lead,
      activities: activities.map((activity) => {
        const { _id, userId, ...rest } = activity as Record<string, unknown>;
        const populated =
          typeof userId === 'object' && userId !== null && '_id' in (userId as object);
        return {
          ...rest,
          id: String(_id),
          user: populated
            ? {
                id: String((userId as Record<string, unknown>)._id),
                name: (userId as Record<string, unknown>).name,
              }
            : null,
        };
      }),
    };
  },

  /**
   * Creates a lead, refusing to create a duplicate.
   *
   * The uniqueness check is *not* a read-then-write: two concurrent requests
   * would both pass a pre-check. We attempt the insert and translate MongoDB's
   * duplicate-key error into a 409, which is race-free by construction.
   */
  async create(ctx: TenantContext, input: CreateLeadInput) {
    assertCan(ctx, 'LEAD_WRITE');

    const normalized = normalizeCreateInput(input);
    const dedupeKey = dedupeKeyFor(normalized);

    // Members may only assign leads to themselves; admins may assign to anyone.
    let ownerId = input.ownerId ?? null;
    if (ownerId && ownerId !== ctx.userId) {
      if (ctx.role === Role.MEMBER) ownerId = ctx.userId;
      else {
        const exists = await UserModel.exists({
          _id: toObjectId(ownerId),
          organizationId: toObjectId(ctx.organizationId),
        });
        if (!exists) throw new ValidationError('Assigned owner is not a member of this organization');
      }
    }

    try {
      const lead = await withTransaction(async (tx?: ClientSession) => {
        const options = tx ? { session: tx } : {};

        const [created] = await LeadModel.create(
          [
            {
              ...normalized,
              organizationId: toObjectId(ctx.organizationId),
              ownerId: ownerId ? toObjectId(ownerId) : null,
              dedupeKey,
              lastActivityAt: new Date(),
            },
          ],
          options,
        );

        await LeadActivityModel.create(
          [
            {
              organizationId: toObjectId(ctx.organizationId),
              leadId: created!._id,
              userId: toObjectId(ctx.userId),
              type: ActivityType.CREATED,
              title: 'Lead created',
              metadata: { source: created!.source },
            },
          ],
          options,
        );

        return created!;
      });

      auditService.record({
        organizationId: ctx.organizationId,
        actorId: ctx.userId,
        action: AuditAction.LEAD_CREATED,
        entityType: 'lead',
        entityId: String(lead._id),
      });
      await invalidateTenantCaches(ctx.organizationId);

      return present(lead);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        const existing = await leadRepository.findByDedupeKey(ctx.organizationId, dedupeKey);
        throw new ConflictError(
          'A lead with this email, phone or name/company already exists',
          ErrorCode.DUPLICATE_LEAD,
          existing
            ? { existingLeadId: String(existing._id), existingLeadName: existing.fullName }
            : undefined,
        );
      }
      throw error;
    }
  },

  async update(ctx: TenantContext, id: string, patch: UpdateLeadInput) {
    assertCan(ctx, 'LEAD_WRITE');

    const current = await leadRepository.findById(ctx, id);
    if (!current) throw new NotFoundError('Lead');

    if (!canMutateLead(ctx, current.ownerId ? String(current.ownerId) : null)) {
      throw new ForbiddenError('You can only edit leads assigned to you or unassigned leads');
    }

    const previousStatus = current.status;
    const previousOwner = current.ownerId ? String(current.ownerId) : null;

    // Only touch what the caller actually sent. `undefined` = leave alone,
    // `null` = clear — the distinction PATCH exists to express.
    if ('firstName' in patch) current.firstName = patch.firstName ? normalizeName(patch.firstName) ?? null : null;
    if ('lastName' in patch) current.lastName = patch.lastName ? normalizeName(patch.lastName) ?? null : null;
    if ('email' in patch) current.email = patch.email ? normalizeEmail(patch.email) ?? null : null;
    if ('phone' in patch) current.phone = patch.phone ? normalizePhone(patch.phone) ?? null : null;
    if ('company' in patch) current.company = patch.company ? cleanString(patch.company, 200) ?? null : null;
    if ('jobTitle' in patch) current.jobTitle = patch.jobTitle ? cleanString(patch.jobTitle, 160) ?? null : null;
    if ('website' in patch) current.website = patch.website ? normalizeUrl(patch.website) ?? null : null;
    if ('industry' in patch) current.industry = patch.industry ? cleanString(patch.industry, 120) ?? null : null;
    if ('companySize' in patch) current.companySize = patch.companySize ?? null;
    if ('city' in patch) current.city = patch.city ?? null;
    if ('state' in patch) current.state = patch.state ?? null;
    if ('country' in patch) current.country = patch.country ?? null;
    if (patch.status !== undefined) current.status = patch.status;
    if (patch.priority !== undefined) current.priority = patch.priority;
    if (patch.source !== undefined) current.source = patch.source;
    if ('sourceDetail' in patch) current.sourceDetail = patch.sourceDetail ?? null;
    if ('estimatedValue' in patch) current.estimatedValue = patch.estimatedValue ?? null;
    if (patch.tags !== undefined) current.tags = normalizeTags(patch.tags);
    if ('notes' in patch) current.notes = patch.notes ?? null;
    if (patch.customFields !== undefined) current.customFields = patch.customFields;

    if ('ownerId' in patch) {
      if (patch.ownerId === null) current.ownerId = null;
      else if (patch.ownerId) {
        const exists = await UserModel.exists({
          _id: toObjectId(patch.ownerId),
          organizationId: toObjectId(ctx.organizationId),
        });
        if (!exists) throw new ValidationError('Assigned owner is not a member of this organization');
        current.ownerId = toObjectId(patch.ownerId);
      }
    }

    // Keep the denormalised name and the dedupe key consistent with the identity
    // fields they are derived from.
    if (touchesIdentity(patch)) {
      current.fullName = buildFullName(
        current.firstName ?? undefined,
        current.lastName ?? undefined,
        current.email ?? current.company ?? undefined,
      );
      current.dedupeKey = dedupeKeyFor({
        email: current.email,
        phone: current.phone,
        fullName: current.fullName,
        company: current.company,
      });
      // The commercial profile changed, so any existing AI score is stale.
      current.scoreInputHash = null;
    }

    const statusChanged = patch.status !== undefined && patch.status !== previousStatus;
    const ownerChanged = 'ownerId' in patch && (patch.ownerId ?? null) !== previousOwner;
    if (statusChanged) current.lastActivityAt = new Date();

    try {
      await withTransaction(async (tx?: ClientSession) => {
        const options = tx ? { session: tx } : {};
        await current.save(options);

        const activities: Record<string, unknown>[] = [];
        if (statusChanged) {
          activities.push({
            organizationId: toObjectId(ctx.organizationId),
            leadId: current._id,
            userId: toObjectId(ctx.userId),
            type: ActivityType.STATUS_CHANGE,
            title: `Status changed to ${current.status}`,
            metadata: { from: previousStatus, to: current.status },
          });
        }
        if (ownerChanged) {
          activities.push({
            organizationId: toObjectId(ctx.organizationId),
            leadId: current._id,
            userId: toObjectId(ctx.userId),
            type: ActivityType.OWNER_CHANGE,
            title: patch.ownerId ? 'Owner reassigned' : 'Owner cleared',
            metadata: { from: previousOwner, to: patch.ownerId ?? null },
          });
        }
        if (activities.length > 0) await LeadActivityModel.create(activities, options);
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new ConflictError(
          'Another lead already uses this email, phone or name/company',
          ErrorCode.DUPLICATE_LEAD,
        );
      }
      throw error;
    }

    auditService.record({
      organizationId: ctx.organizationId,
      actorId: ctx.userId,
      action: AuditAction.LEAD_UPDATED,
      entityType: 'lead',
      entityId: String(current._id),
      metadata: { fields: Object.keys(patch) },
    });
    await invalidateTenantCaches(ctx.organizationId);

    return present(current);
  },

  /** Soft delete — recoverable via `restore` for 30 days. */
  async remove(ctx: TenantContext, id: string): Promise<void> {
    assertCan(ctx, 'LEAD_DELETE');

    const lead = await leadRepository.findById(ctx, id);
    if (!lead) throw new NotFoundError('Lead');
    if (!canMutateLead(ctx, lead.ownerId ? String(lead.ownerId) : null)) {
      throw new ForbiddenError('You can only delete leads assigned to you or unassigned leads');
    }

    lead.deletedAt = new Date();
    // Free the natural key so the same person can be re-added immediately — the
    // unique index covers deleted documents too.
    lead.dedupeKey = `deleted:${String(lead._id)}`;
    await lead.save();

    auditService.record({
      organizationId: ctx.organizationId,
      actorId: ctx.userId,
      action: AuditAction.LEAD_DELETED,
      entityType: 'lead',
      entityId: String(lead._id),
      metadata: { fullName: lead.fullName },
    });
    await invalidateTenantCaches(ctx.organizationId);
  },

  async restore(ctx: TenantContext, id: string) {
    assertCan(ctx, 'LEAD_DELETE');

    const lead = await LeadModel.findOne({
      _id: toObjectId(id),
      organizationId: toObjectId(ctx.organizationId),
      deletedAt: { $ne: null },
    });
    if (!lead) throw new NotFoundError('Deleted lead');

    const dedupeKey = dedupeKeyFor(lead);
    const conflict = await leadRepository.findByDedupeKey(ctx.organizationId, dedupeKey);
    if (conflict) {
      throw new ConflictError(
        'An active lead now occupies this identity — merge instead of restoring',
        ErrorCode.DUPLICATE_LEAD,
        { conflictingLeadId: String(conflict._id) },
      );
    }

    lead.deletedAt = null;
    lead.dedupeKey = dedupeKey;
    await lead.save();

    auditService.record({
      organizationId: ctx.organizationId,
      actorId: ctx.userId,
      action: AuditAction.LEAD_RESTORED,
      entityType: 'lead',
      entityId: String(lead._id),
    });
    await invalidateTenantCaches(ctx.organizationId);
    return present(lead);
  },

  /**
   * Bulk field update.
   *
   * One `updateMany` per distinct change rather than N round-trips — a 500-lead
   * status change is 1–3 commands, not 500. Tag add/remove use `$addToSet` and
   * `$pull`, atomic set operations the server applies per document, which is
   * strictly better than the read-modify-write the SQL version needed.
   */
  async bulkUpdate(ctx: TenantContext, input: BulkUpdateInput): Promise<{ updated: number }> {
    assertCan(ctx, 'LEAD_BULK_WRITE');

    const targets = await leadRepository.findManyByIds(ctx, input.leadIds);
    if (targets.length === 0) throw new NotFoundError('Leads');

    const permitted = targets.filter((lead) =>
      canMutateLead(ctx, lead.ownerId ? String(lead.ownerId) : null),
    );
    if (permitted.length === 0) {
      throw new ForbiddenError('You do not have permission to modify any of the selected leads');
    }
    const ids = permitted.map((lead) => lead._id);

    const scope = {
      _id: { $in: ids },
      organizationId: toObjectId(ctx.organizationId),
      deletedAt: null,
    };

    const { patch } = input;
    const set: Record<string, unknown> = {};
    if (patch.status !== undefined) {
      set.status = patch.status;
      set.lastActivityAt = new Date();
    }
    if (patch.priority !== undefined) set.priority = patch.priority;
    if (patch.ownerId !== undefined) set.ownerId = patch.ownerId ? toObjectId(patch.ownerId) : null;

    let updated = 0;

    if (Object.keys(set).length > 0) {
      const result = await LeadModel.updateMany(scope, { $set: set });
      updated = result.modifiedCount;
    }

    if (patch.addTags?.length) {
      const tags = normalizeTags(patch.addTags);
      await LeadModel.updateMany(scope, { $addToSet: { tags: { $each: tags } } });
    }
    if (patch.removeTags?.length) {
      const tags = normalizeTags(patch.removeTags);
      await LeadModel.updateMany(scope, { $pull: { tags: { $in: tags } } } as UpdateQuery<Lead>);
    }

    if (patch.status !== undefined) {
      await LeadActivityModel.insertMany(
        ids.map((leadId) => ({
          organizationId: toObjectId(ctx.organizationId),
          leadId,
          userId: toObjectId(ctx.userId),
          type: ActivityType.STATUS_CHANGE,
          title: `Status changed to ${patch.status}`,
          metadata: { to: patch.status, bulk: true },
        })),
        // Timeline entries are secondary: one bad document must not abort an
        // otherwise-successful bulk status change.
        { ordered: false },
      );
    }

    auditService.record({
      organizationId: ctx.organizationId,
      actorId: ctx.userId,
      action: AuditAction.LEAD_BULK_UPDATED,
      entityType: 'lead',
      metadata: { count: updated, patch },
    });
    await invalidateTenantCaches(ctx.organizationId);

    return { updated: updated || ids.length };
  },

  async bulkDelete(ctx: TenantContext, leadIds: string[]): Promise<{ deleted: number }> {
    assertCan(ctx, 'LEAD_DELETE');

    const targets = await leadRepository.findManyByIds(ctx, leadIds);
    const permitted = targets.filter((lead) =>
      canMutateLead(ctx, lead.ownerId ? String(lead.ownerId) : null),
    );
    if (permitted.length === 0) throw new ForbiddenError('No deletable leads in the selection');

    const now = new Date();

    /*
     * Each document needs its own `dedupeKey` rewrite, which `updateMany` cannot
     * express because the new value references the document's own `_id`.
     * `bulkWrite` sends all of them in one round-trip instead of N.
     */
    const result = await LeadModel.bulkWrite(
      permitted.map((lead) => ({
        updateOne: {
          filter: {
            _id: lead._id,
            organizationId: toObjectId(ctx.organizationId),
            deletedAt: null,
          },
          update: { $set: { deletedAt: now, dedupeKey: `deleted:${String(lead._id)}` } },
        },
      })),
      { ordered: false },
    );

    const deleted = result.modifiedCount;

    auditService.record({
      organizationId: ctx.organizationId,
      actorId: ctx.userId,
      action: AuditAction.LEAD_DELETED,
      entityType: 'lead',
      metadata: { count: deleted, bulk: true },
    });
    await invalidateTenantCaches(ctx.organizationId);

    return { deleted };
  },

  /**
   * Merges duplicates into a primary record.
   *
   * Merge policy: the primary wins on every field it already has a value for;
   * duplicates only fill blanks. Tags union, activities move across, and the
   * duplicates are soft-deleted with their keys freed. Never destructive.
   */
  async merge(ctx: TenantContext, input: MergeLeadsInput) {
    assertCan(ctx, 'LEAD_WRITE');

    const all = await LeadModel.find({
      _id: { $in: [input.primaryId, ...input.duplicateIds].map(toObjectId) },
      organizationId: toObjectId(ctx.organizationId),
      deletedAt: null,
    });

    const primary = all.find((lead) => String(lead._id) === input.primaryId);
    if (!primary) throw new NotFoundError('Primary lead');

    const duplicates = all.filter((lead) => String(lead._id) !== input.primaryId);
    if (duplicates.length === 0) throw new NotFoundError('Duplicate leads');

    const fillable = [
      'firstName', 'lastName', 'email', 'phone', 'company', 'jobTitle', 'website',
      'industry', 'companySize', 'city', 'state', 'country', 'notes', 'estimatedValue',
    ] as const;

    for (const field of fillable) {
      if (primary[field] === null || primary[field] === undefined) {
        const donor = duplicates.find((d) => d[field] !== null && d[field] !== undefined);
        if (donor) (primary as unknown as Record<string, unknown>)[field] = donor[field];
      }
    }

    primary.tags = normalizeTags([...primary.tags, ...duplicates.flatMap((d) => d.tags)]);
    primary.customFields = duplicates.reduce<Record<string, unknown>>(
      (acc, dup) => ({ ...(dup.customFields as Record<string, unknown>), ...acc }),
      { ...(primary.customFields as Record<string, unknown>) },
    );
    primary.lastActivityAt = new Date();
    primary.scoreInputHash = null; // profile changed; re-score

    const duplicateIds = duplicates.map((d) => d._id);

    await withTransaction(async (tx?: ClientSession) => {
      const options = tx ? { session: tx } : {};

      // Move history so the surviving record keeps the full interaction trail.
      await LeadActivityModel.updateMany(
        { leadId: { $in: duplicateIds } },
        { $set: { leadId: primary._id } },
        options,
      );

      await primary.save(options);

      // Soft-delete each duplicate and free its natural key, in one round-trip.
      await LeadModel.bulkWrite(
        duplicates.map((dup) => ({
          updateOne: {
            filter: { _id: dup._id },
            update: { $set: { deletedAt: new Date(), dedupeKey: `merged:${String(dup._id)}` } },
          },
        })),
        { ...options, ordered: false },
      );

      await LeadActivityModel.create(
        [
          {
            organizationId: toObjectId(ctx.organizationId),
            leadId: primary._id,
            userId: toObjectId(ctx.userId),
            type: ActivityType.MERGED,
            title: `Merged ${duplicates.length} duplicate${duplicates.length === 1 ? '' : 's'}`,
            metadata: {
              mergedIds: duplicateIds.map(String),
              mergedNames: duplicates.map((d) => d.fullName),
            },
          },
        ],
        options,
      );
    });

    auditService.record({
      organizationId: ctx.organizationId,
      actorId: ctx.userId,
      action: AuditAction.LEAD_MERGED,
      entityType: 'lead',
      entityId: String(primary._id),
      metadata: { mergedIds: duplicateIds.map(String) },
    });
    await invalidateTenantCaches(ctx.organizationId);
    log.info({ primaryId: String(primary._id), merged: duplicates.length }, 'leads merged');

    return present(primary);
  },

  async addActivity(ctx: TenantContext, leadId: string, input: CreateActivityInput) {
    assertCan(ctx, 'LEAD_WRITE');

    const lead = await leadRepository.findById(ctx, leadId);
    if (!lead) throw new NotFoundError('Lead');

    const [activity] = await Promise.all([
      LeadActivityModel.create({
        organizationId: toObjectId(ctx.organizationId),
        leadId: toObjectId(leadId),
        userId: toObjectId(ctx.userId),
        type: input.type as ActivityType,
        title: input.title,
        body: input.body ?? null,
      }),
      LeadModel.updateOne({ _id: toObjectId(leadId) }, { $set: { lastActivityAt: new Date() } }),
    ]);

    return { ...activity.toJSON(), user: { id: ctx.userId } };
  },

  /**
   * Pipeline summary for the dashboard.
   *
   * A single `$facet` aggregation rather than six separate queries: it produces
   * every figure the dashboard needs in one round-trip over one pass of the
   * tenant's documents. Cached for 60s — it is read on every dashboard load and
   * tolerates being a minute stale.
   */
  async stats(ctx: TenantContext): Promise<LeadStats> {
    assertCan(ctx, 'ANALYTICS_READ');

    const key = statsCacheKey(ctx.organizationId);
    const cached = await cache.get<LeadStats>(key);
    if (cached) return cached;

    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);

    const [facets] = await leadRepository.aggregate<{
      total: Array<{ count: number }>;
      byStatus: Array<{ _id: LeadStatus; count: number }>;
      bySource: Array<{ _id: LeadSource; count: number }>;
      totals: Array<{ averageScore: number | null; pipelineValue: number | null }>;
      recent: Array<{ count: number }>;
      unscored: Array<{ count: number }>;
    }>(ctx, [
      {
        $facet: {
          total: [{ $count: 'count' }],
          byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
          bySource: [{ $group: { _id: '$source', count: { $sum: 1 } } }],
          totals: [
            {
              $group: {
                _id: null,
                averageScore: { $avg: '$score' },
                pipelineValue: { $sum: { $ifNull: ['$estimatedValue', 0] } },
              },
            },
          ],
          recent: [{ $match: { createdAt: { $gte: thirtyDaysAgo } } }, { $count: 'count' }],
          unscored: [{ $match: { scoredAt: null } }, { $count: 'count' }],
        },
      },
    ]);

    const statusCounts = Object.fromEntries(
      valuesOf(LeadStatus).map((status) => [
        status,
        facets?.byStatus.find((row) => row._id === status)?.count ?? 0,
      ]),
    ) as Record<LeadStatus, number>;

    const won = statusCounts[LeadStatus.WON];
    const closed = won + statusCounts[LeadStatus.LOST];
    const averageScore = facets?.totals[0]?.averageScore ?? null;

    const stats: LeadStats = {
      total: facets?.total[0]?.count ?? 0,
      newLast30Days: facets?.recent[0]?.count ?? 0,
      unscored: facets?.unscored[0]?.count ?? 0,
      byStatus: statusCounts,
      bySource: Object.fromEntries(
        valuesOf(LeadSource).map((source) => [
          source,
          facets?.bySource.find((row) => row._id === source)?.count ?? 0,
        ]),
      ) as Record<LeadSource, number>,
      averageScore: averageScore !== null ? Math.round(averageScore) : null,
      pipelineValue: facets?.totals[0]?.pipelineValue ?? 0,
      // Guard against 0/0 producing NaN, which serialises to null and breaks charts.
      conversionRate: closed > 0 ? Math.round((won / closed) * 1000) / 10 : 0,
    };

    await cache.set(key, stats, STATS_CACHE_TTL);
    return stats;
  },
};

export interface LeadStats {
  total: number;
  newLast30Days: number;
  unscored: number;
  byStatus: Record<LeadStatus, number>;
  bySource: Record<LeadSource, number>;
  averageScore: number | null;
  pipelineValue: number;
  conversionRate: number;
}
