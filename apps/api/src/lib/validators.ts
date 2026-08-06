/**
 * Shared Zod primitives.
 *
 * `objectId()` exists so that identifier validation is defined once. Every route
 * that accepts an id uses it, which means a malformed id is rejected at the edge
 * with a 400 and a readable message, rather than reaching Mongoose and surfacing
 * as a `CastError` — an error that leaks the storage engine and says nothing
 * useful to the caller.
 */
import { z } from 'zod';
import { Types } from 'mongoose';

/**
 * A 24-character hex MongoDB ObjectId.
 *
 * `Types.ObjectId.isValid` alone is too permissive: it accepts any 12-character
 * string (interpreting it as raw bytes), so `"johndoe12345"` would pass. The
 * round-trip check pins it to the canonical hex form that actually appears in
 * our URLs and payloads.
 */
export const objectId = (message = 'Invalid identifier') =>
  z
    .string()
    .refine(
      (value) => Types.ObjectId.isValid(value) && String(new Types.ObjectId(value)) === value,
      message,
    );

/** `{ id }` path parameter, used by every `/:id` route. */
export const idParamSchema = z.object({ id: objectId() });

/** Trimmed string with an upper bound, treating "" as absent. */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    // An empty string from an HTML form means "not provided", not "set to empty".
    .transform((value) => (value === '' ? undefined : value));
