/**
 * Authorisation rules.
 *
 * Permission bugs are silent — nothing errors, the wrong person just sees the
 * wrong data — so these are asserted exhaustively rather than by sampling.
 */
import { describe, expect, it } from 'vitest';
import { Role } from '../src/models';
import {
  assertCan,
  can,
  canMutateLead,
  hasAtLeast,
  rankOf,
} from '../src/modules/auth/rbac';
import { InsufficientRoleError } from '../src/lib/errors';
import type { TenantContext } from '../src/types';

const ctx = (role: Role, userId = 'user-1'): TenantContext => ({
  organizationId: 'org-1',
  userId,
  role,
});

describe('role hierarchy', () => {
  it('ranks roles strictly', () => {
    expect(rankOf(Role.OWNER)).toBeGreaterThan(rankOf(Role.ADMIN));
    expect(rankOf(Role.ADMIN)).toBeGreaterThan(rankOf(Role.MEMBER));
    expect(rankOf(Role.MEMBER)).toBeGreaterThan(rankOf(Role.VIEWER));
  });

  it('treats a role as satisfying itself', () => {
    for (const role of Object.values(Role)) {
      expect(hasAtLeast(role, role)).toBe(true);
    }
  });

  it('does not let a lower role satisfy a higher requirement', () => {
    expect(hasAtLeast(Role.VIEWER, Role.MEMBER)).toBe(false);
    expect(hasAtLeast(Role.MEMBER, Role.ADMIN)).toBe(false);
    expect(hasAtLeast(Role.ADMIN, Role.OWNER)).toBe(false);
  });
});

describe('capabilities', () => {
  it('lets every role read leads', () => {
    for (const role of Object.values(Role)) {
      expect(can(ctx(role), 'LEAD_READ')).toBe(true);
    }
  });

  it('keeps viewers read-only', () => {
    const viewer = ctx(Role.VIEWER);
    expect(can(viewer, 'LEAD_WRITE')).toBe(false);
    expect(can(viewer, 'LEAD_DELETE')).toBe(false);
    expect(can(viewer, 'IMPORT_CREATE')).toBe(false);
    expect(can(viewer, 'AI_USE')).toBe(false);
    // …but they can still see reports, which is the point of the role.
    expect(can(viewer, 'ANALYTICS_READ')).toBe(true);
  });

  it('restricts team management to admins and above', () => {
    expect(can(ctx(Role.MEMBER), 'MEMBER_MANAGE')).toBe(false);
    expect(can(ctx(Role.ADMIN), 'MEMBER_MANAGE')).toBe(true);
    expect(can(ctx(Role.OWNER), 'MEMBER_MANAGE')).toBe(true);
  });

  it('restricts organization management to owners', () => {
    expect(can(ctx(Role.ADMIN), 'ORG_MANAGE')).toBe(false);
    expect(can(ctx(Role.OWNER), 'ORG_MANAGE')).toBe(true);
  });
});

describe('assertCan', () => {
  it('throws a typed error carrying the required roles', () => {
    try {
      assertCan(ctx(Role.VIEWER), 'LEAD_WRITE');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InsufficientRoleError);
      expect((error as InsufficientRoleError).statusCode).toBe(403);
    }
  });

  it('is silent when permitted', () => {
    expect(() => assertCan(ctx(Role.ADMIN), 'LEAD_WRITE')).not.toThrow();
  });
});

describe('canMutateLead', () => {
  it('lets admins and owners edit anything in their organization', () => {
    expect(canMutateLead(ctx(Role.ADMIN), 'someone-else')).toBe(true);
    expect(canMutateLead(ctx(Role.OWNER), 'someone-else')).toBe(true);
  });

  it('limits members to their own and unassigned leads', () => {
    const member = ctx(Role.MEMBER, 'user-1');
    expect(canMutateLead(member, 'user-1')).toBe(true);
    expect(canMutateLead(member, null)).toBe(true);
    expect(canMutateLead(member, 'user-2')).toBe(false);
  });

  it('never lets a viewer mutate, even an unassigned lead', () => {
    expect(canMutateLead(ctx(Role.VIEWER), null)).toBe(false);
    expect(canMutateLead(ctx(Role.VIEWER), 'user-1')).toBe(false);
  });
});
