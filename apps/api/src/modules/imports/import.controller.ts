import type { Request, Response } from 'express';
import { z } from 'zod';
import { objectId } from '../../lib/validators';
import { LeadSource } from '../../models';
import { asyncHandler, sendSuccess } from '../../lib/http';
import { requireAuth } from '../../middleware/authenticate';
import { BadRequestError, ErrorCode } from '../../lib/errors';
import { toTenantContext } from '../../types';
import { importService } from './import.service';

const ctxOf = (req: Request) => toTenantContext(requireAuth(req));

export const startImportSchema = z
  .object({
    /** `{ "CSV Header": "leadField" | null }` */
    columnMapping: z.record(z.string().nullable()),
    duplicateStrategy: z.enum(['SKIP', 'UPDATE', 'CREATE_ANYWAY']).default('SKIP'),
    defaultSource: z.nativeEnum(LeadSource).default(LeadSource.CSV_IMPORT),
    defaultOwnerId: objectId().nullable().optional(),
    keepUnmappedAsCustomFields: z.coerce.boolean().default(true),
    /** Queue AI scoring for everything this import creates. */
    autoScore: z.coerce.boolean().default(true),
  })
  .strict();

export const listImportsSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: objectId().optional(),
  })
  .strict();

export const listErrorsSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();

export const importController = {
  /**
   * Phase 1 — upload. Returns the parsed headers, sample rows and a proposed
   * mapping. Nothing is imported yet.
   */
  create: asyncHandler(async (req: Request, res: Response) => {
    if (!req.uploadedFile) {
      throw new BadRequestError('No file was uploaded', ErrorCode.INVALID_FILE);
    }

    const result = await importService.createFromUpload(ctxOf(req), req.uploadedFile);

    sendSuccess(
      res,
      {
        importJobId: result.job.id,
        filename: result.job.filename,
        status: result.job.status,
        preview: result.preview,
        mapping: result.mapping,
      },
      201,
    );
  }),

  /**
   * Phase 2 — confirm and run.
   *
   * Returns 202 Accepted: the work happens in a worker, and the client polls
   * `GET /imports/:id` for progress.
   */
  start: asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof startImportSchema>;
    const job = await importService.start(ctxOf(req), req.params.id as string, {
      columnMapping: body.columnMapping,
      duplicateStrategy: body.duplicateStrategy,
      defaultSource: body.defaultSource,
      defaultOwnerId: body.defaultOwnerId ?? null,
      keepUnmappedAsCustomFields: body.keepUnmappedAsCustomFields,
      autoScore: body.autoScore,
    });

    res.setHeader('Location', `/api/v1/imports/${job.id}`);
    sendSuccess(res, { importJobId: job.id, status: job.status }, 202);
  }),

  get: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await importService.get(ctxOf(req), req.params.id as string));
  }),

  list: asyncHandler(async (req: Request, res: Response) => {
    const { limit, cursor } = req.query as unknown as z.infer<typeof listImportsSchema>;
    const result = await importService.list(ctxOf(req), limit, cursor);
    sendSuccess(res, result.items, 200, {
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
      limit,
    });
  }),

  errors: asyncHandler(async (req: Request, res: Response) => {
    const { limit, offset } = req.query as unknown as z.infer<typeof listErrorsSchema>;
    const result = await importService.listErrors(ctxOf(req), req.params.id as string, limit, offset);
    sendSuccess(res, result.errors, 200, { total: result.total, limit, offset });
  }),

  cancel: asyncHandler(async (req: Request, res: Response) => {
    const job = await importService.cancel(ctxOf(req), req.params.id as string);
    sendSuccess(res, { importJobId: job.id, status: job.status });
  }),
};
