import type { Role } from '../models';

/**
 * The authenticated principal, derived from a verified access token.
 * Attached to `req.auth` by the `authenticate` middleware.
 */
export interface AuthPrincipal {
  userId: string;
  organizationId: string;
  email: string;
  role: Role;
}

/**
 * Explicit tenant scope handed to every repository call.
 *
 * Passing this by argument rather than reading ambient state is a deliberate
 * choice: a missing tenant filter becomes a *compile* error instead of a
 * cross-tenant data leak discovered by a customer.
 */
export interface TenantContext {
  organizationId: string;
  userId: string;
  role: Role;
}

export const toTenantContext = (principal: AuthPrincipal): TenantContext => ({
  organizationId: principal.organizationId,
  userId: principal.userId,
  role: principal.role,
});

declare global {
   
  namespace Express {
    interface Request {
      /** Correlation id — always present, set by the requestId middleware. */
      id: string;
      /** Present only after `authenticate` has run. */
      auth?: AuthPrincipal;
      /** Populated by the upload middleware for multipart routes. */
      uploadedFile?: {
        originalName: string;
        storageKey: string;
        sizeBytes: number;
        mimeType: string;
      };
    }
  }
}

export {};
