# syntax=docker/dockerfile:1.7
#
# Worker-agent image. This is the ONLY image that ever executes third-party
# extension code, and it is the only one that runs on machines the operator may
# not fully control. It therefore holds nothing worth stealing: no MangaDex
# credentials, no database URL, no Discord webhooks; a worker token and the
# bundle it was handed, and that is the entire blast radius (§8).
#
# It is the core image's Node build plus runner-node/, the extension API v2
# runner (§11). There is NO Python here any more: extensions are TypeScript
# built to a single self-contained ESM file at publish time, so the image needs
# no interpreter, no pip, and no per-extension dependency install. Adding an
# extension no longer means rebuilding and redeploying workers.
#
# Build context is the REPO ROOT (see .dockerignore):
#   docker build -f docker/worker/Dockerfile -t publoader/worker:local .
#
# Base pinning: see the long note in docker/core/Dockerfile. This is the SAME
# digest and must be refreshed together with it; keeping core and worker on
# one base is deliberate: one CVE sweep, one re-pin, one thing to verify.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
ARG PNPM_VERSION=10.12.1


# --- stage: base ------------------------------------------------------------
FROM ${NODE_IMAGE} AS base

# openssl in the BUILD stage as well as the runtime: `prisma generate` picks its
# query-engine target from what it can detect here, and a mismatch between that
# guess and the runtime is a failure that only appears once deployed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=production
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    CI=true
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /build


# --- stage: deps / build / prune -------------------------------------------
# Identical to the core image so both share layer cache and dependency
# provenance. The worker runs dist/src/services/worker.js out of the same tree.
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    NODE_ENV=development pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
# The worker never talks to Postgres, but the shared config/logging modules
# import the generated prisma types, so the client still has to exist at
# compile time. Nothing in the worker's runtime path opens a connection.
RUN pnpm exec prisma generate
RUN pnpm exec tsc -p tsconfig.json
RUN test -f dist/src/services/worker.js || (echo "build produced no dist/src/services/worker.js" >&2; exit 1)

FROM build AS prune
RUN pnpm prune --prod && \
    node -e "require('@prisma/client').PrismaClient || process.exit(1)" && \
    rm -rf /pnpm/store


# --- stage: runtime ---------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

# Prisma's query engine links against libssl at runtime. Without it Prisma logs
# "failed to detect the libssl/openssl version to use ... may not work as
# expected" and falls back to a guess; so install it rather than rely on the
# guess being right. ca-certificates is needed for outbound TLS (MangaDex,
# Discord webhooks, Atlas during a migration).
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 publoader \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin publoader

WORKDIR /app

COPY --from=prune --chown=root:root /build/node_modules ./node_modules
COPY --from=build --chown=root:root /build/dist ./dist
COPY --chown=root:root package.json ./
# The v2 runner. Self-contained: Node built-ins only, no imports from dist/ and
# no node_modules, because it executes under --permission with a read allowlist
# that covers this directory, the bundle, and the job workdir; and nothing else.
COPY --chown=root:root runner-node ./runner-node

# Writable paths, and only these two:
#   /var/lib/publoader-worker  persistent agent state (worker token obtained by
#                              exchanging the enroll token, bundle cache):
#                              a named volume in compose.
#   /tmp                       per-job scratch: unpacked bundles, downloaded
#                              images, the runner's working directory;
#                              a tmpfs in compose, so it is wiped between jobs
#                              and never survives a restart.
# Everything else is root-owned and read-only to uid 10001, which is what lets
# the compose file set `read_only: true` without the agent breaking.
RUN mkdir -p /var/lib/publoader-worker && chown 10001:10001 /var/lib/publoader-worker

ENV NODE_ENV=production \
    WORKER_STATE_PATH=/var/lib/publoader-worker
# executor.ts probes for the runner relative to dist/; this pins it explicitly
# so a layout change fails loudly at spawn instead of silently probing.
ENV PUBLOADER_NODE_RUNNER=/app/runner-node/runner.mjs \
    TMPDIR=/tmp

VOLUME ["/var/lib/publoader-worker"]

USER 10001:10001

# NOTHING is exposed. The agent is outbound-only: it long-polls the core API
# over HTTPS and never accepts an inbound connection. There is no port to
# publish, no listener to firewall, and no reason for a worker host to be
# reachable from the internet.

# Liveness via the heartbeat file services/worker.ts refreshes on every piece of
# work-related traffic with the core (lease polls while idle, lease renewals
# while a job runs). A wedged agent, one whose loop stopped turning but whose
# process is still alive, is the failure `restart: unless-stopped` cannot see,
# and this is what catches it.
#
# A MISSING file is UNHEALTHY. The previous version exited 0 when the file was
# absent, and nothing in the tree ever wrote it, so the probe could not fail at
# all: every worker reported healthy forever, wedged or not. The entry point now
# writes the file before enrolling, so absent genuinely means "never started".
#
# WORKER_HEARTBEAT_MAX_AGE_SECONDS must stay above both the lease long-poll wait
# and one third of the core's LEASE_TTL_SECONDS (the renewal interval); 600s
# clears the shipped defaults (25s and 100s) with room to spare.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD ["node", "-e", "const fs=require('fs'),p=(process.env.WORKER_STATE_PATH||'/var/lib/publoader-worker')+'/heartbeat',max=Number(process.env.WORKER_HEARTBEAT_MAX_AGE_SECONDS||600)*1000;let s;try{s=fs.statSync(p)}catch{console.error('no heartbeat file at '+p);process.exit(1)}const age=Date.now()-s.mtimeMs;if(age>max){console.error('heartbeat stale by '+Math.round(age/1000)+'s');process.exit(1)}"]

CMD ["node", "dist/src/services/worker.js"]
