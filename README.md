# Aarvion CRM

An AI-powered, multi-tenant CRM for importing, managing and organising customer leads.

**MERN stack** — MongoDB · Express · React (Next.js) · Node.js — in TypeScript end to end.

Built as a production system rather than a demo: real multi-tenancy, background job
processing, graceful degradation when the AI provider is down, and a deployment story
that does not depend on anyone's laptop.

---

## Contents

- [What it does](#what-it-does)
- [Stack](#stack)
- [Quick start](#quick-start)
- [Architecture at a glance](#architecture-at-a-glance)
- [Where the AI actually helps](#where-the-ai-actually-helps)
- [Project layout](#project-layout)
- [Development](#development)
- [Testing](#testing)
- [Documentation](#documentation)
- [Engineering decisions](#engineering-decisions)
- [What I deliberately left out](#what-i-deliberately-left-out)

---

## What it does

| Capability | Detail |
|---|---|
| **Multi-tenant workspaces** | Every document is scoped to an organization. Isolation is enforced in one place (the repository layer), not sprinkled across handlers. |
| **Role-based access** | `OWNER → ADMIN → MEMBER → VIEWER`, hierarchical, with object-level rules (a MEMBER may only edit leads they own or that are unassigned). |
| **CSV import at scale** | Streaming parser, delimiter sniffing, AI column mapping, per-row error reporting, three duplicate strategies. A 200k-row file uses one batch of memory, not 200k rows of it. |
| **Deduplication** | Tenant-unique natural key (email → phone → name+company), enforced by a **unique MongoDB index** rather than by application logic racing itself. |
| **AI lead scoring** | 0–100 with a written rationale and a suggested next action. Batched, cached, quota-limited, and skipped entirely when a lead has not changed. |
| **Natural-language search** | "hot fintech leads from last month with no owner" → validated filters, shown back to the user as editable chips. |
| **Pipeline analytics** | Funnel, volume over time, score distribution, per-rep leaderboard. All computed by MongoDB aggregation pipelines, cached per tenant. |
| **Audit trail** | Append-only log of every state-changing action, with actor, IP and user agent. |
| **Streaming CSV export** | Keyset-paginated and streamed, so a 50k-row export starts downloading immediately. |

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| **M**ongoDB 7 + Mongoose 8 | Document store | Leads carry arbitrary customer columns; `customFields` absorbs them with no schema migration per customer. Aggregation pipelines do the reporting. |
| **E**xpress 4 + TypeScript | REST API | Explicit middleware pipeline; every layer typed. |
| **R**eact 19 / Next.js 15 | Frontend | App Router, TanStack Query, Tailwind. |
| **N**ode.js 22 | Runtime | API and a separate BullMQ worker process. |
| Redis 7 | Queues, cache, rate limiting | BullMQ for imports and AI enrichment. |
| Google Gemini | AI | Structured JSON output, with a deterministic fallback for every feature. |

---

## Quick start

### Everything in Docker

```bash
git clone <repository-url>
cd aarvion-crm

cp .env.example .env
# Set the two JWT secrets:  openssl rand -base64 48
# MONGODB_URI defaults to the compose-local MongoDB; point it at Atlas if you prefer.
# GEMINI_API_KEY is optional — see "Running without an API key" below.

docker compose up -d --build

# Create indexes and load demo data
docker compose exec api npm run db:indexes:prod
docker compose exec api npm run db:seed:prod
```

| | |
|---|---|
| App | <http://localhost:3000> |
| API | <http://localhost:4000/api/v1> |
| API docs (Swagger UI) | <http://localhost:4000/api/v1/docs> |
| Health | <http://localhost:4000/api/v1/health> |

Sign in with `admin@acme.test` / `Password123!` — or click **Use demo credentials**
on the login page.

The seed creates ~246 leads across five users with four different roles, deliberately
**unscored**, so the AI scoring flow has something to do on a fresh install.

### Using MongoDB Atlas

```bash
# Run against Atlas only — this overlay drops the local MongoDB container,
# which the base stack otherwise starts (and waits for) needlessly.
docker compose -f docker-compose.yml -f docker-compose.atlas.yml up -d
docker compose exec api npm run db:indexes:prod
docker compose exec api npm run db:seed:prod
```

Set `MONGODB_URI` in **`.env`** to your cluster's connection string.

> **⚠ `.env`, not `.env.example`.** `.env.example` is a committed template — the
> application never reads it. Putting a real connection string there means the app keeps
> using whatever `.env` says (so "it works in Compass but not in the app"), *and* your
> credentials end up in version control. Copy the template once
> (`cp .env.example .env`) and edit `.env` from then on. `.env` is gitignored.

> **⚠ Encode special characters in the password.** This is the single most common
> MongoDB setup failure. Characters reserved in a URI must be percent-encoded, or the
> driver misreads where the credentials end and reports a confusing DNS or auth error:
>
> | Character | Encoded |
> |---|---|
> | `@` | `%40` |
> | `/` | `%2F` |
> | `:` | `%3A` |
> | `?` | `%3F` |
> | `#` | `%23` |
>
> A password of `Aa@89824249` becomes `Aa%4089824249`.
> Generate it reliably: `node -e "console.log(encodeURIComponent('your-password'))"`
>
> The API detects an unencoded `@` at boot and tells you exactly what is wrong, rather
> than letting the driver fail with an unrelated error.

Also remember to **include the database name in the path** (`…mongodb.net/aarvion_crm?…`),
otherwise the driver silently connects to a database called `test`.

### Local development with hot reload

```bash
npm install

# MongoDB (single-node replica set) + Redis in containers; app on the host
docker compose -f docker-compose.dev.yml up -d

cp .env.example .env      # fill in the two JWT secrets
npm run db:indexes
npm run db:seed

npm run dev               # API :4000, web :3000, concurrently
```

Run the background worker in a second terminal — imports and AI scoring will
queue but not process without it:

```bash
npm run dev:worker
```

> The local MongoDB runs as a **single-node replica set**, not a bare `mongod`. MongoDB
> only supports multi-document transactions on a replica set, and this application uses
> them. A standalone server would silently exercise a non-transactional fallback, so
> local behaviour would not match production (Atlas is always a replica set).

### Enabling AI

Put a key from <https://aistudio.google.com/app/apikey> into **`.env`** (not
`.env.example`), then verify it in one command:

```bash
npm run ai:check                                  # host
docker compose exec api npm run ai:check:prod     # container
```

It walks each layer — key present → authenticates → model listed → a real
structured-output call — and tells you exactly where it stops. Sample output:

```
  GEMINI_API_KEY         AIza…9xQ2 (39 chars)
  GEMINI_MODEL           gemini-2.5-flash
  aiEnabled              true
[1/3] Authenticating…            ✔ key is valid — 42 models support generateContent
[2/3] Checking the model…        ✔ listed
[3/3] Structured-output request… ✔ responded in 983ms — {"ok":true}
```

Two things catch people out, and the check names both:

- **The key must be in `.env`.** `.env.example` is a committed template the app never
  reads — putting a real key there also leaks it into version control.
- **Docker fixes environment variables at container start.** Editing `.env` afterwards
  changes nothing until you run
  `docker compose up -d --force-recreate api worker`.

A third is worth knowing about: a key can authenticate perfectly and *still* return
`HTTP 429 … limit: 0` for a given model. That is not a rate limit you can wait out — it
means the model has no quota on your tier. `ai:check` lists the models your key can
actually use. This is why the default is `gemini-2.5-flash` rather than `gemini-2.0-flash`.

### Running without an API key

The application is fully functional with `GEMINI_API_KEY` empty. Every AI feature has a
deterministic fallback:

| Feature | Fallback |
|---|---|
| Lead scoring | Weighted rule engine over the same rubric (seniority, company fit, contact quality, source intent, buying signals) |
| Column mapping | Alias table covering HubSpot, Salesforce, Pipedrive, Mailchimp and Apollo exports |
| Natural-language search | Keyword and phrase matching |
| Lead insights | Template briefing derived from the record |

Responses carry `meta.degraded: true` and the UI says so plainly. **An AI outage is
never allowed to fail a user's request** — see [`ai.heuristics.ts`](apps/api/src/modules/ai/ai.heuristics.ts).

---

## Architecture at a glance

```
                        ┌──────────────────────────────┐
   Browser ───────────► │  Next.js 15 (App Router)     │
                        │  · React 19 + TanStack Query │
                        │  · BFF proxy at /api/v1/*    │
                        └──────────────┬───────────────┘
                                       │  private network
                                       ▼
                        ┌──────────────────────────────┐
                        │  Express 4 + TypeScript API  │
                        │  · Zod validation            │
                        │  · JWT + refresh rotation    │
                        │  · Redis rate limiting       │
                        └───┬──────────┬───────────┬───┘
                            │          │           │
              ┌─────────────▼──┐  ┌────▼─────┐  ┌──▼──────────────┐
              │  MongoDB 7     │  │ Redis 7  │  │ Gemini API      │
              │  · Mongoose 8  │  │ · BullMQ │  │ · structured    │
              │  · replica set │  │ · cache  │  │   JSON output   │
              │  · aggregation │  │ · limits │  │ · circuit break │
              └────────▲───────┘  └────┬─────┘  └──▲──────────────┘
                       │               │           │
                       │        ┌──────▼───────────┴──┐
                       └────────┤  Worker process      │
                                │  · CSV import        │
                                │  · AI enrichment     │
                                │  · Maintenance cron  │
                                └──────────────────────┘
```

Three deployable units — **web**, **api**, **worker** — each scaling on its own signal:
web on page views, api on request rate, worker on queue depth.

Full reasoning in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

### Why a separate worker process

Importing 200,000 rows takes minutes. Doing it inside an HTTP request would hold a
connection open past every reasonable proxy timeout, lose all progress on deploy, and
let one large upload starve the event loop for every other user. So the upload endpoint
does exactly two things — persist the file, enqueue the job — and returns `202`.

### Why a BFF proxy in front of the API

The browser only ever talks to its own origin. That makes auth cookies first-party
(no `SameSite=None`, no third-party-cookie problem), keeps the API off the public
internet, and preserves the cookie path scoping the API sets. It is ~90 lines:
[`apps/web/src/app/api/v1/[...path]/route.ts`](apps/web/src/app/api/v1/%5B...path%5D/route.ts).

---

## Where the AI actually helps

The brief asks for AI "where it adds meaningful value". Four places earn it, and each
one is measured against a rule-based baseline that ships alongside it.

**1. CSV column mapping.** The genuinely hard part of importing arbitrary customer data.
The heuristic alias table handles the exports of the tools people actually migrate from;
the model is only consulted for the columns it could not place. That keeps well-known
headers deterministic across runs — users notice when the same file maps differently on
Tuesday — and only pays for the long tail.

**2. Lead scoring.** A written rubric, applied consistently, at 20 leads per call.
Cached against a hash of the scoring inputs, so editing a note never triggers a re-score
but changing a job title does.

**3. Natural-language search.** The model's output is *never* used to build a database
query directly. It is parsed into the same validated filter object `GET /leads` already
accepts, so the model can only ever produce a query the user could have built by hand in
the UI. That is the entire security argument for the feature.

**4. Pre-call briefing.** Loaded on demand, not on page load — generating a briefing for
every lead a rep clicks past would burn quota on records they glance at for two seconds.

### How the AI layer is kept safe and affordable

| Concern | Mitigation |
|---|---|
| Prompt injection | Customer data is wrapped in a delimited `<untrusted_data>` block with an explicit instruction that it is data, never instructions. Structured output constrains what the model can emit. Worst case is a wrong lead score. |
| Hallucinated IDs | Results are anchored to *our* list of leads, not the model's. Writes filter on `organizationId` as well as `_id`. |
| Malformed output | Every response is re-validated with Zod. `responseSchema` is a strong hint, not a guarantee. |
| Runaway cost | Input hashing → Redis cache → per-tenant daily quota → batching. Four layers, in that order. |
| Provider outage | Timeout, bounded retries with jittered backoff, circuit breaker, then the deterministic fallback. |
| PII leakage | An explicit allow-list projection is sent to the model. Internal IDs, audit fields and custom fields never leave. Prompts are never logged — only a hash. |

---

## Project layout

```
.
├── apps/
│   ├── api/                          Express + TypeScript backend
│   │   ├── src/
│   │   │   ├── models/               Mongoose schemas — the data design
│   │   │   │   ├── enums.ts          Single source of truth for closed value sets
│   │   │   │   ├── base.ts           Shared schema options, id serialisation
│   │   │   │   ├── lead.model.ts     Core record + every index, annotated
│   │   │   │   └── …                 organization · user · refreshToken ·
│   │   │   │                         leadActivity · importJob · auditLog
│   │   │   ├── config/env.ts         Zod-validated config; fails fast at boot
│   │   │   ├── lib/                  db · redis · logger · errors · validators
│   │   │   ├── middleware/           auth · validation · rate limit · upload · errors
│   │   │   ├── modules/
│   │   │   │   ├── auth/             JWT rotation, RBAC, team management
│   │   │   │   ├── leads/            CRUD, filtering, dedupe, merge, export
│   │   │   │   ├── imports/          Two-phase CSV ingestion
│   │   │   │   ├── ai/               Gemini client, prompts, heuristics
│   │   │   │   ├── analytics/        Aggregation pipelines
│   │   │   │   ├── audit/            Append-only trail
│   │   │   │   └── health/           Liveness / readiness
│   │   │   ├── queues/               BullMQ definitions
│   │   │   ├── workers/              Import · enrichment · maintenance
│   │   │   ├── scripts/              sync-indexes · reset
│   │   │   ├── docs/openapi.ts       OpenAPI 3.0 specification
│   │   │   ├── app.ts                Express assembly
│   │   │   ├── server.ts             API entry point
│   │   │   ├── worker.ts             Worker entry point
│   │   │   └── seed.ts               Deterministic, realistic demo data
│   │   └── tests/                    146 tests
│   └── web/                          Next.js 15 frontend
│       └── src/
│           ├── app/
│           │   ├── (auth)/           Login · register
│           │   ├── (app)/            Dashboard · leads · import · settings
│           │   └── api/v1/[...path]/ BFF proxy
│           ├── components/           Shell · UI primitives · charts · lead views
│           ├── lib/                  API client · types · formatting
│           └── middleware.ts         Optimistic route protection
├── docs/
│   ├── ARCHITECTURE.md               System design and trade-offs
│   ├── DEPLOYMENT.md                 Deploying to production
│   └── API.md                        Endpoint reference and conventions
├── docker-compose.yml                Full stack (MongoDB replica set)
├── docker-compose.dev.yml            Infrastructure only, for hot reload
└── .github/workflows/ci.yml          Typecheck · test · indexes · build · smoke
```

---

## Development

```bash
npm run dev            # API + web with hot reload
npm run dev:worker     # Background worker
npm run build          # Build everything
npm run typecheck      # tsc --noEmit across both workspaces
npm run lint
npm run test           # Unit tests

npm run db:indexes     # Create/sync indexes — the MongoDB "migration" step
npm run db:seed        # Load demo data
npm run db:reset       # Drop all collections (development databases only)
```

### Schema and indexes

MongoDB has no DDL, so there is nothing to version the way SQL migrations do. What
*does* need deliberate management is **indexes** — they are the difference between a 2ms
query and a collection scan, and building one on a large collection is a real operation.

`autoIndex` is disabled on the connection precisely so this never happens implicitly.
Mongoose's default of building indexes on first connect is fine on a laptop and actively
dangerous in production: every replica racing to build the same index on deploy.

Instead, [`src/scripts/sync-indexes.ts`](apps/api/src/scripts/sync-indexes.ts) is an
explicit deploy step, exactly like `migrate deploy`:

```bash
npm run db:indexes          # development
npm run db:indexes:prod     # compiled, inside the container
```

It is declarative — it creates what is missing and drops what the schema no longer
declares, so the database converges on what the code says.

The schema itself is [`src/models/`](apps/api/src/models/), where every collection and
every index is defined and annotated with why it exists.

### Environment configuration

Every variable is documented in [`.env.example`](.env.example) and validated at boot by
[`config/env.ts`](apps/api/src/config/env.ts). The API refuses to start on an invalid
configuration and prints exactly which variable is wrong — failing fast beats failing
weird at 3am. It also specifically detects an unencoded password in `MONGODB_URI`.

---

## Testing

```bash
npm run test -w @aarvion/api            # 146 tests
npm run test:coverage -w @aarvion/api
```

The suite concentrates on the logic where a bug is silent and expensive:

- **`app.smoke.test.ts`** — the real Express app driven over HTTP, with no database or
  Redis: middleware order, auth guards, the error envelope, CORS, security headers and
  request-id sanitisation. Unit tests verify each piece in isolation; this verifies they
  are actually wired together.
- **`lead.normalizer.test.ts`** — dedupe key generation. Decides whether re-importing
  last month's export creates 20,000 duplicates or updates 20,000 documents.
- **`import.mapper.test.ts`** — row mapping against the value formats real exports
  contain. *This suite caught a live bug during development: `$50,000` parsed as `50`.*
- **`rbac.test.ts`** — permission rules, asserted exhaustively. Permission bugs do not
  throw; the wrong person just sees the wrong data.
- **`auth.tokens.test.ts`** — token verification, weighted toward what must be
  *rejected*: `alg: none`, wrong secret, wrong audience, expired.
- **`lead.schemas.test.ts`** — the validation boundary, including mass-assignment
  protection, ObjectId validation and sort-field allow-listing.
- **`ai.heuristics.test.ts`** — the fallbacks, which run during a provider outage and
  are therefore on the critical path of an incident.

CI additionally creates the real indexes against a real MongoDB, verifies the unique
dedupe index exists, builds both Docker images, and runs an end-to-end smoke test
against the full compose stack.

### Verified against the running stack

The full stack was brought up on MongoDB and exercised end to end:

| Verified | Result |
|---|---|
| Index sync + seed on a clean database | 10 collections indexed; 246 leads, 5 users, 570 activities seeded |
| Auth | Login, wrong-password rejection, unauthenticated 401 |
| **Refresh rotation** | Rotation issues a new token; replaying the old one is rejected **and revokes the whole family**, including the descendant |
| **RBAC** | VIEWER reads leads and analytics, cannot create leads (403) |
| **Tenant isolation** | A second organization gets `404` on another tenant's lead id and sees `total: 0` |
| **ObjectId handling** | Unknown id → 404; malformed id → 400 at the validation edge, never a driver CastError |
| **Operator filters** | `minScore`, `status`, `tags`, `createdAfter`, score ranges all return 200 |
| **CSV import** (messy, semicolon-delimited) | `$52,000`→52000, `1.2M`→1200000, `1.234,56`→1235, `50k`→50000; "Closed Won"/"MQL"/"Bad Fit" mapped to enums; in-file duplicate skipped; bad email and empty row recorded as row errors |
| **Import idempotency** | Re-importing the same file: `created=0, skipped=5`. `UPDATE` strategy: `updated=4` |
| Worker chaining | Import completed → AI enrichment auto-queued and scored the new leads |
| AI degradation (no API key) | Scoring, NL search and usage analytics returned `degraded: true` with rule-based results instead of failing |
| Analytics | Funnel with stage conversions, zero-filled 7-day series, score histogram, owner leaderboard |

That exercise found and fixed three real MongoDB-specific bugs that no amount of
typechecking would have caught:

1. **`sanitizeFilter: true` broke every operator query.** It cannot distinguish a
   `{ $gte: 70 }` the codebase constructed from one an attacker smuggled in, so
   `?minScore=50` became `{ score: { $eq: { $gte: 50 } } }` and failed to cast. Removed;
   the real defence is Zod coercing every query parameter to a primitive at the edge.
2. **`timestamps: true` conflicted with manual `updatedAt` in `bulkWrite`.** Mongoose
   injects its own `$set: { updatedAt }`, and specifying it too made MongoDB reject the
   entire import batch with a path-conflict error.
3. **Redis `enableOfflineQueue: false` broke the startup health check** — the ping fired
   before the socket was ready, so both processes crash-looped on boot.

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System design, data model, why MongoDB, scaling path, security model, trade-offs |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Production deployment, Atlas configuration, indexes, scaling, monitoring, backups |
| [`docs/API.md`](docs/API.md) | Endpoint reference, conventions, error codes, pagination, worked examples |
| `/api/v1/docs` | Interactive Swagger UI against the running instance |
| `/api/v1/openapi.json` | Machine-readable OpenAPI 3.0 specification |

---

## Engineering decisions

The reasoning behind each choice is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md);
the short version:

| Decision | Why |
|---|---|
| **MongoDB with a strict Mongoose schema** | The flexibility is used exactly where it pays — `customFields` absorbs arbitrary CSV columns — while everything else is schema-validated, so the document store does not become a junk drawer. |
| **Unique compound index for deduplication** | `{ organizationId, dedupeKey }`. The database enforces it under concurrency; four import workers cannot race past it. Application-level checks are a race condition with extra steps. |
| **Explicit document interfaces, not `InferSchemaType`** | Inference collapses when a shared options object is passed to `Schema`, and an explicit interface is the contract consumers program against. |
| **Explicit `TenantContext` argument** | Rather than reading tenant from ambient async state. A missing tenant filter becomes a compile error, not a cross-tenant leak found by a customer. |
| **`strictQuery: 'throw'`** | An unknown field in a filter throws instead of being dropped. A typo'd `organisationId` would otherwise return every tenant's data. |
| **Activities in their own collection** | Embedding an unbounded, ever-growing array on the lead is the classic document-modelling mistake — and MongoDB caps a document at 16 MB. |
| **Refresh-token rotation with reuse detection** | Standard OAuth 2.0 BCP §4.13. Presenting an already-rotated token revokes the whole family. |
| **httpOnly cookies, not localStorage** | localStorage is readable by any XSS payload. |
| **Direct `fetch` against Gemini, no SDK** | One endpoint is needed. No transitive dependency churn in a production image, and full control over timeout, retry classification and the circuit breaker. |
| **Cursor pagination by default** | O(1) at any depth. Offset is available but capped, because "jump to page 40" is a real need in a data grid. |
| **Hand-drawn SVG charts** | Four fixed visualisations. A charting library would add ~120 KB and a second styling system to keep in sync with the theme tokens. |

---

## What I deliberately left out

Being explicit about scope is part of the answer.

- **Email/SMS sending.** Invitations issue a temporary password rather than a magic
  link. Adding a transactional email provider is a configuration change, not an
  architectural one.
- **Real-time updates (WebSocket/SSE).** Import progress polls at 1.5s and stops at a
  terminal state. Polling is correct, trivially scalable, and honest at this size.
  MongoDB change streams would be the natural upgrade.
- **Object storage for uploads.** Uploads go to a shared Docker volume. The seam is
  `storageKey` on `ImportJob` — swapping in S3 touches two functions. Called out
  explicitly in the deployment guide, since it is the first thing that must change for a
  multi-host deployment.
- **Atlas Search.** Free-text search uses a tenant-bounded regex, which matches the
  substring behaviour users expect from a CRM search box. `$text` was considered and
  rejected (it would not match "north" against "Northwind"). The upgrade path is Atlas
  Search, and the seam is one function.
- **XLSX import.** CSV, TSV and delimited text only.
- **Billing.** `Organization.plan` exists as a string; nothing enforces it.

Each of these is a deliberate scope decision, not an oversight — the brief values
thoughtful engineering over feature count.

---

## Licence

MIT
