/**
 * Authentication service.
 *
 * Holds all credential handling and session lifecycle. Controllers stay thin:
 * they translate HTTP to arguments and back, nothing more.
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { ClientSession } from 'mongoose';
import {
  OrganizationModel,
  RefreshTokenModel,
  Role,
  UserModel,
  UserStatus,
  toObjectId,
  type UserDoc,
} from '../../models';
import { isDuplicateKeyError, withTransaction } from '../../lib/db';
import { env } from '../../config/env';
import { createLogger } from '../../lib/logger';
import {
  ConflictError,
  ErrorCode,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from '../../lib/errors';
import { auditService, AuditAction } from '../audit/audit.service';
import { assertAtLeast, hasAtLeast, rankOf } from './rbac';
import { generateRefreshToken, hashRefreshToken, refreshTokenTtlMs, signAccessToken } from './tokens';
import type { AuthPrincipal, TenantContext } from '../../types';
import type {
  ChangePasswordInput,
  InviteMemberInput,
  LoginInput,
  RegisterInput,
  UpdateMemberInput,
} from './auth.schemas';

const log = createLogger('auth');

/**
 * Pre-computed hash of a random string. Compared against when an email does not
 * exist so that "unknown user" and "wrong password" take the same wall-clock
 * time. Without it, response timing is a free user-enumeration oracle.
 */
const DUMMY_HASH = bcrypt.hashSync('timing-equalisation-placeholder-value', 10);

export interface SessionContext {
  ipAddress?: string;
  userAgent?: string;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  organizationId: string;
  createdAt: Date;
  lastLoginAt: Date | null;
}

export interface PublicOrganization {
  id: string;
  name: string;
  slug: string;
  plan: string;
}

export interface AuthResult {
  user: PublicUser;
  organization: PublicOrganization;
  accessToken: string;
  refreshToken: string;
}

/** Strips the password hash. The raw user document never leaves this module. */
const toPublicUser = (user: {
  _id: unknown;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  organizationId: unknown;
  createdAt: Date;
  lastLoginAt: Date | null;
}): PublicUser => ({
  id: String(user._id),
  email: user.email,
  name: user.name,
  role: user.role,
  status: user.status,
  organizationId: String(user.organizationId),
  createdAt: user.createdAt,
  lastLoginAt: user.lastLoginAt,
});

const toPublicOrganization = (org: {
  _id: unknown;
  name: string;
  slug: string;
  plan: string;
}): PublicOrganization => ({
  id: String(org._id),
  name: org.name,
  slug: org.slug,
  plan: org.plan,
});

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'org';

/** Appends a short random suffix until the slug is free. Bounded retries. */
const uniqueSlug = async (base: string): Promise<string> => {
  const root = slugify(base);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const candidate = attempt === 0 ? root : `${root}-${randomUUID().slice(0, 6)}`;
    const taken = await OrganizationModel.exists({ slug: candidate });
    if (!taken) return candidate;
  }
  return `${root}-${randomUUID().slice(0, 12)}`;
};

const issueSession = async (
  user: PublicUser,
  organization: PublicOrganization,
  session: SessionContext,
  familyId = randomUUID(),
): Promise<AuthResult> => {
  const refreshToken = generateRefreshToken();

  await RefreshTokenModel.create({
    userId: toObjectId(user.id),
    tokenHash: hashRefreshToken(refreshToken),
    familyId,
    expiresAt: new Date(Date.now() + refreshTokenTtlMs()),
    ipAddress: session.ipAddress ?? null,
    userAgent: session.userAgent ?? null,
  });

  const accessToken = signAccessToken({
    sub: user.id,
    org: user.organizationId,
    email: user.email,
    role: user.role,
  });

  return { user, organization, accessToken, refreshToken };
};

export const authService = {
  /**
   * Registers a new organization and its first user (OWNER).
   *
   * Both documents are created in one transaction: a half-created tenant with no
   * owner would be unrecoverable through the UI.
   */
  async register(input: RegisterInput, session: SessionContext): Promise<AuthResult> {
    const existing = await UserModel.exists({ email: input.email });
    if (existing) {
      // Registration is one of the few places where revealing that an address is
      // taken is unavoidable — the alternative is a broken signup UX. The auth
      // rate limiter is what makes enumeration here impractical at scale.
      throw new ConflictError('An account with this email already exists', ErrorCode.EMAIL_TAKEN);
    }

    const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_COST);
    const slug = await uniqueSlug(input.organizationName);

    try {
      const { user, organization } = await withTransaction(async (tx?: ClientSession) => {
        const options = tx ? { session: tx } : {};

        const [organization] = await OrganizationModel.create(
          [{ name: input.organizationName, slug }],
          options,
        );
        const [user] = await UserModel.create(
          [
            {
              organizationId: organization!._id,
              email: input.email,
              name: input.name,
              passwordHash,
              role: Role.OWNER,
              status: UserStatus.ACTIVE,
              lastLoginAt: new Date(),
            },
          ],
          options,
        );

        return { user: user!, organization: organization! };
      });

      const publicUser = toPublicUser(user as never);
      const publicOrg = toPublicOrganization(organization as never);

      auditService.record({
        organizationId: publicOrg.id,
        actorId: publicUser.id,
        action: AuditAction.USER_REGISTERED,
        entityType: 'user',
        entityId: publicUser.id,
        metadata: { organizationSlug: publicOrg.slug },
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
      });

      log.info({ organizationId: publicOrg.id, userId: publicUser.id }, 'organization registered');
      return issueSession(publicUser, publicOrg, session);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new ConflictError('An account with this email already exists', ErrorCode.EMAIL_TAKEN);
      }
      throw error;
    }
  },

  async login(input: LoginInput, session: SessionContext): Promise<AuthResult> {
    // `passwordHash` is `select: false`, so it must be requested explicitly.
    const user = await UserModel.findOne({ email: input.email }).select('+passwordHash');

    // Always run a bcrypt comparison, even for an unknown email, so the two
    // failure paths are indistinguishable by timing.
    const hash = user?.passwordHash ?? DUMMY_HASH;
    const passwordMatches = await bcrypt.compare(input.password, hash);

    if (!user || !passwordMatches) {
      if (user) {
        auditService.record({
          organizationId: String(user.organizationId),
          actorId: String(user._id),
          action: AuditAction.USER_LOGIN_FAILED,
          entityType: 'user',
          entityId: String(user._id),
          ipAddress: session.ipAddress,
          userAgent: session.userAgent,
        });
      }
      throw new UnauthenticatedError('Incorrect email or password', ErrorCode.INVALID_CREDENTIALS);
    }

    if (user.status === UserStatus.SUSPENDED) {
      throw new ForbiddenError('This account has been suspended. Contact your administrator.');
    }

    user.lastLoginAt = new Date();
    // An invited user becomes active the first time they actually sign in.
    if (user.status === UserStatus.INVITED) user.status = UserStatus.ACTIVE;
    await user.save();

    const organization = await OrganizationModel.findById(user.organizationId).lean();
    if (!organization) throw new NotFoundError('Organization');

    auditService.record({
      organizationId: String(user.organizationId),
      actorId: String(user._id),
      action: AuditAction.USER_LOGIN,
      entityType: 'user',
      entityId: String(user._id),
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
    });

    return issueSession(
      toPublicUser(user as never),
      toPublicOrganization(organization as never),
      session,
    );
  },

  /**
   * Rotates a refresh token.
   *
   * Reuse detection: presenting a token that has already been rotated or revoked
   * means it was captured. We revoke the entire family, which logs out the
   * attacker *and* the legitimate user — the right outcome, since we cannot tell
   * which one is holding the stolen copy.
   */
  async refresh(presentedToken: string, session: SessionContext): Promise<AuthResult> {
    const tokenHash = hashRefreshToken(presentedToken);

    const stored = await RefreshTokenModel.findOne({ tokenHash });
    if (!stored) throw new UnauthenticatedError('Invalid refresh token', ErrorCode.TOKEN_INVALID);

    const user = await UserModel.findById(stored.userId);
    if (!user) throw new UnauthenticatedError('Invalid refresh token', ErrorCode.TOKEN_INVALID);

    if (stored.revokedAt !== null) {
      log.error(
        { userId: String(stored.userId), familyId: stored.familyId },
        'refresh token reuse detected — revoking token family',
      );
      await RefreshTokenModel.updateMany(
        { familyId: stored.familyId, revokedAt: null },
        { $set: { revokedAt: new Date() } },
      );
      auditService.record({
        organizationId: String(user.organizationId),
        actorId: String(user._id),
        action: AuditAction.TOKEN_REUSE_DETECTED,
        entityType: 'refresh_token',
        entityId: stored.familyId,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
      });
      throw new UnauthenticatedError('Session revoked — please sign in again', ErrorCode.TOKEN_INVALID);
    }

    if (stored.expiresAt.getTime() <= Date.now()) {
      throw new UnauthenticatedError('Refresh token expired', ErrorCode.TOKEN_EXPIRED);
    }
    if (user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenError('This account is no longer active');
    }

    const newToken = generateRefreshToken();
    const newHash = hashRefreshToken(newToken);

    // Rotate atomically: a crash between the two writes must not leave the old
    // token live alongside the new one.
    await withTransaction(async (tx?: ClientSession) => {
      const options = tx ? { session: tx } : {};
      await RefreshTokenModel.create(
        [
          {
            userId: stored.userId,
            tokenHash: newHash,
            familyId: stored.familyId,
            expiresAt: new Date(Date.now() + refreshTokenTtlMs()),
            ipAddress: session.ipAddress ?? null,
            userAgent: session.userAgent ?? null,
          },
        ],
        options,
      );
      await RefreshTokenModel.updateOne(
        { _id: stored._id },
        { $set: { revokedAt: new Date(), replacedBy: newHash } },
        options,
      );
    });

    const organization = await OrganizationModel.findById(user.organizationId).lean();
    if (!organization) throw new NotFoundError('Organization');

    const publicUser = toPublicUser(user as never);
    const accessToken = signAccessToken({
      sub: publicUser.id,
      org: publicUser.organizationId,
      email: publicUser.email,
      role: publicUser.role,
    });

    return {
      user: publicUser,
      organization: toPublicOrganization(organization as never),
      accessToken,
      refreshToken: newToken,
    };
  },

  /** Revokes a single session. Idempotent — an unknown token is a no-op. */
  async logout(presentedToken: string | undefined, principal?: AuthPrincipal): Promise<void> {
    if (presentedToken) {
      await RefreshTokenModel.updateOne(
        { tokenHash: hashRefreshToken(presentedToken), revokedAt: null },
        { $set: { revokedAt: new Date() } },
      );
    }
    if (principal) {
      auditService.record({
        organizationId: principal.organizationId,
        actorId: principal.userId,
        action: AuditAction.USER_LOGOUT,
        entityType: 'user',
        entityId: principal.userId,
      });
    }
  },

  /** Revokes every live session for a user (password change, "sign out everywhere"). */
  async revokeAllSessions(userId: string): Promise<number> {
    const result = await RefreshTokenModel.updateMany(
      { userId: toObjectId(userId), revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    return result.modifiedCount;
  },

  async changePassword(
    principal: AuthPrincipal,
    input: ChangePasswordInput,
    session: SessionContext,
  ): Promise<void> {
    const user = await UserModel.findById(principal.userId).select('+passwordHash');
    if (!user) throw new NotFoundError('User');

    const matches = await bcrypt.compare(input.currentPassword, user.passwordHash);
    if (!matches) {
      throw new UnauthenticatedError('Current password is incorrect', ErrorCode.INVALID_CREDENTIALS);
    }

    user.passwordHash = await bcrypt.hash(input.newPassword, env.BCRYPT_COST);
    await user.save();

    // A password change must invalidate every other session — that is the whole
    // point of changing it after a suspected compromise.
    await this.revokeAllSessions(String(user._id));

    auditService.record({
      organizationId: String(user.organizationId),
      actorId: String(user._id),
      action: AuditAction.USER_PASSWORD_CHANGED,
      entityType: 'user',
      entityId: String(user._id),
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
    });
  },

  async me(principal: AuthPrincipal) {
    const user = await UserModel.findOne({
      _id: toObjectId(principal.userId),
      organizationId: toObjectId(principal.organizationId),
    }).lean();
    if (!user) throw new NotFoundError('User');

    const organization = await OrganizationModel.findById(user.organizationId).lean();
    if (!organization) throw new NotFoundError('Organization');

    return {
      user: toPublicUser(user as never),
      organization: toPublicOrganization(organization as never),
    };
  },

  async updateProfile(principal: AuthPrincipal, name: string): Promise<PublicUser> {
    const user = await UserModel.findByIdAndUpdate(
      principal.userId,
      { $set: { name } },
      { new: true },
    ).lean();
    if (!user) throw new NotFoundError('User');
    return toPublicUser(user as never);
  },

  /* ---------------------------------------------------------------------- */
  /* Team management                                                        */
  /* ---------------------------------------------------------------------- */

  async listMembers(ctx: TenantContext): Promise<PublicUser[]> {
    const users = await UserModel.find({ organizationId: toObjectId(ctx.organizationId) })
      .sort({ role: 1, createdAt: 1 })
      .lean();
    return users.map((user) => toPublicUser(user as never));
  },

  async inviteMember(
    ctx: TenantContext,
    input: InviteMemberInput,
    session: SessionContext,
  ): Promise<PublicUser> {
    assertAtLeast(ctx.role, Role.ADMIN);

    // Privilege-escalation guard: you can never grant a role above your own.
    if (rankOf(input.role) > rankOf(ctx.role)) {
      throw new ForbiddenError('You cannot grant a role higher than your own');
    }

    if (await UserModel.exists({ email: input.email })) {
      throw new ConflictError('This email is already registered', ErrorCode.EMAIL_TAKEN);
    }

    const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_COST);

    try {
      const user = await UserModel.create({
        organizationId: toObjectId(ctx.organizationId),
        email: input.email,
        name: input.name,
        role: input.role,
        passwordHash,
        status: UserStatus.INVITED,
      });

      auditService.record({
        organizationId: ctx.organizationId,
        actorId: ctx.userId,
        action: AuditAction.USER_INVITED,
        entityType: 'user',
        entityId: String(user._id),
        metadata: { role: input.role },
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
      });

      return toPublicUser(user as never);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new ConflictError('This email is already registered', ErrorCode.EMAIL_TAKEN);
      }
      throw error;
    }
  },

  async updateMember(
    ctx: TenantContext,
    memberId: string,
    input: UpdateMemberInput,
    session: SessionContext,
  ): Promise<PublicUser> {
    assertAtLeast(ctx.role, Role.ADMIN);

    const target: UserDoc | null = await UserModel.findOne({
      _id: toObjectId(memberId),
      organizationId: toObjectId(ctx.organizationId),
    });
    if (!target) throw new NotFoundError('Member');

    if (String(target._id) === ctx.userId) {
      throw new ValidationError('You cannot change your own role or status');
    }
    // You may not act on someone at or above your rank.
    if (rankOf(target.role) >= rankOf(ctx.role) && !hasAtLeast(ctx.role, Role.OWNER)) {
      throw new ForbiddenError('You cannot modify a member with an equal or higher role');
    }
    if (input.role && rankOf(input.role) > rankOf(ctx.role)) {
      throw new ForbiddenError('You cannot grant a role higher than your own');
    }

    // An organization must always retain at least one OWNER, or it becomes
    // permanently unadministrable.
    if (target.role === Role.OWNER && input.role && input.role !== Role.OWNER) {
      const owners = await UserModel.countDocuments({
        organizationId: toObjectId(ctx.organizationId),
        role: Role.OWNER,
        status: UserStatus.ACTIVE,
      });
      if (owners <= 1) throw new ValidationError('An organization must have at least one owner');
    }

    const previous = { role: target.role, status: target.status };
    if (input.role) target.role = input.role;
    if (input.status) target.status = input.status as UserStatus;
    await target.save();

    // Suspension must take effect now, not when the access token expires.
    if (input.status === UserStatus.SUSPENDED) await this.revokeAllSessions(String(target._id));

    auditService.record({
      organizationId: ctx.organizationId,
      actorId: ctx.userId,
      action:
        input.status === UserStatus.SUSPENDED
          ? AuditAction.USER_SUSPENDED
          : AuditAction.USER_ROLE_CHANGED,
      entityType: 'user',
      entityId: String(target._id),
      metadata: { from: previous, to: input },
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
    });

    return toPublicUser(target as never);
  },

  /**
   * Housekeeping for revoked tokens.
   *
   * Expired tokens are removed automatically by the TTL index on `expiresAt`, so
   * this only sweeps tokens that were explicitly revoked (logout, rotation,
   * family kill) and are past the retention window kept for incident forensics.
   */
  async pruneExpiredTokens(): Promise<number> {
    const cutoff = new Date(Date.now() - 7 * 86_400_000);
    const result = await RefreshTokenModel.deleteMany({ revokedAt: { $ne: null, $lt: cutoff } });
    if (result.deletedCount > 0) log.info({ count: result.deletedCount }, 'pruned refresh tokens');
    return result.deletedCount;
  },
};
