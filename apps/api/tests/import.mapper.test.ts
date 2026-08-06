/**
 * CSV row mapping.
 *
 * The importer's contract: never throw for data reasons, never silently drop a
 * column, and never let one bad row fail an import. These tests pin that
 * behaviour against the value formats real exports contain.
 */
import { describe, expect, it } from 'vitest';
import { LeadPriority, LeadSource, LeadStatus } from '../src/models';
import { mapRow, parseMoney, type ColumnMapping } from '../src/modules/imports/import.mapper';

const baseOptions = {
  defaultSource: LeadSource.CSV_IMPORT,
  sourceDetail: 'contacts.csv',
  defaultOwnerId: null,
  keepUnmappedAsCustomFields: true,
};

describe('parseMoney', () => {
  it('parses the common currency formats', () => {
    expect(parseMoney('$12,500.00')).toBe(12_500);
    expect(parseMoney('12500')).toBe(12_500);
    expect(parseMoney('12 500')).toBe(12_500);
    expect(parseMoney('£1,200')).toBe(1_200);
  });

  it('handles European decimal notation', () => {
    // "1.234,56" is one thousand two hundred, not one point two.
    expect(parseMoney('€1.234,56')).toBe(1_235);
  });

  it('expands k/m suffixes', () => {
    expect(parseMoney('50k')).toBe(50_000);
    expect(parseMoney('1.2M')).toBe(1_200_000);
  });

  it('clamps negatives to zero', () => {
    // Accounting parentheses mean negative; a negative pipeline value is a data
    // error, not something to propagate into revenue totals.
    expect(parseMoney('(500)')).toBe(0);
    expect(parseMoney('-500')).toBe(0);
  });

  it('returns undefined for non-numeric input', () => {
    expect(parseMoney('TBD')).toBeUndefined();
    expect(parseMoney('')).toBeUndefined();
  });
});

describe('mapRow', () => {
  const mapping: ColumnMapping = {
    'First Name': 'firstName',
    'Last Name': 'lastName',
    Email: 'email',
    Phone: 'phone',
    Company: 'company',
    'Job Title': 'jobTitle',
    'Deal Value': 'estimatedValue',
    Stage: 'status',
    'Lead Source': 'source',
    'Internal Ref': null, // deliberately unmapped
  };

  it('maps a well-formed row', () => {
    const result = mapRow(
      {
        'First Name': 'jane',
        'Last Name': 'doe',
        Email: 'Jane.Doe@ACME.com',
        Phone: '(555) 010-1234',
        Company: 'Acme Corp',
        'Job Title': 'CTO',
        'Deal Value': '$50,000',
        Stage: 'Closed Won',
        'Lead Source': 'Referral',
        'Internal Ref': 'XYZ-99',
      },
      { mapping, ...baseOptions },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { data, dedupeKey } = result.lead;
    expect(data.firstName).toBe('Jane');
    expect(data.lastName).toBe('Doe');
    expect(data.fullName).toBe('Jane Doe');
    expect(data.email).toBe('jane.doe@acme.com');
    expect(data.phone).toBe('5550101234');
    expect(data.estimatedValue).toBe(50_000);
    expect(data.status).toBe(LeadStatus.WON);
    expect(data.source).toBe(LeadSource.REFERRAL);
    expect(dedupeKey).toBe('e:jane.doe@acme.com');
  });

  it('preserves unmapped columns instead of discarding them', () => {
    const result = mapRow(
      { Email: 'jane@acme.com', 'Internal Ref': 'XYZ-99' },
      { mapping, ...baseOptions },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lead.data.customFields).toMatchObject({ 'Internal Ref': 'XYZ-99' });
  });

  it('drops unmapped columns when the user opts out', () => {
    const result = mapRow(
      { Email: 'jane@acme.com', 'Internal Ref': 'XYZ-99' },
      { mapping, ...baseOptions, keepUnmappedAsCustomFields: false },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lead.data.customFields).toEqual({});
  });

  it('splits a combined full-name column', () => {
    const result = mapRow(
      { Name: 'Jane Quinn Doe' },
      { mapping: { Name: 'fullName' }, ...baseOptions },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lead.data.firstName).toBe('Jane Quinn');
    expect(result.lead.data.lastName).toBe('Doe');
  });

  it('recognises status synonyms from other CRMs', () => {
    const cases: Array<[string, LeadStatus]> = [
      ['Open', LeadStatus.NEW],
      ['In Progress', LeadStatus.CONTACTED],
      ['MQL', LeadStatus.QUALIFIED],
      ['Negotiation', LeadStatus.PROPOSAL],
      ['Closed Lost', LeadStatus.LOST],
      ['Bad Fit', LeadStatus.DISQUALIFIED],
    ];

    for (const [input, expected] of cases) {
      const result = mapRow(
        { Email: 'a@b.com', Stage: input },
        { mapping: { Email: 'email', Stage: 'status' }, ...baseOptions },
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.lead.data.status).toBe(expected);
    }
  });

  it('falls back to defaults for unrecognised enum values', () => {
    const result = mapRow(
      { Email: 'a@b.com', Stage: 'Schrödinger' },
      { mapping: { Email: 'email', Stage: 'status' }, ...baseOptions },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lead.data.status).toBe(LeadStatus.NEW);
    expect(result.lead.data.priority).toBe(LeadPriority.MEDIUM);
  });

  it('rejects a row with no identifying information', () => {
    const result = mapRow({ 'Internal Ref': 'XYZ' }, { mapping, ...baseOptions });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/no email, phone, name or company/i);
  });

  it('reports a malformed email rather than importing the lead without one', () => {
    // Silently dropping it would lose the only contact detail on the record and
    // give the user no way to know.
    const result = mapRow(
      { Email: 'not-an-email', Company: 'Acme' },
      { mapping, ...baseOptions },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.field).toBe('email');
  });

  it('accepts a row that only has a company', () => {
    const result = mapRow({ Company: 'Acme Corp' }, { mapping, ...baseOptions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lead.data.fullName).toBe('Acme Corp');
  });

  it('records provenance on every row', () => {
    const result = mapRow({ Email: 'a@b.com' }, { mapping, ...baseOptions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lead.data.sourceDetail).toBe('contacts.csv');
  });

  it('bounds custom fields so a wide file cannot bloat every row', () => {
    const wideRow: Record<string, string> = { Email: 'a@b.com' };
    for (let i = 0; i < 100; i += 1) wideRow[`col${i}`] = `value${i}`;

    const result = mapRow(wideRow, { mapping: { Email: 'email' }, ...baseOptions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.lead.data.customFields as object).length).toBeLessThanOrEqual(30);
  });
});
