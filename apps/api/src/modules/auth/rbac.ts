/**
 * Role-based access control.
 *
 * Roles are hierarchical: OWNER ⊇ ADMIN ⊇ MEMBER ⊇ VIEWER. Rather than listing
 * every acceptable role at each call site (which drifts the moment a role is
 * added), guards declare the *minimum* rank required.
 *
 * Object-level rules that depend on the record itself (e.g. "a MEMBER may only
 * edit leads they own") live next to the resource in its service, because they
 * need the row to decide. This file handles the role dimension only.
 */
import { Role } from '../../models';
import { InsufficientRoleError } from '../../lib/errors';
import type { TenantContext } from '../../types';

const RANK: Record<Role, number> = {
  [Role.OWNER]: 40,
  [Role.ADMIN]: 30,
  [Role.MEMBER]: 20,
  [Role.VIEWER]: 10,
};

export const rankOf = (role: Role): number => RANK[role];

export const hasAtLeast = (role: Role, minimum: Role): boolean => RANK[role] >= RANK[minimum];

/** Roles at or above `minimum`, for error messages. */
export const rolesAtLeast = (minimum: Role): Role[] =>
  (Object.keys(RANK) as Role[]).filter((r) => RANK[r] >= RANK[minimum]);

export const assertAtLeast = (role: Role, minimum: Role): void => {
  if (!hasAtLeast(role, minimum)) throw new InsufficientRoleError(rolesAtLeast(minimum), role);
};

/**
 * Capability matrix. Named capabilities beat scattered role literals: when the
 * rules change, they change here, and the guard at the route reads as intent.
 */
export const Capability = {
  LEAD_READ: Role.VIEWER,
  LEAD_WRITE: Role.MEMBER,
  LEAD_DELETE: Role.MEMBER,
  LEAD_BULK_WRITE: Role.MEMBER,
  IMPORT_CREATE: Role.MEMBER,
  IMPORT_READ: Role.VIEWER,
  AI_USE: Role.MEMBER,
  ANALYTICS_READ: Role.VIEWER,
  MEMBER_MANAGE: Role.ADMIN,
  ORG_MANAGE: Role.OWNER,
  AUDIT_READ: Role.ADMIN,
} as const;

export type CapabilityName = keyof typeof Capability;

export const can = (ctx: TenantContext, capability: CapabilityName): boolean =>
  hasAtLeast(ctx.role, Capability[capability]);

export const assertCan = (ctx: TenantContext, capability: CapabilityName): void => {
  if (!can(ctx, capability)) {
    throw new InsufficientRoleError(rolesAtLeast(Capability[capability]), ctx.role);
  }
};

/**
 * A MEMBER may only mutate leads they own or that are unassigned; ADMIN and
 * above may mutate anything in their organization. Enforced in the lead service
 * where the owner is known.
 */
export const canMutateLead = (ctx: TenantContext, leadOwnerId: string | null): boolean => {
  if (hasAtLeast(ctx.role, Role.ADMIN)) return true;
  if (!hasAtLeast(ctx.role, Role.MEMBER)) return false;
  return leadOwnerId === null || leadOwnerId === ctx.userId;
};
