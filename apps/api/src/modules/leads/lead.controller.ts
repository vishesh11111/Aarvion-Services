import type { Request, Response } from 'express';
import { asyncHandler, sendNoContent, sendSuccess } from '../../lib/http';
import { requireAuth } from '../../middleware/authenticate';
import { toTenantContext } from '../../types';
import { leadRepository } from './lead.repository';
import { leadService } from './lead.service';
import type {
  BulkUpdateInput,
  CreateActivityInput,
  CreateLeadInput,
  ExportLeadsQuery,
  ListLeadsQuery,
  MergeLeadsInput,
  UpdateLeadInput,
} from './lead.schemas';

const ctxOf = (req: Request) => toTenantContext(requireAuth(req));

/** RFC 4180 escaping. A stray quote or comma must not shift every later column. */
const csvCell = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  const str = Array.isArray(value) ? value.join('; ') : String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

const EXPORT_COLUMNS = [
  'id', 'firstName', 'lastName', 'email', 'phone', 'company', 'jobTitle',
  'industry', 'city', 'state', 'country', 'status', 'priority', 'source',
  'estimatedValue', 'score', 'tags', 'createdAt',
] as const;

export const leadController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as unknown as ListLeadsQuery;
    const result = await leadService.list(ctxOf(req), query);
    sendSuccess(res, result.items, 200, {
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
      limit: query.limit,
      ...(result.total !== undefined ? { total: result.total } : {}),
      ...(result.totalIsApproximate ? { totalIsApproximate: true } : {}),
    });
  }),

  get: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await leadService.getById(ctxOf(req), req.params.id as string));
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const lead = await leadService.create(ctxOf(req), req.body as CreateLeadInput);
    res.setHeader('Location', `/api/v1/leads/${lead.id}`);
    sendSuccess(res, lead, 201);
  }),

  update: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await leadService.update(ctxOf(req), req.params.id as string, req.body as UpdateLeadInput));
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    await leadService.remove(ctxOf(req), req.params.id as string);
    sendNoContent(res);
  }),

  restore: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await leadService.restore(ctxOf(req), req.params.id as string));
  }),

  bulkUpdate: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await leadService.bulkUpdate(ctxOf(req), req.body as BulkUpdateInput));
  }),

  bulkDelete: asyncHandler(async (req: Request, res: Response) => {
    const { leadIds } = req.body as { leadIds: string[] };
    sendSuccess(res, await leadService.bulkDelete(ctxOf(req), leadIds));
  }),

  merge: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await leadService.merge(ctxOf(req), req.body as MergeLeadsInput));
  }),

  addActivity: asyncHandler(async (req: Request, res: Response) => {
    const activity = await leadService.addActivity(
      ctxOf(req),
      req.params.id as string,
      req.body as CreateActivityInput,
    );
    sendSuccess(res, activity, 201);
  }),

  stats: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await leadService.stats(ctxOf(req)));
  }),

  /**
   * Streaming CSV export.
   *
   * The response is written incrementally from a keyset-paginated cursor, so
   * exporting 50k leads costs one batch of memory rather than 50k rows of it,
   * and the browser starts downloading immediately instead of waiting for the
   * whole file to be built.
   */
  exportCsv: asyncHandler(async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const query = req.query as unknown as ExportLeadsQuery;

    const filename = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // Streaming means no Content-Length; make sure nothing buffers it.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // BOM so Excel opens UTF-8 correctly — without it, accented names are mojibake.
    res.write('\uFEFF');
    res.write(`${EXPORT_COLUMNS.join(',')}\n`);

    for await (const batch of leadRepository.iterate(ctx, query, 1_000, query.limit)) {
      const chunk = batch
        .map((lead) =>
          EXPORT_COLUMNS.map((column) => csvCell((lead as Record<string, unknown>)[column])).join(','),
        )
        .join('\n');
      // Respect backpressure: if the socket buffer is full, wait for it to drain
      // rather than growing an unbounded queue in the Node process.
      if (!res.write(`${chunk}\n`)) {
        await new Promise<void>((resolve) => res.once('drain', resolve));
      }
    }

    res.end();
  }),
};
