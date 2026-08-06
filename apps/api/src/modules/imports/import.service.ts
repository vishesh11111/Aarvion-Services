/**
 * Import orchestration (API side).
 *
 * The HTTP flow is deliberately two-phase:
 *
 *   1. POST /imports          — upload, sniff headers, propose a mapping.
 *                               Nothing is written to `leads` yet.
 *   2. POST /imports/:id/start — user confirms/corrects the mapping; the job is
 *                               enqueued and a 202 is returned immediately.
 *
 * A one-shot "upload and import" endpoint would be simpler, but importing 50k
 * customer records under a mapping nobody looked at is how CRMs end up full of
 * phone numbers in the job-title column. The confirmation step is the product.
 */
import {
  ImportErrorModel,
  ImportJobModel,
  ImportStatus,
  TERMINAL_IMPORT_STATUSES,
  UserModel,
  toObjectId,
  type LeadSource,
} from '../../models';
import { env } from '../../config/env';
import { createLogger } from '../../lib/logger';
import {
  BadRequestError,
  ConflictError,
  ErrorCode,
  NotFoundError,
  ServiceUnavailableError,
} from '../../lib/errors';
import { auditService, AuditAction } from '../audit/audit.service';
import { assertCan } from '../auth/rbac';
import { aiService } from '../ai/ai.service';
import { importQueue } from '../../queues';
import { discardUpload } from '../../middleware/upload';
import type { TenantContext } from '../../types';
import { previewCsv } from './csv.parser';
import { MAPPABLE_FIELDS } from '../ai/ai.prompts';
import type { ColumnMapping } from './import.mapper';

const log = createLogger('imports');

/**
 * Queue job id for an import.
 *
 * Deterministic, so a double-submitted import cannot be enqueued twice and
 * `cancel` can find the queued entry. BullMQ rejects ':' in custom job ids,
 * which is why this is a helper rather than an inline template string — the two
 * call sites must not drift apart.
 */
const queueJobId = (importJobId: string): string => `import-${importJobId}`;

export interface StartImportOptions {
  columnMapping: ColumnMapping;
  duplicateStrategy: 'SKIP' | 'UPDATE' | 'CREATE_ANYWAY';
  defaultSource: LeadSource;
  defaultOwnerId?: string | null;
  keepUnmappedAsCustomFields: boolean;
  autoScore: boolean;
}

export const importService = {
  /**
   * Phase 1: register the uploaded file and propose a column mapping.
   *
   * The file is already on disk (streamed there by the upload middleware); this
   * only reads its first 64 KB.
   */
  async createFromUpload(
    ctx: TenantContext,
    file: { originalName: string; storageKey: string; sizeBytes: number },
  ) {
    assertCan(ctx, 'IMPORT_CREATE');

    try {
      const preview = await previewCsv(file.storageKey);

      if (preview.rows.length === 0) {
        throw new BadRequestError('The file has a header row but no data rows', ErrorCode.INVALID_FILE);
      }

      const suggestion = await aiService.suggestMapping(ctx, preview.headers, preview.rows);

      const columnMapping: ColumnMapping = Object.fromEntries(
        suggestion.data.mappings.map((m) => [m.csvColumn, m.leadField]),
      );

      const job = await ImportJobModel.create({
        organizationId: toObjectId(ctx.organizationId),
        createdById: toObjectId(ctx.userId),
        filename: file.originalName,
        storageKey: file.storageKey,
        fileSizeBytes: file.sizeBytes,
        status: ImportStatus.PENDING,
        detectedHeaders: preview.headers,
        columnMapping,
        options: { delimiter: preview.delimiter },
        totalRows: preview.estimatedRows,
      });

      log.info(
        {
          importJobId: String(job._id),
          headers: preview.headers.length,
          estimatedRows: preview.estimatedRows,
        },
        'import created',
      );

      return {
        job: { id: String(job._id), filename: job.filename, status: job.status },
        preview: {
          headers: preview.headers,
          sampleRows: preview.rows,
          estimatedRows: preview.estimatedRows,
          delimiter: preview.delimiter,
        },
        mapping: {
          suggestions: suggestion.data.mappings,
          ...(suggestion.data.detectedSourceHint
            ? { detectedSourceHint: suggestion.data.detectedSourceHint }
            : {}),
          degraded: suggestion.degraded,
          ...(suggestion.degradedReason ? { degradedReason: suggestion.degradedReason } : {}),
        },
      };
    } catch (error) {
      // Never leave an orphaned upload on the volume if we could not register it.
      await discardUpload(file.storageKey);
      throw error;
    }
  },

  /** Phase 2: validate the confirmed mapping and enqueue the job. */
  async start(ctx: TenantContext, importJobId: string, options: StartImportOptions) {
    assertCan(ctx, 'IMPORT_CREATE');

    const job = await ImportJobModel.findOne({
      _id: toObjectId(importJobId),
      organizationId: toObjectId(ctx.organizationId),
    });
    if (!job) throw new NotFoundError('Import job');

    if (job.status !== ImportStatus.PENDING) {
      throw new ConflictError(`This import is already ${job.status.toLowerCase()}`);
    }

    this.validateMapping(options.columnMapping, job.detectedHeaders);

    if (options.defaultOwnerId) {
      const owner = await UserModel.exists({
        _id: toObjectId(options.defaultOwnerId),
        organizationId: toObjectId(ctx.organizationId),
      });
      if (!owner) throw new BadRequestError('Default owner is not a member of this organization');
    }

    job.status = ImportStatus.VALIDATING;
    job.columnMapping = options.columnMapping;
    job.options = {
      ...(job.options as Record<string, unknown>),
      duplicateStrategy: options.duplicateStrategy,
      defaultSource: options.defaultSource,
      defaultOwnerId: options.defaultOwnerId ?? null,
      keepUnmappedAsCustomFields: options.keepUnmappedAsCustomFields,
      autoScore: options.autoScore,
    };
    await job.save();

    try {
      await importQueue.add(
        'process-import',
        {
          importJobId: String(job._id),
          organizationId: ctx.organizationId,
          userId: ctx.userId,
        },
        { jobId: queueJobId(String(job._id)) },
      );
    } catch (error) {
      // The document is already VALIDATING. Leaving it there would show the user
      // an import that is permanently "starting" with no worker coming for it.
      job.status = ImportStatus.FAILED;
      job.failureReason = 'Could not queue the import — the job queue is unavailable.';
      job.completedAt = new Date();
      await job.save();

      log.error(
        { importJobId: String(job._id), err: (error as Error).message },
        'failed to enqueue import',
      );
      throw new ServiceUnavailableError('Import queue is unavailable — please try again shortly');
    }

    auditService.record({
      organizationId: ctx.organizationId,
      actorId: ctx.userId,
      action: AuditAction.IMPORT_STARTED,
      entityType: 'import_job',
      entityId: String(job._id),
      metadata: { filename: job.filename, duplicateStrategy: options.duplicateStrategy },
    });

    log.info({ importJobId: String(job._id) }, 'import enqueued');
    return { id: String(job._id), status: job.status };
  },

  /**
   * Rejects mappings that would silently corrupt data: unknown target fields,
   * unknown source columns, or two columns writing to the same field
   * (last-write-wins is not something a user can reason about).
   */
  validateMapping(mapping: ColumnMapping, detectedHeaders: string[]): void {
    const headers = new Set(detectedHeaders);
    const targets = new Set<string>();

    for (const [column, field] of Object.entries(mapping)) {
      if (!headers.has(column)) {
        throw new BadRequestError(`Column "${column}" is not present in the uploaded file`);
      }
      if (field === null) continue;
      if (!(MAPPABLE_FIELDS as readonly string[]).includes(field)) {
        throw new BadRequestError(`"${field}" is not a mappable lead field`);
      }
      if (targets.has(field)) {
        throw new BadRequestError(`Two columns are mapped to "${field}" — each field accepts one column`);
      }
      targets.add(field);
    }

    // Without one of these, every row would dedupe to a random key and the
    // import would produce an unusable pile of anonymous records.
    const hasIdentity = ['email', 'phone', 'fullName', 'firstName', 'lastName', 'company'].some((f) =>
      targets.has(f),
    );
    if (!hasIdentity) {
      throw new BadRequestError(
        'Map at least one identifying column (email, phone, name or company) before importing',
      );
    }
  },

  async get(ctx: TenantContext, importJobId: string) {
    assertCan(ctx, 'IMPORT_READ');

    const job = await ImportJobModel.findOne({
      _id: toObjectId(importJobId),
      organizationId: toObjectId(ctx.organizationId),
    })
      .populate({ path: 'createdById', select: 'name' })
      .lean();
    if (!job) throw new NotFoundError('Import job');

    // Never leak the server-side storage path.
    const { _id, storageKey: _storageKey, createdById, ...safe } = job as Record<string, unknown>;
    void _storageKey;

    const total = Number(safe.totalRows ?? 0);
    const processed = Number(safe.processedRows ?? 0);

    return {
      ...safe,
      id: String(_id),
      createdBy:
        createdById && typeof createdById === 'object' && '_id' in (createdById as object)
          ? {
              id: String((createdById as Record<string, unknown>)._id),
              name: (createdById as Record<string, unknown>).name,
            }
          : null,
      progress: total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0,
    };
  },

  async list(ctx: TenantContext, limit = 20, cursor?: string) {
    assertCan(ctx, 'IMPORT_READ');

    const filter: Record<string, unknown> = { organizationId: toObjectId(ctx.organizationId) };
    if (cursor) filter._id = { $lt: toObjectId(cursor) };

    const rows = await ImportJobModel.find(filter)
      .select(
        'filename status totalRows processedRows createdCount updatedCount skippedCount ' +
          'errorCount failureReason startedAt completedAt createdAt createdById',
      )
      .populate({ path: 'createdById', select: 'name' })
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      items: items.map((row) => {
        const { _id, createdById, ...rest } = row as Record<string, unknown>;
        return {
          ...rest,
          id: String(_id),
          createdBy:
            createdById && typeof createdById === 'object' && '_id' in (createdById as object)
              ? {
                  id: String((createdById as Record<string, unknown>)._id),
                  name: (createdById as Record<string, unknown>).name,
                }
              : null,
        };
      }),
      hasMore,
      nextCursor: hasMore ? String(items.at(-1)?._id ?? '') || null : null,
    };
  },

  /** Row-level failures, paginated — this is what the user downloads and fixes. */
  async listErrors(ctx: TenantContext, importJobId: string, limit = 100, offset = 0) {
    assertCan(ctx, 'IMPORT_READ');

    const job = await ImportJobModel.exists({
      _id: toObjectId(importJobId),
      organizationId: toObjectId(ctx.organizationId),
    });
    if (!job) throw new NotFoundError('Import job');

    const [errors, total] = await Promise.all([
      ImportErrorModel.find({ importJobId: toObjectId(importJobId) })
        .sort({ rowNumber: 1 })
        .skip(offset)
        .limit(Math.min(limit, 500))
        .lean(),
      ImportErrorModel.countDocuments({ importJobId: toObjectId(importJobId) }),
    ]);

    return {
      errors: errors.map((row) => {
        const { _id, ...rest } = row as Record<string, unknown>;
        return { ...rest, id: String(_id) };
      }),
      total,
    };
  },

  /**
   * Cancels a queued or running import.
   *
   * A running job is signalled cooperatively: the worker checks the status at
   * every batch boundary. Killing it mid-batch would leave the counters lying
   * about what was actually written.
   */
  async cancel(ctx: TenantContext, importJobId: string) {
    assertCan(ctx, 'IMPORT_CREATE');

    const job = await ImportJobModel.findOne({
      _id: toObjectId(importJobId),
      organizationId: toObjectId(ctx.organizationId),
    });
    if (!job) throw new NotFoundError('Import job');

    const cancellable: string[] = [
      ImportStatus.PENDING,
      ImportStatus.VALIDATING,
      ImportStatus.PROCESSING,
    ];
    if (!cancellable.includes(job.status)) {
      throw new ConflictError(`Cannot cancel an import that is ${job.status.toLowerCase()}`);
    }

    const wasPending = job.status === ImportStatus.PENDING;
    job.status = ImportStatus.CANCELLED;
    job.completedAt = new Date();
    await job.save();

    // Remove it from the queue if it has not started yet.
    const queued = await importQueue.getJob(queueJobId(String(job._id)));
    if (queued && (await queued.isWaiting())) await queued.remove().catch(() => undefined);

    if (wasPending) await discardUpload(job.storageKey);

    auditService.record({
      organizationId: ctx.organizationId,
      actorId: ctx.userId,
      action: AuditAction.IMPORT_CANCELLED,
      entityType: 'import_job',
      entityId: String(job._id),
    });

    return { id: String(job._id), status: job.status };
  },

  /** Deletes uploads whose job finished more than 24h ago. Run by maintenance. */
  async cleanupProcessedUploads(): Promise<number> {
    const cutoff = new Date(Date.now() - 86_400_000);
    const jobs = await ImportJobModel.find({
      completedAt: { $lt: cutoff },
      storageKey: { $nin: ['', null] },
      status: { $in: TERMINAL_IMPORT_STATUSES },
    })
      .select('storageKey')
      .limit(500)
      .lean();

    for (const job of jobs) {
      await discardUpload(job.storageKey);
      await ImportJobModel.updateOne({ _id: job._id }, { $set: { storageKey: '' } });
    }

    if (jobs.length > 0) log.info({ count: jobs.length }, 'cleaned up processed uploads');
    return jobs.length;
  },
};

export const MAX_IMPORT_BYTES = env.MAX_UPLOAD_BYTES;
