import { z } from 'zod';
import { objectId } from '../../lib/validators';
import { LeadPriority, LeadSource, LeadStatus } from '../../models';

/**
 * Request schemas for the leads API.
 *
 * All of these are `.strict()`: an unknown key is a 400, not a silent no-op.
 * That turns a typo'd field name in a client into an immediate, obvious error
 * instead of an update that appears to succeed and changes nothing.
 */

const trimmed = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  trimmed(max)
    .optional()
    // "" from an HTML form means "clear this field", not "set empty string".
    .transform((v) => (v === '' ? undefined : v));

export const leadIdParam = z.object({ id: objectId('Invalid lead id') });

export const createLeadSchema = z
  .object({
    firstName: optionalText(120),
    lastName: optionalText(120),
    email: z.string().trim().toLowerCase().email('Enter a valid email').max(254).optional().or(z.literal('').transform(() => undefined)),
    phone: optionalText(40),

    company: optionalText(200),
    jobTitle: optionalText(160),
    website: optionalText(255),
    industry: optionalText(120),
    companySize: optionalText(40),
    city: optionalText(120),
    state: optionalText(120),
    country: optionalText(120),

    status: z.nativeEnum(LeadStatus).default(LeadStatus.NEW),
    priority: z.nativeEnum(LeadPriority).default(LeadPriority.MEDIUM),
    source: z.nativeEnum(LeadSource).default(LeadSource.MANUAL),
    sourceDetail: optionalText(200),
    estimatedValue: z.coerce.number().int().min(0).max(1_000_000_000).optional(),
    ownerId: objectId().optional().nullable(),
    tags: z.array(trimmed(40)).max(25).default([]),
    notes: optionalText(5_000),
    customFields: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  })
  .strict()
  // A lead with no name, no email and no company is not a lead, it's noise.
  .refine(
    (v) => Boolean(v.email || v.phone || v.firstName || v.lastName || v.company),
    { message: 'Provide at least an email, phone, name or company' },
  );

/**
 * Update is a partial of create, minus the defaults — `undefined` means
 * "leave alone" and `null` means "clear". Reusing `.partial()` on the create
 * schema would apply defaults on PATCH and silently reset unspecified fields.
 */
export const updateLeadSchema = z
  .object({
    firstName: optionalText(120).nullable(),
    lastName: optionalText(120).nullable(),
    email: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
    phone: optionalText(40).nullable(),

    company: optionalText(200).nullable(),
    jobTitle: optionalText(160).nullable(),
    website: optionalText(255).nullable(),
    industry: optionalText(120).nullable(),
    companySize: optionalText(40).nullable(),
    city: optionalText(120).nullable(),
    state: optionalText(120).nullable(),
    country: optionalText(120).nullable(),

    status: z.nativeEnum(LeadStatus).optional(),
    priority: z.nativeEnum(LeadPriority).optional(),
    source: z.nativeEnum(LeadSource).optional(),
    sourceDetail: optionalText(200).nullable(),
    estimatedValue: z.coerce.number().int().min(0).max(1_000_000_000).nullable().optional(),
    ownerId: objectId().nullable().optional(),
    tags: z.array(trimmed(40)).max(25).optional(),
    notes: optionalText(5_000).nullable(),
    customFields: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

/* -------------------------------------------------------------------------- */
/* Querying                                                                   */
/* -------------------------------------------------------------------------- */

/** Comma-separated enum list -> array. `?status=NEW,QUALIFIED` */
const enumList = <T extends Record<string, string>>(enumObject: T) =>
  z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      const parts = (Array.isArray(value) ? value : value.split(','))
        .map((v) => v.trim().toUpperCase())
        .filter(Boolean);
      return parts.length > 0 ? parts : undefined;
    })
    .pipe(z.array(z.nativeEnum(enumObject as never)).optional());

export const SORTABLE_FIELDS = [
  'createdAt',
  'updatedAt',
  'score',
  'fullName',
  'company',
  'estimatedValue',
  'lastActivityAt',
] as const;

/**
 * The filter surface as a plain object schema. Kept separate from
 * `listLeadsSchema` so other endpoints (export, AI search) can `.omit`/`.extend`
 * it — cross-field refinements wrap the schema in a ZodEffects, which no longer
 * exposes the object combinators.
 */
const listLeadsBase = z
  .object({
    /** Free-text search across name, email, company. */
    q: z.string().trim().max(200).optional(),
    status: enumList(LeadStatus),
    source: enumList(LeadSource),
    priority: enumList(LeadPriority),
    ownerId: objectId().optional(),
    /** `unassigned` is a distinct filter from "no owner filter". */
    unassigned: z.coerce.boolean().optional(),
    tags: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .transform((v) =>
        v === undefined ? undefined : (Array.isArray(v) ? v : v.split(',')).map((t) => t.trim().toLowerCase()).filter(Boolean),
      ),
    minScore: z.coerce.number().int().min(0).max(100).optional(),
    maxScore: z.coerce.number().int().min(0).max(100).optional(),
    createdAfter: z.coerce.date().optional(),
    createdBefore: z.coerce.date().optional(),
    importJobId: objectId().optional(),
    /** Include soft-deleted rows. ADMIN+ only, enforced in the service. */
    includeDeleted: z.coerce.boolean().default(false),

    sortBy: z.enum(SORTABLE_FIELDS).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),

    /** Cursor pagination is the default; `page` opts into offset pagination. */
    cursor: objectId().optional(),
    page: z.coerce.number().int().min(1).max(10_000).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export const listLeadsSchema = listLeadsBase
  .refine((v) => !(v.minScore !== undefined && v.maxScore !== undefined) || v.minScore <= v.maxScore, {
    message: 'minScore must not exceed maxScore',
    path: ['minScore'],
  })
  .refine(
    (v) => !(v.createdAfter && v.createdBefore) || v.createdAfter <= v.createdBefore,
    { message: 'createdAfter must be before createdBefore', path: ['createdAfter'] },
  );

/* -------------------------------------------------------------------------- */
/* Bulk operations                                                            */
/* -------------------------------------------------------------------------- */

export const bulkUpdateSchema = z
  .object({
    // Bounded so one request cannot lock 100k rows in a single transaction.
    leadIds: z.array(objectId()).min(1).max(500),
    patch: z
      .object({
        status: z.nativeEnum(LeadStatus).optional(),
        priority: z.nativeEnum(LeadPriority).optional(),
        ownerId: objectId().nullable().optional(),
        addTags: z.array(trimmed(40)).max(10).optional(),
        removeTags: z.array(trimmed(40)).max(10).optional(),
      })
      .strict()
      .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one change' }),
  })
  .strict();

export const bulkDeleteSchema = z
  .object({ leadIds: z.array(objectId()).min(1).max(500) })
  .strict();

export const mergeLeadsSchema = z
  .object({
    /** The record that survives. */
    primaryId: objectId(),
    /** Records folded into the primary and then soft-deleted. */
    duplicateIds: z.array(objectId()).min(1).max(20),
  })
  .strict()
  .refine((v) => !v.duplicateIds.includes(v.primaryId), {
    message: 'A lead cannot be merged into itself',
    path: ['duplicateIds'],
  });

export const createActivitySchema = z
  .object({
    type: z.enum(['NOTE', 'EMAIL', 'CALL', 'MEETING']),
    title: trimmed(255).min(1),
    body: optionalText(5_000),
  })
  .strict();

/** Export reuses the same filters but with a much larger row ceiling. */
export const exportLeadsSchema = listLeadsBase
  .omit({ cursor: true, page: true, limit: true })
  .extend({ limit: z.coerce.number().int().min(1).max(50_000).default(10_000) })
  .strict();

/** Filters an AI natural-language query is allowed to produce. */
export const aiFilterSchema = listLeadsBase
  .omit({ cursor: true, page: true, includeDeleted: true, importJobId: true })
  .partial();

export type CreateLeadInput = z.infer<typeof createLeadSchema>;
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;
export type ListLeadsQuery = z.infer<typeof listLeadsSchema>;
export type BulkUpdateInput = z.infer<typeof bulkUpdateSchema>;
export type MergeLeadsInput = z.infer<typeof mergeLeadsSchema>;
export type CreateActivityInput = z.infer<typeof createActivitySchema>;
export type ExportLeadsQuery = z.infer<typeof exportLeadsSchema>;
