import { model, Schema, type HydratedDocument, type Types } from 'mongoose';
import { baseSchemaOptions, objectIdRef } from './base';
import { ActivityType, valuesOf } from './enums';

/**
 * The interaction timeline for a lead.
 *
 * A separate collection rather than an array embedded on the lead. Embedding
 * looks natural in a document store and is the wrong call here: an active lead
 * accumulates activity indefinitely, and MongoDB caps a document at 16 MB. An
 * unbounded growing array is the classic document-modelling mistake — and it
 * would also drag the entire history along on every lead read.
 */
export interface LeadActivity {
  organizationId: Types.ObjectId;
  leadId: Types.ObjectId;
  userId: Types.ObjectId | null;
  type: ActivityType;
  title: string;
  body: string | null;
  /** Structured payload, e.g. `{ from: 'NEW', to: 'QUALIFIED' }`. */
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const leadActivitySchema = new Schema<LeadActivity>(
  {
    organizationId: objectIdRef('Organization'),
    leadId: objectIdRef('Lead'),
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    type: { type: String, enum: valuesOf(ActivityType), required: true },
    title: { type: String, required: true, maxlength: 255 },
    body: { type: String, default: null, maxlength: 5000 },
    metadata: { type: Schema.Types.Mixed, default: () => ({}) },
  },
  baseSchemaOptions,
);

/** The timeline query: one lead, newest first. */
leadActivitySchema.index({ leadId: 1, createdAt: -1 });
leadActivitySchema.index({ organizationId: 1, createdAt: -1 });

export type LeadActivityDoc = HydratedDocument<LeadActivity>;

export const LeadActivityModel = model<LeadActivity>('LeadActivity', leadActivitySchema);
