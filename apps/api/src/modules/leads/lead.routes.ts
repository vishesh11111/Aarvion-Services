import { Router } from 'express';
import { Role } from '../../models';
import { validate } from '../../middleware/validate';
import { authenticate, requireRole } from '../../middleware/authenticate';
import { leadController } from './lead.controller';
import {
  bulkDeleteSchema,
  bulkUpdateSchema,
  createActivitySchema,
  createLeadSchema,
  exportLeadsSchema,
  leadIdParam,
  listLeadsSchema,
  mergeLeadsSchema,
  updateLeadSchema,
} from './lead.schemas';

export const leadRouter: Router = Router();

// Every lead route requires a session. Applied once here rather than repeated
// per route, so a new route cannot accidentally ship unauthenticated.
leadRouter.use(authenticate);

/* --- collection ---------------------------------------------------------- */

leadRouter.get('/', validate({ query: listLeadsSchema }), leadController.list);
leadRouter.get('/stats', leadController.stats);
leadRouter.get('/export', validate({ query: exportLeadsSchema }), leadController.exportCsv);

leadRouter.post(
  '/',
  requireRole(Role.MEMBER),
  validate({ body: createLeadSchema }),
  leadController.create,
);

/* --- bulk ---------------------------------------------------------------- */
// Declared before `/:id` so "bulk" is never captured as an id.

leadRouter.patch(
  '/bulk',
  requireRole(Role.MEMBER),
  validate({ body: bulkUpdateSchema }),
  leadController.bulkUpdate,
);
leadRouter.post(
  '/bulk-delete',
  requireRole(Role.MEMBER),
  validate({ body: bulkDeleteSchema }),
  leadController.bulkDelete,
);
leadRouter.post(
  '/merge',
  requireRole(Role.MEMBER),
  validate({ body: mergeLeadsSchema }),
  leadController.merge,
);

/* --- single resource ----------------------------------------------------- */

leadRouter.get('/:id', validate({ params: leadIdParam }), leadController.get);
leadRouter.patch(
  '/:id',
  requireRole(Role.MEMBER),
  validate({ params: leadIdParam, body: updateLeadSchema }),
  leadController.update,
);
leadRouter.delete('/:id', requireRole(Role.MEMBER), validate({ params: leadIdParam }), leadController.remove);
leadRouter.post(
  '/:id/restore',
  requireRole(Role.ADMIN),
  validate({ params: leadIdParam }),
  leadController.restore,
);
leadRouter.post(
  '/:id/activities',
  requireRole(Role.MEMBER),
  validate({ params: leadIdParam, body: createActivitySchema }),
  leadController.addActivity,
);
