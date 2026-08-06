import { model, Schema, type HydratedDocument, type Types } from 'mongoose';
import { baseSchemaOptions, objectIdRef } from './base';

/**
 * Refresh tokens, stored hashed and rotated on every use.
 *
 * `familyId` groups a rotation chain. Presenting a token that has already been
 * rotated means it was captured, so the whole family is revoked — the standard
 * reuse detection from OAuth 2.0 Security BCP §4.13.
 */
export interface RefreshToken {
  userId: Types.ObjectId;
  /** SHA-256 of the opaque token. The raw value is never stored. */
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  /** Set when rotated, pointing at the successor's hash. */
  replacedBy: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const refreshTokenSchema = new Schema<RefreshToken>(
  {
    userId: objectIdRef('User'),
    tokenHash: { type: String, required: true, unique: true },
    familyId: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    replacedBy: { type: String, default: null },
    userAgent: { type: String, default: null, maxlength: 400 },
    ipAddress: { type: String, default: null, maxlength: 64 },
  },
  baseSchemaOptions,
);

refreshTokenSchema.index({ userId: 1 });

/**
 * TTL index: MongoDB deletes documents once `expiresAt` passes.
 *
 * This replaces the scheduled prune job the SQL version needed — expired tokens
 * disappear without any application code running, so the collection cannot grow
 * unbounded if a maintenance worker is down. The background reaper runs about
 * once a minute, so deletion is prompt rather than instant; that is fine, since
 * a token is rejected on its expiry timestamp regardless of whether the document
 * still exists.
 */
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type RefreshTokenDoc = HydratedDocument<RefreshToken>;

export const RefreshTokenModel = model<RefreshToken>('RefreshToken', refreshTokenSchema);
