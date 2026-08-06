/**
 * Auth HTTP layer. Thin by design — no business rules live here.
 *
 * Tokens are returned in httpOnly cookies *and* in the JSON body. The cookie is
 * what the browser app uses; the body is what non-browser API clients and the
 * OpenAPI playground use. Both are the same token, so there is no divergence.
 */
import type { Request, Response } from 'express';
import { asyncHandler, clientIp, sendNoContent, sendSuccess, userAgent } from '../../lib/http';
import { requireAuth } from '../../middleware/authenticate';
import { UnauthenticatedError } from '../../lib/errors';
import { toTenantContext } from '../../types';
import { authService, type AuthResult, type SessionContext } from './auth.service';
import { REFRESH_COOKIE, clearAuthCookies, setAuthCookies } from './tokens';
import type { ChangePasswordInput, InviteMemberInput, LoginInput, RegisterInput, UpdateMemberInput } from './auth.schemas';

const sessionOf = (req: Request): SessionContext => {
  const ua = userAgent(req);
  return { ipAddress: clientIp(req), ...(ua ? { userAgent: ua } : {}) };
};

const respondWithSession = (res: Response, result: AuthResult, status = 200): void => {
  setAuthCookies(res, result.accessToken, result.refreshToken);
  sendSuccess(
    res,
    {
      user: result.user,
      organization: result.organization,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    },
    status,
  );
};

export const authController = {
  register: asyncHandler(async (req: Request, res: Response) => {
    const result = await authService.register(req.body as RegisterInput, sessionOf(req));
    respondWithSession(res, result, 201);
  }),

  login: asyncHandler(async (req: Request, res: Response) => {
    const result = await authService.login(req.body as LoginInput, sessionOf(req));
    respondWithSession(res, result);
  }),

  /**
   * Accepts the refresh token from the cookie or, for non-browser clients, from
   * the request body.
   */
  refresh: asyncHandler(async (req: Request, res: Response) => {
    const token =
      (req.cookies?.[REFRESH_COOKIE] as string | undefined) ??
      (req.body as { refreshToken?: string } | undefined)?.refreshToken;

    if (!token) throw new UnauthenticatedError('No refresh token provided');

    try {
      const result = await authService.refresh(token, sessionOf(req));
      respondWithSession(res, result);
    } catch (error) {
      // A failed refresh means the session is dead; make sure the browser stops
      // sending the stale cookie rather than retrying forever.
      clearAuthCookies(res);
      throw error;
    }
  }),

  logout: asyncHandler(async (req: Request, res: Response) => {
    await authService.logout(req.cookies?.[REFRESH_COOKIE] as string | undefined, req.auth);
    clearAuthCookies(res);
    sendNoContent(res);
  }),

  logoutAll: asyncHandler(async (req: Request, res: Response) => {
    const auth = requireAuth(req);
    const revoked = await authService.revokeAllSessions(auth.userId);
    clearAuthCookies(res);
    sendSuccess(res, { revokedSessions: revoked });
  }),

  me: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await authService.me(requireAuth(req)));
  }),

  updateProfile: asyncHandler(async (req: Request, res: Response) => {
    const { name } = req.body as { name: string };
    sendSuccess(res, { user: await authService.updateProfile(requireAuth(req), name) });
  }),

  changePassword: asyncHandler(async (req: Request, res: Response) => {
    await authService.changePassword(requireAuth(req), req.body as ChangePasswordInput, sessionOf(req));
    clearAuthCookies(res);
    sendNoContent(res);
  }),

  listMembers: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, { members: await authService.listMembers(toTenantContext(requireAuth(req))) });
  }),

  inviteMember: asyncHandler(async (req: Request, res: Response) => {
    const member = await authService.inviteMember(
      toTenantContext(requireAuth(req)),
      req.body as InviteMemberInput,
      sessionOf(req),
    );
    sendSuccess(res, { member }, 201);
  }),

  updateMember: asyncHandler(async (req: Request, res: Response) => {
    const member = await authService.updateMember(
      toTenantContext(requireAuth(req)),
      req.params.id as string,
      req.body as UpdateMemberInput,
      sessionOf(req),
    );
    sendSuccess(res, { member });
  }),
};
