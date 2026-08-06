import { z } from 'zod';
import { Role } from '../../models';

/**
 * Password policy: length over composition rules.
 *
 * NIST SP 800-63B deprecated forced character-class rules — they push users
 * toward `Password1!` and measurably reduce entropy. We require 10+ characters
 * and reject the obvious offenders, which is both stronger and less annoying.
 */
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', 'qwertyuiop',
  'letmein123', 'welcome123', 'admin123', 'iloveyou1', 'changeme1', 'passw0rd',
]);

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128, 'Password must be at most 128 characters')
  .refine((v) => !COMMON_PASSWORDS.has(v.toLowerCase()), 'This password is too common')
  .refine((v) => new Set(v).size >= 5, 'Password is not varied enough');

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email address')
  .max(254); // RFC 5321 maximum

export const registerSchema = z
  .object({
    organizationName: z.string().trim().min(2).max(160),
    name: z.string().trim().min(2).max(120),
    email: emailSchema,
    password: passwordSchema,
  })
  .strict();

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1, 'Password is required').max(128),
  })
  .strict();

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: passwordSchema,
  })
  .strict()
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: 'New password must differ from the current one',
    path: ['newPassword'],
  });

export const inviteMemberSchema = z
  .object({
    email: emailSchema,
    name: z.string().trim().min(2).max(120),
    role: z.nativeEnum(Role).default(Role.MEMBER),
    // Temporary credential; the invitee changes it on first sign-in.
    password: passwordSchema,
  })
  .strict();

export const updateMemberSchema = z
  .object({
    role: z.nativeEnum(Role).optional(),
    status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
  })
  .strict()
  .refine((v) => v.role !== undefined || v.status !== undefined, {
    message: 'Provide at least one field to update',
  });

export const updateProfileSchema = z
  .object({ name: z.string().trim().min(2).max(120) })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;
