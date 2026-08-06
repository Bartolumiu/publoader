#!/usr/bin/env bash
#
# Run the dashboard's browser assertions against a real Chrome.
#
# Everything here is disposable: a scratch database, a core-api on its own port,
# and a headless Chrome with a throwaway profile. Nothing touches the dev or prod
# stacks, so this is safe to run while they are up.
#
#   ./test/browser/run.sh                 # all three suites
#   ./test/browser/run.sh verify.mjs      # just one
#
# Requires Chrome (override with CHROME_PATH) and a reachable Postgres; by
# default the dev stack's, on 55432. No psql needed.
set -euo pipefail

cd "$(dirname "$0")/../.."

PGBASE="${PGBASE:-postgresql://publoader:dev@localhost:55432}"
DB="${BROWSER_TEST_DB:-publoader_browser}"
PORT="${DASH_PORT:-8101}"
export DATABASE_URL="${PGBASE}/${DB}?schema=public&connection_limit=5"
export DASH_ORIGIN="http://127.0.0.1:${PORT}"

echo "==> scratch database: ${DB}"
# Via node's `pg` rather than `psql`, which is not installed on every machine that
# can run this; the Postgres here usually lives in a container.
db() {
  node -e '
    const { Client } = require("pg");
    const c = new Client({ connectionString: process.argv[1] + "/postgres" });
    c.connect()
      .then(() => c.query(process.argv[2]))
      .then(() => c.end())
      .catch((err) => { console.error(err.message); process.exit(1); });
  ' "${PGBASE}" "$1"
}
db "CREATE DATABASE \"${DB}\"" 2>/dev/null || true
# `db push` rather than `migrate deploy`: this database is created and dropped
# around the run, so migration history on it would be noise.
npx prisma db push --skip-generate >/dev/null

echo "==> core-api on :${PORT}"
# Credentials are deliberately fake. The MangaDex base points at a port with
# nothing on it: these suites assert what the browser renders, and a real
# MangaDex call from a UI test would be both slow and someone else's problem.
PORT="${PORT}" HOST=127.0.0.1 \
  ADMIN_TOKEN=dev-admin-not-a-secret \
  SESSION_SECRET=browser-suite-session-secret-0123456789 \
  MANGADEX_API_URL=http://127.0.0.1:8299 \
  MANGADEX_AUTH_URL=http://127.0.0.1:8299/realms/mangadex/protocol/openid-connect \
  MANGADEX_USERNAME=dev MANGADEX_PASSWORD=dev \
  MANGADEX_CLIENT_ID=dev-client MANGADEX_CLIENT_SECRET=dev-secret \
  LOG_LEVEL=warn \
  npx tsx src/services/api.ts &
API_PID=$!
# Always reap the API and the scratch database, including on a failed assertion -
# otherwise a red run leaves a port bound and the next one fails for the wrong
# reason.
cleanup() {
  kill "${API_PID}" 2>/dev/null || true
  wait "${API_PID}" 2>/dev/null || true
  db "DROP DATABASE IF EXISTS \"${DB}\" WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  curl -fsS "${DASH_ORIGIN}/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "${DASH_ORIGIN}/healthz" >/dev/null

echo "==> seeding"
node test/browser/seed.mjs
# After the API is up: passwords must be hashed by the API, not written
# straight into the column, or no login would ever match them.
ADMIN_TOKEN=dev-admin-not-a-secret node test/browser/seed-accounts.mjs

SUITES=("${@:-verify.mjs verify-untracked.mjs verify-modules.mjs verify-features.mjs}")
# shellcheck disable=SC2068 -- intentional word splitting on the default list.
for suite in ${SUITES[@]}; do
  echo "==> ${suite}"
  node "test/browser/${suite}"
done
echo "==> all browser assertions passed"
