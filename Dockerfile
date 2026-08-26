# syntax=docker/dockerfile:1

# kapi ships as two images from one file:
#
#   docker build --target orchestrator -t kapi/orchestrator .
#   docker build --target web          -t kapi/web .
#
# Both are built from the same dependency layer, so a `pnpm install` is paid
# once rather than twice.

# ---------------------------------------------------------------- base
FROM node:22-alpine AS base
# git: the agent engine shells out to it. The orchestrator itself only does so
# for the `local` sandbox provider, which is refused on a multi-user
# deployment - but the CLI in this image can still use it.
# tini: without an init process, PID 1 ignores SIGTERM and the container is
# killed rather than shut down, which orphans running sandboxes.
RUN apk add --no-cache git tini
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------- dependencies
# Manifests first: this layer is only invalidated when a dependency changes,
# not when source does.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/orchestrator/package.json ./apps/orchestrator/
COPY apps/web/package.json ./apps/web/
COPY packages/agent-engine/package.json ./packages/agent-engine/
COPY packages/agent-runtime/package.json ./packages/agent-runtime/
COPY packages/bus/package.json ./packages/bus/
COPY packages/db/package.json ./packages/db/
COPY packages/env/package.json ./packages/env/
COPY packages/identity/package.json ./packages/identity/
COPY packages/llm/package.json ./packages/llm/
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/sandbox/package.json ./packages/sandbox/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------- build
FROM deps AS build
COPY . .
# Baked into the dashboard bundle. Set at `docker compose build` time from .env;
# a runtime env var cannot add a sign-in button that was compiled out.
ARG CLERK_PUBLISHABLE_KEY
ENV CLERK_PUBLISHABLE_KEY=$CLERK_PUBLISHABLE_KEY
RUN pnpm build:api && pnpm --filter @kapi/web build

# --------------------------------------------------------- orchestrator
FROM base AS orchestrator
ENV NODE_ENV=production
WORKDIR /app

# Both bundles are self-contained - scripts/build.ts inlines every dependency
# except the optional Redis driver - so this image carries no node_modules, no
# pnpm and no TypeScript. The .sql files are data the migrator reads at
# runtime, resolved relative to WORKDIR.
COPY --from=build /app/dist/orchestrator.mjs ./dist/orchestrator.mjs
COPY --from=build /app/dist/migrate.mjs ./dist/migrate.mjs
COPY --from=build /app/packages/db/migrations ./packages/db/migrations

# Runs as an unprivileged user. The `node` user ships with the base image.
RUN chown -R node:node /app
USER node

ENV ORCHESTRATOR_PORT=8787
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ORCHESTRATOR_PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/orchestrator.mjs"]

# ------------------------------------------------------------------ web
FROM base AS web
ENV NODE_ENV=production
WORKDIR /app

# Unlike the orchestrator, this image does need node_modules: vite's SSR build
# leaves react and @tanstack/react-router as bare imports rather than inlining
# them. The store is copied whole because pnpm's per-package directories are
# symlinks into the root .pnpm store, and half of that tree is useless.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/web ./apps/web
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./

WORKDIR /app/apps/web
RUN chown -R node:node /app
USER node

ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.mjs"]

# -------------------------------------------------------------------- agent
# Isolated workspace for SANDBOX_PROVIDER=docker. Built as kapi/agent:latest
# so the default image name in DockerProvider actually exists.
FROM node:22-bookworm-slim AS agent
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git python3 python3-pip python3-venv bash curl ca-certificates build-essential \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
CMD ["sleep", "infinity"]

# --------------------------------------------------------------- hosted
# Single public process for Render (and any host that only gives one port).
# The dashboard binds PORT; the orchestrator stays on loopback :8787.
FROM base AS hosted
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/packages/db/migrations ./packages/db/migrations
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/web ./apps/web
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/deploy/start-hosted.mjs ./deploy/start-hosted.mjs

RUN chown -R node:node /app
USER node

ENV ORCHESTRATOR_PORT=8787
ENV ORCHESTRATOR_URL=http://127.0.0.1:8787
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "deploy/start-hosted.mjs"]
