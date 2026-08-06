import { Router } from 'express';
import { z } from 'zod';
import { objectId } from '../../lib/validators';
import { authenticate } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import { aiLimiter } from '../../middleware/rate-limit';
import { aiController, nlSearchSchema, scoreLeadsSchema } from './ai.controller';

export const aiRouter: Router = Router();

aiRouter.use(authenticate);

// Cheap, read-only: no need to spend rate-limit budget on it.
aiRouter.get('/status', aiController.status);
aiRouter.get('/usage', aiController.usage);

// Everything below reaches the provider and is limited separately from the
// global budget — LLM calls are orders of magnitude more expensive than a query.
aiRouter.post('/score', aiLimiter, validate({ body: scoreLeadsSchema }), aiController.scoreLeads);
aiRouter.post('/search', aiLimiter, validate({ body: nlSearchSchema }), aiController.search);
aiRouter.get(
  '/leads/:id/insights',
  aiLimiter,
  validate({ params: z.object({ id: objectId() }) }),
  aiController.insights,
);
