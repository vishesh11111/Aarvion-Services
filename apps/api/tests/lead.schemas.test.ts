/**
 * Request validation.
 *
 * The schemas are the API's trust boundary: anything they accept reaches the
 * database. These tests pin the boundary, particularly the cases where being
 * permissive would be a security or data-integrity problem.
 */
import { describe, expect, it } from 'vitest';
import { LeadStatus } from '../src/models';
import {
  bulkUpdateSchema,
  createLeadSchema,
  listLeadsSchema,
  mergeLeadsSchema,
  updateLeadSchema,
} from '../src/modules/leads/lead.schemas';
import { passwordSchema, registerSchema } from '../src/modules/auth/auth.schemas';

// A syntactically valid 24-character hex ObjectId.
const oid = '507f1f77bcf86cd799439011';

describe('createLeadSchema', () => {
  it('accepts a lead with any single identifier', () => {
    expect(createLeadSchema.safeParse({ email: 'jane@acme.com' }).success).toBe(true);
    expect(createLeadSchema.safeParse({ phone: '+15550101234' }).success).toBe(true);
    expect(createLeadSchema.safeParse({ company: 'Acme' }).success).toBe(true);
  });

  it('rejects a lead with nothing identifying', () => {
    const result = createLeadSchema.safeParse({ notes: 'called them' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields instead of ignoring them', () => {
    // Strict mode is mass-assignment protection: without it, a client could try
    // to set `score`, `organizationId` or `deletedAt` directly.
    const result = createLeadSchema.safeParse({
      email: 'jane@acme.com',
      organizationId: 'someone-elses-org',
    });
    expect(result.success).toBe(false);
  });

  it('normalises the email', () => {
    const result = createLeadSchema.safeParse({ email: '  Jane@ACME.com ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.email).toBe('jane@acme.com');
  });

  it('applies sensible defaults', () => {
    const result = createLeadSchema.safeParse({ email: 'jane@acme.com' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('NEW');
      expect(result.data.priority).toBe('MEDIUM');
      expect(result.data.source).toBe('MANUAL');
      expect(result.data.tags).toEqual([]);
    }
  });

  it('rejects out-of-range and negative money', () => {
    expect(createLeadSchema.safeParse({ email: 'a@b.com', estimatedValue: -1 }).success).toBe(false);
    expect(createLeadSchema.safeParse({ email: 'a@b.com', estimatedValue: 2e9 }).success).toBe(false);
  });

  it('caps the tag list', () => {
    const tags = Array.from({ length: 30 }, (_, i) => `t${i}`);
    expect(createLeadSchema.safeParse({ email: 'a@b.com', tags }).success).toBe(false);
  });
});

describe('updateLeadSchema', () => {
  it('requires at least one field', () => {
    expect(updateLeadSchema.safeParse({}).success).toBe(false);
  });

  it('distinguishes null (clear) from absent (leave alone)', () => {
    // This distinction is the entire reason PATCH exists here; if `null` were
    // rejected there would be no way to remove a phone number.
    const result = updateLeadSchema.safeParse({ phone: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('phone' in result.data).toBe(true);
      expect(result.data.phone).toBeNull();
    }
  });

  it('does not apply create-time defaults', () => {
    // Reusing `.partial()` on the create schema would silently reset status to
    // NEW on every PATCH that did not mention it.
    const result = updateLeadSchema.safeParse({ company: 'Acme' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.status).toBeUndefined();
  });
});

describe('listLeadsSchema', () => {
  it('parses a comma-separated enum list', () => {
    const result = listLeadsSchema.safeParse({ status: 'NEW,QUALIFIED' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.status).toEqual([LeadStatus.NEW, LeadStatus.QUALIFIED]);
  });

  it('rejects an invalid enum value rather than ignoring it', () => {
    expect(listLeadsSchema.safeParse({ status: 'NOT_A_STATUS' }).success).toBe(false);
  });

  it('coerces numeric query strings', () => {
    const result = listLeadsSchema.safeParse({ limit: '50', minScore: '70' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
      expect(result.data.minScore).toBe(70);
    }
  });

  it('caps the page size', () => {
    // Without this, `?limit=1000000` is a one-request denial of service.
    expect(listLeadsSchema.safeParse({ limit: '10000' }).success).toBe(false);
  });

  it('rejects a contradictory score range', () => {
    expect(listLeadsSchema.safeParse({ minScore: 80, maxScore: 20 }).success).toBe(false);
  });

  it('rejects an inverted date range', () => {
    const result = listLeadsSchema.safeParse({
      createdAfter: '2026-06-01',
      createdBefore: '2026-01-01',
    });
    expect(result.success).toBe(false);
  });

  it('restricts sorting to an allow-list', () => {
    // sortBy reaches an ORDER BY clause; an open string would be an injection
    // surface even through an ORM.
    expect(listLeadsSchema.safeParse({ sortBy: 'passwordHash' }).success).toBe(false);
    expect(listLeadsSchema.safeParse({ sortBy: 'score' }).success).toBe(true);
  });
});

describe('bulkUpdateSchema', () => {
  it('requires at least one id and one change', () => {
    expect(bulkUpdateSchema.safeParse({ leadIds: [], patch: { status: 'WON' } }).success).toBe(false);
    expect(bulkUpdateSchema.safeParse({ leadIds: [oid], patch: {} }).success).toBe(false);
  });

  it('caps the batch size', () => {
    // Bounds how many rows a single transaction can lock.
    const ids = Array.from({ length: 501 }, () => oid);
    expect(bulkUpdateSchema.safeParse({ leadIds: ids, patch: { status: 'WON' } }).success).toBe(false);
  });
});

describe('mergeLeadsSchema', () => {
  it('rejects merging a lead into itself', () => {
    const result = mergeLeadsSchema.safeParse({ primaryId: oid, duplicateIds: [oid] });
    expect(result.success).toBe(false);
  });
});

describe('passwordSchema', () => {
  it('enforces length over composition rules', () => {
    expect(passwordSchema.safeParse('Short1!').success).toBe(false);
    // A long passphrase with no symbols is accepted — it has far more entropy
    // than "P@ssw0rd", which is rejected below.
    expect(passwordSchema.safeParse('correct horse battery staple').success).toBe(true);
  });

  it('rejects known-common passwords', () => {
    expect(passwordSchema.safeParse('password123').success).toBe(false);
    expect(passwordSchema.safeParse('Password123').success).toBe(false);
  });

  it('rejects low-variety strings that pass the length check', () => {
    expect(passwordSchema.safeParse('aaaaaaaaaaaaaaa').success).toBe(false);
  });
});

describe('registerSchema', () => {
  it('accepts a well-formed registration', () => {
    const result = registerSchema.safeParse({
      organizationName: 'Acme Corporation',
      name: 'Jane Doe',
      email: 'JANE@ACME.COM',
      password: 'correct horse battery staple',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.email).toBe('jane@acme.com');
  });

  it('rejects extra fields such as a self-assigned role', () => {
    const result = registerSchema.safeParse({
      organizationName: 'Acme',
      name: 'Jane Doe',
      email: 'jane@acme.com',
      password: 'correct horse battery staple',
      role: 'OWNER',
    });
    expect(result.success).toBe(false);
  });
});
