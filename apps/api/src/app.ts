/**
 * Express application assembly.
 *
 * Exported separately from `server.ts` so tests can mount the app with
 * supertest without binding a port or starting workers.
 *
 * Middleware order is load-bearing and reads top to bottom as the lifecycle of
 * a request: identify it, secure it, parse it, limit it, route it, and handle
 * whatever went wrong.
 */
import express, { type Express, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors, { type CorsOptions } from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env';
import { logger } from './lib/logger';
import { requestId } from './middleware/request-id';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { globalLimiter } from './middleware/rate-limit';
import { authRouter } from './modules/auth/auth.routes';
import { leadRouter } from './modules/leads/lead.routes';
import { importRouter } from './modules/imports/import.routes';
import { aiRouter } from './modules/ai/ai.routes';
import { analyticsRouter } from './modules/analytics/analytics.routes';
import { healthRouter } from './modules/health/health.routes';
import { openApiDocument } from './docs/openapi';

const API_PREFIX = '/api/v1';

/**
 * CORS.
 *
 * `credentials: true` means cookies cross origins, which makes a permissive
 * origin policy genuinely dangerous — the browser would attach the user's
 * session to a malicious site's request. So the allow-list is explicit and a
 * wildcard is only honoured outside production.
 */
const corsOptions: CorsOptions = {
  origin(origin, callback) {
    // Same-origin, curl, and server-to-server requests send no Origin header.
    if (!origin) return callback(null, true);
    if (env.corsOrigins.includes(origin)) return callback(null, true);
    if (env.corsOrigins.includes('*') && !env.isProduction) return callback(null, true);
    callback(new Error(`Origin ${origin} is not permitted by CORS policy`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  exposedHeaders: ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
  maxAge: 86_400, // cache the preflight for a day
};

export const createApp = (): Express => {
  const app = express();

  /* --- 1. trust the proxy ------------------------------------------------ */
  // Required for correct client IPs behind a load balancer, which rate limiting
  // and audit logging both depend on. `1` = trust exactly one hop; trusting all
  // proxies would let a client forge X-Forwarded-For and bypass rate limits.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.set('etag', 'strong');

  /* --- 2. correlation id (before logging, so logs carry it) -------------- */
  app.use(requestId);

  /* --- 3. security headers ---------------------------------------------- */
  app.use(
    helmet({
      // This is a JSON API; the only HTML it serves is Swagger UI, which needs
      // its own inline styles. Scripts stay locked down.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      // 1 year HSTS, only meaningful over TLS.
      hsts: env.isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  app.use(cors(corsOptions));

  /* --- 4. request logging ------------------------------------------------ */
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as Request).id,
      // Health checks would otherwise dominate the log volume at 1 req/s/pod.
      autoLogging: {
        ignore: (req) => (req.url ?? '').startsWith(`${API_PREFIX}/health`),
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
      serializers: {
        req: (req) => ({ method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  /* --- 5. body parsing --------------------------------------------------- */
  // 1 MB is generous for JSON here; bulk operations are capped at 500 ids and
  // file uploads use the streaming multipart path, not this parser.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieParser());

  // Skip compressing streamed CSV exports: buffering them to compress would
  // undo the entire point of streaming.
  app.use(
    compression({
      filter: (req, res) => {
        if (res.getHeader('Content-Type')?.toString().includes('text/csv')) return false;
        return compression.filter(req, res);
      },
    }),
  );

  /* --- 6. health (before rate limiting — probes must never be throttled) - */
  app.use(`${API_PREFIX}/health`, healthRouter);

  /* --- 7. rate limiting -------------------------------------------------- */
  app.use(API_PREFIX, globalLimiter);

  /* --- 8. documentation -------------------------------------------------- */
  app.get(`${API_PREFIX}/openapi.json`, (_req: Request, res: Response) => {
    res.json(openApiDocument);
  });
  app.use(
    `${API_PREFIX}/docs`,
    swaggerUi.serve,
    swaggerUi.setup(openApiDocument, {
      customSiteTitle: 'Aarvion CRM API',
      swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
    }),
  );

  /* --- 9. routes --------------------------------------------------------- */
  app.use(`${API_PREFIX}/auth`, authRouter);
  app.use(`${API_PREFIX}/leads`, leadRouter);
  app.use(`${API_PREFIX}/imports`, importRouter);
  app.use(`${API_PREFIX}/ai`, aiRouter);
  app.use(`${API_PREFIX}/analytics`, analyticsRouter);

  /* --- 10. service discovery -------------------------------------------- */
  app.get('/', (_req: Request, res: Response) => {
    res.json({
      service: 'aarvion-crm-api',
      version: '1.0.0',
      documentation: `${API_PREFIX}/docs`,
      openapi: `${API_PREFIX}/openapi.json`,
      health: `${API_PREFIX}/health`,
    });
  });

  /* --- 11. terminal handlers -------------------------------------------- */
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
