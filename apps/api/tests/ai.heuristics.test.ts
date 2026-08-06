/**
 * Deterministic AI fallbacks.
 *
 * These run whenever the provider is unavailable, so they are on the critical
 * path of a production incident — and unlike the model, they can be asserted
 * exactly. They are also the baseline the LLM has to beat to justify its cost.
 */
import { describe, expect, it } from 'vitest';
import { LeadPriority, LeadSource } from '../src/models';
import { heuristicMapping, heuristicScore, heuristicSearch } from '../src/modules/ai/ai.heuristics';

const lead = (overrides: Partial<Parameters<typeof heuristicScore>[0]> = {}) => ({
  id: 'lead-1',
  fullName: 'Jane Doe',
  email: null,
  phone: null,
  company: null,
  jobTitle: null,
  industry: null,
  companySize: null,
  country: null,
  website: null,
  source: LeadSource.CSV_IMPORT,
  estimatedValue: null,
  notes: null,
  ...overrides,
});

describe('heuristicScore', () => {
  it('always produces a score inside 0-100', () => {
    const best = heuristicScore(
      lead({
        email: 'ceo@acme.com',
        phone: '5550101234',
        company: 'Acme',
        jobTitle: 'Chief Executive Officer',
        industry: 'Software',
        companySize: '1000+',
        website: 'https://acme.com',
        source: LeadSource.REFERRAL,
        estimatedValue: 500_000,
        notes: 'Budget approved, wants a demo and pricing this week',
      }),
    );
    const worst = heuristicScore(lead());

    expect(best.score).toBeLessThanOrEqual(100);
    expect(worst.score).toBeGreaterThanOrEqual(0);
    expect(best.score).toBeGreaterThan(worst.score);
  });

  it('ranks a senior decision-maker above an intern at the same company', () => {
    const exec = heuristicScore(lead({ jobTitle: 'VP of Engineering', company: 'Acme', email: 'v@acme.com' }));
    const intern = heuristicScore(lead({ jobTitle: 'Marketing Intern', company: 'Acme', email: 'i@acme.com' }));
    expect(exec.score).toBeGreaterThan(intern.score);
  });

  it('rewards a business email over a free provider', () => {
    const business = heuristicScore(lead({ email: 'jane@acme.com' }));
    const freemail = heuristicScore(lead({ email: 'jane@gmail.com' }));
    expect(business.score).toBeGreaterThan(freemail.score);
    expect(business.rationale).toMatch(/business email/i);
  });

  it('rewards high-intent sources over scraped lists', () => {
    const referral = heuristicScore(lead({ source: LeadSource.REFERRAL }));
    const imported = heuristicScore(lead({ source: LeadSource.CSV_IMPORT }));
    expect(referral.score).toBeGreaterThan(imported.score);
  });

  it('detects buying signals in the notes', () => {
    const withSignal = heuristicScore(lead({ notes: 'Asked for pricing and a proposal' }));
    const without = heuristicScore(lead({ notes: 'Met at a conference' }));
    expect(withSignal.score).toBeGreaterThan(without.score);
  });

  it('derives priority from the score consistently', () => {
    const strong = heuristicScore(
      lead({
        email: 'ceo@acme.com',
        phone: '5550101234',
        company: 'Acme',
        jobTitle: 'CEO',
        companySize: '1000+',
        source: LeadSource.REFERRAL,
        notes: 'wants a demo, budget approved',
      }),
    );
    expect([LeadPriority.HIGH, LeadPriority.URGENT]).toContain(strong.priority);
    expect(heuristicScore(lead()).priority).toBe(LeadPriority.LOW);
  });

  it('is deterministic', () => {
    // The whole value of the fallback is that it does not vary run to run.
    const input = lead({ email: 'jane@acme.com', jobTitle: 'Director' });
    expect(heuristicScore(input)).toEqual(heuristicScore(input));
  });

  it('always returns a usable next action and summary', () => {
    const result = heuristicScore(lead());
    expect(result.nextAction.length).toBeGreaterThan(0);
    expect(result.summary).toContain('Jane Doe');
  });
});

describe('heuristicMapping', () => {
  it('matches the headers real CRM exports use', () => {
    const mappings = heuristicMapping([
      'First Name', 'Last Name', 'Email Address', 'Phone Number',
      'Company Name', 'Job Title', 'Lead Source',
    ]);
    const byColumn = Object.fromEntries(mappings.map((m) => [m.csvColumn, m.leadField]));

    expect(byColumn['First Name']).toBe('firstName');
    expect(byColumn['Last Name']).toBe('lastName');
    expect(byColumn['Email Address']).toBe('email');
    expect(byColumn['Phone Number']).toBe('phone');
    expect(byColumn['Company Name']).toBe('company');
    expect(byColumn['Job Title']).toBe('jobTitle');
    expect(byColumn['Lead Source']).toBe('source');
  });

  it('is insensitive to separators and case', () => {
    const mappings = heuristicMapping(['first_name', 'LAST-NAME', 'e-mail']);
    expect(mappings[0]?.leadField).toBe('firstName');
    expect(mappings[1]?.leadField).toBe('lastName');
    expect(mappings[2]?.leadField).toBe('email');
  });

  it('never assigns the same target field twice', () => {
    // Two columns writing to one field is last-write-wins, which the user
    // cannot reason about — so it must be structurally impossible.
    const mappings = heuristicMapping(['Name', 'Full Name', 'Contact Name']);
    const assigned = mappings.map((m) => m.leadField).filter(Boolean);
    expect(new Set(assigned).size).toBe(assigned.length);
  });

  it('prefers an exact match over a fuzzy one', () => {
    const mappings = heuristicMapping(['Contact', 'Email']);
    const email = mappings.find((m) => m.csvColumn === 'Email');
    expect(email?.leadField).toBe('email');
    expect(email?.confidence).toBeGreaterThan(0.9);
  });

  it('leaves unrecognised columns unmapped rather than guessing', () => {
    const mappings = heuristicMapping(['Internal Ref XYZ']);
    expect(mappings[0]?.leadField).toBeNull();
    expect(mappings[0]?.confidence).toBe(0);
  });

  it('returns one entry per input header', () => {
    const headers = ['A', 'B', 'C', 'Email'];
    expect(heuristicMapping(headers)).toHaveLength(headers.length);
  });
});

describe('heuristicSearch', () => {
  it('maps quality language onto score thresholds', () => {
    expect(heuristicSearch('show me hot leads').filters).toMatchObject({ minScore: 70 });
    expect(heuristicSearch('cold leads').filters).toMatchObject({ maxScore: 40 });
  });

  it('recognises pipeline stages', () => {
    expect(heuristicSearch('qualified leads').filters).toMatchObject({ status: ['QUALIFIED'] });
  });

  it('recognises unassigned', () => {
    expect(heuristicSearch('leads with no owner').filters).toMatchObject({ unassigned: true });
  });

  it('resolves relative date ranges to absolute dates', () => {
    const result = heuristicSearch('leads from the last 14 days');
    expect(result.filters.createdAfter).toBeTypeOf('string');
  });

  it('falls back to text search rather than returning nothing', () => {
    const result = heuristicSearch('acme corporation');
    expect(result.filters.q).toContain('acme');
  });

  it('always explains itself', () => {
    // The UI shows this to the user; an empty interpretation would render as a
    // blank explanation box.
    expect(heuristicSearch('anything at all').interpretation.length).toBeGreaterThan(0);
  });
});
