import { model, Schema, type HydratedDocument, type Types } from 'mongoose';
import { baseSchemaOptions, objectIdRef } from './base';
import { Role, UserStatus, valuesOf } from './enums';

export interface User {
  organizationId: Types.ObjectId;
  email: string;
  passwordHash: string;
  name: string;
  role: Role;
  status: UserStatus;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<User>(
  {
    organizationId: objectIdRef('Organization'),

    /**
     * Lower-cased on write and backed by a unique index — case-insensitive
     * uniqueness without needing a collation-aware index. "Jane@acme.com" and
     * "jane@acme.com" must never become two accounts.
     */
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },

    /**
     * `select: false` so the hash never leaves the database by accident. Code
     * that genuinely needs it (login, password change) opts in explicitly with
     * `.select('+passwordHash')`, which makes every such site greppable.
     */
    passwordHash: { type: String, required: true, select: false },

    name: { type: String, required: true, trim: true, maxlength: 120 },
    role: { type: String, enum: valuesOf(Role), default: Role.MEMBER, required: true },
    status: { type: String, enum: valuesOf(UserStatus), default: UserStatus.ACTIVE, required: true },
    lastLoginAt: { type: Date, default: null },
  },
  baseSchemaOptions,
);

// Tenant-first compound indexes: the organization predicate is present in every
// query, so it must lead for the index to be usable.
userSchema.index({ organizationId: 1, role: 1 });
userSchema.index({ organizationId: 1, status: 1 });

export type UserDoc = HydratedDocument<User>;

export const UserModel = model<User>('User', userSchema);
