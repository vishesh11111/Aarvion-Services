# Architecture

How Aarvion CRM is built and why. This document is about *trade-offs* — the choices
that had a real alternative — rather than a restatement of the file tree.

Stack: **MongoDB · Express · React/Next.js · Node.js**, TypeScript throughout.

---

## Contents

1. [System topology](#1-system-topology)
2. [Data model](#2-data-model)
3. [Multi-tenancy and isolation](#3-multi-tenancy-and-isolation)
4. [Authentication and authorisation](#4-authentication-and-authorisation)
5. [The import pipeline](#5-the-import-pipeline)
6. [Deduplication](#6-deduplication)
7. [The AI layer](#7-the-ai-layer)
8. [Frontend architecture](#8-frontend-architecture)
9. [Performance](#9-performance)
10. [Scaling path](#10-scaling-path)
11. [Security model](#11-security-model)
12. [Observability](#12-observability)
13. [Decisions I would revisit](#13-decisions-i-would-revisit)

---

## 1. System topology

Three deployable units plus two stateful services.

```
web (Next.js)  →  api (Express)  →  MongoDB
                       ↓                ↑
                     redis  ←──── worker (BullMQ)
                       ↓
                  Gemini API
```

**Why three units rather than one.** They fail differently and scale on different
signals. The API scales on request rate; the worker scales on queue depth; the web app
scales on page views. Bundled together, a 200k-row import would consume the same event
loop serving interactive requests, and you would be forced to over-provision all three
to handle a spike in any one.

The worker runs the *same image* as the API with a different command. One build, one
dependency tree, one place for shared domain code — and no risk of the API and the
worker disagreeing about what a lead is.

**Why the browser never talks to the API directly.** Every browser request goes to
`/api/v1/*` on the web app's own origin and is proxied server-side
([`route.ts`](../apps/web/src/app/api/v1/%5B...path%5D/route.ts)). This gives three
things:

1. Auth cookies are first-party. No `SameSite=None`, no third-party-cookie deprecation
   problem, no Safari ITP edge cases.
2. The API needs no public ingress at all in production.
3. The API scopes the refresh cookie to `/api/v1/auth`; mirroring the path prefix through
   the proxy means that scoping survives instead of silently breaking.

The proxy is deliberately dumb — it does not parse bodies (so uploads stream through
untouched) and contains no logic of its own. A BFF that accumulates business rules
becomes a second backend to maintain.

---

## 2. Data model

Ten collections. The annotated definitions are in
[`src/models/`](../apps/api/src/models/).

```
organizations ─┬─< users ──< refreshtokens
               ├─< leads ──< leadactivities
               ├─< importjobs ──< importerrors
               │        └──< leads
               ├─< savedviews
               ├─< auditlogs
               └─< aiinteractions
```

### Choosing MongoDB

The brief allows relational or NoSQL. MongoDB earns its place here for one specific
reason, and the rest of the design is about containing the costs that come with it.

**The reason it wins: arbitrary customer columns.** Every CRM migration arrives with a
CSV containing columns nobody anticipated — `legacy_crm_id`, `territory_code`,
`renewal_quarter`. In a relational schema those are either dropped, stuffed into a JSON
column, or handled with a schema migration per customer. Here, `customFields` is a
native subdocument: queryable, indexable, and free. That is a real, load-bearing use of
the document model rather than a stylistic preference.

**The costs, and how they are contained:**

| Cost | Containment |
|---|---|
| No schema enforcement by default | Every collection has a **strict Mongoose schema** with types, enums, `maxlength` and `required`. `strict: true` drops unknown keys rather than persisting them — the document-store equivalent of mass-assignment protection. |
| No foreign keys | References are typed as `Types.ObjectId` with a `ref`, and `populate()` resolves them in one extra query per page, not one per row. Cascade behaviour is explicit in the services that need it. |
| No joins | Reporting uses aggregation pipelines with `$lookup` — bounded by a preceding `$limit`, so the leaderboard resolves at most 25 users, never N. |
| Uniqueness is not automatic | The deduplication guarantee is a **unique compound index**, `{ organizationId, dedupeKey }`. Enforced by the server under concurrency. |
| Transactions need a replica set | Both the compose stack and Atlas run one. `withTransaction` detects an unsupported deployment and warns loudly rather than silently losing atomicity. |

**What a relational store would have done better:** aggregate reporting is more natural
in SQL, and referential integrity would be enforced rather than conventional. Those are
real losses. The trade was made knowingly, and the mitigations above are why it holds.

### Design details worth noting

**Explicit document interfaces, not `InferSchemaType`.** Inference collapses when a
shared options object is passed to the `Schema` constructor, and — more importantly — an
explicit interface is the contract the rest of the codebase programs against. A schema
change that breaks a consumer becomes a type error rather than `undefined` at runtime.

**`_id` is never in the interface.** Mongoose supplies it; declaring it too makes
`bulkWrite` and `insertMany` generics diverge. Every document is serialised through a
`toJSON` transform that renames `_id` → `id` and strips `__v`, so the API contract never
leaks Mongo's internal representation.

**Every index is organization-first.** `{ organizationId, deletedAt, status, createdAt }`
rather than `{ status, createdAt }`. The tenant predicate is present in every query, so
it must be index-leading; `deletedAt` sits second because every read path filters it,
which keeps the soft-delete predicate inside the index rather than as a post-filter.

**Money is `Number` used as an integer.** Whole currency units, `min: 0`. Floating-point
money is a bug that surfaces as a one-cent discrepancy in a report six months later.

**`score` is nullable and that distinction matters.** `null` means "not scored yet"; `0`
means "scored, and it is terrible". Collapsing them would make the unscored backlog
unqueryable and put every new lead at the bottom of a score-sorted list.

**Activities live in their own collection, not embedded.** Embedding looks natural in a
document store and is the wrong call: an active lead accumulates activity indefinitely,
MongoDB caps a document at 16 MB, and every lead read would drag the whole history along.
An unbounded growing array is the classic document-modelling mistake.

**Import errors likewise.** A 500k-row import at a 5% error rate would be a 25k-element
array on one document — unqueryable, unpaginatable, and re-fetched in full every time
the UI polls for progress.

**Refresh tokens expire via a TTL index.** MongoDB deletes them once `expiresAt` passes,
with no application code running. That is strictly better than the scheduled prune job
the SQL version needed: the collection cannot grow unbounded even if the maintenance
worker is down.

**Soft delete on `Lead` only.** Deleting sets `deletedAt` *and* rewrites `dedupeKey` to
`deleted:<id>`, which frees the natural key so the same person can be re-added
immediately. Everything else is hard-deleted or append-only. Universal soft delete means
every query needs a filter and every unique index becomes conditional — a large ongoing
tax for a guarantee only the leads collection needs.

---

## 3. Multi-tenancy and isolation

Shared database, shared collections, `organizationId` on every tenant-owned document.

**Why not database-per-tenant.** MongoDB makes it easy, and it is operationally
miserable at scale: index management runs N times, connection pools fragment (each
database holds its own), and cross-tenant analytics become impossible. Row-level tenancy
is what almost every B2B SaaS actually runs, and the isolation risk is manageable if —
and only if — enforcement is concentrated in one place.

### How the risk is actually managed

Every query is built through `tenantScope()` in
[`lead.repository.ts`](../apps/api/src/modules/leads/lead.repository.ts). No handler
constructs a bare filter. "Did we remember the tenant filter?" has exactly one place to
look, rather than being a review checklist item on every future pull request.

The tenant is passed **explicitly** as a `TenantContext` argument, not read from
AsyncLocalStorage:

```ts
leadRepository.list(ctx, query)   // ctx is required by the type system
```

AsyncLocalStorage *is* used — but only for observability (attaching a request id to log
lines). Authorisation that depends on ambient state is authorisation that eventually
leaks: someone adds a background job, forgets the context is absent, and the query runs
unscoped. Making it a parameter turns that mistake into a compile error.

**Three MongoDB-specific safeguards:**

1. **`strictQuery: 'throw'`.** An unknown field in a filter throws instead of being
   silently dropped. Without it, a typo'd `organisationId` (British spelling) would be
   ignored and the query would return *every tenant's data*. This is the single highest-
   value setting in the whole configuration.

2. **`toObjectId()` on every aggregation `$match`.** `$match` does **not** cast strings
   to `ObjectId` the way `find()` does — a raw string silently matches nothing. Every
   pipeline goes through `leadRepository.aggregate`, which prepends the tenant match with
   the correct type. The failure mode this prevents is subtle: an analytics endpoint that
   returns zeros rather than an error.

3. **Defence in depth on writes.** AI-driven updates filter on `organizationId` in
   addition to `_id`, so even a hallucinated id from another tenant cannot be written to.

---

## 4. Authentication and authorisation

### Token design

| | Access token | Refresh token |
|---|---|---|
| Format | JWT (HS256) | 32 random bytes, base64url |
| Lifetime | 15 minutes | 30 days |
| Storage | Not stored | SHA-256 hash in MongoDB, TTL-indexed |
| Transport | httpOnly cookie + `Authorization` header | httpOnly cookie scoped to `/api/v1/auth` |

The access token carries tenant and role, so the hot path authorises with **zero database
round-trips**. The refresh path does read the database, but that happens once per 15
minutes per session.

**The refresh token is deliberately not a JWT.** An opaque random string cannot be forged
even if a signing secret leaks, and it carries no claims that can go stale.

**Hashed with SHA-256, not bcrypt.** The token already has 256 bits of entropy, so there
is nothing to brute-force; bcrypt would only turn an indexed equality lookup into a slow
one. Passwords are a different problem and use bcrypt at cost 12.

### Rotation and reuse detection

Every refresh mints a new token and revokes the old one, both in a single transaction.
Each token belongs to a `familyId`. **Presenting an already-rotated token revokes the
entire family**, killing every session in that chain — the standard mitigation from
OAuth 2.0 Security BCP §4.13.

This logs out the legitimate user too. That is the correct outcome: when a token has
demonstrably been captured, we cannot tell which party is holding the stolen copy.

The client shares a single in-flight refresh across concurrent 401s
([`api-client.ts`](../apps/web/src/lib/api-client.ts)). Without that, a dashboard firing
six parallel queries would send six refreshes, five of which rotation would correctly
classify as reuse — and the user would be logged out for loading a page.

### The 15-minute revocation window

A stateless access token cannot be revoked. Suspending a user therefore takes effect
within 15 minutes rather than instantly. Where that is not acceptable — suspension,
role downgrade, destructive routes — `requireActiveUser` performs one indexed read to
verify status against the database. Applying that to *every* request would reintroduce a
database round-trip on the hot path and give up the reason for stateless tokens.

### Authorisation

Roles are hierarchical (`OWNER 40 → ADMIN 30 → MEMBER 20 → VIEWER 10`) and guards declare
a *minimum* rank rather than enumerating acceptable roles — a list that drifts the moment
a role is added.

Named capabilities (`LEAD_WRITE`, `MEMBER_MANAGE`, `ORG_MANAGE`) map to minimum ranks in
one table, so route guards read as intent and rule changes happen in one place.

Object-level rules that need the document live next to the resource:

```ts
canMutateLead(ctx, lead.ownerId)   // MEMBER: own or unassigned only
```

Two invariants are enforced explicitly because both are unrecoverable through the UI:
you can never grant a role above your own, and an organization can never drop to zero
active owners.

---

## 5. The import pipeline

The feature the brief is really testing: *"capable of handling real-world datasets"*.

### Two phases, on purpose

```
POST /imports            → parse headers, propose a mapping, write nothing
POST /imports/:id/start  → user confirms; enqueue; 202 Accepted
GET  /imports/:id        → poll progress
```

A one-shot "upload and import" endpoint would be simpler. It would also let someone
import 50,000 customer records under a mapping nobody looked at — which is how CRMs end
up with phone numbers in the job-title column and no undo. **The confirmation step is the
product, not friction.**

### Constraints the worker is built around

**1. Bounded memory.** Rows are consumed from a stream and flushed every
`IMPORT_BATCH_SIZE` (default 500). Peak memory is one batch whether the file has 500 rows
or 5 million. Only the first 64 KB is read for the preview.

**2. Duplicates are the normal case.** People re-upload last month's export with 200 new
rows. Three strategies, each expressed declaratively in the bulk write:

- `SKIP` — upsert with `$setOnInsert` only. Existing documents are matched and left
  completely untouched; only genuinely new keys are inserted.
- `UPDATE` — upsert with `$set` for the fields the file provided. A field the CSV does
  not carry is never blanked out.
- `CREATE_ANYWAY` — uniquified keys, so every row lands as its own document.

**3. Partial failure is expected.** One malformed row must not fail 49,999 good ones.
`ordered: false` lets the server continue past an individual failure; row errors are
recorded individually with the original row, and the job completes as
`COMPLETED_WITH_ERRORS`.

**4. Retries must not duplicate data.** BullMQ can re-deliver after a crash. Because
every write is an **upsert keyed on `(organizationId, dedupeKey)`**, re-running converges
rather than doubling. This was verified: re-importing the same file reports
`created=0, skipped=5`.

### Query economics

Naively, each row needs a lookup and an insert: ~1,000 round-trips per 500-row batch.
Instead each batch is:

1. Deduplicated within the batch in memory (files routinely contain the same person twice)
2. Sent as **one `bulkWrite`** with 500 upsert operations

That is **one round-trip per 500 rows**, and the duplicate strategy is expressed in the
operation itself rather than in application branching.

### A MongoDB trap worth documenting

With `timestamps: true`, Mongoose injects its own `$set: { updatedAt }` and
`$setOnInsert: { createdAt }` into every `bulkWrite` operation. Setting them by hand as
well makes MongoDB reject the **entire batch**:

```
Updating the path 'updatedAt' would create a conflict at 'updatedAt'
```

This failed every import until it was found by running a real file through the real
worker. Nothing in the type system points at it.

### Cancellation

Cooperative, checked at batch boundaries every 500 rows. Killing the worker mid-batch
would leave the progress counters lying about what was actually committed.

### Tolerances

Real exports are messy, so the parser handles: BOM stripping (Excel writes one and it
corrupts the first header), delimiter sniffing (comma / semicolon / tab / pipe —
semicolon is standard in European Excel), ragged rows, duplicate and blank headers, and
a value normaliser covering `$12,500.00`, `€1.234,56`, `(500)`, `1.2k` and `50k`.

That last one is where the test suite earned its keep: it caught `$50,000` parsing as
`50` because the "later separator is the decimal point" heuristic is wrong when only one
separator is present.

---

## 6. Deduplication

One implementation, in [`lead.normalizer.ts`](../apps/api/src/modules/leads/lead.normalizer.ts),
used by both the API and the import worker. Having one is what stops a manually created
lead and an imported lead from silently becoming duplicates of each other.

**Key precedence:** `email` → `phone` → `name + company` → random.

Names and companies are folded before hashing — accents decomposed, punctuation removed,
legal suffixes stripped — so `Acme, Inc.` and `acme inc` collapse together, and
`José Álvarez` matches `Jose Alvarez`.

**A record with no identifying information gets a random key**, meaning it never dedupes.
That is the safe direction to fail: creating a duplicate is recoverable in one click,
merging two unrelated customers is not.

**Uniqueness is never checked before writing.** Two concurrent requests would both pass a
pre-check. Instead the insert is attempted and MongoDB's duplicate-key error (code
`11000`) is translated into a `409` carrying the existing lead's id — race-free by
construction, and the UI turns it into "Open the existing lead" rather than an error.

Merging is non-destructive: the primary wins on every field it already has, duplicates
only fill blanks, tags union, activities move to the survivor (one `updateMany`), and
duplicates are soft-deleted with their keys freed.

---

## 7. The AI layer

### Provider integration

Gemini is called with `fetch` against the REST API — no SDK. The surface needed is one
endpoint; an SDK would add transitive dependency churn to a production image and hide the
three things that actually matter when a third-party service sits on a user-facing path:
timeout, retry classification, and failure detection.

[`gemini.client.ts`](../apps/api/src/modules/ai/gemini.client.ts) provides:

- **Hard timeout** via `AbortController`. A hung LLM call must not hold a request socket
  open indefinitely.
- **Retries only on 429/5xx/network.** Retrying a 400 just burns quota.
- **Full-jitter exponential backoff.** Synchronised retries from many replicas would
  otherwise hammer a recovering provider in lockstep.
- **Circuit breaker.** After five consecutive failures it fails fast for 30 seconds, then
  half-opens with a single probe. Without it, every request during an outage pays the
  full 25-second timeout before falling back.

The breaker is in-process, not in Redis. Each replica learning independently is fine —
the goal is to bound latency, not achieve consensus, and a shared breaker would add a
Redis round-trip to the path we are trying to make fast.

### Structured output, then validated anyway

Every call declares a `responseSchema`, so the model returns typed JSON rather than prose
to be regexed. The result is then re-validated with Zod, because a schema is a strong hint
to the model, not a guarantee. **Model output is untrusted input** and gets the same
treatment as a request body.

### Cost control, in order of application

1. **Input hashing** — `scoreInputHash` means an unchanged lead is never re-scored.
   Editing a note does not trigger a call; changing a job title does.
2. **Redis cache** — identical prompts within the TTL are free.
3. **Per-tenant daily quota** — a runaway loop cannot produce a surprise bill.
4. **Batching** — 20 leads per scoring call, roughly a 15× reduction in per-request
   overhead versus one call per lead.

Scores are written back with a single `bulkWrite`, and every call is recorded in
`aiinteractions` with latency, tokens, cache-hit and degraded flags, so cost is
attributable per feature and per tenant via one `$facet` aggregation.

### Graceful degradation

Every feature has a deterministic fallback in
[`ai.heuristics.ts`](../apps/api/src/modules/ai/ai.heuristics.ts). They are not
placeholders — the rule-based scorer implements the same rubric the prompt describes, and
serves as the baseline the model has to beat to justify its cost.

Results carry `degraded: true` and the UI states plainly that it is showing a fallback.
**Presenting a heuristic as a model output would be the actual failure.**

### Prompt injection

Lead data is customer-controlled text and can contain `ignore previous instructions`. The
containment is threefold: data is wrapped in a delimited `<untrusted_data>` block; the
system instruction states that the block is data and never instructions; and structured
output constrains what the model can emit. Combined, the blast radius of a successful
injection is a wrong lead score.

For natural-language search specifically, **model output never builds a database query
directly**. It is parsed into the same validated filter object `GET /leads` accepts — the
model can only ever produce a query the user could have built by hand in the UI. That is
the entire security argument for the feature, and it is why the feature is safe to ship.

---

## 8. Frontend architecture

Next.js 15 App Router, React 19, TanStack Query, Tailwind.

**Client components, not server components, for the data views.** The dashboard, lead
table and import wizard are interactive, poll for updates, and mutate. Server components
buy little there and would push auth-cookie forwarding and cache invalidation into the
render path. Server rendering is used where it pays: the auth shell and route protection.

**TanStack Query for server state.** `staleTime: 30s`, no refetch on window focus (noise
that burns rate-limit budget on a shared API), and retries only on 5xx — a 400 will not
fix itself.

**No global client-state library.** There is very little client state: filters and
selection are local to the leads page, session and theme are two small contexts. Redux or
Zustand here would be ceremony.

**Charts are hand-drawn SVG.** Four fixed visualisations. A charting library would add
~120 KB and a second styling system to keep in sync with the CSS custom properties. The
SVG inherits `currentColor`, so dark mode works with no extra code — and each chart ships
a screen-reader table, which most chart libraries do not.

**Theming through CSS custom properties**, not Tailwind `dark:` variants. Dark mode is one
block of overrides in `globals.css` instead of a variant on every element. A blocking
inline script applies the stored theme before first paint, avoiding the white flash that
otherwise hits every dark-theme user on every load.

**Accessibility is built in, not retrofitted**: `<dialog>` for modals (focus trapping,
Escape, background inertness for free), `Field` wires up `htmlFor`/`aria-describedby`/
`aria-invalid` so it cannot rot, `aria-sort` on the header cell (not the button inside
it), `aria-live` on toasts, a skip link, visible focus rings, and `prefers-reduced-motion`
respected.

---

## 9. Performance

### Indexes

Indexes are organization-first and cover the actual access patterns — see
[`lead.model.ts`](../apps/api/src/models/lead.model.ts), where each one is annotated with
the query it serves. They are created by an explicit deploy step
([`sync-indexes.ts`](../apps/api/src/scripts/sync-indexes.ts)), never implicitly:
`autoIndex` is disabled precisely so that every replica does not race to build the same
index on deploy.

### Free-text search: a deliberate trade

`$text` was considered and **rejected**:

- `$text` matches whole stemmed words, so typing "north" would not find "Northwind
  Logistics" — a regression against what users expect from a CRM search box.
- MongoDB allows only one text index per collection, and it adds write amplification to
  every insert. This application's heaviest write path is bulk CSV import of hundreds of
  thousands of rows.

Instead search is a case-insensitive regex across four fields, bounded to one tenant's
documents by the compound index — the same cost profile the SQL version had with
`ILIKE '%term%'`. When one tenant outgrows it, the upgrade is Atlas Search, and
`buildLeadFilter` is the only function that changes.

### Query patterns

**Cursor pagination by default.** MongoDB's `skip` walks and discards every preceding
document, exactly like SQL `OFFSET`; keyset pagination on `_id` is O(1) at any depth.
Offset is still available because "jump to page 40" is a real need in a data grid —
capped at 10,000.

**`countDocuments` is only paid for when the client can act on it.** The infinite
scroller does not need a total; offset pagination does. Above 10,000 the count is capped
and reported as approximate.

**Fetch `limit + 1`** to determine `hasMore` without a second query.

**Sort always includes a tiebreaker on `_id`.** Without a total order, cursor pagination
over a non-unique field can skip or repeat documents when ties straddle a page boundary —
a bug that only appears in production data and is miserable to reproduce. `_id` is also
the natural cursor: ObjectIds embed a timestamp and increase monotonically.

**`$facet` for the dashboard.** `leadService.stats` produces six figures — total, status
breakdown, source breakdown, average score, pipeline value, 30-day count, unscored count
— from **one aggregation over one pass** of the tenant's documents, rather than six
independent queries.

**`.lean()` on every read path.** Skips Mongoose document hydration, which is a
significant win on a 100-row page. The cost is that the `toJSON` transform does not run,
so `shapeLead()` does that work explicitly in one place.

### Caching

| Data | TTL | Why |
|---|---|---|
| Lead stats | 60s | Read on every dashboard load; tolerates a minute stale |
| Analytics | 300s | Expensive aggregates, slow-moving |
| AI mapping | 24h | Same headers → same mapping, deterministically |
| AI insights | 24h | Keyed on the lead's content hash |

Cache reads **fail open**: if Redis is down the API serves uncached rather than 500ing.
Losing a cache is an inconvenience; losing availability is an outage.

The cache client runs with `enableOfflineQueue: false` so a Redis outage fails
immediately rather than after a connect timeout — otherwise "degrade gracefully" would
still cost every request several seconds. (That change introduced a real bug: the startup
health check began racing the initial connection. Fixed with an explicit
`waitForRedisReady()` before the boot ping.)

### Streaming

CSV export streams from a keyset cursor with backpressure handling, so 50,000 rows cost
one batch of memory and start downloading immediately. Compression is explicitly disabled
for `text/csv` — buffering to compress would undo the point.

---

## 10. Scaling path

The architecture is built for the first two steps and does not block the third.

**Now (thousands of leads per tenant).** Single API replica, single worker, one replica
set.

**10× (hundreds of thousands).** Scale the API horizontally — it is stateless; sessions
are in MongoDB and rate-limit counters in Redis, so any replica can serve any request.
Scale workers on queue depth. Route analytics reads to a secondary with
`readPreference=secondaryPreferred`.

**100× (millions).** The known bottlenecks and their fixes, in the order they would bite:

| Bottleneck | Fix | Seam already in place |
|---|---|---|
| Regex search past its comfort zone | Atlas Search | `buildLeadFilter()` — one function |
| Analytics competing with OLTP | Materialised collections refreshed on a schedule (`$merge`) | Analytics pipelines are already isolated |
| Single primary write throughput | Shard on `organizationId` | Every index is already organization-first, so the shard key is already the leading field |
| Upload volume | S3 instead of a shared volume | `storageKey` on `ImportJob` |
| AI provider rate limits | Per-tenant queues with fair scheduling | Worker limiter already global |

**Sharding is unusually cheap here** precisely because the tenant field leads every
index — the shard key is already in place, which is the decision that is expensive to
retrofit.

**Uploads on a shared volume are the one thing that must change before a multi-host
deployment.** It is called out here and in the deployment guide rather than left to be
discovered.

---

## 11. Security model

| Layer | Control |
|---|---|
| Transport | HSTS (1 year, preload) in production; secure cookies |
| Headers | Helmet — CSP, `X-Frame-Options: DENY`, `nosniff`, referrer policy |
| CORS | Explicit allow-list. Wildcard is impossible in production, because `credentials: true` makes a permissive origin genuinely dangerous |
| Rate limiting | Redis-backed, so it survives deploys and cannot be multiplied by replica count. Per-user when authenticated, per-IP otherwise. Separate tighter budgets for auth, AI and uploads |
| Input validation | Zod on body, query and params. `.strict()` everywhere — an unknown key is a 400, which is mass-assignment protection for free |
| **NoSQL injection** | Every query parameter is coerced to a primitive by Zod *before* reaching a filter: `z.coerce.number()` for scores, `z.enum` for statuses, a 24-hex-character check for ids. A value arriving as `{"$ne": null}` fails validation with a 400 and never reaches the database. No filter is built from a raw request object |
| Query typos | `strictQuery: 'throw'` — an unknown field in a filter throws rather than being dropped, which is what stops a misspelled tenant field from returning everyone's data |
| XSS | React escapes by default; no `dangerouslySetInnerHTML` on user data. URL normalisation rejects `javascript:` |
| CSRF | httpOnly + `SameSite`, JSON content-type requirement, CORS allow-list |
| Password storage | bcrypt cost 12. Length-based policy per NIST SP 800-63B — composition rules push users toward `Password1!` and measurably *reduce* entropy |
| Credential exposure | `passwordHash` is `select: false` on the schema, so it cannot leave the database by accident; the two call sites that need it opt in explicitly and are greppable |
| User enumeration | Login always runs a bcrypt comparison, even for an unknown email, so both failure paths take the same wall-clock time |
| File upload | Streaming size limit enforced as bytes arrive; extension allow-list; UUID storage keys, so a client filename never touches the filesystem and `../../etc/passwd` is structurally impossible |
| Secrets | Validated at boot; access and refresh secrets must differ; placeholder values rejected in production |
| Logging | Pino redaction on passwords, tokens, cookies and auth headers. Prompts are never logged — only a hash |
| Audit | Append-only trail of every state-changing action with actor, IP and user agent |

### A note on `sanitizeFilter`

Mongoose offers `sanitizeFilter`, which wraps object values in `$eq` to defeat query-
selector injection. It is **deliberately not enabled**: it cannot distinguish a
`{ $gte: 70 }` this codebase constructed from one an attacker smuggled in, so it breaks
every legitimate operator query — `?minScore=70` becomes `{ score: { $eq: { $gte: 70 } } }`
and fails to cast.

Enabling it globally silently broke every filtered query until it was caught by running
the real endpoints. The actual defence — Zod coercion at the edge — is both stronger and
does not have this failure mode.

### Threats explicitly considered

- **Stolen refresh token** → rotation with family revocation.
- **Compromised access token** → 15-minute lifetime; `requireActiveUser` on privileged
  routes for immediate revocation.
- **Cross-tenant access** → single-chokepoint tenant scoping; ids from other
  organizations return 404, not 403, so they leak nothing about existence.
- **NoSQL operator injection** → Zod primitives at the edge; `strictQuery: 'throw'`.
- **Prompt injection** → delimited untrusted-data block, structured output, and filters
  re-validated against the same schema a user's own query uses.
- **Denial of service** → rate limits, upload ceiling, pagination caps, bulk-operation
  caps, AI quotas.
- **Privilege escalation** → cannot grant a role above your own; cannot modify a peer or
  senior; cannot change your own role.

---

## 12. Observability

**Structured JSON logs** (pino) with a `requestId` on every line, propagated through
AsyncLocalStorage so a log emitted three layers deep inside a service is still
attributable to a request. Inbound `x-request-id` is honoured and sanitised — an
unvalidated client-controlled string in a log file is how log injection happens.

**Health endpoints distinguish liveness from readiness**, which is routinely got wrong:

- `/health/live` touches no dependency. If it checked MongoDB, a database blip would make
  the orchestrator kill every healthy pod simultaneously and turn a brief outage into a
  total one.
- `/health/ready` checks MongoDB and Redis — what this instance cannot serve without.
- `/health` is the human roll-up, and reports AI unavailability as `degraded` rather than
  `down`, because every AI feature has a fallback.

**Slow-query surfacing** via Mongoose debug at `trace` level only. Full command logging is
too noisy and logs PII in filter parameters.

**AI usage telemetry** per feature: calls, latency, tokens, cache-hit rate, degradation
rate — surfaced in the app's own settings page via a single `$facet`, not just in logs.

---

## 13. Decisions I would revisit

Being honest about what is a compromise:

**Uploads on a shared volume.** Correct for single-host Docker Compose, wrong the moment
there is more than one host. S3 is the fix; `storageKey` is the seam. This is the first
thing I would change for a real production deployment.

**Regex search.** Correct for the substring behaviour users expect, and bounded by the
tenant index — but it is a scan within the tenant, not an index seek. At a few hundred
thousand leads for a single tenant, Atlas Search becomes the right answer.

**In-process circuit breaker.** Each replica learns independently, so with 10 replicas
the provider sees up to 50 failures before all breakers open. Acceptable — the goal is
bounding latency — but a shared breaker would be strictly better at scale.

**Polling for import progress.** 1.5s polling is correct and trivially scalable, but
MongoDB **change streams** would be a genuinely better fit here and are available on any
replica set. Deliberately deferred; the requirements have no user for it.

**No field-level encryption.** Lead data is PII. MongoDB supports Queryable Encryption,
which would protect it even from a database-level compromise. Out of scope here, but for
a real customer deployment in a regulated market it would not be optional.

**Audit writes are fire-and-forget.** They must never add latency to or fail a user's
action, but that means a database failure loses audit entries. For a regulated
deployment this would become an outbox collection drained by a worker —
`auditService.record` is the only thing that would change.

**Team invitations issue a temporary password.** Magic-link invitations need a
transactional email provider, which is configuration rather than architecture — but the
current flow requires an admin to communicate a password out of band, which is not what I
would ship to real customers.
