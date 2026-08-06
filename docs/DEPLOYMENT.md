# Deployment

How to run Aarvion CRM in production, what to configure, and what to watch.

---

## Contents

1. [Deployment topology](#1-deployment-topology)
2. [Environment configuration](#2-environment-configuration)
3. [MongoDB setup](#3-mongodb-setup)
4. [Indexes — the deploy step that replaces migrations](#4-indexes--the-deploy-step-that-replaces-migrations)
5. [Deploying with Docker Compose](#5-deploying-with-docker-compose)
6. [Deploying to a managed platform](#6-deploying-to-a-managed-platform)
7. [Kubernetes](#7-kubernetes)
8. [Scaling](#8-scaling)
9. [Monitoring and health](#9-monitoring-and-health)
10. [Backups and recovery](#10-backups-and-recovery)
11. [Zero-downtime deploys](#11-zero-downtime-deploys)
12. [Production checklist](#12-production-checklist)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Deployment topology

Three application containers and two stateful services.

| Component | Image | Scaling signal | Public? |
|---|---|---|---|
| `web` | `apps/web/Dockerfile` | Page views | Yes |
| `api` | `apps/api/Dockerfile` | Request rate | Optional — see below |
| `worker` | Same image, `node dist/worker.js` | Queue depth | No |
| MongoDB | Atlas, or `mongo:7` replica set | — | No |
| `redis` | `redis:7-alpine` | — | No |

**The API does not need public ingress.** The browser talks only to the web app, which
proxies to the API over the internal network. Exposing the API publicly is optional and
only useful for third-party API clients or a public Swagger UI. If you do expose it, put
it behind the same TLS termination and set `CORS_ORIGINS` accordingly.

**The worker is not optional.** Without it, uploads are accepted and queued but never
processed, and AI enrichment never runs. It is the same image with a different command.

---

## 2. Environment configuration

Every variable is documented in [`.env.example`](../.env.example) and validated at boot by
[`config/env.ts`](../apps/api/src/config/env.ts). **The API refuses to start on an invalid
configuration** and prints exactly which variable is wrong.

### Generating secrets

```bash
openssl rand -base64 48   # JWT_ACCESS_SECRET
openssl rand -base64 48   # JWT_REFRESH_SECRET  (must be different)
```

The API rejects identical access and refresh secrets, and rejects the `.env.example`
placeholder values when `NODE_ENV=production`.

### Production values that differ from development

| Variable | Production | Why |
|---|---|---|
| `NODE_ENV` | `production` | Enables HSTS, disables stack traces in responses |
| `LOG_LEVEL` | `info` | `debug` in production is expensive and noisy |
| `COOKIE_SECURE` | `true` | Cookies only over HTTPS |
| `COOKIE_SAMESITE` | `lax` | Keep `lax` — with the BFF proxy, cookies are first-party, so `none` is unnecessary and weaker |
| `CORS_ORIGINS` | Your exact web origin | Never `*`. With `credentials: true` a permissive origin is genuinely dangerous |
| `MONGODB_URI` | Atlas SRV string with the database name | See below |
| `MONGO_POOL_SIZE` | Sized against the cluster limit | See below |
| `API_INTERNAL_URL` | Internal DNS name | e.g. `http://api:4000` |

---

## 3. MongoDB setup

### The connection string

```
mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/aarvion_crm?retryWrites=true&w=majority
```

Two things go wrong here more often than everything else combined.

**1. Unencoded characters in the password.** Characters reserved in a URI must be
percent-encoded, or the driver misreads where the credentials end and reports a DNS or
authentication error that says nothing about the real cause:

| Character | Encoded |
|---|---|
| `@` | `%40` |
| `/` | `%2F` |
| `:` | `%3A` |
| `?` | `%3F` |
| `#` | `%23` |

A password of `Aa@89824249` becomes `Aa%4089824249`. Generate it reliably:

```bash
node -e "console.log(encodeURIComponent('your-password'))"
```

The API detects an unencoded `@` at boot and prints this table rather than letting the
driver fail with something unrelated.

**2. A missing database name.** Without `/aarvion_crm` in the path the driver silently
connects to a database called `test`, and everything appears to work until someone
wonders where the data went.

### Atlas checklist

- **Network access.** Add your deployment's egress IPs to the allow-list, or use VPC
  peering / private endpoints. A missing entry produces a *server selection timeout*, not
  an auth error — that distinction is the fastest way to tell the two problems apart.
- **Database user.** Needs `readWrite` on the application database. The user is
  authenticated against `admin` by default.
- **Tier.** Any tier is a replica set, so transactions work. Shared tiers (M0/M2/M5) have
  low connection limits — see the pool arithmetic below.

### Transactions require a replica set

The application uses multi-document transactions for registration, lead creation, updates
and merges. MongoDB only supports them on a replica set or sharded cluster.

- **Atlas** — always a replica set. Nothing to do.
- **Self-hosted / local** — a bare `mongod` will not work. Both compose files run a
  **single-node replica set** for exactly this reason. If you run MongoDB yourself, start
  it with `--replSet rs0` and run `rs.initiate()` once.

If transactions are unavailable, `withTransaction` detects it, logs a prominent warning,
and falls back to running the operations without a session. That is a development
affordance, not something to run in production — it silently gives up atomicity.

### Connection pool sizing

```
MONGO_POOL_SIZE=20
```

This is **per process**, so the total is:

```
(api replicas × MONGO_POOL_SIZE) + (worker replicas × MONGO_POOL_SIZE)
  ≤ cluster connection limit − headroom for admin tools and backups
```

Atlas shared tiers are far lower than people expect (M0 allows 500 total, M2/M5 also
500). With 3 API replicas at 20 and 2 workers at 10, you are using 80 — comfortable.
Exceeding the limit produces intermittent failures only at peak load, which is one of the
least obvious production problems to diagnose.

---

## 4. Indexes — the deploy step that replaces migrations

MongoDB is schemaless, so there is no DDL to version. What *does* need deliberate
management is indexes: they decide whether a query takes 2ms or scans a collection, and
building one on a large collection is a real operation with a real cost.

`autoIndex` is **disabled** on the connection precisely so this never happens implicitly.
Mongoose's default of building indexes on every process start is fine on a laptop and
actively dangerous in production: every replica racing to build the same index on deploy.

Run index synchronisation as an explicit deploy step, exactly like `migrate deploy`:

```bash
# Development
npm run db:indexes

# Production / inside the container (compiled)
docker compose exec api npm run db:indexes:prod
```

[`sync-indexes.ts`](../apps/api/src/scripts/sync-indexes.ts) is declarative: it creates
what is missing and drops indexes the schema no longer declares, so the database
converges on what the code says. It logs any index it drops — an unexpected drop means
someone removed a declaration.

### On a large existing collection

Index builds on MongoDB 4.2+ do not block reads or writes, which is why this is safe to
run against a live cluster. It still consumes I/O, so prefer a quiet window when the
collection is large. Atlas can also build indexes with a rolling process across replica
set members — use that for anything above a few million documents.

The schema and every index live in [`src/models/`](../apps/api/src/models/), annotated
with the query each one serves.

### Seeding

`npm run db:seed` is for development and demos. It **deletes all leads for the seeded
organization** before inserting. Never point it at production.

---

## 5. Deploying with Docker Compose

Suitable for a single host, a demo deployment or a small production install.

```bash
git clone <repository-url> && cd aarvion-crm

cp .env.example .env
# Set: NODE_ENV=production, both JWT secrets, MONGODB_URI (Atlas or local),
#      COOKIE_SECURE=true, CORS_ORIGINS=https://your-domain,
#      NEXT_PUBLIC_APP_URL=https://your-domain, GEMINI_API_KEY (optional)

docker compose up -d --build
docker compose exec api npm run db:indexes:prod
```

The compose stack includes a local MongoDB single-node replica set. To use Atlas instead,
set `MONGODB_URI` in `.env` — the `mongo` service simply goes unused, and you can remove
it from the file.

Put a TLS-terminating reverse proxy in front of the web container. Caddy is the shortest
path to a correct configuration:

```caddyfile
crm.example.com {
    reverse_proxy localhost:3000
}
```

Then remove the `api` port publication from `docker-compose.yml` so only the web app is
reachable from outside.

### Verifying the deployment

```bash
curl -fsS https://crm.example.com/api/v1/health | jq
docker compose ps            # all services healthy
docker compose logs -f api worker
```

---

## 6. Deploying to a managed platform

The images are plain containers with no platform-specific assumptions, so any container
host works.

### Railway / Render / Fly.io

1. Provision MongoDB Atlas and a managed Redis; note their connection strings.
2. Create three services from this repository:

   | Service | Dockerfile | Command | Port |
   |---|---|---|---|
   | api | `apps/api/Dockerfile` | default | 4000 |
   | worker | `apps/api/Dockerfile` | `node dist/worker.js` | — |
   | web | `apps/web/Dockerfile` | default | 3000 |

3. Set environment variables per [section 2](#2-environment-configuration). Point
   `API_INTERNAL_URL` at the platform's internal hostname for the API service.
4. Run `npm run db:indexes:prod` once — as a release command, a job, or via a shell into
   the API container.
5. Add the platform's egress IPs to the Atlas network allow-list.
6. Expose only the web service publicly.

**Uploads need a persistent volume shared between the API and the worker**, mounted at
`UPLOAD_DIR` on both. If the platform cannot share a volume between services, switch to
object storage first — see [section 8](#8-scaling).

### Vercel for the frontend

The web app deploys to Vercel unchanged. Set `API_INTERNAL_URL` to the publicly reachable
API URL and add that origin to `CORS_ORIGINS`. Note that the API is then public, so keep
its rate limits tight.

---

## 7. Kubernetes

No manifests are included — they would be guesses about your cluster — but the images are
built for it:

- **Liveness** → `/api/v1/health/live` (no dependencies; a database blip must not kill
  healthy pods).
- **Readiness** → `/api/v1/health/ready` (checks MongoDB and Redis).
- **`SIGTERM` is handled**: the server stops accepting connections, drains in-flight
  requests, then closes the pools. `terminationGracePeriodSeconds: 30` for the API.
- **The worker needs longer**: it finishes the active job rather than abandoning it. Use
  `terminationGracePeriodSeconds: 90`.
- **`tini` is PID 1**, so signals are forwarded and zombies reaped.
- **Containers run as non-root** (`node`) and need no elevated capabilities.
- Run `db:indexes:prod` as an init container or a `Job` before rolling out.
- Scale workers with a KEDA `ScaledObject` on Redis list length, not on CPU — a worker
  waiting on a slow LLM call uses almost none.

---

## 8. Scaling

### Horizontal scaling

**API** — stateless. Sessions are in MongoDB, rate-limit counters in Redis, so any
replica can serve any request. Scale on request rate or p95 latency.

**Worker** — scale on queue depth. Set `IMPORT_WORKER_CONCURRENCY` per process (default
4). Prefer more processes over higher concurrency: a single process saturating its
connection pool starves itself.

**Web** — stateless. Scale on page views.

Remember that every new replica consumes `MONGO_POOL_SIZE` connections — recheck the
arithmetic in [section 3](#3-mongodb-setup) before scaling out.

### The one thing that must change first

**Uploads are written to a shared filesystem volume.** The API writes the file, the worker
reads it. On a single host with Docker Compose this is correct and simple. **On more than
one host it breaks**, because the worker may land on a different machine from the API that
accepted the upload.

The fix is object storage. The seam is `storageKey` on `ImportJob`:

- `singleFileUpload` ([`upload.ts`](../apps/api/src/middleware/upload.ts)) streams to S3
  instead of disk.
- `previewCsv` and `streamCsv`
  ([`csv.parser.ts`](../apps/api/src/modules/imports/csv.parser.ts)) read a stream from S3
  instead of `fs`.

Two functions. Do this before the second host, not after.

### MongoDB scaling, in the order it will bite

1. **Read preference for analytics.** Route the aggregation endpoints to a secondary with
   `readPreference=secondaryPreferred`. They are already isolated in
   `analytics.routes.ts`.
2. **Materialised collections.** When the funnel and time-series aggregations start
   competing with OLTP traffic, precompute them on a schedule with `$merge`.
3. **Shard on `organizationId`** when a single primary becomes the write bottleneck.
   Unusually cheap here: every index is already organization-first, so the shard key is
   already the leading field — the decision that is otherwise expensive to retrofit.
4. **Atlas Search** when regex search stops keeping up for a large single tenant.
   `buildLeadFilter()` is the only function that changes.

### Redis

Configured with `appendonly yes` so queued jobs survive a restart — losing an in-flight
import because Redis restarted is data loss from the user's point of view.

`maxmemory-policy` is `noeviction`, deliberately. With an eviction policy Redis would
silently discard queued jobs under memory pressure. Better to fail loudly than to lose
work. Size Redis for the queue, not just the cache.

---

## 9. Monitoring and health

### Endpoints

| Endpoint | Purpose | Status codes |
|---|---|---|
| `/api/v1/health/live` | Liveness. No dependencies. | 200 |
| `/api/v1/health/ready` | Readiness. MongoDB + Redis. | 200 / 503 |
| `/api/v1/health` | Full roll-up including AI and queue depth. | 200 / 503 |

`/health` reports `degraded` — not `down` — when AI is unavailable, because every AI
feature has a working fallback. Alerting on that as an outage would be a false page.

### What to alert on

| Signal | Threshold | Meaning |
|---|---|---|
| `/health/ready` failing | 2 consecutive | Instance cannot serve; pull from the load balancer |
| API p95 latency | > 1s for 5 min | Investigate slow queries |
| 5xx rate | > 1% for 5 min | Real breakage |
| Import queue depth | > 100 waiting | Workers under-provisioned |
| Import failure rate | > 5% | Likely a parser or mapping regression |
| `aiinteractions.degraded` rate | > 20% over 1h | Provider trouble; users are seeing fallbacks |
| Atlas connections | > 80% of limit | Pool sizing is wrong |
| Atlas COLLSCAN count | Rising | An index is missing or was dropped |
| Redis memory | > 80% | Queue backlog or cache growth |

Atlas Performance Advisor is worth checking after any query change — it surfaces
collection scans and suggests indexes, which is the fastest way to catch a filter that
stopped using its index.

### Logs

Structured JSON with a `requestId` on every line. Ship to your aggregator and index on
`requestId`, `organizationId`, `userId` and `component`.

Useful queries:

```
level:error                          # anything genuinely broken
component:import-worker              # ingestion issues
msg:"refresh token reuse detected"   # possible session theft — investigate
msg:"circuit breaker opened"         # AI provider outage
msg:"rate-limit store unavailable"   # Redis trouble; limits are failing open
```

Passwords, tokens, cookies and auth headers are redacted by pino. Prompts are never
logged — only a hash — because they contain customer PII.

---

## 10. Backups and recovery

### What must be backed up

| Store | Backup? | Rationale |
|---|---|---|
| MongoDB | **Yes** | The only source of truth |
| Redis | No | Cache is disposable; queued jobs are recoverable by re-uploading |
| Uploads | Optional | Deleted 24h after processing; the leads are already in MongoDB |

### MongoDB

On Atlas, enable **continuous cloud backup** with point-in-time restore. It is a
checkbox, and it is the single highest-value operational setting available.

Self-hosted:

```bash
# Nightly logical backup
mongodump --uri="$MONGODB_URI" --gzip --archive="backup-$(date +%F).gz"

# Restore
mongorestore --uri="$MONGODB_URI" --gzip --archive="backup-2026-08-06.gz" --drop
```

**Test a restore.** A backup that has never been restored is not a backup. Restore into a
scratch database quarterly and check the document counts.

### Application-level recovery

Deleted leads are recoverable for 30 days (`deletedAt`), then purged by the maintenance
worker. Restoring one is `POST /leads/{id}/restore` — no database access required, which
means support can do it without an engineer.

---

## 11. Zero-downtime deploys

The pieces are in place; the sequence matters.

1. **Schema changes must be backwards compatible with the running code**, because old and
   new versions overlap during a rolling deploy. MongoDB makes this easier than SQL —
   adding a field needs no migration at all — but the discipline is the same: add a field
   and deploy code that tolerates its absence, backfill, then deploy code that requires
   it. Never remove a field in the same release that stops writing it.

2. **Run `db:indexes:prod` before rolling out** the new image. Adding an index is safe
   with old code running; removing one is not, so a deploy that drops an index should be
   separated from the one that stops using it.

3. **Roll the API** with a readiness gate. `SIGTERM` triggers a graceful shutdown that
   drains in-flight requests, so no user sees a 502.

4. **Roll workers last.** They finish the active job before exiting; allow at least 60
   seconds of grace so a mid-flight import batch completes rather than being re-delivered.

5. **`keepAliveTimeout` is 65s**, above the typical 60s proxy idle timeout. The reverse
   ordering causes intermittent 502s that are very hard to trace.

---

## 12. Production checklist

Before the first real user:

**Security**
- [ ] `NODE_ENV=production`
- [ ] `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` are freshly generated and different
- [ ] `COOKIE_SECURE=true` and TLS terminates in front of the app
- [ ] `CORS_ORIGINS` lists exact origins — never `*`
- [ ] Atlas network allow-list contains only your deployment's egress IPs
- [ ] Atlas database user has `readWrite` on the application database only
- [ ] MongoDB and Redis are not reachable from the public internet
- [ ] Default seed credentials removed or the seeded organization deleted
- [ ] Rate limits reviewed for expected traffic

**Data**
- [ ] `db:indexes:prod` run successfully
- [ ] Unique index on `{ organizationId, dedupeKey }` confirmed present
- [ ] Continuous backup with point-in-time restore enabled, and a restore tested
- [ ] `MONGO_POOL_SIZE` sized against the cluster's connection limit
- [ ] Deployment is a replica set (so transactions work) — check the boot logs for the
      "does not support transactions" warning

**Operations**
- [ ] Worker container running (uploads do nothing without it)
- [ ] Health checks wired to the load balancer / orchestrator
- [ ] Logs shipping to an aggregator
- [ ] Alerts configured per [section 9](#9-monitoring-and-health)
- [ ] Graceful-shutdown grace periods set (API 30s, worker 90s)

**AI**
- [ ] `GEMINI_API_KEY` set, or the team accepts fallback-only operation
- [ ] `AI_DAILY_REQUEST_LIMIT` set deliberately
- [ ] Provider billing alerts configured on the Google side

---

## 13. Troubleshooting

**"It connects from Compass / mongosh but not from the app."**
Almost always one of three things, in order of likelihood:

1. **The URI is in `.env.example` rather than `.env`.** `.env.example` is a committed
   template that the application never reads. The app is still using whatever `.env`
   says. Fix: put it in `.env` (which is gitignored), and scrub the credential out of
   `.env.example` — anything committed there is public the moment you push.
2. **The container cannot resolve the SRV record.** `mongodb+srv://` needs SRV *and* TXT
   DNS lookups, not a plain hostname lookup. Test from inside the container:
   ```bash
   docker compose exec api node -e "require('node:dns/promises')
     .resolveSrv('_mongodb._tcp.cluster0.xxxxx.mongodb.net')
     .then(r => console.log('OK', r.length)).catch(e => console.log('FAILED', e.message))"
   ```
   If SRV fails, use the non-SRV seed-list form instead (`mongodb://host1,host2,host3/...`),
   which Atlas shows under "Connect → Drivers → older driver version".
   *Note that a failing plain `A`-record lookup for the cluster hostname is normal and
   harmless — the driver only uses SRV/TXT and then dials the shard hostnames.*
3. **The deployment's egress IP is not on the Atlas allow-list.** This produces a
   *server selection timeout*, never an auth error.

**`bad auth : authentication failed`.**
The username or password is wrong — the driver reached Atlas and was rejected. Check the
database user exists and the password matches. If the password contains `@`, `/`, `:`,
`?` or `#`, it must be percent-encoded; see [section 3](#3-mongodb-setup). Note that a
*network* problem produces a server-selection timeout instead, so this error specifically
means credentials.

**`MongoServerSelectionError` / connection timeout.**
Usually the Atlas network allow-list. Add your deployment's egress IPs. Also check the
cluster is not paused (Atlas pauses idle free clusters).

**The API exits immediately on start.**
It validated its configuration and refused to run. The log names the exact variable. Most
often: a missing `MONGODB_URI`, a secret under 32 characters, identical access and refresh
secrets, or an unencoded password.

**Warning: "this MongoDB deployment does not support transactions".**
You are connected to a standalone `mongod`, not a replica set. Multi-document operations
are running without atomicity. Fix by starting MongoDB with `--replSet rs0` and running
`rs.initiate()`, or by using Atlas.

**`/health/ready` returns 503.**
MongoDB or Redis is unreachable. The response body names which, with per-dependency
latency.

**Uploads are accepted but nothing imports.**
The worker is not running, or it cannot see the uploaded file. Check
`docker compose logs worker` and confirm both containers mount the same `UPLOAD_DIR`
volume. On multiple hosts, this is the shared-volume limitation — see
[section 8](#8-scaling).

**An import fails immediately with a path-conflict error.**
`Updating the path 'updatedAt' would create a conflict` means a `bulkWrite` is setting a
timestamp that Mongoose also manages. Let `timestamps: true` own `createdAt`/`updatedAt`
and never set them by hand in an update document.

**Filtered queries return 404 or empty results unexpectedly.**
Check that `sanitizeFilter` has not been re-enabled — it wraps legitimate operators like
`{ $gte: 70 }` in `$eq` and breaks every range query. See the note in
[`lib/db.ts`](../apps/api/src/lib/db.ts).

**Everyone is logged out at once.**
Either the JWT secrets changed (all tokens invalidated — expected) or refresh-token reuse
was detected on a shared account. Search logs for `refresh token reuse detected`.

**AI features return `degraded: true` even though a key is set.**
Run the preflight — it walks every layer and reports exactly where it stops:

```bash
docker compose exec api npm run ai:check:prod
```

The four causes, in the order they actually occur:

1. **The key is in `.env.example`, not `.env`.** The template is never read. (It is also
   committed, so a key there is a leak.)
2. **The container predates the key.** Environment variables are fixed when a container
   starts; editing `.env` afterwards has no effect until
   `docker compose up -d --force-recreate api worker`.
3. **The model has no quota on your tier.** A key can authenticate and list models
   perfectly and still return `HTTP 429 … limit: 0` for a specific model — that is a
   *zero* allocation, not a rate limit that clears. `ai:check` prints the models the key
   can actually use; set `GEMINI_MODEL` to one of them.
4. **The circuit breaker is open** after repeated provider failures. `GET /ai/status`
   shows `enabled: true, available: false`; search logs for `circuit breaker opened`.

**AI returns "spent its entire output budget on reasoning".**
Gemini 2.5+ models reason before answering and bill those tokens as output, consuming
`maxOutputTokens` before any answer text exists — so a low cap yields
`finishReason: STOP` with empty text and no error. The client sets
`thinkingConfig.thinkingBudget: 0` by default, which is correct for scoring and mapping
(classification against a fixed rubric) and measured 4.4× cheaper. Raise it only for
genuinely open-ended generation, and raise `maxOutputTokens` with it.

**Queries are slow on a large tenant.**
Run Atlas Performance Advisor, or `.explain('executionStats')` on the query. A
`COLLSCAN` where you expect an `IXSCAN` means an index is missing or the filter no longer
matches its prefix. Confirm `db:indexes:prod` has been run against this cluster.
