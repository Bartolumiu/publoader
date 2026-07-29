# syntax=docker/dockerfile:1.7
#
# Core control-plane image. ONE image serves core-api, core-scheduler,
# core-processor and core-uploader — they are the same code with different
# entrypoints (see package.json start:*), so a single build, a single digest
# and a single upgrade step cover the whole control plane.
#
# Build context is platform/ (see platform/.dockerignore):
#   docker build -f platform/docker/core/Dockerfile -t publoader/core:local platform
#
# ---------------------------------------------------------------------------
# Base image is pinned BY DIGEST, not by tag: `node:24-bookworm-slim` is a
# moving target, and an unpinned base means two builds of the same commit can
# ship different userlands (§8 "supply chain": base images pinned by digest).
#
# The digest below is the multi-arch index digest of node:24-bookworm-slim as
# of 2026-07-29 (it therefore builds on both amd64 and arm64). It goes stale as
# soon as the tag moves, which is the point — refresh it deliberately, on a
# schedule and for CVE fixes, so the change appears in a diff and gets reviewed:
#
#   docker pull node:24-bookworm-slim
#   docker buildx imagetools inspect node:24-bookworm-slim   # take "Digest:"
#
# Paste the result as NODE_IMAGE below and update the worker and mock-md
# Dockerfiles to match. A digest that no longer exists fails the build loudly;
# it never silently falls back to the tag. To build unpinned (dev only):
#   docker build --build-arg NODE_IMAGE=node:24-bookworm-slim ...
# ---------------------------------------------------------------------------
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

# pnpm version is pinned for the same reason the lockfile is: the resolver
# version is part of the build's reproducibility.
ARG PNPM_VERSION=10.12.1


# --- stage: base ------------------------------------------------------------
# Shared by build and runtime so both sides use the identical libc/OpenSSL the
# prisma engines and sharp were compiled against.
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=production
# Keep package managers quiet and non-interactive: update notifiers try to
# write a cache into $HOME, which does not exist for the runtime user.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    CI=true
# corepack ships with node:24 and is the supported way to get an exact pnpm.
# If a future base drops it, replace with: npm i -g pnpm@${PNPM_VERSION}
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /build


# --- stage: deps ------------------------------------------------------------
# Dependency install is its own layer keyed only on the manifests, so editing
# src/ does not re-download the dependency tree.
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
# --frozen-lockfile: fail rather than silently resolve a different tree than
# the one reviewed (§8). This REQUIRES pnpm-lock.yaml to be committed; if the
# build errors with "no lockfile found", generate it with `pnpm install` in
# platform/ and commit the result — do not "fix" it by dropping the flag.
# NODE_ENV=production would skip devDependencies, and we need tsc/prisma here.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    NODE_ENV=development pnpm install --frozen-lockfile


# --- stage: build -----------------------------------------------------------
# prisma generate + tsc. Both need devDependencies, neither belongs in the
# runtime image.
FROM deps AS build
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
# Generates node_modules/.prisma/client against the committed schema. Runs
# before tsc because the TypeScript in src/ imports the generated types.
RUN pnpm exec prisma generate
RUN pnpm exec tsc -p tsconfig.json
# Fail the build here rather than at 03:00 in production if the entrypoint the
# compose files reference was never emitted.
RUN test -f dist/src/services/api.js || (echo "build produced no dist/src/services/api.js" >&2; exit 1)


# --- stage: migrate ---------------------------------------------------------
# Schema migrations need the prisma CLI, which is a devDependency and is
# deliberately absent from the runtime image (a long-lived service must not
# carry a tool that can rewrite the database). So the one-shot `migrate`
# compose service runs THIS target instead: full node_modules, the schema and
# the migration history, nothing else. It exits when the migration is applied.
FROM build AS migrate
RUN groupadd --gid 10001 publoader && \
    useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin publoader && \
    chown -R publoader:publoader /build
# The user has no home directory; point HOME at the tmpfs so any tool that
# insists on a cache dir has a writable one under `read_only: true`.
ENV HOME=/tmp
USER 10001:10001
# The .bin shim rather than `pnpm exec`, so running a migration does not drag
# the package manager (and its own state directories) into the container.
ENTRYPOINT ["./node_modules/.bin/prisma"]
CMD ["migrate", "deploy"]


# --- stage: prune -----------------------------------------------------------
# Strip devDependencies from the installed tree. The prisma client generated in
# the build stage lives inside the @prisma/client package directory, which is a
# production dependency and therefore survives the prune — the smoke check
# below proves that on every build instead of trusting it.
FROM build AS prune
RUN pnpm prune --prod && \
    node -e "require('@prisma/client').PrismaClient || process.exit(1)" && \
    rm -rf /pnpm/store


# --- stage: runtime ---------------------------------------------------------
# Only what a service needs to run: compiled JS, production node_modules, the
# prisma schema (the client reads it for engine metadata), and the manifest.
# No compilers, no package manager, no source, no tests, no shell tooling
# beyond what the base image already carries.
FROM ${NODE_IMAGE} AS runtime

# uid 10001 is fixed and high on purpose: it collides with no distro account,
# and named volumes/bind mounts on the host can be chowned to a stable number.
RUN groupadd --gid 10001 publoader && \
    useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin publoader

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8100 \
    HOST=0.0.0.0

COPY --from=prune --chown=root:root /build/node_modules ./node_modules
COPY --from=build --chown=root:root /build/dist ./dist
COPY --from=build --chown=root:root /build/prisma ./prisma
COPY --chown=root:root package.json ./

# Everything is owned by root and only readable by the service account: the
# process can execute its own code but cannot rewrite it, which is what makes
# `read_only: true` in compose meaningful rather than decorative.
USER 10001:10001

# core-api's internal port. `EXPOSE` is documentation plus a hint to tooling —
# it publishes nothing on the host by itself, and the compose files never map
# it (the cloudflared tunnel is the only ingress).
EXPOSE 8100

# Liveness only: /healthz answers as long as the event loop is turning. It says
# nothing about Postgres — that is /readyz, and a database blip must not cause
# an orchestrator to kill an otherwise healthy API.
# curl/wget are not installed (nothing to smuggle a request out with), so the
# probe uses node's built-in fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8100)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# Default command is the API. The scheduler/processor/uploader services
# override it (see docker/core/docker-compose.yml); they have no listening
# socket and disable this healthcheck.
CMD ["node", "dist/src/services/api.js"]
