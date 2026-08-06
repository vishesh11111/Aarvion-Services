/**
 * Normalisation and deduplication.
 *
 * These are the highest-value unit tests in the codebase: dedupe correctness
 * decides whether re-importing last month's export creates 20,000 duplicates or
 * updates 20,000 rows, and it is enforced by a database constraint that will
 * happily reject an entire batch if the key is computed inconsistently.
 *
 * Cases are drawn from the shapes real CRM exports actually contain.
 */
import { describe, expect, it } from 'vitest';
import {
  buildDedupeKey,
  buildFullName,
  cleanString,
  dedupeKeyFor,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  normalizeTags,
  normalizeUrl,
  scoreInputSignature,
  splitFullName,
} from '../src/modules/leads/lead.normalizer';

describe('cleanString', () => {
  it('collapses whitespace and trims', () => {
    expect(cleanString('  Acme   Corp  ')).toBe('Acme Corp');
  });

  it('treats spreadsheet null-markers as empty', () => {
    for (const marker of ['N/A', 'n/a', 'NULL', 'none', '-', '--', '#N/A']) {
      expect(cleanString(marker)).toBeUndefined();
    }
  });

  it('returns undefined rather than an empty string', () => {
    expect(cleanString('   ')).toBeUndefined();
    expect(cleanString(null)).toBeUndefined();
    expect(cleanString(undefined)).toBeUndefined();
  });

  it('truncates to the column limit', () => {
    expect(cleanString('a'.repeat(500), 100)).toHaveLength(100);
  });
});

describe('normalizeEmail', () => {
  it('lower-cases and trims', () => {
    expect(normalizeEmail('  Jane.Doe@Example.COM ')).toBe('jane.doe@example.com');
  });

  it('extracts the address from a display-name form', () => {
    expect(normalizeEmail('Jane Doe <jane@example.com>')).toBe('jane@example.com');
  });

  it('takes the first address from a delimited list', () => {
    expect(normalizeEmail('jane@example.com; john@example.com')).toBe('jane@example.com');
  });

  it('rejects malformed addresses instead of storing them', () => {
    for (const invalid of ['not-an-email', 'jane@', '@example.com', 'jane@example', 'a b@c.com']) {
      expect(normalizeEmail(invalid)).toBeUndefined();
    }
  });
});

describe('normalizePhone', () => {
  it('strips formatting so equivalent numbers compare equal', () => {
    expect(normalizePhone('(555) 010-1234')).toBe('5550101234');
    expect(normalizePhone('555-010-1234')).toBe('5550101234');
    expect(normalizePhone('555.010.1234')).toBe('5550101234');
  });

  it('preserves the international prefix', () => {
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
  });

  it('rejects numbers outside the E.164 length bounds', () => {
    expect(normalizePhone('12345')).toBeUndefined();
    expect(normalizePhone('1234567890123456789')).toBeUndefined();
  });
});

describe('normalizeUrl', () => {
  it('adds a scheme when one is missing', () => {
    expect(normalizeUrl('acme.com')).toBe('https://acme.com');
  });

  it('rejects values that are not hostnames', () => {
    expect(normalizeUrl('not a url')).toBeUndefined();
    expect(normalizeUrl('localhost')).toBeUndefined(); // no dot => not a public host
  });

  it('rejects non-http schemes', () => {
    // `javascript:` in a field the UI renders as a link would be stored XSS.
    expect(normalizeUrl('javascript:alert(1)')).toBeUndefined();
    expect(normalizeUrl('ftp://files.acme.com')).toBeUndefined();
  });
});

describe('normalizeName', () => {
  it('title-cases all-lower and all-upper input', () => {
    expect(normalizeName('jane doe')).toBe('Jane Doe');
    expect(normalizeName('JANE DOE')).toBe('Jane Doe');
  });

  it('leaves deliberately mixed case alone', () => {
    // Re-casing this would turn "McDonald" into "Mcdonald".
    expect(normalizeName('Ronald McDonald')).toBe('Ronald McDonald');
  });

  it('handles hyphenated names', () => {
    expect(normalizeName('mary-jane watson')).toBe('Mary-Jane Watson');
  });
});

describe('splitFullName', () => {
  it('treats the final token as the surname', () => {
    expect(splitFullName('Jane Doe')).toEqual({ firstName: 'Jane', lastName: 'Doe' });
    expect(splitFullName('Jane Quinn Doe')).toEqual({ firstName: 'Jane Quinn', lastName: 'Doe' });
  });

  it('handles a single token', () => {
    expect(splitFullName('Cher')).toEqual({ firstName: 'Cher' });
  });
});

describe('buildFullName', () => {
  it('joins the parts it has', () => {
    expect(buildFullName('Jane', 'Doe')).toBe('Jane Doe');
    expect(buildFullName('Jane', undefined)).toBe('Jane');
  });

  it('falls back rather than producing an empty name', () => {
    // fullName is NOT NULL in the schema, so this must always return something.
    expect(buildFullName(undefined, undefined, 'jane@acme.com')).toBe('jane@acme.com');
    expect(buildFullName(undefined, undefined, undefined)).toBe('Unknown');
  });
});

describe('buildDedupeKey', () => {
  it('prefers email over every other identifier', () => {
    const key = buildDedupeKey({
      email: 'jane@acme.com',
      phone: '5550101234',
      fullName: 'Jane Doe',
      company: 'Acme',
    });
    expect(key).toBe('e:jane@acme.com');
  });

  it('falls back to phone, then name+company', () => {
    expect(buildDedupeKey({ phone: '5550101234', fullName: 'Jane Doe' })).toBe('p:5550101234');
    expect(buildDedupeKey({ fullName: 'Jane Doe', company: 'Acme Inc.' })).toMatch(/^nc:/);
  });

  it('collapses cosmetic company differences', () => {
    // "Acme, Inc." and "acme inc" are the same company; a naive key would
    // create a duplicate for every legal-suffix variant in the file.
    const a = buildDedupeKey({ fullName: 'Jane Doe', company: 'Acme, Inc.' });
    const b = buildDedupeKey({ fullName: 'jane doe', company: 'acme inc' });
    expect(a).toBe(b);
  });

  it('folds accents so unicode variants match', () => {
    const a = buildDedupeKey({ fullName: 'José Álvarez', company: 'Acme' });
    const b = buildDedupeKey({ fullName: 'Jose Alvarez', company: 'Acme' });
    expect(a).toBe(b);
  });

  it('never returns an empty key, and never dedupes anonymous rows together', () => {
    // Two records with no identifying data are not evidence they are the same
    // person. Creating a duplicate is recoverable; merging strangers is not.
    const a = buildDedupeKey({});
    const b = buildDedupeKey({});
    expect(a).toMatch(/^x:/);
    expect(a).not.toBe(b);
  });
});

describe('dedupeKeyFor', () => {
  it('accepts the nullable shape a database row has', () => {
    expect(
      dedupeKeyFor({ email: 'jane@acme.com', phone: null, fullName: 'Jane Doe', company: null }),
    ).toBe('e:jane@acme.com');
  });
});

describe('normalizeTags', () => {
  it('lower-cases and de-duplicates', () => {
    expect(normalizeTags(['Enterprise', 'enterprise', 'EMEA'])).toEqual(['enterprise', 'emea']);
  });

  it('splits delimited strings', () => {
    expect(normalizeTags('enterprise, emea; renewal')).toEqual(['enterprise', 'emea', 'renewal']);
  });

  it('caps the list so one bad row cannot create hundreds of tags', () => {
    const many = Array.from({ length: 100 }, (_, i) => `tag${i}`);
    expect(normalizeTags(many).length).toBeLessThanOrEqual(25);
  });
});

describe('scoreInputSignature', () => {
  const lead = {
    fullName: 'Jane Doe',
    email: 'jane@acme.com',
    company: 'Acme',
    jobTitle: 'CTO',
    industry: 'Software',
    companySize: '51-200',
    country: 'US',
    source: 'REFERRAL',
    estimatedValue: 50_000,
    notes: 'Wants a demo',
  };

  it('is stable for unchanged input', () => {
    expect(scoreInputSignature(lead)).toBe(scoreInputSignature(lead));
  });

  it('changes when a commercially relevant field changes', () => {
    expect(scoreInputSignature({ ...lead, jobTitle: 'Intern' })).not.toBe(scoreInputSignature(lead));
  });

  it('fits the column width', () => {
    // scoreInputHash is VARCHAR(64); a longer value would be a runtime failure
    // only observable in production.
    expect(scoreInputSignature(lead)).toHaveLength(64);
  });
});
