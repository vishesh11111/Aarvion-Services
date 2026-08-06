/**
 * Append-only audit trail.
 *
 * Writes are fire-and-forget by design: an audit failure must never fail the
 * user's action or add latency to the request path. Failures are logged at
 * `error` so they surface in alerting — silent loss of an audit trail is worse
 * than the original failure.
 *
 * For a regulated deployment this would move to an outbox collection drained by
 * a worker, giving exactly-once delivery. That is deliberately out of scope, and
 * `record` is the only thing that would change.
 */
import type { ClientSession } from 'mongoose';
import { AuditLogModel, toObjectId } from '../../models';
import { createLogger } from '../../lib/logger';

const log = createLogger('audit');

export const AuditAction = {
  USER_REGISTERED: 'user.registered',
  USER_LOGIN: 'user.login',
  USER_LOGIN_FAILED: 'user.login_failed',
  USER_LOGOUT: 'user.logout',
  USER_PASSWORD_CHANGED: 'user.password_changed',
  USER_INVITED: 'user.invited',
  USER_ROLE_CHANGED: 'user.role_changed',
  USER_SUSPENDED: 'user.suspended',
  TOKEN_REUSE_DETECTED: 'auth.token_reuse_detected',
  LEAD_CREATED: 'lead.created',
  LEAD_UPDATED: 'lead.updated',
  LEAD_DELETED: 'lead.deleted',
  LEAD_RESTORED: 'lead.restored',
  LEAD_BULK_UPDATED: 'lead.bulk_updated',
  LEAD_MERGED: 'lead.merged',
  IMPORT_STARTED: 'import.started',
  IMPORT_COMPLETED: 'import.completed',
  IMPORT_FAILED: 'import.failed',
  IMPORT_CANCELLED: 'import.cancelled',
  AI_SCORED: 'ai.lead_scored',
  AI_SEARCH: 'ai.nl_search',
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditEntry {
  organizationId: string;
  actorId?: string | null;
  action: AuditActionValue;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

const toDocument = (entry: AuditEntry) => ({
  organizationId: toObjectId(entry.organizationId),
  actorId: entry.actorId ? toObjectId(entry.actorId) : null,
  action: entry.action,
  entityType: entry.entityType,
  entityId: entry.entityId ?? null,
  metadata: entry.metadata ?? {},
  ipAddress: entry.ipAddress ?? null,
  userAgent: entry.userAgent ?? null,
});

export const auditService = {
  /** Non-blocking. Never throws. */
  record(entry: AuditEntry): void {
    void AuditLogModel.create(toDocument(entry)).catch((err: Error) => {
      log.error({ err: err.message, action: entry.action }, 'failed to write audit log');
    });
  },

  /**
   * Transactional variant, for actions where the audit record must commit with
   * the change itself (role escalation, ownership transfer).
   */
  async recordInTransaction(entry: AuditEntry, session?: ClientSession): Promise<void> {
    await AuditLogModel.create([toDocument(entry)], session ? { session } : {});
  },

  async list(organizationId: string, limit = 50, cursor?: string) {
    const filter: Record<string, unknown> = { organizationId: toObjectId(organizationId) };
    // Cursor pagination on `_id`: ObjectIds embed a timestamp and increase
    // monotonically, so paging by id matches creation order without needing a
    // separate sort key or a tiebreaker.
    if (cursor) filter._id = { $lt: toObjectId(cursor) };

    const rows = await AuditLogModel.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
      items,
      hasMore,
      nextCursor: hasMore ? String(items.at(-1)?._id ?? '') || null : null,
    };
  },
};
