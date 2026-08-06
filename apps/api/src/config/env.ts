/**
 * Environment configuration.
 *
 * Parsed and validated exactly once, at import time. If anything is missing or
 * malformed the process exits with a readable report instead of throwing a
 * `undefined is not a string` five minutes into a production incident.
 *
 * Everywhere else in the codebase reads `env.X` — `process.env` is never touched
 * outside this file, which means the type system knows the shape of our config.
 */
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load the repo-root .env (shared by api + web) then any api-local override.
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

/** Accepts "true"/"1"/"yes" (case-insensitive) as true. */
const booleanish = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? defaultValue : /^(true|1|yes)$/i.test(v)));

const intWithin = (min: number, max: number, defaultValue: number) =>
  z.coerce.number().int().min(min).max(max).default(defaultValue);

const schema = z.object({
  // --- runtime ------------------------------------------------------------
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: intWithin(1, 65535, 4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  // --- data stores --------------------------------------------------------
  /**
   * MongoDB connection string.
   *
   * Not validated with `z.string().url()`: the WHATWG URL parser rejects
   * `mongodb+srv://` hosts that carry no port, so a perfectly valid Atlas SRV
   * string would fail. The shape check below is what actually matters, plus a
   * specific diagnostic for the mistake people hit most often — an unencoded
   * special character in the password.
   */
  MONGODB_URI: z
    .string()
    .min(1, 'MONGODB_URI is required')
    .refine(
      (value) => value.startsWith('mongodb://') || value.startsWith('mongodb+srv://'),
      'MONGODB_URI must start with mongodb:// or mongodb+srv://',
    ),
  /** Connection pool size per process. See DEPLOYMENT.md for the arithmetic. */
  MONGO_POOL_SIZE: intWithin(1, 500, 20),

  REDIS_URL: z.string().url('REDIS_URL must be a valid redis:// connection string'),

  // --- auth ---------------------------------------------------------------
  // 32 chars is the floor for an HS256 secret to carry 256 bits of entropy.
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  BCRYPT_COST: intWithin(10, 15, 12),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: booleanish(false),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

  // --- AI -----------------------------------------------------------------
  GEMINI_API_KEY: z.string().optional().default(''),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  GEMINI_API_BASE: z.string().url().default('https://generativelanguage.googleapis.com/v1beta'),
  GEMINI_TIMEOUT_MS: intWithin(1_000, 120_000, 25_000),
  GEMINI_MAX_RETRIES: intWithin(0, 5, 2),
  AI_DAILY_REQUEST_LIMIT: intWithin(0, 1_000_000, 1_000),
  AI_CACHE_TTL_SECONDS: intWithin(0, 2_592_000, 86_400),

  // --- ingestion ----------------------------------------------------------
  MAX_UPLOAD_BYTES: intWithin(1_024, 1_073_741_824, 52_428_800),
  IMPORT_BATCH_SIZE: intWithin(50, 5_000, 500),
  IMPORT_WORKER_CONCURRENCY: intWithin(1, 32, 4),
  AI_WORKER_CONCURRENCY: intWithin(1, 16, 2),
  UPLOAD_DIR: z.string().default(path.resolve(process.cwd(), 'uploads')),

  // --- rate limiting ------------------------------------------------------
  RATE_LIMIT_WINDOW_MS: intWithin(1_000, 3_600_000, 60_000),
  RATE_LIMIT_MAX: intWithin(1, 100_000, 300),
  AUTH_RATE_LIMIT_MAX: intWithin(1, 1_000, 10),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  • ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  // Deliberately console.error: the logger itself depends on this config.
  console.error(`\n✖ Invalid environment configuration:\n${issues}\n`);
  console.error('  Copy .env.example to .env and fill in the missing values.\n');
  process.exit(1);
}

const raw = parsed.data;

/**
 * Catches the single most common MongoDB configuration mistake: a password
 * containing a character that is reserved in a URI (`@`, `/`, `:`, `?`, `#`)
 * left unencoded. The driver then reads everything before the *last* `@` as the
 * credentials and produces a DNS or authentication error that says nothing about
 * the real cause. Diagnosing it from that error costs people hours.
 */
const credentialsPart = raw.MONGODB_URI.replace(/^mongodb(\+srv)?:\/\//, '').split('/')[0] ?? '';
if ((credentialsPart.match(/@/g)?.length ?? 0) > 1) {
  console.error(
    '\n✖ MONGODB_URI appears to contain an unencoded character in the password.\n' +
      '  Reserved characters must be percent-encoded:\n' +
      '    @ -> %40    / -> %2F    : -> %3A    ? -> %3F    # -> %23\n\n' +
      '  For example, the password "Aa@89824249" becomes "Aa%4089824249".\n' +
      "  In Node:  encodeURIComponent('your-password')\n",
  );
  process.exit(1);
}

if (raw.JWT_ACCESS_SECRET === raw.JWT_REFRESH_SECRET) {
  console.error(
    '\n✖ JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ.\n' +
      '  Sharing them means a leaked access secret can also mint refresh tokens.\n',
  );
  process.exit(1);
}

const isProduction = raw.NODE_ENV === 'production';

if (isProduction) {
  const weak: string[] = [];
  if (raw.JWT_ACCESS_SECRET.includes('replace-with')) weak.push('JWT_ACCESS_SECRET');
  if (raw.JWT_REFRESH_SECRET.includes('replace-with')) weak.push('JWT_REFRESH_SECRET');
  if (weak.length > 0) {
    console.error(`\n✖ Placeholder secrets detected in production: ${weak.join(', ')}\n`);
    process.exit(1);
  }
}

export const env = {
  ...raw,
  isProduction,
  isDevelopment: raw.NODE_ENV === 'development',
  isTest: raw.NODE_ENV === 'test',

  /** Parsed CORS allow-list. `*` disables the allow-list (development only). */
  corsOrigins: raw.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  /** AI features are live only when a key is configured. */
  aiEnabled: raw.GEMINI_API_KEY.trim().length > 0,
} as const;

export type Env = typeof env;
