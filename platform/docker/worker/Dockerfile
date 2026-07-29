# syntax=docker/dockerfile:1.7
#
# Worker-agent image. This is the ONLY image that ever executes third-party
# extension code, and it is the only one that runs on machines the operator may
# not fully control. It therefore holds nothing worth stealing: no MangaDex
# credentials, no database URL, no Discord webhooks — a worker token and the
# bundle it was handed, and that is the entire blast radius (§8).
#
# It is the core image's Node build plus a Python 3.11 environment for the
# runner shim, because the extension contract is still the Python `Extension`
# class (§11).
#
# Build context is platform/ (see platform/.dockerignore):
#   docker build -f platform/docker/worker/Dockerfile -t publoader/worker:local platform
#
# Base pinning: see the long note in docker/core/Dockerfile. The digest below
# is the SAME PLACEHOLDER and must be re-pinned the same way. Keeping core and
# worker on one base digest is deliberate — one CVE sweep, one re-pin.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:0f6b6e0f1a1d1a3f9a5b7e3c9a2c4d5e6f70819293a4b5c6d7e8f90a1b2c3d4e5
ARG PNPM_VERSION=10.12.1


# --- stage: base ------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
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


# --- stage: pyenv -----------------------------------------------------------
# Python dependencies are resolved at BUILD time, never at run time: a worker
# that pip-installs on demand is a worker whose behaviour changes without a new
# image digest, and it needs egress to PyPI from a host running untrusted code.
# Compilers live in this stage only and are dropped from the runtime image.
FROM ${NODE_IMAGE} AS pyenv
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-dev \
      build-essential libffi-dev libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# A venv rather than the system interpreter: Debian's python3 is
# externally-managed (PEP 668) and pip into it is both refused and wrong.
ENV VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH
RUN python3 -m venv "$VIRTUAL_ENV" && pip install --no-cache-dir --upgrade pip

# 1) The runner shim's own pinned dependencies (§8: "Python runner deps pinned
#    in the worker image"). Its own layer so extension churn does not rebuild
#    the shim environment.
COPY runner/requirements.txt /tmp/runner-requirements.txt
RUN pip install --no-cache-dir -r /tmp/runner-requirements.txt

# 2) Every extension's declared dependencies (§11: extensions declare deps in
#    their own requirements.txt, installed at worker image build time).
#
#    EXTENSIONS_DIR points at a directory in the build context holding
#    <extension>/requirements.txt files. It defaults to
#    docker/worker/extensions/, which ships EMPTY (just .gitkeep) — a stock
#    build therefore installs no extension deps and runs only extensions whose
#    requirements are already satisfied by the runner shim.
#
#    To bake extension deps in, stage the files before building, e.g.
#      mkdir -p platform/docker/worker/extensions/mangaplus
#      cp ../publoader-extensions/mangaplus/requirements.txt \
#         platform/docker/worker/extensions/mangaplus/
#    (or point EXTENSIONS_DIR at another directory inside the context with
#     --build-arg EXTENSIONS_DIR=some/other/dir).
#
#    Consequence to keep in mind: adding an extension that needs a new
#    dependency means REBUILDING AND REDEPLOYING WORKERS, not just publishing a
#    bundle. That is the intended trade — it keeps dependency installation out
#    of job execution.
ARG EXTENSIONS_DIR=docker/worker/extensions
COPY ${EXTENSIONS_DIR}/ /tmp/extension-reqs/
RUN set -eu; \
    found=0; \
    for req in $(find /tmp/extension-reqs -name 'requirements*.txt' | sort); do \
      echo "installing extension deps from $req"; \
      pip install --no-cache-dir -r "$req"; \
      found=$((found+1)); \
    done; \
    echo "installed extension requirement files: $found"; \
    rm -rf /tmp/extension-reqs

# Record what actually landed, so a support question ("which pandas did that
# worker have?") is answered by the image instead of by guesswork.
RUN pip freeze > /opt/venv/pip-freeze.txt


# --- stage: runtime ---------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

# python3 only — no venv/dev/pip in the runtime image. The interpreter and its
# stdlib are needed to run what pyenv already installed; the toolchain that
# built those wheels is not.
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 publoader \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin publoader

WORKDIR /app

COPY --from=pyenv --chown=root:root /opt/venv /opt/venv
COPY --from=prune --chown=root:root /build/node_modules ./node_modules
COPY --from=build --chown=root:root /build/dist ./dist
COPY --chown=root:root package.json ./
COPY --chown=root:root runner ./runner

# Writable paths, and only these two:
#   /var/lib/publoader-worker  persistent agent state (worker token obtained by
#                              exchanging the enroll token, bundle cache) —
#                              a named volume in compose.
#   /tmp                       per-job scratch: unpacked bundles, downloaded
#                              images, the runner's working directory —
#                              a tmpfs in compose, so it is wiped between jobs
#                              and never survives a restart.
# Everything else is root-owned and read-only to uid 10001, which is what lets
# the compose file set `read_only: true` without the agent breaking.
RUN mkdir -p /var/lib/publoader-worker && chown 10001:10001 /var/lib/publoader-worker

ENV NODE_ENV=production \
    WORKER_STATE_PATH=/var/lib/publoader-worker
# config.ts reads RUNNER_PYTHON to spawn the shim; point it at the venv
# interpreter so extension imports resolve without activating anything.
ENV RUNNER_PYTHON=/opt/venv/bin/python3 \
    PUBLOADER_RUNNER=/app/runner/runner.py \
    VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH
# No .pyc writes (the rootfs is read-only) and unbuffered output so the shim's
# stderr interleaves correctly with the agent's JSON logs.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TMPDIR=/tmp

VOLUME ["/var/lib/publoader-worker"]

USER 10001:10001

# NOTHING is exposed. The agent is outbound-only: it long-polls the core API
# over HTTPS and never accepts an inbound connection. There is no port to
# publish, no listener to firewall, and no reason for a worker host to be
# reachable from the internet.

# Liveness via a heartbeat file the agent rewrites while its lease loop is
# turning (same technique as the legacy scheduler's /tmp heartbeat). A wedged
# agent — blocked on a hung extension subprocess, stuck socket — keeps its
# process alive and would otherwise never be restarted.
# A MISSING file is treated as healthy on purpose: the agent writes it once
# started, and a slow first boot (enrollment, bundle download) must not be
# killed. Staleness is what indicates a wedge.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "const fs=require('fs'),p=(process.env.WORKER_STATE_PATH||'/var/lib/publoader-worker')+'/heartbeat';let s;try{s=fs.statSync(p)}catch{process.exit(0)}process.exit(Date.now()-s.mtimeMs<180000?0:1)"]

CMD ["node", "dist/src/services/worker.js"]
