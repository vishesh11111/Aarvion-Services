# =============================================================================
# Aarvion CRM API — production image
#
# Multi-stage build. The runtime stage contains compiled JavaScript and
# production dependencies only — no TypeScript, no source, no dev toolchain.
#
# Built from the repository root:
#   docker build -f apps/api/Dockerfile -t aarvion-api .
# =============================================================================

# --- Stage 1: dependencies ---------------------------------------------------
# Isolated so a change to source code does not invalidate the (slow) dependency
# install layer. Only a lockfile change does.
FROM node:22-alpine AS deps

WORKDIR /repo

# Copy only manifests first — this is the layer-caching win.
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

# `npm ci` is deterministic and fails on a lockfile mismatch, which is exactly
# what a production build should do. The web workspace is not needed here.
RUN npm ci --workspace @aarvion/api --include-workspace-root


# --- Stage 2: build ----------------------------------------------------------
FROM deps AS build

WORKDIR /repo
COPY apps/api ./apps/api

RUN npm run build --workspace @aarvion/api


# --- Stage 3: production dependencies ---------------------------------------
# A clean install with devDependencies omitted. Pruning the build stage's
# node_modules in place leaves behind stale nested dev packages.
FROM node:22-alpine AS prod-deps

WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

RUN npm ci --omit=dev --workspace @aarvion/api --include-workspace-root \
 && npm cache clean --force \
    # npm workspaces hoist dependencies to the root node_modules, so a
    # workspace-local node_modules only exists when a version conflict forced a
    # nested install. Creating it unconditionally keeps the COPY in the runtime
    # stage valid either way — COPY cannot be conditional.
 && mkdir -p /repo/apps/api/node_modules


# --- Stage 4: runtime --------------------------------------------------------
FROM node:22-alpine AS runtime

WORKDIR /repo

# curl for the healthcheck; tini so PID 1 reaps zombies and forwards SIGTERM,
# without which graceful shutdown silently does not work.
RUN apk add --no-cache curl tini

ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps" \
    UPLOAD_DIR=/data/uploads

COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=prod-deps /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build     /repo/apps/api/dist ./apps/api/dist
COPY                  apps/api/package.json ./apps/api/
COPY                  package.json ./

# Uploads land on a volume; the app user must own it.
RUN mkdir -p /data/uploads && chown -R node:node /data

# Never run as root. `node` is a non-root user that ships with the base image.
USER node

WORKDIR /repo/apps/api

EXPOSE 4000

# Liveness probe. Deliberately hits /health/live, which touches no dependency —
# a database blip must not make the orchestrator kill healthy containers.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:4000/api/v1/health/live || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
