/**
 * CSV import worker.
 *
 * Processes one import job: stream the file, map each row, and write leads in
 * batches. Designed around four constraints that only show up with real data.
 *
 *  1. **Bounded memory.** Rows are consumed from a stream and flushed every
 *     `IMPORT_BATCH_SIZE`. Peak memory is one batch, whether the file has 500
 *     rows or 5 million.
 *
 *  2. **Duplicates are the normal case, not the error case.** People re-upload
 *     last month's export with 200 new rows. The strategy is chosen by the user
 *     (SKIP / UPDATE / CREATE_ANYWAY) and applied per batch.
 *
 *  3. **Partial failure is expected.** One malformed row must not fail 50k good
 *     ones. Row errors are recorded individually and the job completes as
 *     COMPLETED_WITH_ERRORS.
 *
 *  4. **Retries must not duplicate data.** BullMQ can re-deliver a job after a
 *     crash. Writes are upserts keyed on (organizationId, dedupeKey), so
 *     re-running an import converges rather than doubling it.
 */
import { Worker, type Job } from 'bullmq';
import {
  ImportErrorModel,
  ImportJobModel,
  ImportStatus,
  LeadModel,
  LeadSource,
  toObjectId,
} from '../models';
import { env } from '../config/env';
import { createLogger } from '../lib/logger';
import { cache, createQueueConnection } from '../lib/redis';
import { QueueName, enrichmentQueue, type ImportJobPayload } from '../queues';
import { auditService, AuditAction } from '../modules/audit/audit.service';
import { streamCsv, type CsvRow } from '../modules/imports/csv.parser';
import {
  mapRow,
  type ColumnMapping,
  type MappedLeadFields,
  type RowError,
} from '../modules/imports/import.mapper';

const log = createLogger('import-worker');

type DuplicateStrategy = 'SKIP' | 'UPDATE' | 'CREATE_ANYWAY';

interface JobOptions {
  delimiter: string;
  duplicateStrategy: DuplicateStrategy;
  defaultSource: LeadSource;
  defaultOwnerId: string | null;
  keepUnmappedAsCustomFields: boolean;
  autoScore: boolean;
}

interface Counters {
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
}

/** How often progress is flushed to the database — every N rows. */
const PROGRESS_INTERVAL = 500;

/** Cap on recorded row errors, so a catastrophically bad file cannot write millions. */
const MAX_RECORDED_ERRORS = 5_000;

const readOptions = (raw: unknown): JobOptions => {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    delimiter: typeof o.delimiter === 'string' ? o.delimiter : ',',
    duplicateStrategy: (o.duplicateStrategy as DuplicateStrategy) ?? 'SKIP',
    defaultSource: (o.defaultSource as LeadSource) ?? LeadSource.CSV_IMPORT,
    defaultOwnerId: (o.defaultOwnerId as string | null) ?? null,
    keepUnmappedAsCustomFields: o.keepUnmappedAsCustomFields !== false,
    autoScore: o.autoScore === true,
  };
};

/**
 * Writes one batch with a single `bulkWrite`.
 *
 * This is the heart of import throughput. Naively, each row needs a lookup and
 * an insert: ~1000 round-trips per 500-row batch. Instead the whole batch goes
 * out as one command, and the duplicate strategy is expressed declaratively:
 *
 *   • SKIP   — upsert with `$setOnInsert` only. Existing documents are matched
 *              and left completely untouched; only new keys are inserted.
 *   • UPDATE — upsert with `$set` for the fields the file provided plus
 *              `$setOnInsert` for creation-only fields, so a field the CSV does
 *              not carry is never blanked out.
 *   • CREATE_ANYWAY — uniquified keys, so every row lands as its own document.
 *
 * Using upserts rather than insert-then-catch is what makes a retried job
 * idempotent: re-running converges on the same result instead of erroring or
 * doubling the data.
 */
const flushBatch = async (
  organizationId: string,
  importJobId: string,
  batch: Array<{ data: MappedLeadFields; dedupeKey: string }>,
  strategy: DuplicateStrategy,
  counters: Counters,
): Promise<void> => {
  if (batch.length === 0) return;

  const orgId = toObjectId(organizationId);
  const jobId = toObjectId(importJobId);

  // Within-file duplicates: last occurrence wins, matching how people expect a
  // spreadsheet's later corrections to override earlier rows.
  const byKey = new Map<string, MappedLeadFields>();
  for (const row of batch) {
    if (strategy === 'CREATE_ANYWAY') {
      const unique = `${row.dedupeKey}:${Date.now()}:${byKey.size}`;
      byKey.set(unique, { ...row.data, dedupeKey: unique });
    } else {
      if (byKey.has(row.dedupeKey)) counters.skipped += 1;
      byKey.set(row.dedupeKey, { ...row.data, dedupeKey: row.dedupeKey });
    }
  }

  const rows = [...byKey.values()];

  // Typed from the method itself rather than hand-written as
  // `AnyBulkWriteOperation<Lead>`: Mongoose wraps the document type
  // (`Pick<Lead, keyof Lead> & { _id?: ObjectId }`), and deriving the type keeps
  // this correct across Mongoose versions instead of chasing their generics.
  const operations: Parameters<typeof LeadModel.bulkWrite>[0] = rows.map((row) => {
    const { dedupeKey, ownerId, ...fields } = row;

    const base = {
      ...fields,
      ownerId: ownerId ? toObjectId(ownerId) : null,
      organizationId: orgId,
      importJobId: jobId,
    };

    /*
     * `createdAt` / `updatedAt` are never set by hand here.
     *
     * With `timestamps: true` on the schema, Mongoose injects its own
     * `$set: { updatedAt }` and `$setOnInsert: { createdAt }` into every
     * bulkWrite operation. Specifying them ourselves makes MongoDB reject the
     * whole batch with "Updating the path 'updatedAt' would create a conflict".
     *
     * `dedupeKey` is likewise omitted from the update: on an upsert MongoDB
     * derives it from the equality condition in the filter.
     */
    if (strategy === 'UPDATE') {
      // Only fields the file actually provided are written, so a column the CSV
      // does not carry is never blanked out on an existing lead.
      const settable = Object.fromEntries(
        Object.entries(base).filter(([, value]) => value !== null && value !== undefined),
      );
      return {
        updateOne: {
          filter: { organizationId: orgId, dedupeKey },
          update: {
            $set: {
              ...settable,
              // A re-import revives a soft-deleted lead, and the commercial
              // profile may have changed, so the AI score is invalidated.
              deletedAt: null,
              scoreInputHash: null,
            },
          },
          upsert: true,
        },
      };
    }

    return {
      updateOne: {
        filter: { organizationId: orgId, dedupeKey },
        update: { $setOnInsert: base },
        upsert: true,
      },
    };
  });

  // `ordered: false` lets the server continue past an individual failure and
  // execute the remaining operations — the batch equivalent of "one bad row must
  // not fail the import".
  const result = await LeadModel.bulkWrite(operations, { ordered: false });

  counters.created += result.upsertedCount;
  if (strategy === 'UPDATE') {
    counters.updated += result.modifiedCount;
    counters.skipped += Math.max(0, rows.length - result.upsertedCount - result.modifiedCount);
  } else {
    counters.skipped += Math.max(0, rows.length - result.upsertedCount);
  }
};

/** Persists row errors in bulk. */
const flushErrors = async (importJobId: string, errors: RowError[]): Promise<void> => {
  if (errors.length === 0) return;
  await ImportErrorModel.insertMany(
    errors.map((e) => ({
      importJobId: toObjectId(importJobId),
      rowNumber: e.rowNumber,
      field: e.field ?? null,
      message: e.message.slice(0, 500),
      rawRow: e.rawRow,
    })),
    { ordered: false },
  );
};

export const processImportJob = async (job: Job<ImportJobPayload>): Promise<Counters> => {
  const { importJobId, organizationId, userId } = job.data;
  const empty: Counters = { processed: 0, created: 0, updated: 0, skipped: 0, errors: 0 };

  const record = await ImportJobModel.findOne({
    _id: toObjectId(importJobId),
    organizationId: toObjectId(organizationId),
  });
  if (!record) {
    log.warn({ importJobId }, 'import job vanished before processing');
    return empty;
  }
  if (record.status === ImportStatus.CANCELLED) {
    log.info({ importJobId }, 'import was cancelled before it started');
    return empty;
  }

  const options = readOptions(record.options);
  const mapping = record.columnMapping as ColumnMapping;

  await ImportJobModel.updateOne(
    { _id: record._id },
    { $set: { status: ImportStatus.PROCESSING, startedAt: new Date(), processedRows: 0 } },
  );

  const counters: Counters = { ...empty };
  let batch: Array<{ data: MappedLeadFields; dedupeKey: string }> = [];
  let errorBuffer: RowError[] = [];
  let rowNumber = 1; // row 1 is the header
  let cancelled = false;

  const parser = streamCsv(record.storageKey, options.delimiter);

  try {
    for await (const raw of parser) {
      const row = raw as CsvRow;
      rowNumber += 1;

      const mapped = mapRow(row, {
        mapping,
        defaultSource: options.defaultSource,
        sourceDetail: record.filename,
        defaultOwnerId: options.defaultOwnerId,
        keepUnmappedAsCustomFields: options.keepUnmappedAsCustomFields,
      });

      if (!mapped.ok) {
        counters.errors += 1;
        if (counters.errors <= MAX_RECORDED_ERRORS) {
          errorBuffer.push({
            rowNumber,
            ...(mapped.error.field ? { field: mapped.error.field } : {}),
            message: mapped.error.message,
            rawRow: row,
          });
        }
      } else {
        batch.push({ data: mapped.lead.data, dedupeKey: mapped.lead.dedupeKey });
      }

      counters.processed += 1;

      if (batch.length >= env.IMPORT_BATCH_SIZE) {
        await flushBatch(organizationId, importJobId, batch, options.duplicateStrategy, counters);
        batch = [];
      }
      if (errorBuffer.length >= 200) {
        await flushErrors(importJobId, errorBuffer);
        errorBuffer = [];
      }

      if (counters.processed % PROGRESS_INTERVAL === 0) {
        // Cooperative cancellation, checked at a safe point where the counters
        // accurately describe what has been committed.
        const current = await ImportJobModel.findById(record._id).select('status').lean();
        if (current?.status === ImportStatus.CANCELLED) {
          cancelled = true;
          break;
        }

        await ImportJobModel.updateOne(
          { _id: record._id },
          {
            $set: {
              processedRows: counters.processed,
              createdCount: counters.created,
              updatedCount: counters.updated,
              skippedCount: counters.skipped,
              errorCount: counters.errors,
              // Correct the estimate once we know better than the byte-size guess.
              ...(counters.processed > record.totalRows ? { totalRows: counters.processed } : {}),
            },
          },
        );
        await job.updateProgress(
          record.totalRows > 0
            ? Math.min(99, Math.round((counters.processed / record.totalRows) * 100))
            : 0,
        );
      }
    }

    // Final flush of whatever is left in the buffers.
    await flushBatch(organizationId, importJobId, batch, options.duplicateStrategy, counters);
    await flushErrors(importJobId, errorBuffer);

    const status = cancelled
      ? ImportStatus.CANCELLED
      : counters.errors > 0
        ? ImportStatus.COMPLETED_WITH_ERRORS
        : ImportStatus.COMPLETED;

    await ImportJobModel.updateOne(
      { _id: record._id },
      {
        $set: {
          status,
          totalRows: counters.processed,
          processedRows: counters.processed,
          createdCount: counters.created,
          updatedCount: counters.updated,
          skippedCount: counters.skipped,
          errorCount: counters.errors,
          completedAt: new Date(),
        },
      },
    );

    // The dashboard counts are now wrong; drop the tenant's cached aggregates.
    await Promise.all([
      cache.del(`stats:${organizationId}`),
      cache.delByPattern(`analytics:${organizationId}:*`),
    ]);

    auditService.record({
      organizationId,
      actorId: userId,
      action: cancelled ? AuditAction.IMPORT_CANCELLED : AuditAction.IMPORT_COMPLETED,
      entityType: 'import_job',
      entityId: importJobId,
      metadata: { ...counters },
    });

    // Hand newly created leads to the AI worker. Enqueued rather than inlined so
    // a slow or failing LLM never delays the result the user is watching.
    if (!cancelled && options.autoScore && counters.created > 0) {
      await enrichmentQueue.add('score-imported', { organizationId, userId, importJobId });
    }

    log.info({ importJobId, ...counters, status }, 'import finished');
    await job.updateProgress(100);
    return counters;
  } catch (error) {
    const message = (error as Error).message;
    log.error({ importJobId, err: message, rowNumber }, 'import failed');

    await ImportJobModel.updateOne(
      { _id: record._id },
      {
        $set: {
          status: ImportStatus.FAILED,
          failureReason: `Failed at row ${rowNumber}: ${message}`.slice(0, 1_000),
          processedRows: counters.processed,
          createdCount: counters.created,
          updatedCount: counters.updated,
          errorCount: counters.errors,
          completedAt: new Date(),
        },
      },
    );

    auditService.record({
      organizationId,
      actorId: userId,
      action: AuditAction.IMPORT_FAILED,
      entityType: 'import_job',
      entityId: importJobId,
      metadata: { error: message.slice(0, 500), ...counters },
    });

    throw error;
  } finally {
    parser.destroy();
  }
};

export const createImportWorker = (): Worker<ImportJobPayload> => {
  const worker = new Worker<ImportJobPayload>(QueueName.IMPORT, processImportJob, {
    connection: createQueueConnection('import-worker'),
    concurrency: env.IMPORT_WORKER_CONCURRENCY,
    // A large import legitimately takes minutes. Without this, BullMQ would
    // consider the job stalled and hand it to a second worker, duplicating work.
    lockDuration: 5 * 60_000,
    stalledInterval: 60_000,
  });

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, 'import job failed');
  });
  worker.on('completed', (job) => log.info({ jobId: job.id }, 'import job completed'));

  return worker;
};
