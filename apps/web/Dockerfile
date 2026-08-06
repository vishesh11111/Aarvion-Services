# =============================================================================
# Aarvion CRM web — production image
#
# Uses Next.js `output: 'standalone'`, which traces the exact module graph the
# server needs and emits a self-contained bundle. Copying full node_modules
# instead would produce a ~1.2 GB image; this one is ~180 MB.
#
# Built from the repository root:
#   docker build -f apps/web/Dockerfile -t aarvion-web .
# =============================================================================

# --- Stage 1: dependencies ---------------------------------------------------
FROM node:22-alpine AS deps

WORKDIR /repo
RUN apk add --no-cache libc6-compat

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

RUN npm ci --workspace @aarvion/web --include-workspace-root


# --- Stage 2: build ----------------------------------------------------------
FROM deps AS build

WORKDIR /repo
COPY apps/web ./apps/web

# Telemetry off in CI/CD: it is a network call on every build for no benefit.
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

RUN npm run build --workspace @aarvion/web


# --- Stage 3: runtime --------------------------------------------------------
FROM node:22-alpine AS runtime

WORKDIR /app

RUN apk add --no-cache curl tini

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# The standalone output already contains a minimal node_modules and its own
# server.js. `public` and `.next/static` are served by it but not traced into it.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/login || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
# Standalone preserves the workspace layout, so the server entry point sits at
# the workspace path rather than the root.
CMD ["node", "apps/web/server.js"]
