# API Reference

Base URL: `/api/v1`
Interactive docs: `/api/v1/docs` · Machine-readable: `/api/v1/openapi.json`

---

## Conventions

### Response envelope

Success:

```json
{ "data": { ... }, "meta": { ... } }
```

Failure:

```json
{
  "error": { "code": "DUPLICATE_LEAD", "message": "A lead with this email already exists", "details": {} },
  "requestId": "9f1c8a2e-…"
}
```

**Branch on `error.code`, never on `error.message`.** Codes are stable and additive;
messages are for humans and may be reworded at any time.

Every response carries an `x-request-id` header. Include it in bug reports — it ties a
client-side failure to the exact server-side log lines.

### Authentication

Two interchangeable transports:

**Cookie** — `POST /auth/login` sets an httpOnly `aarvion_at` cookie. Used by the web app.

**Bearer** — the same response body contains `accessToken`:

```
Authorization: Bearer <accessToken>
```

Access tokens live 15 minutes. On a `401` with code `TOKEN_EXPIRED`, call
`POST /auth/refresh` and retry. Refresh rotates the token; **presenting an
already-rotated refresh token revokes the entire session family** — send at most one
refresh at a time.

### Pagination

Cursor-based by default:

```
GET /leads?limit=25
GET /leads?limit=25&cursor=<meta.nextCursor>
```

```json
{ "data": [...], "meta": { "nextCursor": "507f1f77bcf86cd799439011", "hasMore": true, "limit": 25 } }
```

Offset pagination is available for data grids that need "jump to page N":

```
GET /leads?page=3&limit=25
```

This adds `total` to `meta`. Above 10,000 matches the count is capped and
`totalIsApproximate: true` is returned — past that point the count costs more than
the page itself.

### Rate limits

`RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (draft-7) on every
response. Limits are per user when authenticated, per IP otherwise.

| Scope | Default |
|---|---|
| Global | 300 / minute |
| Auth endpoints | 10 / 15 minutes per IP (successful logins do not count) |
| AI endpoints | 20 / minute, plus a per-organization daily quota |
| Uploads | 30 / hour |

### Identifiers

Every `id` is a 24-character hexadecimal MongoDB ObjectId, e.g.
`507f1f77bcf86cd799439011`. They are validated at the edge: a malformed id returns
`400 VALIDATION_ERROR`, and a well-formed id that does not exist (or belongs to another
tenant) returns `404`.

ObjectIds embed a creation timestamp and increase monotonically, which is why they double
as the pagination cursor.

### Multi-tenancy

Every request is scoped to the organization in your token. There is no way to address
another tenant's data; IDs belonging to another organization return `404`, not `403`, so
they leak nothing about existence.

### Roles

`OWNER` > `ADMIN` > `MEMBER` > `VIEWER`. Endpoints below note the minimum role.
A `MEMBER` may only mutate leads they own or that are unassigned; `ADMIN` and above may
mutate anything in their organization.

---

## Errors

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Request failed schema validation. `details.fields` maps field → messages |
| `BAD_REQUEST` | 400 | Malformed request |
| `INVALID_FILE` | 400 | Upload is not a readable CSV |
| `UNAUTHENTICATED` | 401 | No credentials supplied |
| `INVALID_CREDENTIALS` | 401 | Wrong email or password |
| `TOKEN_EXPIRED` | 401 | Access token expired — refresh and retry |
| `TOKEN_INVALID` | 401 | Token malformed, forged or revoked |
| `FORBIDDEN` | 403 | Authenticated but not permitted |
| `INSUFFICIENT_ROLE` | 403 | Role too low. `details.requiredRoles` lists what is needed |
| `NOT_FOUND` | 404 | Does not exist, or belongs to another tenant |
| `CONFLICT` | 409 | Violates a uniqueness constraint |
| `DUPLICATE_LEAD` | 409 | Matching lead exists. `details.existingLeadId` is included |
| `EMAIL_TAKEN` | 409 | Email already registered |
| `PAYLOAD_TOO_LARGE` | 413 | Upload exceeds `MAX_UPLOAD_BYTES` |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | File type not accepted |
| `RATE_LIMITED` | 429 | Too many requests. Honour `Retry-After` |
| `AI_QUOTA_EXCEEDED` | 429 | Organization's daily AI quota exhausted |
| `INTERNAL_ERROR` | 500 | Unexpected failure — report with the `requestId` |
| `AI_PROVIDER_ERROR` | 502 | LLM provider failed (rarely surfaced; features fall back instead) |
| `SERVICE_UNAVAILABLE` | 503 | A dependency is down. Honour `Retry-After` |

Validation errors carry per-field detail, ready to render next to form inputs:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": { "source": "body", "fields": { "email": ["Enter a valid email"] } }
  },
  "requestId": "…"
}
```

---

## Auth

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/auth/register` | — | Create an organization and its first user (becomes `OWNER`) |
| POST | `/auth/login` | — | Sign in |
| POST | `/auth/refresh` | — | Rotate the refresh token, mint a new access token |
| POST | `/auth/logout` | — | Revoke this session |
| POST | `/auth/logout-all` | any | Revoke every session for this user |
| GET | `/auth/me` | any | Current user and organization |
| PATCH | `/auth/me` | any | Update your display name |
| POST | `/auth/change-password` | any | Change password — **revokes all sessions** |
| GET | `/auth/members` | any | List organization members |
| POST | `/auth/members` | ADMIN | Invite a member with a temporary password |
| PATCH | `/auth/members/:id` | ADMIN | Change a member's role or status |

**Password policy:** at least 10 characters, no composition rules. Per NIST SP 800-63B,
forced character-class rules push users toward `Password1!` and measurably reduce entropy.
Common passwords and low-variety strings are rejected.

**Privilege escalation is blocked at every edge:** you cannot grant a role above your own,
cannot modify a member at or above your own rank, cannot change your own role, and an
organization can never drop to zero active owners.

### Register

```bash
curl -X POST http://localhost:4000/api/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{
    "organizationName": "Acme Corporation",
    "name": "Jane Doe",
    "email": "jane@acme.com",
    "password": "correct horse battery staple"
  }'
```

```json
{
  "data": {
    "user": { "id": "507f1f77bcf86cd799439011", "email": "jane@acme.com", "name": "Jane Doe", "role": "OWNER", "status": "ACTIVE" },
    "organization": { "id": "507f1f77bcf86cd799439011", "name": "Acme Corporation", "slug": "acme-corporation", "plan": "free" },
    "accessToken": "eyJ…",
    "refreshToken": "Xk3…"
  }
}
```

---

## Leads

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/leads` | VIEWER | List and filter |
| POST | `/leads` | MEMBER | Create |
| GET | `/leads/stats` | VIEWER | Pipeline summary (cached 60s) |
| GET | `/leads/export` | VIEWER | Stream matching leads as CSV |
| PATCH | `/leads/bulk` | MEMBER | Update up to 500 at once |
| POST | `/leads/bulk-delete` | MEMBER | Soft-delete up to 500 |
| POST | `/leads/merge` | MEMBER | Merge duplicates into a primary |
| GET | `/leads/:id` | VIEWER | Full record with owner, import source and timeline |
| PATCH | `/leads/:id` | MEMBER | Partial update |
| DELETE | `/leads/:id` | MEMBER | Soft delete (recoverable 30 days) |
| POST | `/leads/:id/restore` | ADMIN | Restore a soft-deleted lead |
| POST | `/leads/:id/activities` | MEMBER | Log a note, call, email or meeting |

### Filtering

| Parameter | Type | Notes |
|---|---|---|
| `q` | string | Free text over name, email, company, job title |
| `status` | csv enum | `NEW,QUALIFIED` |
| `source` | csv enum | |
| `priority` | csv enum | |
| `ownerId` | ObjectId | |
| `unassigned` | boolean | Takes precedence over `ownerId` |
| `tags` | csv | Matches any |
| `minScore` / `maxScore` | 0–100 | |
| `createdAfter` / `createdBefore` | ISO date | |
| `importJobId` | ObjectId | Everything from one import |
| `sortBy` | enum | `createdAt` `updatedAt` `score` `fullName` `company` `estimatedValue` `lastActivityAt` |
| `sortOrder` | `asc`/`desc` | Default `desc` |
| `cursor` / `page` / `limit` | | `limit` max 100 |

```bash
curl -G http://localhost:4000/api/v1/leads \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'status=QUALIFIED,PROPOSAL' \
  --data-urlencode 'minScore=70' \
  --data-urlencode 'sortBy=score' \
  --data-urlencode 'limit=50'
```

### Creating a lead

At least one of `email`, `phone`, `firstName`, `lastName` or `company` is required — a
record with none of those is not a lead.

Unknown fields are **rejected**, not ignored. That is deliberate: it turns a typo'd field
name into an immediate error instead of an update that appears to succeed and changes
nothing, and it prevents mass assignment of server-controlled fields like `score`.

On a duplicate you get a `409` that tells you what to do next:

```json
{
  "error": {
    "code": "DUPLICATE_LEAD",
    "message": "A lead with this email, phone or name/company already exists",
    "details": { "existingLeadId": "507f1f77bcf86cd799439011", "existingLeadName": "Jane Doe" }
  }
}
```

### Updating

`PATCH` distinguishes *absent* from *null*:

- Omit a field → leave it unchanged
- Send `null` → clear it

This is the whole reason the endpoint is `PATCH`. Without the distinction there would be
no way to remove a phone number.

### Merging

```json
{ "primaryId": "507f1f77bcf86cd799439011", "duplicateIds": ["507f1f77bcf86cd799439011", "507f1f77bcf86cd799439011"] }
```

Non-destructive: the primary wins on every field it already has, duplicates only fill
blanks, tags union, activities move to the survivor, and duplicates are soft-deleted.

---

## Imports

Two-phase by design. Nothing is written to `leads` until the user confirms the mapping.

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/imports` | VIEWER | Import history |
| POST | `/imports` | MEMBER | **Phase 1** — upload, get a proposed mapping |
| GET | `/imports/:id` | VIEWER | Status and progress |
| GET | `/imports/:id/errors` | VIEWER | Row-level failures with the original rows |
| POST | `/imports/:id/start` | MEMBER | **Phase 2** — confirm mapping, enqueue |
| POST | `/imports/:id/cancel` | MEMBER | Cancel a queued or running import |

### Phase 1 — upload

```bash
curl -X POST http://localhost:4000/api/v1/imports \
  -H "Authorization: Bearer $TOKEN" \
  -F 'file=@contacts.csv'
```

```json
{
  "data": {
    "importJobId": "507f1f77bcf86cd799439011",
    "filename": "contacts.csv",
    "status": "PENDING",
    "preview": {
      "headers": ["First Name", "Last Name", "Email Address", "Internal Ref"],
      "sampleRows": [{ "First Name": "Jane", "Last Name": "Doe", "Email Address": "jane@acme.com" }],
      "estimatedRows": 12480,
      "delimiter": ","
    },
    "mapping": {
      "suggestions": [
        { "csvColumn": "First Name",    "leadField": "firstName", "confidence": 0.97, "reason": "Header matches \"firstName\"" },
        { "csvColumn": "Email Address", "leadField": "email",     "confidence": 0.97, "reason": "Header matches \"email\"" },
        { "csvColumn": "Internal Ref",  "leadField": null,        "confidence": 0,    "reason": "No confident match" }
      ],
      "degraded": false
    }
  }
}
```

Accepts `.csv`, `.tsv` and `.txt` up to `MAX_UPLOAD_BYTES` (default 50 MB). Comma,
semicolon, tab and pipe delimiters are detected automatically. Only the first 64 KB is
read for the preview.

### Phase 2 — confirm and run

```bash
curl -X POST http://localhost:4000/api/v1/imports/507f1f77bcf86cd799439011 \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "columnMapping": {
      "First Name": "firstName",
      "Last Name": "lastName",
      "Email Address": "email",
      "Internal Ref": null
    },
    "duplicateStrategy": "SKIP",
    "defaultSource": "CSV_IMPORT",
    "autoScore": true,
    "keepUnmappedAsCustomFields": true
  }'
```

Returns `202 Accepted`. Poll `GET /imports/:id`.

| Option | Values | Notes |
|---|---|---|
| `duplicateStrategy` | `SKIP` · `UPDATE` · `CREATE_ANYWAY` | `UPDATE` fills only fields the file provides; it never blanks out data the CSV does not carry |
| `defaultSource` | `LeadSource` | Applied to rows with no source column |
| `defaultOwnerId` | ObjectId or null | Assign every imported lead |
| `keepUnmappedAsCustomFields` | boolean | Default `true`, so no column is silently discarded |
| `autoScore` | boolean | Queue AI scoring for created leads, in the background |

**Validation rejects mappings that would corrupt data**: unknown target fields, columns not
present in the file, two columns mapped to the same field, and mappings with no
identifying column at all.

### Progress

```json
{
  "data": {
    "id": "507f1f77bcf86cd799439011",
    "status": "PROCESSING",
    "totalRows": 12480,
    "processedRows": 6500,
    "createdCount": 6102,
    "updatedCount": 0,
    "skippedCount": 380,
    "errorCount": 18,
    "progress": 52
  }
}
```

Terminal statuses: `COMPLETED`, `COMPLETED_WITH_ERRORS`, `FAILED`, `CANCELLED`. Stop
polling once one is reached.

Row errors keep the original row so the user can fix and re-upload only the failures:

```json
{
  "data": [
    {
      "rowNumber": 47,
      "field": "email",
      "message": "\"jane@\" is not a valid email address",
      "rawRow": { "First Name": "Jane", "Email Address": "jane@" }
    }
  ],
  "meta": { "total": 18, "limit": 100, "offset": 0 }
}
```

---

## AI

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/ai/status` | any | Whether AI is configured and available, plus quota used today |
| GET | `/ai/usage` | VIEWER | Calls, latency, tokens and degradation rate over 30 days |
| POST | `/ai/score` | MEMBER | Score leads 0–100 |
| POST | `/ai/search` | VIEWER | Natural-language lead search |
| GET | `/ai/leads/:id/insights` | MEMBER | Pre-call briefing |

**Every AI response carries provenance in `meta`:**

```json
{ "degraded": false, "degradedReason": null, "cached": false }
```

`degraded: true` means the result came from the deterministic fallback rather than the
model — no key configured, provider outage, or circuit breaker open. **AI failures never
fail the request**; they change the source of the answer, and say so.

### Scoring

```bash
curl -X POST http://localhost:4000/api/v1/ai/score \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"limit": 50}'
```

With no `leadIds`, scores the oldest unscored leads. Leads whose scoring inputs are
unchanged are skipped, so calling this repeatedly is cheap and idempotent. Pass
`force: true` to re-score regardless.

```json
{
  "data": {
    "scored": [
      {
        "id": "507f1f77bcf86cd799439011",
        "score": 87,
        "rationale": "VP-level title at an identified 500-person software company, business email domain, inbound demo request.",
        "nextAction": "Call today — reference their Q3 platform migration.",
        "priority": "URGENT",
        "summary": "Jane Doe — VP of Engineering at Acme Corporation."
      }
    ]
  },
  "meta": { "degraded": false, "cached": false }
}
```

Scores are persisted to the leads, so `GET /leads?minScore=70` works immediately after.

### Natural-language search

```bash
curl -X POST http://localhost:4000/api/v1/ai/search \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"query": "hot fintech leads from last month with no owner"}'
```

```json
{
  "data": [ /* leads */ ],
  "meta": {
    "interpretation": "Showing unassigned leads scoring 70+ matching \"fintech\", created since 2026-07-06.",
    "appliedFilters": { "minScore": 70, "unassigned": true, "q": "fintech", "createdAfter": "2026-07-06" },
    "degraded": false
  }
}
```

The model's output is **never** used to build SQL. It is parsed into the same validated
filter object `GET /leads` accepts, so it can only produce a query you could have built by
hand. `appliedFilters` is echoed back so the UI can show — and let the user correct —
exactly what was searched. Filters that fail validation are dropped and
`filtersRejected: true` is set.

### Insights

```json
{
  "data": {
    "summary": "Jane Doe is VP of Engineering at Acme Corporation, a 500-person software company…",
    "talkingPoints": ["Reference their Q3 platform migration", "Lead with the SOC 2 story"],
    "risks": ["No budget authority confirmed", "Evaluating two competitors"],
    "suggestedNextAction": "Book a 30-minute technical deep-dive with their security lead.",
    "recommendedChannel": "CALL",
    "draftOpener": "Hi Jane, I noticed Acme is scaling its platform team…"
  },
  "meta": { "degraded": false, "cached": true }
}
```

Cached for 24 hours against the lead's content hash — editing the lead invalidates it.

---

## Analytics

| Method | Path | Description |
|---|---|---|
| GET | `/analytics/timeseries?days=30` | Daily lead volume, zero-filled across the window |
| GET | `/analytics/funnel` | Stage counts and value with stage-to-stage conversion |
| GET | `/analytics/score-distribution` | Score histogram in ten buckets |
| GET | `/analytics/by-owner` | Per-rep totals, win rate and average score |
| GET | `/analytics/segments` | Top tags and industries |

All require `VIEWER` and are cached per organization for 5 minutes (`x-cache: HIT|MISS`).

The time series is zero-filled with `generate_series`, so days with no leads return `0`
rather than being absent — a chart with missing days silently misleads by compressing the
x-axis.

---

## Health

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health/live` | — | Liveness. Touches no dependency |
| GET | `/health/ready` | — | Readiness. Checks MongoDB and Redis. `503` when not ready |
| GET | `/health` | — | Full roll-up including AI status and queue depth |

`/health` reports `degraded` rather than `down` when AI is unavailable, because every AI
feature has a working fallback — alerting on it as an outage would be a false page.

```json
{
  "status": "ok",
  "version": "1.0.0",
  "environment": "production",
  "uptimeSeconds": 84213,
  "checks": {
    "database": { "status": "ok", "latencyMs": 2 },
    "redis": { "status": "ok", "latencyMs": 1 },
    "ai": { "status": "ok" }
  },
  "queues": { "import": { "waiting": 0, "active": 1, "failed": 0 } }
}
```
