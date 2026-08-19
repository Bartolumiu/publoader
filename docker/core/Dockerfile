# syntax=docker/dockerfile:1.7
#
# Core control-plane image. ONE image serves core-api, core-scheduler,
# core-processor and core-uploader; they are the same code with different
# entrypoints (see package.json start:*), so a single build, a single digest
# and a single upgrade step cover the whole control plane.
#
# Build context is the REPO ROOT (see .dockerignore): the image copies docs/
#   docker build -f docker/core/Dockerfile -t publoader/core:local .
#
# ---------------------------------------------------------------------------
# Base image is pinned BY DIGEST, not by tag: `node:24-bookworm-slim` is a
# moving target, and an unpinned base means two builds of the same commit can
# ship different userlands (§8 "supply chain": base images pinned by digest).
#
# The digest below is the multi-arch index digest of node:24-bookworm-slim as
# of 2026-07-29 (it therefore builds on both amd64 and arm64). It goes stale as
# soon as the tag moves, which is the point; refresh it deliberately, on a
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
# the repo root and commit the result; do not "fix" it by dropping the flag.
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
# The dashboard is static assets, not TypeScript, so tsc does not emit them.
# core-api reads them at boot and would crash without them.
RUN mkdir -p dist/src/core/api/dashboard \
    && cp -r src/core/api/dashboard/. dist/src/core/api/dashboard/
# Fail the build here rather than at 03:00 in production if the entrypoint the
# compose files reference was never emitted.
RUN test -f dist/src/services/api.js || (echo "build produced no dist/src/services/api.js" >&2; exit 1)
RUN test -f dist/src/core/api/dashboard/index.html || (echo "build produced no dashboard assets" >&2; exit 1)


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
# production dependency and therefore survives the prune; the smoke check
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

# Prisma's query engine links against libssl at runtime. Without it Prisma logs
# "failed to detect the libssl/openssl version to use ... may not work as
# expected" and falls back to a guess; so install it rather than rely on the
# guess being right. ca-certificates is needed for outbound TLS (MangaDex,
# Discord webhooks, Atlas during a migration).
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates curl gnupg \
 # postgresql-client-16 specifically, from PGDG: Debian bookworm ships client 15,
 # and pg_dump REFUSES to dump a newer server ("aborting because of server
 # version mismatch"), so the default package would give a backup button that
 # always fails against our Postgres 16.
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-16 \
 && apt-get purge -y curl gnupg && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

# Fonts. The unavailable-chapter card (core/md/card.ts) is SVG text rasterised
# by sharp, and librsvg draws a glyph only if a font on this filesystem has it.
# A slim base ships NONE, so without this every card renders as a grid of tofu
# boxes — the layout correct, the text unreadable — and the failure is silent:
# nothing errors, a PNG is produced, and it goes to MangaDex as a public page.
#
#   fontconfig       /etc/fonts, so the renderer can find anything at all
#   fonts-dejavu-core   DejaVu Sans + Sans Mono, the two families card.ts pins
#   fonts-liberation2   Liberation Sans, the pinned second choice
#   fonts-noto-cjk      Japanese/Korean/Chinese series titles, which DejaVu has
#                       no glyphs for; the biggest package here and the reason
#                       the card can name a Japanese series at all
#
# The two `fc-list` greps fail the build rather than ship an image that renders
# tofu; a missing font is otherwise invisible until a card reaches MangaDex.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fontconfig fonts-dejavu-core fonts-liberation2 fonts-noto-cjk \
 && fc-cache -f \
 && fc-list | grep -q DejaVuSans \
 && fc-list | grep -qi NotoSansCJK \
 && rm -rf /var/lib/apt/lists/*

# postgresql-client is here for ONE reason: the dashboard's backup button, which
# streams `pg_dump` to the operator. Without it that button answers 503 and a
# backup means shelling onto the host, which defeats the point of the dashboard.
#
# The trade-off was considered rather than assumed. It adds no listener and no
# privilege: the route is behind the strictest guard in the system (OWNER role
# AND users:admin, which excludes every API token however scoped), and anyone
# who can already execute code in this container holds DATABASE_URL and can read
# the same rows over SQL. So pg_dump grants an attacker nothing they lacked; it
# only costs image size and the CVE surface of one well-maintained package.

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
# The docs the dashboard serves (GET /api/v1/admin/docs). They live at the repo
# root because they document the whole project, and the dashboard serves them
# from the running image.
#
# The API finds this directory by walking up from its own module, so /app/docs is
# what makes the "Read the docs" view work in the container (see
# core/sysops/docsStore.ts; DOCS_PATH overrides the search). An EMPTY or absent
# directory is reported as "not shipped with this build" rather than as "there is
# no documentation"; so a build that drops this line degrades honestly, but it
# does drop the feature.
COPY --chown=root:root docs ./docs
# Fail here rather than serving an empty docs list in production.
RUN test -n "$(ls -A ./docs 2>/dev/null)" || (echo "no docs/ in the runtime image" >&2; exit 1)

# Everything is owned by root and only readable by the service account: the
# process can execute its own code but cannot rewrite it, which is what makes
# `read_only: true` in compose meaningful rather than decorative.
USER 10001:10001

# core-api's internal port. `EXPOSE` is documentation plus a hint to tooling;
# it publishes nothing on the host by itself, and the compose files never map
# it (the cloudflared tunnel is the only ingress).
EXPOSE 8100

# Liveness only: /healthz answers as long as the event loop is turning. It says
# nothing about Postgres; that is /readyz, and a database blip must not cause
# an orchestrator to kill an otherwise healthy API.
# curl/wget are not installed (nothing to smuggle a request out with), so the
# probe uses node's built-in fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8100)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# Default command is the API. The scheduler/processor/uploader services
# override it (see docker/core/docker-compose.yml); they have no listening
# socket and disable this healthcheck.
CMD ["node", "dist/src/services/api.js"]
