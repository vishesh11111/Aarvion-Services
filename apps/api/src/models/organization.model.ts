import { model, Schema, type HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from './base';

/**
 * Tenant root. Every other tenant-owned document carries `organizationId`
 * pointing here.
 *
 * The document shape is declared as an explicit interface rather than inferred
 * from the schema. Inference (`InferSchemaType`) collapses when a shared options
 * object is passed to the `Schema` constructor, and — more importantly — an
 * explicit interface is the contract the rest of the codebase programs against,
 * so a schema change that breaks a consumer shows up as a type error here rather
 * than as `undefined` at runtime.
 */
export interface Organization {
  name: string;
  /** URL-safe tenant identifier, globally unique. */
  slug: string;
  /** Soft feature-gate. Deliberately simple — no billing system in scope. */
  plan: string;
  createdAt: Date;
  updatedAt: Date;
}

const organizationSchema = new Schema<Organization>(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 80 },
    plan: { type: String, default: 'free', maxlength: 32 },
  },
  baseSchemaOptions,
);

organizationSchema.index({ createdAt: -1 });

export type OrganizationDoc = HydratedDocument<Organization>;

export const OrganizationModel = model<Organization>('Organization', organizationSchema);
