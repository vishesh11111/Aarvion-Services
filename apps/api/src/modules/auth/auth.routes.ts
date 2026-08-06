import { Router } from 'express';
import { z } from 'zod';
import { objectId } from '../../lib/validators';
import { Role } from '../../models';
import { validate } from '../../middleware/validate';
import { authenticate, requireActiveUser, requireRole } from '../../middleware/authenticate';
import { authLimiter, refreshLimiter } from '../../middleware/rate-limit';
import { authController } from './auth.controller';
import {
  changePasswordSchema,
  inviteMemberSchema,
  loginSchema,
  registerSchema,
  updateMemberSchema,
  updateProfileSchema,
} from './auth.schemas';

const idParam = z.object({ id: objectId('Invalid identifier') });

export const authRouter: Router = Router();

/* --- public: credential endpoints, aggressively rate limited -------------- */

// `authLimiter` is a *credential-guessing* budget: 10 attempts per 15 minutes,
// keyed by IP. It belongs on endpoints where an attacker gains something by
// trying repeatedly — a password or an email that might exist.
authRouter.post('/register', authLimiter, validate({ body: registerSchema }), authController.register);
authRouter.post('/login', authLimiter, validate({ body: loginSchema }), authController.login);

/*
 * Refresh deliberately uses the *refresh* budget, not the credential one.
 *
 * There is nothing to guess here: the token is 256 bits of opaque randomness,
 * so brute force is not a threat model, and rotation already revokes the whole
 * family on any reuse.
 *
 * Putting it on the credential limiter was an outright bug. Refresh is a normal
 * background operation — every active session performs one every 15 minutes,
 * and the client attempts one whenever it sees a 401. Ten per 15 minutes per IP
 * meant that a handful of expired-session page loads exhausted the budget and
 * then **blocked login itself**, because login shares that counter. Any office
 * behind a single NAT address would have locked itself out permanently.
 */
authRouter.post('/refresh', refreshLimiter, authController.refresh);

/* --- session ------------------------------------------------------------- */

// Logout intentionally does not require a valid access token: an expired token
// must still be able to clear its cookies and revoke its refresh token.
authRouter.post('/logout', authController.logout);
authRouter.post('/logout-all', authenticate, authController.logoutAll);

/* --- current user -------------------------------------------------------- */

authRouter.get('/me', authenticate, authController.me);
authRouter.patch('/me', authenticate, validate({ body: updateProfileSchema }), authController.updateProfile);
authRouter.post(
  '/change-password',
  authenticate,
  authLimiter,
  validate({ body: changePasswordSchema }),
  authController.changePassword,
);

/* --- team management (ADMIN+) -------------------------------------------- */

authRouter.get('/members', authenticate, authController.listMembers);
authRouter.post(
  '/members',
  authenticate,
  requireActiveUser,
  requireRole(Role.ADMIN),
  validate({ body: inviteMemberSchema }),
  authController.inviteMember,
);
authRouter.patch(
  '/members/:id',
  authenticate,
  requireActiveUser,
  requireRole(Role.ADMIN),
  validate({ params: idParam, body: updateMemberSchema }),
  authController.updateMember,
);
