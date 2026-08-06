import { model, Schema, type HydratedDocument, type Types } from 'mongoose';
import { baseSchemaOptions, objectIdRef } from './base';
import { ImportStatus, valuesOf } from './enums';

export interface ImportJob {
  organizationId: Types.ObjectId;
  createdById: Types.ObjectId;

  filename: string;
  /** Path on the shared volume, or the object-store key. */
  storageKey: string;
  fileSizeBytes: number;
  status: ImportStatus;

  /** Header row of the uploaded file, preserved to drive the mapping UI. */
  detectedHeaders: string[];
  /** `{ "csvColumn": "leadField" | null }` — AI-proposed, user-confirmed. */
  columnMapping: Record<string, string | null>;
  /** Delimiter, duplicate strategy, default owner, autoScore, ... */
  options: Record<string, unknown>;

  totalRows: number;
  processedRows: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;

  /** Populated only on whole-job failure, never for row-level errors. */
  failureReason: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const importJobSchema = new Schema<ImportJob>(
  {
    organizationId: objectIdRef('Organization'),
    createdById: objectIdRef('User'),

    filename: { type: String, required: true, maxlength: 255 },
    storageKey: { type: String, default: '', maxlength: 512 },
    fileSizeBytes: { type: Number, required: true, min: 0 },
    status: { type: String, enum: valuesOf(ImportStatus), default: ImportStatus.PENDING, required: true },

    detectedHeaders: { type: [String], default: [] },
    columnMapping: { type: Schema.Types.Mixed, default: () => ({}) },
    options: { type: Schema.Types.Mixed, default: () => ({}) },

    totalRows: { type: Number, default: 0 },
    processedRows: { type: Number, default: 0 },
    createdCount: { type: Number, default: 0 },
    updatedCount: { type: Number, default: 0 },
    skippedCount: { type: Number, default: 0 },
    errorCount: { type: Number, default: 0 },

    failureReason: { type: String, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  baseSchemaOptions,
);

importJobSchema.index({ organizationId: 1, createdAt: -1 });
importJobSchema.index({ organizationId: 1, status: 1 });

export type ImportJobDoc = HydratedDocument<ImportJob>;

export const ImportJobModel = model<ImportJob>('ImportJob', importJobSchema);

/* -------------------------------------------------------------------------- */

/**
 * Row-level import failures.
 *
 * Their own collection rather than an array on the job: a 500k-row import at a
 * 5% error rate would otherwise be a 25k-element array on a single document —
 * unqueryable, unpaginatable, past the 16 MB limit, and re-fetched in full every
 * time the UI polls for progress.
 */
export interface ImportError {
  importJobId: Types.ObjectId;
  rowNumber: number;
  /** The field that failed validation, when attributable. */
  field: string | null;
  message: string;
  /** The original row, so the user can fix and re-upload just the failures. */
  rawRow: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const importErrorSchema = new Schema<ImportError>(
  {
    importJobId: objectIdRef('ImportJob'),
    rowNumber: { type: Number, required: true },
    field: { type: String, default: null, maxlength: 120 },
    message: { type: String, required: true, maxlength: 500 },
    rawRow: { type: Schema.Types.Mixed, required: true },
  },
  baseSchemaOptions,
);

importErrorSchema.index({ importJobId: 1, rowNumber: 1 });

export type ImportErrorDoc = HydratedDocument<ImportError>;

export const ImportErrorModel = model<ImportError>('ImportError', importErrorSchema);
