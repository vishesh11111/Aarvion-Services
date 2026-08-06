/**
 * Lead normalisation and deduplication.
 *
 * This module is the single source of truth for "are these two rows the same
 * person?" â€” used by the API on create/update *and* by the CSV import worker.
 * Having one implementation is what keeps a manually created lead and an
 * imported lead from silently becoming duplicates of each other.
 *
 * Dedupe key precedence (first non-empty wins):
 *   1. email          â€” the only truly reliable identifier in B2B data
 *   2. phone (E.164-ish digits) â€” reliable when present and well-formed
 *   3. name + company â€” a weak fallback; better than nothing for the very
 *                       common "no email, no phone" export
 *
 * The key is stored on the row and constrained UNIQUE (organizationId, dedupeKey)
 * so the database â€” not application logic racing with itself across four import
 * workers â€” is what actually enforces uniqueness.
 */
import { createHash, randomUUID } from 'node:crypto';

/** Collapses whitespace and trims. Returns undefined for empty input. */
export const cleanString = (value: unknown, maxLength = 255): string | undefined => {
  if (value === null || value === undefined) return undefined;
  const str = String(value).replace(/\s+/g, ' ').trim();
  if (str.length === 0) return undefined;
  // Common spreadsheet artefacts that mean "empty" but aren't.
  if (/^(n\/?a|null|nil|none|-|--|#n\/a)$/i.test(str)) return undefined;
  return str.slice(0, maxLength);
};

const EMAIL_RE = /^[^\s@,;<>()[\]\\]+@[^\s@.,;<>()[\]\\]+(\.[^\s@.,;<>()[\]\\]+)+$/;

/**
 * Normalises and validates an email. Real exports contain `"Jane <j@x.com>"`,
 * trailing semicolons, and mixed case; all of that is handled here.
 */
export const normalizeEmail = (value: unknown): string | undefined => {
  const raw = cleanString(value, 320);
  if (!raw) return undefined;

  // Extract from "Display Name <addr@example.com>" if present.
  const angled = /<([^>]+)>/.exec(raw);
  const candidate = (angled?.[1] ?? raw).split(/[,;]/)[0]?.trim().toLowerCase();

  if (!candidate || candidate.length > 254 || !EMAIL_RE.test(candidate)) return undefined;
  return candidate;
};

/**
 * Reduces a phone number to comparable digits.
 *
 * We keep a leading `+` for international numbers but strip formatting. This is
 * intentionally *not* full E.164 parsing (which needs a country context we do
 * not have on import); it is a normalisation good enough to catch
 * "(555) 010-1234" == "555-010-1234".
 */
export const normalizePhone = (value: unknown): string | undefined => {
  const raw = cleanString(value, 64);
  if (!raw) return undefined;

  const hasPlus = raw.trimStart().startsWith('+');
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return undefined; // ITU E.164 bounds
  return hasPlus ? `+${digits}` : digits;
};

export const normalizeUrl = (value: unknown): string | undefined => {
  const raw = cleanString(value, 255);
  if (!raw) return undefined;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (!/^https?:$/.test(url.protocol)) return undefined;
    if (!url.hostname.includes('.')) return undefined;
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
};

/** Title-cases a name without mangling "McDonald" or "O'Brien" beyond repair. */
export const normalizeName = (value: unknown): string | undefined => {
  const raw = cleanString(value, 120);
  if (!raw) return undefined;
  // Only re-case input that is entirely one case; leave mixed case alone.
  if (raw === raw.toLowerCase() || raw === raw.toUpperCase()) {
    return raw
      .split(' ')
      .map((part) =>
        part
          .split('-')
          .map((seg) => (seg.length > 0 ? seg[0]!.toUpperCase() + seg.slice(1).toLowerCase() : seg))
          .join('-'),
      )
      .join(' ');
  }
  return raw;
};

/**
 * Splits "Jane Q. Doe" into first/last when a file only has a full-name column.
 * Everything before the final token is the first name â€” imperfect for
 * multi-part surnames, but predictable and reversible, which matters more.
 */
export const splitFullName = (full: string): { firstName?: string; lastName?: string } => {
  const parts = full.split(' ').filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { firstName: parts[0]! };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1)! };
};

export const buildFullName = (
  firstName: string | undefined,
  lastName: string | undefined,
  fallback?: string,
): string => {
  const joined = [firstName, lastName].filter(Boolean).join(' ').trim();
  if (joined.length > 0) return joined.slice(0, 255);
  const fb = cleanString(fallback, 255);
  return fb ?? 'Unknown';
};

export interface DedupeInput {
  email?: string | undefined;
  phone?: string | undefined;
  fullName?: string | undefined;
  company?: string | undefined;
}

/**
 * Strips accents, legal suffixes and punctuation so "Acme, Inc." and "acme inc"
 * collapse to the same token.
 *
 * NFKD decomposes "Ã©" into "e" + a combining mark, and the final `[^a-z0-9]`
 * pass removes the mark â€” so accent folding falls out of the same step that
 * removes punctuation, with no explicit diacritic range to maintain.
 */
const fold = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|gmbh|co|plc|sa|bv|pty)\b/g, '')
    .replace(/[^a-z0-9]/g, '');

/**
 * Produces the tenant-unique natural key for a lead.
 *
 * Always returns a value â€” a lead with no identifying information at all still
 * needs a key, so it falls back to a random one (meaning "never dedupes"), which
 * is the safe direction to fail: creating a duplicate is recoverable, merging
 * two unrelated customers is not.
 */
export const buildDedupeKey = (input: DedupeInput): string => {
  if (input.email) return `e:${input.email}`;
  if (input.phone) return `p:${input.phone}`;

  const name = input.fullName ? fold(input.fullName) : '';
  const company = input.company ? fold(input.company) : '';
  if (name.length > 0 && company.length > 0) return `nc:${name}|${company}`;
  if (name.length > 2) return `n:${name}`;

  return `x:${randomUUID()}`;
};

/** Recomputes the key after an edit â€” call this whenever an identity field changes. */
export const dedupeKeyFor = (lead: {
  email?: string | null;
  phone?: string | null;
  fullName?: string | null;
  company?: string | null;
}): string =>
  buildDedupeKey({
    email: lead.email ?? undefined,
    phone: lead.phone ?? undefined,
    fullName: lead.fullName ?? undefined,
    company: lead.company ?? undefined,
  });

/** Tags: lower-cased, de-duplicated, bounded. Prevents tag-list explosion. */
export const normalizeTags = (value: unknown, max = 25): string[] => {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,;|]/)
      : [];
  const seen = new Set<string>();
  for (const item of list) {
    const tag = cleanString(item, 40)?.toLowerCase();
    if (tag) seen.add(tag);
    if (seen.size >= max) break;
  }
  return [...seen];
};

/**
 * Fields that feed the AI scorer. Hashing them lets us skip re-scoring a lead
 * whose commercially relevant attributes have not changed (a note edit should
 * not burn an LLM call), and automatically invalidate when they have.
 */
export const scoreInputSignature = (lead: {
  fullName?: string | null;
  email?: string | null;
  company?: string | null;
  jobTitle?: string | null;
  industry?: string | null;
  companySize?: string | null;
  country?: string | null;
  source?: string | null;
  estimatedValue?: number | null;
  notes?: string | null;
}): string => {
  const signature = [
    lead.fullName,
    lead.email,
    lead.company,
    lead.jobTitle,
    lead.industry,
    lead.companySize,
    lead.country,
    lead.source,
    lead.estimatedValue,
    lead.notes?.slice(0, 500),
  ]
    .map((v) => (v === null || v === undefined ? '' : String(v).toLowerCase().trim()))
    .join('|');

  return createHash('sha256').update(signature).digest('hex');
};
