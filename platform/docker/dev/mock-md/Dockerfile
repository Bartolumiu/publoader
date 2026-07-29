# syntax=docker/dockerfile:1.7
#
# Mock MangaDex API for the local e2e stack. One file, no dependencies, no
# install step — copy and run. Build context is this directory.
#
# Same base digest as the real images so the dev stack pulls no extra base
# layer (see docker/core/Dockerfile for the refresh instructions — this digest
# must be updated together with the other two).
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
FROM ${NODE_IMAGE}

WORKDIR /app
COPY --chown=root:root mock-md.mjs ./

ENV NODE_ENV=production \
    PORT=8200

# Non-root and root-owned code, matching the rest of the stack: a test fixture
# that runs as root is a habit that eventually escapes into production.
USER node

EXPOSE 8200

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8200)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "mock-md.mjs"]
