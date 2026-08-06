/**
 * Deterministic fallbacks for every AI feature.
 *
 * These exist so the product is never *broken* by the AI provider: no API key
 * configured, provider outage, quota exhausted, circuit breaker open — the
 * feature still returns something useful, flagged `degraded: true` so the UI can
 * say so honestly rather than passing off a heuristic as a model output.
 *
 * They are also the reference implementation the LLM is measured against: if the
 * model cannot beat these rules, the model is not earning its cost.
 */
import { LeadPriority, LeadSource, type Lead } from '../../models';
import { MAPPABLE_FIELDS } from './ai.prompts';

/* -------------------------------------------------------------------------- */
/* Scoring                                                                    */
/* -------------------------------------------------------------------------- */

const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com',
  'proton.me', 'protonmail.com', 'mail.com', 'gmx.com', 'yandex.com', 'live.com',
]);

const SENIORITY_TIERS: Array<{ points: number; patterns: RegExp }> = [
  { points: 25, patterns: /\b(ceo|cto|cfo|coo|cmo|ciso|founder|co-founder|owner|president|partner)\b/i },
  { points: 21, patterns: /\b(vp|vice president|svp|evp|chief|head of|managing director)\b/i },
  { points: 16, patterns: /\b(director|principal|senior manager)\b/i },
  { points: 11, patterns: /\b(manager|lead|supervisor)\b/i },
  { points: 6, patterns: /\b(senior|specialist|architect|engineer|analyst|consultant)\b/i },
  { points: 3, patterns: /\b(intern|assistant|coordinator|junior|student|trainee)\b/i },
];

/** Sources ranked by observed intent. Referral and demo requests convert best. */
const SOURCE_POINTS: Record<LeadSource, number> = {
  [LeadSource.REFERRAL]: 20,
  [LeadSource.WEBINAR]: 16,
  [LeadSource.EVENT]: 15,
  [LeadSource.WEBSITE]: 14,
  [LeadSource.LINKEDIN]: 11,
  [LeadSource.API]: 10,
  [LeadSource.MANUAL]: 9,
  [LeadSource.ADVERTISING]: 8,
  [LeadSource.CSV_IMPORT]: 6,
  [LeadSource.OTHER]: 5,
};

const BUYING_SIGNALS =
  /\b(demo|pricing|quote|proposal|trial|budget|evaluat|rfp|contract|renew|migrat|onboard|urgent|deadline)/i;

const SIZE_POINTS = (size: string | null): number => {
  if (!size) return 0;
  const digits = size.replace(/\D/g, '');
  const n = Number(digits);
  if (!Number.isFinite(n) || n === 0) return /enterprise|large/i.test(size) ? 10 : 0;
  if (n >= 1_000) return 12;
  if (n >= 200) return 10;
  if (n >= 50) return 8;
  if (n >= 10) return 5;
  return 3;
};

export interface HeuristicScore {
  id: string;
  score: number;
  rationale: string;
  nextAction: string;
  priority: LeadPriority;
  summary: string;
}

/**
 * The projection the scorer works from.
 *
 * Declared explicitly rather than `Pick<Lead, …>` for two reasons: these
 * functions are pure and unit-tested without a database, and `id` is a string
 * here while the stored document has an `ObjectId` `_id`. Callers convert once,
 * via `toScorableLead`, which keeps the conversion in one place.
 */
export interface ScorableLead {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  jobTitle: string | null;
  industry: string | null;
  companySize: string | null;
  country: string | null;
  website: string | null;
  source: LeadSource;
  estimatedValue: number | null;
  notes: string | null;
}

/** Converts a stored lead document into the scorer's input shape. */
export const toScorableLead = (lead: Lead & { _id: unknown }): ScorableLead => ({
  id: String(lead._id),
  fullName: lead.fullName,
  email: lead.email ?? null,
  phone: lead.phone ?? null,
  company: lead.company ?? null,
  jobTitle: lead.jobTitle ?? null,
  industry: lead.industry ?? null,
  companySize: lead.companySize ?? null,
  country: lead.country ?? null,
  website: lead.website ?? null,
  source: lead.source,
  estimatedValue: lead.estimatedValue ?? null,
  notes: lead.notes ?? null,
});

/**
 * Rule-based score in the same 0-100 space the model uses, built from the same
 * rubric so the two are broadly comparable.
 */
export const heuristicScore = (lead: ScorableLead): HeuristicScore => {
  let score = 0;
  const reasons: string[] = [];

  // --- seniority (0-25) ---------------------------------------------------
  const title = lead.jobTitle ?? '';
  const tier = SENIORITY_TIERS.find((t) => t.patterns.test(title));
  if (tier) {
    score += tier.points;
    if (tier.points >= 16) reasons.push(`senior title (${title})`);
  } else if (title) {
    score += 5;
  }

  // --- company fit (0-25) -------------------------------------------------
  if (lead.company) {
    score += 8;
    reasons.push('identified company');
  }
  score += SIZE_POINTS(lead.companySize);
  if (lead.industry) score += 3;
  if (lead.website) score += 2;

  // --- contact quality (0-20) --------------------------------------------
  if (lead.email) {
    const domain = lead.email.split('@')[1]?.toLowerCase() ?? '';
    if (domain && !FREE_EMAIL_DOMAINS.has(domain)) {
      score += 14;
      reasons.push('business email domain');
    } else {
      score += 5;
      reasons.push('free email provider');
    }
  }
  if (lead.phone) score += 6;

  // --- source intent (0-20) ----------------------------------------------
  const sourcePoints = SOURCE_POINTS[lead.source] ?? 5;
  score += sourcePoints;
  if (sourcePoints >= 16) reasons.push(`high-intent source (${lead.source.toLowerCase()})`);

  // --- explicit signals (0-10) -------------------------------------------
  if (lead.notes && BUYING_SIGNALS.test(lead.notes)) {
    score += 10;
    reasons.push('buying signal in notes');
  }
  if ((lead.estimatedValue ?? 0) > 0) score += 3;

  score = Math.max(0, Math.min(100, Math.round(score)));

  const priority: LeadPriority =
    score >= 80 ? LeadPriority.URGENT
    : score >= 60 ? LeadPriority.HIGH
    : score >= 35 ? LeadPriority.MEDIUM
    : LeadPriority.LOW;

  const nextAction =
    score >= 75 ? 'Reach out today — call first, email as backup.'
    : score >= 50 ? 'Send a personalised email this week referencing their role.'
    : score >= 30 ? 'Add to a nurture sequence and revisit in 30 days.'
    : 'Enrich the record before spending rep time on it.';

  const descriptor = [lead.jobTitle, lead.company].filter(Boolean).join(' at ');

  return {
    id: lead.id,
    score,
    rationale:
      reasons.length > 0
        ? `Rule-based score: ${reasons.join(', ')}.`
        : 'Rule-based score: limited information available on this record.',
    nextAction,
    priority,
    summary: descriptor
      ? `${lead.fullName} — ${descriptor}.`
      : `${lead.fullName} — no role or company recorded.`,
  };
};

/* -------------------------------------------------------------------------- */
/* Column mapping                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Header-name matching for CSV import.
 *
 * Covers the exports of the tools people actually migrate from (HubSpot,
 * Salesforce, Pipedrive, Mailchimp, Apollo), which is the overwhelming majority
 * of real files. The LLM is what handles the long tail of bespoke headers.
 */
const HEADER_ALIASES: Record<(typeof MAPPABLE_FIELDS)[number], string[]> = {
  firstName: ['first name', 'firstname', 'first_name', 'given name', 'fname', 'contact first name'],
  lastName: ['last name', 'lastname', 'last_name', 'surname', 'family name', 'lname', 'contact last name'],
  fullName: ['full name', 'fullname', 'name', 'contact name', 'lead name', 'person', 'contact'],
  email: ['email', 'e-mail', 'email address', 'work email', 'business email', 'mail', 'primary email'],
  phone: ['phone', 'phone number', 'mobile', 'telephone', 'cell', 'contact number', 'work phone', 'tel'],
  company: ['company', 'company name', 'organisation', 'organization', 'account', 'account name', 'employer', 'business'],
  jobTitle: ['title', 'job title', 'position', 'role', 'designation', 'job role', 'job_title'],
  website: ['website', 'url', 'web site', 'company website', 'domain', 'homepage'],
  industry: ['industry', 'sector', 'vertical', 'market', 'category'],
  companySize: ['company size', 'employees', 'headcount', 'employee count', 'size', 'num employees'],
  city: ['city', 'town', 'locality'],
  state: ['state', 'province', 'region', 'county'],
  country: ['country', 'nation', 'country/region'],
  status: ['status', 'lead status', 'stage', 'lifecycle stage', 'pipeline stage'],
  priority: ['priority', 'urgency', 'rating'],
  source: ['source', 'lead source', 'channel', 'origin', 'utm_source', 'original source'],
  estimatedValue: ['value', 'deal value', 'amount', 'estimated value', 'revenue', 'opportunity amount', 'deal size'],
  tags: ['tags', 'labels', 'keywords', 'segments', 'lists'],
  notes: ['notes', 'note', 'comments', 'description', 'remarks', 'details', 'message'],
};

const normalizeHeader = (header: string): string =>
  header.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();

export interface MappingSuggestion {
  csvColumn: string;
  leadField: string | null;
  confidence: number;
  reason: string;
}

export const heuristicMapping = (headers: string[]): MappingSuggestion[] => {
  const taken = new Set<string>();

  // Exact alias matches first, so a file containing both "Name" and "First Name"
  // does not let the fuzzy pass claim `firstName` for "Name".
  const suggestions: MappingSuggestion[] = headers.map((header) => ({
    csvColumn: header,
    leadField: null,
    confidence: 0,
    reason: 'No confident match',
  }));

  for (const pass of ['exact', 'fuzzy'] as const) {
    headers.forEach((header, index) => {
      const current = suggestions[index]!;
      if (current.leadField) return;

      const normalized = normalizeHeader(header);

      for (const field of MAPPABLE_FIELDS) {
        if (taken.has(field)) continue;
        const aliases = HEADER_ALIASES[field];

        const matched =
          pass === 'exact'
            ? aliases.includes(normalized)
            : aliases.some((alias) => normalized.includes(alias) || alias.includes(normalized));

        if (matched) {
          current.leadField = field;
          current.confidence = pass === 'exact' ? 0.97 : 0.7;
          current.reason = pass === 'exact' ? `Header matches "${field}"` : `Header resembles "${field}"`;
          taken.add(field);
          return;
        }
      }
    });
  }

  return suggestions;
};

/* -------------------------------------------------------------------------- */
/* Natural-language search                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Keyword fallback for NL search. Recognises the handful of phrasings that
 * account for most real queries; anything else becomes a plain text search,
 * which is a reasonable answer rather than an error.
 */
export const heuristicSearch = (
  query: string,
): { filters: Record<string, unknown>; interpretation: string } => {
  const q = query.toLowerCase();
  const filters: Record<string, unknown> = {};
  const parts: string[] = [];

  if (/\b(hot|best|top|promising|high[- ]?quality|qualified lead)\b/.test(q)) {
    filters.minScore = 70;
    parts.push('score of 70 or above');
  } else if (/\b(cold|poor|low[- ]?quality|weak)\b/.test(q)) {
    filters.maxScore = 40;
    parts.push('score of 40 or below');
  }

  const statusWords: Array<[RegExp, string]> = [
    [/\bnew\b/, 'NEW'],
    [/\bcontacted\b/, 'CONTACTED'],
    [/\bqualified\b/, 'QUALIFIED'],
    [/\bproposal\b/, 'PROPOSAL'],
    [/\b(won|closed[- ]won|customer)\b/, 'WON'],
    [/\b(lost|closed[- ]lost)\b/, 'LOST'],
  ];
  const statuses = statusWords.filter(([re]) => re.test(q)).map(([, s]) => s);
  if (statuses.length > 0) {
    filters.status = statuses;
    parts.push(`status ${statuses.join(' or ')}`);
  }

  if (/\bunassigned|no owner|nobody\b/.test(q)) {
    filters.unassigned = true;
    parts.push('with no owner');
  }

  const relativeDays = /\blast (\d+) days?\b/.exec(q)?.[1];
  if (relativeDays) {
    filters.createdAfter = new Date(Date.now() - Number(relativeDays) * 86_400_000).toISOString();
    parts.push(`created in the last ${relativeDays} days`);
  } else if (/\b(this week|last week|past week)\b/.test(q)) {
    filters.createdAfter = new Date(Date.now() - 7 * 86_400_000).toISOString();
    parts.push('created in the last 7 days');
  } else if (/\b(this month|last month|past month)\b/.test(q)) {
    filters.createdAfter = new Date(Date.now() - 30 * 86_400_000).toISOString();
    parts.push('created in the last 30 days');
  }

  // Whatever is left that looks like a proper noun becomes the text search.
  const stopwords = new Set([
    'show', 'me', 'all', 'the', 'leads', 'lead', 'find', 'get', 'list', 'with', 'from',
    'in', 'at', 'who', 'that', 'are', 'is', 'and', 'or', 'my', 'our', 'a', 'an', 'of',
    'hot', 'cold', 'new', 'top', 'best', 'last', 'this', 'week', 'month', 'days', 'day',
  ]);
  const residual = q
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopwords.has(word) && !/^\d+$/.test(word));

  if (residual.length > 0 && Object.keys(filters).length === 0) {
    filters.q = residual.join(' ');
    parts.push(`matching "${filters.q}"`);
  }

  return {
    filters,
    interpretation:
      parts.length > 0
        ? `Showing leads ${parts.join(', ')}. (Keyword matching — AI search is unavailable.)`
        : 'Could not interpret that request; showing all leads.',
  };
};

/* -------------------------------------------------------------------------- */
/* Lead insights                                                              */
/* -------------------------------------------------------------------------- */

export const heuristicInsights = (lead: ScorableLead) => {
  const scored = heuristicScore(lead);
  const missing: string[] = [];
  if (!lead.email) missing.push('no email address on file');
  if (!lead.phone) missing.push('no phone number on file');
  if (!lead.company) missing.push('company is unknown');
  if (!lead.jobTitle) missing.push('job title is unknown');

  const talkingPoints: string[] = [];
  if (lead.company) talkingPoints.push(`Reference their work at ${lead.company}.`);
  if (lead.industry) talkingPoints.push(`Lead with a ${lead.industry} case study.`);
  if (lead.jobTitle) talkingPoints.push(`Frame the value for a ${lead.jobTitle}.`);
  if (talkingPoints.length === 0) talkingPoints.push('Open by confirming their role and priorities.');

  return {
    summary: scored.summary,
    talkingPoints,
    risks: missing.length > 0 ? missing : ['No obvious gaps in this record.'],
    suggestedNextAction: scored.nextAction,
    recommendedChannel: lead.phone ? 'CALL' : lead.email ? 'EMAIL' : 'LINKEDIN',
    draftOpener: `Hi ${lead.fullName.split(' ')[0] ?? 'there'}, I noticed you're${
      lead.jobTitle ? ` a ${lead.jobTitle}` : ''
    }${lead.company ? ` at ${lead.company}` : ''}. I'd love to show you how teams like yours are solving this — do you have 15 minutes this week?`,
  };
};
