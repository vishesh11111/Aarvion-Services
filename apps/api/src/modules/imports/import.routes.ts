import { Router } from 'express';
import { z } from 'zod';
import { objectId } from '../../lib/validators';
import { Role } from '../../models';
import { authenticate, requireRole } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import { uploadLimiter } from '../../middleware/rate-limit';
import { singleFileUpload } from '../../middleware/upload';
import {
  importController,
  listErrorsSchema,
  listImportsSchema,
  startImportSchema,
} from './import.controller';

const idParam = z.object({ id: objectId('Invalid import id') });

export const importRouter: Router = Router();

importRouter.use(authenticate);

importRouter.get('/', validate({ query: listImportsSchema }), importController.list);

// Upload runs before validation because the body only exists after the
// multipart stream has been consumed.
importRouter.post(
  '/',
  requireRole(Role.MEMBER),
  uploadLimiter,
  singleFileUpload('file'),
  importController.create,
);

importRouter.get('/:id', validate({ params: idParam }), importController.get);
importRouter.get(
  '/:id/errors',
  validate({ params: idParam, query: listErrorsSchema }),
  importController.errors,
);
importRouter.post(
  '/:id/start',
  requireRole(Role.MEMBER),
  validate({ params: idParam, body: startImportSchema }),
  importController.start,
);
importRouter.post(
  '/:id/cancel',
  requireRole(Role.MEMBER),
  validate({ params: idParam }),
  importController.cancel,
);
