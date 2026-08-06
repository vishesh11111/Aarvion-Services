/**
 * Shared model conventions.
 *
 * Every schema in this codebase uses `baseSchemaOptions`, which guarantees three
 * things that would otherwise be decided ten times inconsistently:
 *
 *  1. **`id`, not `_id`, on the wire.** The API contract exposes `id` as a
 *     string. Leaking `_id`/`__v` would couple every client to Mongo's internal
 *     representation and make swapping the store a breaking API change.
 *  2. **`createdAt` / `updatedAt` on everything**, maintained by Mongoose.
 *  3. **Strict schemas.** Unknown keys are dropped rather than silently
 *     persisted — the document-store equivalent of mass-assignment protection.
 */
import { Schema, Types, type SchemaOptions } from 'mongoose';

/**
 * Rewrites a document for JSON serialisation: `_id` becomes `id`, internals
 * disappear, and nested ObjectIds become strings.
 */
const serialise = (_doc: unknown, ret: Record<string, unknown>): Record<string, unknown> => {
  ret.id = String(ret._id);
  delete ret._id;
  delete ret.__v;
  return ret;
};

/**
 * Note the `satisfies` rather than a `: SchemaOptions` annotation.
 *
 * `SchemaOptions` is generic over the document type. Annotating with the bare
 * name binds those parameters to `unknown`, and passing the result to
 * `new Schema<Lead>(...)` then fails to type-check because the options no longer
 * describe a `Lead` schema. `satisfies` checks the shape while preserving the
 * literal type, so the same object works for every model.
 */
export const baseSchemaOptions = {
  timestamps: true,
  strict: true,
  // `strictQuery` prevents an unknown field in a filter from being silently
  // ignored — which would turn a typo'd tenant filter into a full-collection
  // read. It must throw, not shrug.
  strictQuery: 'throw',
  versionKey: false,
  toJSON: { virtuals: true, transform: serialise },
  toObject: { virtuals: true, transform: serialise },
  // Mongoose 8 defaults this to false; being explicit documents the intent.
  id: false,
} satisfies SchemaOptions;

/** Reference to another document, always required unless stated otherwise. */
export const objectIdRef = (ref: string, required = true) => ({
  type: Schema.Types.ObjectId,
  ref,
  required,
});

/** True when a string is a syntactically valid ObjectId. */
export const isValidObjectId = (value: unknown): value is string =>
  typeof value === 'string' && Types.ObjectId.isValid(value) && String(new Types.ObjectId(value)) === value;

/**
 * Converts a string id to an ObjectId for aggregation pipelines.
 *
 * `$match` inside an aggregation does **not** cast strings to ObjectId the way
 * `find()` does — a raw string silently matches nothing. Every pipeline in this
 * codebase goes through here, which is the difference between an analytics
 * endpoint that returns zeros and one that works.
 */
export const toObjectId = (value: string): Types.ObjectId => new Types.ObjectId(value);

export { Types };
