import { model, Schema, type HydratedDocument, type Types } from 'mongoose';
import { baseSchemaOptions, objectIdRef } from './base';
import { LeadPriority, LeadSource, LeadStatus, valuesOf } from './enums';

/**
 * The core CRM record.
 *
 * Design notes
 * ------------
 * • **Money is an integer**, never a float. Whole currency units. Floating-point
 *   money surfaces as a one-cent discrepancy in a report six months later.
 * • **`score` is nullable and the distinction matters.** `null` means "not scored
 *   yet"; `0` means "scored, and it is terrible". Collapsing them makes the
 *   unscored backlog unqueryable and buries new leads at the bottom of a sorted
 *   list.
 * • **`customFields` is a free-form subdocument** so real-world CSVs with
 *   arbitrary columns import losslessly without a schema change per customer.
 *   This is the one place the document model genuinely beats a relational one.
 * • **Soft delete.** `deletedAt` is set and `dedupeKey` rewritten to
 *   `deleted:<id>`, freeing the natural key so the same person can be re-added.
 */
export interface Lead {
  organizationId: Types.ObjectId;

  // --- identity -----------------------------------------------------------
  firstName: string | null;
  lastName: string | null;
  /** Denormalised for sorting and searching without a computed field. */
  fullName: string;
  email: string | null;
  phone: string | null;

  // --- firmographics ------------------------------------------------------
  company: string | null;
  jobTitle: string | null;
  website: string | null;
  industry: string | null;
  companySize: string | null;
  city: string | null;
  state: string | null;
  country: string | null;

  // --- pipeline -----------------------------------------------------------
  status: LeadStatus;
  priority: LeadPriority;
  source: LeadSource;
  /** Free-text provenance: the UTM campaign, or the CSV filename. */
  sourceDetail: string | null;
  estimatedValue: number | null;
  ownerId: Types.ObjectId | null;
  tags: string[];
  notes: string | null;

  // --- AI-derived ---------------------------------------------------------
  score: number | null;
  scoreRationale: string | null;
  aiSummary: string | null;
  aiNextAction: string | null;
  scoredAt: Date | null;
  /**
   * SHA-256 of the fields fed to the scorer. Lets us skip re-scoring an
   * unchanged lead and invalidate automatically when its commercial profile
   * changes — editing a note must not burn an LLM call.
   */
  scoreInputHash: string | null;

  // --- extensibility ------------------------------------------------------
  /** Unmapped CSV columns land here so no customer data is silently dropped. */
  customFields: Record<string, unknown>;

  // --- dedupe -------------------------------------------------------------
  /**
   * Normalised natural key (email, else phone, else name+company).
   * Unique per organization — the database, not application logic racing itself
   * across four import workers, is what enforces this.
   */
  dedupeKey: string;

  // --- bookkeeping --------------------------------------------------------
  importJobId: Types.ObjectId | null;
  lastActivityAt: Date | null;
  /** Soft delete. All read paths filter `deletedAt: null`. */
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const leadSchema = new Schema<Lead>(
  {
    organizationId: objectIdRef('Organization'),

    firstName: { type: String, default: null, trim: true, maxlength: 120 },
    lastName: { type: String, default: null, trim: true, maxlength: 120 },
    fullName: { type: String, required: true, trim: true, maxlength: 255 },
    email: { type: String, default: null, lowercase: true, trim: true, maxlength: 254 },
    phone: { type: String, default: null, trim: true, maxlength: 40 },

    company: { type: String, default: null, trim: true, maxlength: 200 },
    jobTitle: { type: String, default: null, trim: true, maxlength: 160 },
    website: { type: String, default: null, trim: true, maxlength: 255 },
    industry: { type: String, default: null, trim: true, maxlength: 120 },
    companySize: { type: String, default: null, trim: true, maxlength: 40 },
    city: { type: String, default: null, trim: true, maxlength: 120 },
    state: { type: String, default: null, trim: true, maxlength: 120 },
    country: { type: String, default: null, trim: true, maxlength: 120 },

    status: { type: String, enum: valuesOf(LeadStatus), default: LeadStatus.NEW, required: true },
    priority: { type: String, enum: valuesOf(LeadPriority), default: LeadPriority.MEDIUM, required: true },
    source: { type: String, enum: valuesOf(LeadSource), default: LeadSource.MANUAL, required: true },
    sourceDetail: { type: String, default: null, maxlength: 200 },
    estimatedValue: { type: Number, default: null, min: 0 },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    tags: { type: [String], default: [] },
    notes: { type: String, default: null, maxlength: 5000 },

    score: { type: Number, default: null, min: 0, max: 100 },
    scoreRationale: { type: String, default: null },
    aiSummary: { type: String, default: null },
    aiNextAction: { type: String, default: null },
    scoredAt: { type: Date, default: null },
    scoreInputHash: { type: String, default: null, maxlength: 64 },

    customFields: { type: Schema.Types.Mixed, default: () => ({}) },

    dedupeKey: { type: String, required: true, maxlength: 255 },

    importJobId: { type: Schema.Types.ObjectId, ref: 'ImportJob', default: null },
    lastActivityAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  baseSchemaOptions,
);

/* -------------------------------------------------------------------------- */
/* Indexes                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The deduplication guarantee. Everything else about import correctness rests on
 * this one constraint being enforced by the database rather than by application
 * logic that four concurrent workers would race through.
 */
leadSchema.index({ organizationId: 1, dedupeKey: 1 }, { unique: true });

/*
 * Every index is organization-first. The tenant predicate is present in every
 * query, so it must lead for the index to be usable and for each tenant's
 * working set to stay physically clustered.
 *
 * `deletedAt` sits second because every read path filters it, which keeps the
 * soft-delete predicate inside the index rather than as a post-filter.
 */
leadSchema.index({ organizationId: 1, deletedAt: 1, createdAt: -1 });
leadSchema.index({ organizationId: 1, deletedAt: 1, status: 1, createdAt: -1 });
leadSchema.index({ organizationId: 1, deletedAt: 1, score: -1 });
leadSchema.index({ organizationId: 1, deletedAt: 1, ownerId: 1, status: 1 });
leadSchema.index({ organizationId: 1, deletedAt: 1, source: 1 });
/** Multikey index — supports `tags: { $in: [...] }`. */
leadSchema.index({ organizationId: 1, deletedAt: 1, tags: 1 });
/** Drives the "unscored backlog" query the AI enrichment worker drains. */
leadSchema.index({ organizationId: 1, deletedAt: 1, scoredAt: 1, createdAt: -1 });
/** "Show me everything from this import." */
leadSchema.index({ importJobId: 1 });

/*
 * Deliberately NO text index.
 *
 * Free-text search uses a case-insensitive regex bounded by the tenant index
 * (see `buildLeadFilter`). A MongoDB `$text` index was considered and rejected:
 *
 *   • `$text` matches whole stemmed words, so typing "north" would not find
 *     "Northwind Logistics" — a regression against what users expect from a CRM
 *     search box.
 *   • It adds write amplification to every insert, and this application's
 *     heaviest write path is bulk CSV import of hundreds of thousands of rows.
 *
 * The regex scan is bounded to one tenant's documents by the compound index,
 * which is the same cost profile the SQL version had with ILIKE. The upgrade
 * path when a single tenant outgrows it is Atlas Search, and the seam is one
 * function.
 */

export type LeadDoc = HydratedDocument<Lead>;

export const LeadModel = model<Lead>('Lead', leadSchema);
