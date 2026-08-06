/**
 * OpenAPI 3.0 description of the public API.
 *
 * Hand-written rather than generated from the Zod schemas. Generation sounds
 * better than it is here: it produces documentation that describes the *shape*
 * of a request but nothing about when or why to call it, and the annotations
 * needed to fix that end up larger than this file. This is reviewed alongside
 * the routes it documents.
 *
 * Served as JSON at /api/v1/openapi.json and as Swagger UI at /api/v1/docs.
 */
import { LeadPriority, LeadSource, LeadStatus, Role } from '../models';
import { env } from '../config/env';

const errorResponse = (description: string) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ErrorResponse' },
    },
  },
});

export const openApiDocument = {
  openapi: '3.0.3',

  info: {
    title: 'Aarvion CRM API',
    version: '1.0.0',
    description: `
AI-powered CRM for importing, managing and organising customer leads.

## Authentication

Two interchangeable transports:

* **Cookie** — \`POST /auth/login\` sets an httpOnly \`aarvion_at\` cookie. Used by the web app.
* **Bearer** — the same response body contains \`accessToken\`. Send it as
  \`Authorization: Bearer <token>\`. Used by API clients and by the "Authorize"
  button in this page.

Access tokens live 15 minutes. Refresh with \`POST /auth/refresh\`, which rotates
the refresh token. Presenting an already-rotated refresh token is treated as
theft and revokes the entire session family.

## Conventions

* Success: \`{ "data": ..., "meta": { ... } }\`
* Failure: \`{ "error": { "code", "message", "details" }, "requestId" }\`
* Branch on \`error.code\` (stable), never on \`error.message\` (may be reworded).
* All list endpoints are cursor-paginated by default; pass \`page\` for offset
  pagination when you need to jump to a specific page.
* Every response carries \`x-request-id\`; include it in bug reports.

## Rate limits

\`RateLimit-*\` headers (draft-7) are returned on every response. Limits are
per-user when authenticated and per-IP otherwise. AI endpoints have a separate,
tighter budget plus a per-organization daily quota.

## Multi-tenancy

Every request is scoped to the organization in your token. There is no way to
address another tenant's data; ids from other organizations return 404.
`.trim(),
    contact: { name: 'Aarvion Engineering' },
    license: { name: 'MIT' },
  },

  servers: [
    { url: '/api/v1', description: 'Current host' },
    { url: 'http://localhost:4000/api/v1', description: 'Local development' },
  ],

  tags: [
    { name: 'Auth', description: 'Registration, sessions and team management' },
    { name: 'Leads', description: 'The core CRM resource' },
    { name: 'Imports', description: 'Two-phase CSV ingestion' },
    { name: 'AI', description: `Gemini-backed features (model: ${env.GEMINI_MODEL})` },
    { name: 'Analytics', description: 'Aggregated pipeline reporting' },
    { name: 'Health', description: 'Liveness and readiness probes' },
  ],

  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      cookieAuth: { type: 'apiKey', in: 'cookie', name: 'aarvion_at' },
    },

    parameters: {
      LeadId: {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: 'Lead identifier (24-character hex MongoDB ObjectId)',
      },
      Cursor: {
        name: 'cursor',
        in: 'query',
        schema: { type: 'string' },
        description: 'Opaque cursor from a previous response\'s `meta.nextCursor`',
      },
      Limit: {
        name: 'limit',
        in: 'query',
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
      },
    },

    schemas: {
      ErrorResponse: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: {
                type: 'string',
                description: 'Stable machine-readable code — branch on this',
                example: 'DUPLICATE_LEAD',
              },
              message: { type: 'string', example: 'A lead with this email already exists' },
              details: { type: 'object', nullable: true, description: 'Field errors or retry hints' },
            },
          },
          requestId: { type: 'string', example: '9f1c...' },
        },
      },

      PaginationMeta: {
        type: 'object',
        properties: {
          nextCursor: { type: 'string', nullable: true },
          hasMore: { type: 'boolean' },
          limit: { type: 'integer' },
          total: { type: 'integer', description: 'Only present for offset pagination' },
          totalIsApproximate: { type: 'boolean', description: 'True when the count was capped at 10,000' },
        },
      },

      User: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          email: { type: 'string', format: 'email' },
          name: { type: 'string' },
          role: { type: 'string', enum: Object.values(Role) },
          status: { type: 'string', enum: ['ACTIVE', 'INVITED', 'SUSPENDED'] },
          organizationId: { type: 'string' },
          lastLoginAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },

      Lead: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          firstName: { type: 'string', nullable: true },
          lastName: { type: 'string', nullable: true },
          fullName: { type: 'string' },
          email: { type: 'string', format: 'email', nullable: true },
          phone: { type: 'string', nullable: true },
          company: { type: 'string', nullable: true },
          jobTitle: { type: 'string', nullable: true },
          website: { type: 'string', nullable: true },
          industry: { type: 'string', nullable: true },
          companySize: { type: 'string', nullable: true },
          city: { type: 'string', nullable: true },
          state: { type: 'string', nullable: true },
          country: { type: 'string', nullable: true },
          status: { type: 'string', enum: Object.values(LeadStatus) },
          priority: { type: 'string', enum: Object.values(LeadPriority) },
          source: { type: 'string', enum: Object.values(LeadSource) },
          estimatedValue: { type: 'integer', nullable: true, description: 'Whole currency units' },
          ownerId: { type: 'string', nullable: true },
          tags: { type: 'array', items: { type: 'string' } },
          notes: { type: 'string', nullable: true },
          score: {
            type: 'integer',
            nullable: true,
            minimum: 0,
            maximum: 100,
            description: 'AI conversion score. null means not yet scored (0 is a real score).',
          },
          scoreRationale: { type: 'string', nullable: true },
          aiSummary: { type: 'string', nullable: true },
          aiNextAction: { type: 'string', nullable: true },
          scoredAt: { type: 'string', format: 'date-time', nullable: true },
          customFields: {
            type: 'object',
            additionalProperties: true,
            description: 'CSV columns that had no schema equivalent, preserved verbatim',
          },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },

      CreateLeadRequest: {
        type: 'object',
        description: 'At least one of email, phone, firstName, lastName or company is required.',
        properties: {
          firstName: { type: 'string', maxLength: 120 },
          lastName: { type: 'string', maxLength: 120 },
          email: { type: 'string', format: 'email' },
          phone: { type: 'string', maxLength: 40 },
          company: { type: 'string', maxLength: 200 },
          jobTitle: { type: 'string', maxLength: 160 },
          website: { type: 'string' },
          industry: { type: 'string' },
          companySize: { type: 'string' },
          city: { type: 'string' },
          state: { type: 'string' },
          country: { type: 'string' },
          status: { type: 'string', enum: Object.values(LeadStatus), default: 'NEW' },
          priority: { type: 'string', enum: Object.values(LeadPriority), default: 'MEDIUM' },
          source: { type: 'string', enum: Object.values(LeadSource), default: 'MANUAL' },
          estimatedValue: { type: 'integer', minimum: 0 },
          ownerId: { type: 'string', nullable: true },
          tags: { type: 'array', items: { type: 'string' }, maxItems: 25 },
          notes: { type: 'string', maxLength: 5000 },
          customFields: { type: 'object', additionalProperties: true },
        },
      },

      ImportJob: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          filename: { type: 'string' },
          status: {
            type: 'string',
            enum: ['PENDING', 'VALIDATING', 'PROCESSING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED'],
          },
          totalRows: { type: 'integer' },
          processedRows: { type: 'integer' },
          createdCount: { type: 'integer' },
          updatedCount: { type: 'integer' },
          skippedCount: { type: 'integer' },
          errorCount: { type: 'integer' },
          progress: { type: 'integer', minimum: 0, maximum: 100 },
          failureReason: { type: 'string', nullable: true },
          startedAt: { type: 'string', format: 'date-time', nullable: true },
          completedAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },

      AiMeta: {
        type: 'object',
        description: 'Present on every AI response so clients can be honest about provenance.',
        properties: {
          degraded: {
            type: 'boolean',
            description: 'True when the result came from the deterministic fallback, not the model',
          },
          degradedReason: { type: 'string' },
          cached: { type: 'boolean' },
        },
      },
    },
  },

  security: [{ bearerAuth: [] }, { cookieAuth: [] }],

  paths: {
    /* ---------------------------------------------------------------- auth */
    '/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Create an organization and its first user',
        description: 'The created user becomes the OWNER. Rate limited to 10 attempts per IP per 15 minutes.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['organizationName', 'name', 'email', 'password'],
                properties: {
                  organizationName: { type: 'string', minLength: 2, maxLength: 160 },
                  name: { type: 'string', minLength: 2, maxLength: 120 },
                  email: { type: 'string', format: 'email' },
                  password: {
                    type: 'string',
                    minLength: 10,
                    description: 'At least 10 characters. No composition rules (NIST SP 800-63B).',
                  },
                },
              },
              example: {
                organizationName: 'Acme Corporation',
                name: 'Jane Doe',
                email: 'jane@acme.com',
                password: 'correct-horse-battery',
              },
            },
          },
        },
        responses: {
          201: { description: 'Organization created; auth cookies set' },
          409: errorResponse('Email already registered'),
          429: errorResponse('Too many attempts'),
        },
      },
    },

    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Sign in',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Signed in; access and refresh cookies set' },
          401: errorResponse('Incorrect email or password'),
          403: errorResponse('Account suspended'),
        },
      },
    },

    '/auth/refresh': {
      post: {
        tags: ['Auth'],
        summary: 'Rotate the refresh token and mint a new access token',
        description:
          'Reusing an already-rotated refresh token revokes the whole session family — this is theft detection, not a bug.',
        security: [],
        responses: {
          200: { description: 'New token pair issued' },
          401: errorResponse('Refresh token invalid, expired or revoked'),
        },
      },
    },

    '/auth/logout': {
      post: { tags: ['Auth'], summary: 'Revoke this session', responses: { 204: { description: 'Signed out' } } },
    },

    '/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'Current user and organization',
        responses: { 200: { description: 'Current principal' }, 401: errorResponse('Not authenticated') },
      },
    },

    '/auth/members': {
      get: { tags: ['Auth'], summary: 'List organization members', responses: { 200: { description: 'Members' } } },
      post: {
        tags: ['Auth'],
        summary: 'Invite a member (ADMIN+)',
        description: 'You can never grant a role above your own.',
        responses: { 201: { description: 'Member created' }, 403: errorResponse('Insufficient role') },
      },
    },

    /* --------------------------------------------------------------- leads */
    '/leads': {
      get: {
        tags: ['Leads'],
        summary: 'List and filter leads',
        description:
          'Cursor-paginated by default. Supply `page` for offset pagination (needed only for "jump to page N").',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Free text over name, email, company, title' },
          { name: 'status', in: 'query', schema: { type: 'string' }, description: 'Comma-separated, e.g. NEW,QUALIFIED' },
          { name: 'source', in: 'query', schema: { type: 'string' }, description: 'Comma-separated' },
          { name: 'priority', in: 'query', schema: { type: 'string' } },
          { name: 'ownerId', in: 'query', schema: { type: 'string' } },
          { name: 'unassigned', in: 'query', schema: { type: 'boolean' } },
          { name: 'tags', in: 'query', schema: { type: 'string' }, description: 'Comma-separated; matches any' },
          { name: 'minScore', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 100 } },
          { name: 'maxScore', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 100 } },
          { name: 'createdAfter', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'createdBefore', in: 'query', schema: { type: 'string', format: 'date' } },
          {
            name: 'sortBy',
            in: 'query',
            schema: {
              type: 'string',
              enum: ['createdAt', 'updatedAt', 'score', 'fullName', 'company', 'estimatedValue', 'lastActivityAt'],
              default: 'createdAt',
            },
          },
          { name: 'sortOrder', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } },
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
          { $ref: '#/components/parameters/Cursor' },
          { $ref: '#/components/parameters/Limit' },
        ],
        responses: {
          200: {
            description: 'Matching leads',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Lead' } },
                    meta: { $ref: '#/components/schemas/PaginationMeta' },
                  },
                },
              },
            },
          },
          400: errorResponse('Invalid filter parameters'),
        },
      },
      post: {
        tags: ['Leads'],
        summary: 'Create a lead',
        description:
          'Rejects duplicates on the tenant-unique natural key (email, else phone, else name+company). ' +
          'The 409 response includes the id of the existing record.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateLeadRequest' } } },
        },
        responses: {
          201: { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Lead' } } } },
          400: errorResponse('Validation failed'),
          409: errorResponse('Duplicate lead'),
        },
      },
    },

    '/leads/stats': {
      get: {
        tags: ['Leads'],
        summary: 'Pipeline summary for the dashboard',
        description: 'Cached for 60 seconds per organization.',
        responses: { 200: { description: 'Counts, averages and conversion rate' } },
      },
    },

    '/leads/export': {
      get: {
        tags: ['Leads'],
        summary: 'Stream matching leads as CSV',
        description: 'Accepts the same filters as `GET /leads`. Streamed, so large exports start immediately.',
        responses: { 200: { description: 'CSV stream', content: { 'text/csv': {} } } },
      },
    },

    '/leads/bulk': {
      patch: {
        tags: ['Leads'],
        summary: 'Update up to 500 leads at once',
        responses: { 200: { description: 'Number of rows updated' }, 403: errorResponse('No permitted leads in selection') },
      },
    },

    '/leads/merge': {
      post: {
        tags: ['Leads'],
        summary: 'Merge duplicates into a primary lead',
        description:
          'The primary wins on every populated field; duplicates only fill blanks. Activities move to the survivor and duplicates are soft-deleted.',
        responses: { 200: { description: 'The surviving lead' } },
      },
    },

    '/leads/{id}': {
      get: {
        tags: ['Leads'],
        summary: 'Get a lead with owner, import source and activity timeline',
        parameters: [{ $ref: '#/components/parameters/LeadId' }],
        responses: { 200: { description: 'Lead' }, 404: errorResponse('Not found') },
      },
      patch: {
        tags: ['Leads'],
        summary: 'Partially update a lead',
        description: 'Omit a field to leave it alone; send `null` to clear it.',
        parameters: [{ $ref: '#/components/parameters/LeadId' }],
        responses: { 200: { description: 'Updated' }, 409: errorResponse('Would duplicate another lead') },
      },
      delete: {
        tags: ['Leads'],
        summary: 'Soft-delete a lead',
        description: 'Recoverable for 30 days via POST /leads/{id}/restore.',
        parameters: [{ $ref: '#/components/parameters/LeadId' }],
        responses: { 204: { description: 'Deleted' } },
      },
    },

    /* ------------------------------------------------------------- imports */
    '/imports': {
      get: { tags: ['Imports'], summary: 'List import jobs', responses: { 200: { description: 'Import jobs' } } },
      post: {
        tags: ['Imports'],
        summary: 'Phase 1 — upload a CSV and receive a proposed column mapping',
        description:
          'Nothing is imported yet. The response contains detected headers, sample rows and an AI-assisted mapping ' +
          'for the user to confirm or correct. Max upload size is set by MAX_UPLOAD_BYTES (default 50 MB).',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: { file: { type: 'string', format: 'binary', description: '.csv, .tsv or .txt' } },
              },
            },
          },
        },
        responses: {
          201: { description: 'Import registered with a proposed mapping' },
          413: errorResponse('File too large'),
          415: errorResponse('Unsupported file type'),
        },
      },
    },

    '/imports/{id}/start': {
      post: {
        tags: ['Imports'],
        summary: 'Phase 2 — confirm the mapping and run the import',
        description: 'Returns 202 immediately; poll `GET /imports/{id}` for progress.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['columnMapping'],
                properties: {
                  columnMapping: {
                    type: 'object',
                    additionalProperties: { type: 'string', nullable: true },
                    description: 'CSV header -> lead field, or null to keep as a custom field',
                  },
                  duplicateStrategy: {
                    type: 'string',
                    enum: ['SKIP', 'UPDATE', 'CREATE_ANYWAY'],
                    default: 'SKIP',
                    description: 'UPDATE only fills fields the file actually provides',
                  },
                  defaultSource: { type: 'string', enum: Object.values(LeadSource) },
                  defaultOwnerId: { type: 'string', nullable: true },
                  keepUnmappedAsCustomFields: { type: 'boolean', default: true },
                  autoScore: { type: 'boolean', default: true },
                },
              },
            },
          },
        },
        responses: {
          202: { description: 'Import queued' },
          400: errorResponse('Invalid mapping'),
          409: errorResponse('Import already started'),
        },
      },
    },

    '/imports/{id}': {
      get: {
        tags: ['Imports'],
        summary: 'Import status and progress',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: {
            description: 'Import job',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ImportJob' } } },
          },
        },
      },
    },

    '/imports/{id}/errors': {
      get: {
        tags: ['Imports'],
        summary: 'Row-level failures, with the original row for correction',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Row errors' } },
      },
    },

    /* ------------------------------------------------------------------ ai */
    '/ai/status': {
      get: {
        tags: ['AI'],
        summary: 'Whether AI is configured, available, and how much quota is left today',
        responses: { 200: { description: 'AI status' } },
      },
    },

    '/ai/score': {
      post: {
        tags: ['AI'],
        summary: 'Score leads 0-100 for conversion likelihood',
        description:
          'With no `leadIds`, scores the oldest unscored leads. Leads whose scoring inputs are unchanged are ' +
          'skipped, so calling this repeatedly is cheap. Falls back to a deterministic rule-based score if the ' +
          'provider is unavailable — check `meta.degraded`.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  leadIds: { type: 'array', items: { type: 'string' }, maxItems: 200 },
                  limit: { type: 'integer', default: 50, maximum: 200 },
                  force: { type: 'boolean', default: false, description: 'Re-score even if inputs are unchanged' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Scores, persisted to the leads',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'object' },
                    meta: { $ref: '#/components/schemas/AiMeta' },
                  },
                },
              },
            },
          },
          429: errorResponse('AI rate limit or daily organization quota exceeded'),
        },
      },
    },

    '/ai/search': {
      post: {
        tags: ['AI'],
        summary: 'Natural-language lead search',
        description:
          'Translates plain English into the same validated filters `GET /leads` accepts — the model cannot ' +
          'produce a query you could not have built by hand. The response echoes the applied filters so the user ' +
          'can inspect and adjust them.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['query'],
                properties: { query: { type: 'string', minLength: 3, maxLength: 500 } },
              },
              example: { query: 'hot fintech leads from last month with no owner' },
            },
          },
        },
        responses: { 200: { description: 'Matching leads plus the interpreted filters' } },
      },
    },

    '/ai/leads/{id}/insights': {
      get: {
        tags: ['AI'],
        summary: 'Pre-call briefing: summary, talking points, risks and a draft opener',
        parameters: [{ $ref: '#/components/parameters/LeadId' }],
        responses: { 200: { description: 'Insights' } },
      },
    },

    '/ai/usage': {
      get: {
        tags: ['AI'],
        summary: 'AI call volume, latency and token usage for the last 30 days',
        responses: { 200: { description: 'Usage by feature' } },
      },
    },

    /* ----------------------------------------------------------- analytics */
    '/analytics/timeseries': {
      get: {
        tags: ['Analytics'],
        summary: 'Daily lead volume, zero-filled across the window',
        parameters: [{ name: 'days', in: 'query', schema: { type: 'integer', default: 30, maximum: 365 } }],
        responses: { 200: { description: 'Daily counts' } },
      },
    },
    '/analytics/funnel': {
      get: { tags: ['Analytics'], summary: 'Stage counts with stage-to-stage conversion', responses: { 200: { description: 'Funnel' } } },
    },
    '/analytics/score-distribution': {
      get: { tags: ['Analytics'], summary: 'Score histogram in ten buckets', responses: { 200: { description: 'Distribution' } } },
    },
    '/analytics/by-owner': {
      get: { tags: ['Analytics'], summary: 'Per-rep totals, win rate and average score', responses: { 200: { description: 'Leaderboard' } } },
    },

    /* -------------------------------------------------------------- health */
    '/health': {
      get: { tags: ['Health'], summary: 'Full dependency roll-up', security: [], responses: { 200: { description: 'Healthy or degraded' }, 503: { description: 'A critical dependency is down' } } },
    },
    '/health/live': {
      get: { tags: ['Health'], summary: 'Liveness probe — never touches a dependency', security: [], responses: { 200: { description: 'Process is alive' } } },
    },
    '/health/ready': {
      get: { tags: ['Health'], summary: 'Readiness probe — checks MongoDB and Redis', security: [], responses: { 200: { description: 'Ready for traffic' }, 503: { description: 'Not ready' } } },
    },
  },
} as const;
