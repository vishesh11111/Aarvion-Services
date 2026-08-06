import { model, Schema, type HydratedDocument, type Types } from 'mongoose';
import { baseSchemaOptions, objectIdRef } from './base';
import { AiFeature, valuesOf } from './enums';

/** Append-only. Written for every state-changing action on tenant data. */
export interface AuditLog {
  organizationId: Types.ObjectId;
  actorId: Types.ObjectId | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const auditLogSchema = new Schema<AuditLog>(
  {
    organizationId: objectIdRef('Organization'),
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    action: { type: String, required: true, maxlength: 80 },
    entityType: { type: String, required: true, maxlength: 60 },
    entityId: { type: String, default: null, maxlength: 64 },
    metadata: { type: Schema.Types.Mixed, default: () => ({}) },
    ipAddress: { type: String, default: null, maxlength: 64 },
    userAgent: { type: String, default: null, maxlength: 400 },
  },
  baseSchemaOptions,
);

auditLogSchema.index({ organizationId: 1, createdAt: -1 });
auditLogSchema.index({ organizationId: 1, entityType: 1, entityId: 1 });

export type AuditLogDoc = HydratedDocument<AuditLog>;

export const AuditLogModel = model<AuditLog>('AuditLog', auditLogSchema);

/* -------------------------------------------------------------------------- */

/**
 * One document per LLM call.
 *
 * Drives the per-tenant AI budget, cache hit-rate metrics and cost attribution.
 * Prompts are deliberately NOT stored — they contain customer PII — only a hash
 * for cache correlation.
 */
export interface AiInteraction {
  organizationId: Types.ObjectId;
  userId: Types.ObjectId | null;
  feature: AiFeature;
  model: string;
  promptHash: string;
  cacheHit: boolean;
  success: boolean;
  /** True when the provider failed and a heuristic fallback was served. */
  degraded: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const aiInteractionSchema = new Schema<AiInteraction>(
  {
    organizationId: objectIdRef('Organization'),
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    feature: { type: String, enum: valuesOf(AiFeature), required: true },
    model: { type: String, required: true, maxlength: 80 },
    promptHash: { type: String, required: true, maxlength: 64 },
    cacheHit: { type: Boolean, default: false },
    success: { type: Boolean, default: true },
    degraded: { type: Boolean, default: false },
    inputTokens: { type: Number, default: null },
    outputTokens: { type: Number, default: null },
    latencyMs: { type: Number, required: true },
    errorCode: { type: String, default: null, maxlength: 80 },
  },
  baseSchemaOptions,
);

aiInteractionSchema.index({ organizationId: 1, createdAt: -1 });
aiInteractionSchema.index({ organizationId: 1, feature: 1, createdAt: -1 });

export type AiInteractionDoc = HydratedDocument<AiInteraction>;

export const AiInteractionModel = model<AiInteraction>('AiInteraction', aiInteractionSchema);

/* -------------------------------------------------------------------------- */

/** Persisted filter sets ("Hot leads in EMEA"). Shared org-wide when `isShared`. */
export interface SavedView {
  organizationId: Types.ObjectId;
  userId: Types.ObjectId;
  name: string;
  filters: Record<string, unknown>;
  isShared: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const savedViewSchema = new Schema<SavedView>(
  {
    organizationId: objectIdRef('Organization'),
    userId: objectIdRef('User'),
    name: { type: String, required: true, maxlength: 120 },
    filters: { type: Schema.Types.Mixed, required: true },
    isShared: { type: Boolean, default: false },
  },
  baseSchemaOptions,
);

savedViewSchema.index({ organizationId: 1, userId: 1, name: 1 }, { unique: true });
savedViewSchema.index({ organizationId: 1, isShared: 1 });

export type SavedViewDoc = HydratedDocument<SavedView>;

export const SavedViewModel = model<SavedView>('SavedView', savedViewSchema);
