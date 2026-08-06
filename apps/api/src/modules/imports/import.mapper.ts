/**
 * Turns one raw CSV row into a validated lead payload.
 *
 * This is the hot path of the importer — it runs once per row, so it is written
 * to allocate little and to never throw for data reasons: a bad row returns an
 * error object and the import carries on. An import that aborts on row 40,000 of
 * 50,000 is worse than useless, because the user cannot tell what landed.
 */
import { LeadPriority, LeadSource, LeadStatus } from '../../models';
import {
  buildFullName,
  buildDedupeKey,
  cleanString,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  normalizeTags,
  normalizeUrl,
  splitFullName,
} from '../leads/lead.normalizer';
import type { CsvRow } from './csv.parser';

/** `{ "CSV Header": "leadField" }` — the user-confirmed mapping. */
export type ColumnMapping = Record<string, string | null>;

/**
 * The lead fields a CSV row can produce.
 *
 * Declared explicitly rather than derived from the Mongoose model: the mapper is
 * pure and unit-tested without a database, and an explicit shape means adding a
 * schema field cannot silently change what the importer writes.
 * `organizationId` and `importJobId` are added by the worker.
 */
export interface MappedLeadFields {
  firstName: string | null;
  lastName: string | null;
  fullName: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  jobTitle: string | null;
  website: string | null;
  industry: string | null;
  companySize: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  status: LeadStatus;
  priority: LeadPriority;
  source: LeadSource;
  sourceDetail: string;
  estimatedValue: number | null;
  tags: string[];
  notes: string | null;
  ownerId: string | null;
  customFields: Record<string, string>;
  dedupeKey: string;
}

export interface MappedLead {
  data: MappedLeadFields;
  dedupeKey: string;
}

export interface RowError {
  rowNumber: number;
  field?: string;
  message: string;
  rawRow: CsvRow;
}

export type MapRowResult =
  | { ok: true; lead: MappedLead }
  | { ok: false; error: Omit<RowError, 'rowNumber' | 'rawRow'> };

/* -------------------------------------------------------------------------- */
/* Value coercion                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Maps free-text status values onto the enum. Exports say "Open", "In Progress",
 * "Closed Won"; none of those are our enum names, and rejecting them would make
 * the importer useless against real files.
 */
const STATUS_ALIASES: Array<[RegExp, LeadStatus]> = [
  [/^(new|open|fresh|unqualified|untouched|to.?contact)$/i, LeadStatus.NEW],
  [/^(contacted|reached.?out|in.?progress|attempted|working|engaged)$/i, LeadStatus.CONTACTED],
  [/^(qualified|sql|mql|interested|discovery)$/i, LeadStatus.QUALIFIED],
  [/^(proposal|quote|negotiation|demo|pilot|trial)$/i, LeadStatus.PROPOSAL],
  [/^(won|closed.?won|customer|converted|client)$/i, LeadStatus.WON],
  [/^(lost|closed.?lost|dead|churned)$/i, LeadStatus.LOST],
  [/^(disqualified|dq|bad.?fit|spam|invalid|bounced)$/i, LeadStatus.DISQUALIFIED],
];

const SOURCE_ALIASES: Array<[RegExp, LeadSource]> = [
  [/referr?al|word.?of.?mouth|partner/i, LeadSource.REFERRAL],
  [/web.?site|organic|inbound|contact.?form|landing/i, LeadSource.WEBSITE],
  [/webinar|workshop|demo.?day/i, LeadSource.WEBINAR],
  [/event|conference|trade.?show|expo|meetup/i, LeadSource.EVENT],
  [/linked.?in|sales.?nav/i, LeadSource.LINKEDIN],
  [/ad(s|words)?|ppc|paid|google.?ads|facebook|campaign/i, LeadSource.ADVERTISING],
  [/api|integration|zapier|webhook/i, LeadSource.API],
  [/import|csv|upload|list/i, LeadSource.CSV_IMPORT],
  [/manual|entered|typed/i, LeadSource.MANUAL],
];

const PRIORITY_ALIASES: Array<[RegExp, LeadPriority]> = [
  [/^(urgent|critical|p0|hot|a\+?)$/i, LeadPriority.URGENT],
  [/^(high|important|p1|a)$/i, LeadPriority.HIGH],
  [/^(medium|normal|standard|p2|b)$/i, LeadPriority.MEDIUM],
  [/^(low|cold|p3|c|d)$/i, LeadPriority.LOW],
];

const matchAlias = <T>(value: string | undefined, aliases: Array<[RegExp, T]>): T | undefined => {
  if (!value) return undefined;
  return aliases.find(([pattern]) => pattern.test(value))?.[1];
};

/**
 * Parses a monetary value from the many shapes exports use:
 * "$12,500.00", "12 500", "€1.234,56", "(500)" for negatives, "1.2k".
 * Returns whole units — we store integers, not floats, for money.
 */
export const parseMoney = (value: unknown): number | undefined => {
  const raw = cleanString(value, 40);
  if (!raw) return undefined;

  const negative = /^\(.*\)$/.test(raw) || raw.trimStart().startsWith('-');
  let text = raw.replace(/[()]/g, '').replace(/[^\d.,kKmM]/g, '');
  if (text.length === 0) return undefined;

  const multiplier = /k$/i.test(text) ? 1_000 : /m$/i.test(text) ? 1_000_000 : 1;
  text = text.replace(/[kKmM]$/, '');

  /*
   * Work out which separator is the decimal point.
   *
   * The naive rule "whichever appears last is the decimal point" is wrong for
   * the single most common input we get: "$50,000" would parse as 50. The
   * distinction only exists when both separators are present; with one, the
   * count and the number of trailing digits decide it.
   */
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  const commaCount = (text.match(/,/g) ?? []).length;
  const dotCount = (text.match(/\./g) ?? []).length;

  if (lastComma >= 0 && lastDot >= 0) {
    // Both present: the later one is the decimal separator, the other groups.
    // "1.234,56" -> 1234.56   |   "1,234.56" -> 1234.56
    if (lastComma > lastDot) text = text.replace(/\./g, '').replace(',', '.');
    else text = text.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // Commas only. A single comma with one or two trailing digits is a European
    // decimal ("1234,56"); anything else is thousands grouping ("50,000").
    const trailingDigits = text.length - lastComma - 1;
    if (commaCount === 1 && trailingDigits > 0 && trailingDigits <= 2) text = text.replace(',', '.');
    else text = text.replace(/,/g, '');
  } else if (lastDot >= 0 && dotCount > 1) {
    // "1.234.567" can only be grouping — a number has at most one decimal point.
    text = text.replace(/\./g, '');
  }
  // A single dot is left alone: "1234.56" is by far the most likely reading.

  const parsed = Number.parseFloat(text);
  if (!Number.isFinite(parsed)) return undefined;

  const result = Math.round(parsed * multiplier);
  if (negative || result < 0) return 0; // a negative pipeline value is a data error
  return Math.min(result, 1_000_000_000);
};

/* -------------------------------------------------------------------------- */
/* Row mapping                                                                */
/* -------------------------------------------------------------------------- */

export interface MapRowOptions {
  mapping: ColumnMapping;
  /** Applied when the file has no source column. */
  defaultSource: LeadSource;
  /** Filename or campaign, recorded as provenance on every row. */
  sourceDetail: string;
  defaultOwnerId?: string | null;
  /** Columns not in `mapping` are preserved here rather than discarded. */
  keepUnmappedAsCustomFields: boolean;
}

export const mapRow = (row: CsvRow, options: MapRowOptions): MapRowResult => {
  const get = (field: string): string | undefined => {
    for (const [column, target] of Object.entries(options.mapping)) {
      if (target === field) {
        const value = row[column];
        if (value !== undefined && value !== null && String(value).trim() !== '') return String(value);
      }
    }
    return undefined;
  };

  // --- identity -----------------------------------------------------------
  let firstName = normalizeName(get('firstName'));
  let lastName = normalizeName(get('lastName'));

  const fullNameColumn = cleanString(get('fullName'), 255);
  if (!firstName && !lastName && fullNameColumn) {
    const split = splitFullName(fullNameColumn);
    firstName = normalizeName(split.firstName);
    lastName = normalizeName(split.lastName);
  }

  const email = normalizeEmail(get('email'));
  const phone = normalizePhone(get('phone'));
  const company = cleanString(get('company'), 200);

  // A row with no identifying value at all is noise, not a lead. This is the
  // one condition that rejects a row outright.
  if (!email && !phone && !firstName && !lastName && !company && !fullNameColumn) {
    return { ok: false, error: { message: 'Row has no email, phone, name or company' } };
  }

  // An email column that was present but unparseable is worth telling the user
  // about — silently importing a lead with no email loses real information.
  const rawEmail = get('email');
  if (rawEmail && !email) {
    return { ok: false, error: { field: 'email', message: `"${rawEmail.slice(0, 60)}" is not a valid email address` } };
  }

  const fullName = buildFullName(firstName, lastName, fullNameColumn ?? email ?? company);

  // --- custom fields ------------------------------------------------------
  const customFields: Record<string, string> = {};
  if (options.keepUnmappedAsCustomFields) {
    for (const [column, value] of Object.entries(row)) {
      const isMapped = options.mapping[column] != null;
      if (isMapped) continue;
      const cleaned = cleanString(value, 500);
      // Bound both count and size: a 200-column file must not create a 200-key
      // JSON blob on every one of 200k rows.
      if (cleaned && Object.keys(customFields).length < 30) customFields[column.slice(0, 60)] = cleaned;
    }
  }

  const tagValue = get('tags');

  return {
    ok: true,
    lead: {
      data: {
        firstName: firstName ?? null,
        lastName: lastName ?? null,
        fullName,
        email: email ?? null,
        phone: phone ?? null,
        company: company ?? null,
        jobTitle: cleanString(get('jobTitle'), 160) ?? null,
        website: normalizeUrl(get('website')) ?? null,
        industry: cleanString(get('industry'), 120) ?? null,
        companySize: cleanString(get('companySize'), 40) ?? null,
        city: cleanString(get('city'), 120) ?? null,
        state: cleanString(get('state'), 120) ?? null,
        country: cleanString(get('country'), 120) ?? null,
        status: matchAlias(cleanString(get('status'), 60), STATUS_ALIASES) ?? LeadStatus.NEW,
        priority: matchAlias(cleanString(get('priority'), 40), PRIORITY_ALIASES) ?? LeadPriority.MEDIUM,
        source: matchAlias(cleanString(get('source'), 80), SOURCE_ALIASES) ?? options.defaultSource,
        sourceDetail: options.sourceDetail.slice(0, 200),
        estimatedValue: parseMoney(get('estimatedValue')) ?? null,
        tags: tagValue ? normalizeTags(tagValue) : [],
        notes: cleanString(get('notes'), 5_000) ?? null,
        ownerId: options.defaultOwnerId ?? null,
        customFields,
        dedupeKey: '', // set below; kept in the object shape for clarity
      },
      dedupeKey: buildDedupeKey({ email, phone, fullName, company }),
    },
  };
};
