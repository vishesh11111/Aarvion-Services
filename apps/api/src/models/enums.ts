/**
 * Domain enums.
 *
 * Plain `as const` objects rather than TypeScript `enum`s: they erase to simple
 * strings at runtime (so what is stored in MongoDB is exactly what you read in
 * the shell), they give a `Object.values()` list for Mongoose's `enum` validator
 * and for Zod's `z.enum`, and they avoid the well-known footguns of numeric
 * TypeScript enums.
 *
 * This file is the single source of truth for every closed value set in the
 * system — models, validation schemas, prompts and the OpenAPI document all
 * derive from it, so adding a lead status is a one-line change.
 */

/* -------------------------------------------------------------------------- */
/* Identity                                                                   */
/* -------------------------------------------------------------------------- */

/** Ordered most to least privileged. Ranking lives in `modules/auth/rbac.ts`. */
export const Role = {
  OWNER: 'OWNER',
  ADMIN: 'ADMIN',
  MEMBER: 'MEMBER',
  VIEWER: 'VIEWER',
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const UserStatus = {
  ACTIVE: 'ACTIVE',
  INVITED: 'INVITED',
  SUSPENDED: 'SUSPENDED',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

/* -------------------------------------------------------------------------- */
/* Leads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Pipeline stages. NEW → CONTACTED → QUALIFIED → PROPOSAL → WON | LOST.
 * DISQUALIFIED is a terminal side-exit (bad fit, spam, bounced email).
 */
export const LeadStatus = {
  NEW: 'NEW',
  CONTACTED: 'CONTACTED',
  QUALIFIED: 'QUALIFIED',
  PROPOSAL: 'PROPOSAL',
  WON: 'WON',
  LOST: 'LOST',
  DISQUALIFIED: 'DISQUALIFIED',
} as const;
export type LeadStatus = (typeof LeadStatus)[keyof typeof LeadStatus];

/** The order the funnel is reported in. Excludes terminal side-exits. */
export const PIPELINE_ORDER: LeadStatus[] = [
  LeadStatus.NEW,
  LeadStatus.CONTACTED,
  LeadStatus.QUALIFIED,
  LeadStatus.PROPOSAL,
  LeadStatus.WON,
];

export const LeadSource = {
  CSV_IMPORT: 'CSV_IMPORT',
  MANUAL: 'MANUAL',
  WEBSITE: 'WEBSITE',
  REFERRAL: 'REFERRAL',
  WEBINAR: 'WEBINAR',
  ADVERTISING: 'ADVERTISING',
  LINKEDIN: 'LINKEDIN',
  EVENT: 'EVENT',
  API: 'API',
  OTHER: 'OTHER',
} as const;
export type LeadSource = (typeof LeadSource)[keyof typeof LeadSource];

export const LeadPriority = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  URGENT: 'URGENT',
} as const;
export type LeadPriority = (typeof LeadPriority)[keyof typeof LeadPriority];

/* -------------------------------------------------------------------------- */
/* Imports                                                                    */
/* -------------------------------------------------------------------------- */

export const ImportStatus = {
  PENDING: 'PENDING',
  VALIDATING: 'VALIDATING',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  COMPLETED_WITH_ERRORS: 'COMPLETED_WITH_ERRORS',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;
export type ImportStatus = (typeof ImportStatus)[keyof typeof ImportStatus];

/** Statuses after which no further work happens; clients stop polling. */
export const TERMINAL_IMPORT_STATUSES: ImportStatus[] = [
  ImportStatus.COMPLETED,
  ImportStatus.COMPLETED_WITH_ERRORS,
  ImportStatus.FAILED,
  ImportStatus.CANCELLED,
];

/* -------------------------------------------------------------------------- */
/* Activity & AI                                                              */
/* -------------------------------------------------------------------------- */

export const ActivityType = {
  NOTE: 'NOTE',
  EMAIL: 'EMAIL',
  CALL: 'CALL',
  MEETING: 'MEETING',
  STATUS_CHANGE: 'STATUS_CHANGE',
  OWNER_CHANGE: 'OWNER_CHANGE',
  CREATED: 'CREATED',
  IMPORTED: 'IMPORTED',
  MERGED: 'MERGED',
  AI_ENRICHMENT: 'AI_ENRICHMENT',
} as const;
export type ActivityType = (typeof ActivityType)[keyof typeof ActivityType];

/**
 * Distinct AI capabilities, tracked separately so usage and cost can be
 * attributed per feature and individual features disabled under load.
 */
export const AiFeature = {
  LEAD_SCORING: 'LEAD_SCORING',
  COLUMN_MAPPING: 'COLUMN_MAPPING',
  NL_SEARCH: 'NL_SEARCH',
  LEAD_INSIGHTS: 'LEAD_INSIGHTS',
  DUPLICATE_REVIEW: 'DUPLICATE_REVIEW',
} as const;
export type AiFeature = (typeof AiFeature)[keyof typeof AiFeature];

/** Helper for Mongoose `enum:` and Zod `z.enum(...)`. */
export const valuesOf = <T extends Record<string, string>>(source: T): Array<T[keyof T]> =>
  Object.values(source) as Array<T[keyof T]>;
