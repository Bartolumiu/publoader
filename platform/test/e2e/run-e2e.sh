#!/usr/bin/env bash
# End-to-end proof against the docker/dev compose stack:
#   1. publish the fixture extension bundle
#   2. trigger a FORCE run
#   3. watch it lease to one of two real workers, execute in the Node runner
#      (extension API v2), ingest, process, and upload to the mock MangaDex
#   4. assert uploads + untracked-series persistence
#   5. failover: switch the fixture into slow mode, kill the worker holding
#      the lease, and assert the OTHER worker completes the run
#
# Usage:  ./run-e2e.sh            (stack must already be up: docker compose -f docker/dev/docker-compose.yml up -d)
#         ./run-e2e.sh --no-failover
set -euo pipefail

API=${API:-http://127.0.0.1:8100}
MOCK=${MOCK:-http://127.0.0.1:8200}
ADMIN="authorization: Bearer ${DEV_ADMIN_TOKEN:-dev-admin-not-a-secret}"
COMPOSE=${COMPOSE:-docker compose -f docker/dev/docker-compose.yml}
HERE="$(cd "$(dirname "$0")" && pwd)"
FIXTURE="$HERE/fixtures/e2etest"

say()  { printf '\n=== %s ===\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }

publish_bundle() {
  local dir="$1" tmp
  tmp="$(mktemp -d)"
  (cd "$dir" && zip -qr "$tmp/bundle.zip" .)
  curl -fsS -X POST "$API/api/v1/admin/bundles" \
    -H "$ADMIN" -H 'content-type: application/zip' \
    --data-binary @"$tmp/bundle.zip"
  rm -rf "$tmp"
}

trigger_run() {
  curl -fsS -X POST "$API/api/v1/admin/runs" -H "$ADMIN" -H 'content-type: application/json' \
    -d "{\"extension\": \"e2etest\", \"kind\": \"FORCE\", \"idempotencyKey\": \"e2e:$1:$(date +%s)\"}" \
    | json "d['runId']"
}

run_state() {
  curl -fsS "$API/api/v1/admin/runs/$1" -H "$ADMIN" | json "d['run']['state']"
}

wait_run() {
  local run_id="$1" deadline=$(( $(date +%s) + ${2:-180} )) state
  while true; do
    state="$(run_state "$run_id")"
    case "$state" in
      PROCESSED) echo "$state"; return 0 ;;
      FAILED|DEAD_LETTER|CANCELLED) fail "run $run_id ended $state" ;;
    esac
    [ "$(date +%s)" -lt "$deadline" ] || fail "run $run_id stuck in $state"
    sleep 3
  done
}

say "preflight"
curl -fsS "$API/readyz" >/dev/null || fail "core-api not ready at $API"
workers_json="$(curl -fsS "$API/api/v1/admin/workers" -H "$ADMIN")"
active="$(echo "$workers_json" | json "sum(1 for w in d['workers'] if w['status']=='ACTIVE')")"
[ "$active" -ge 2 ] || fail "expected >=2 ACTIVE workers, got $active"
echo "workers: $active active"

say "1/5 publish fixture bundle"
publish_bundle "$FIXTURE"; echo

say "2/5 trigger run and wait for full pipeline"
run_id="$(trigger_run normal)"
echo "run: $run_id"
wait_run "$run_id" 180

say "3/5 assert mock MangaDex received the uploads"
# Upload tasks drain asynchronously after the run is PROCESSED — poll.
count=0
for _ in $(seq 1 30); do
  count="$(curl -fsS "$MOCK/_test/uploads" | json "len(d['commits'])")"
  [ "$count" -ge 2 ] && break
  sleep 2
done
[ "$count" -ge 2 ] || { curl -fsS "$MOCK/_test/uploads"; fail "expected >=2 committed uploads on mock-md, got $count"; }
echo "mock-md committed uploads: $count"

say "4/5 assert untracked series was persisted for the title pipeline"
untracked="$(curl -fsS "$API/api/v1/admin/untracked" -H "$ADMIN")"
echo "$untracked" | json "[u['mangaId'] for u in d['untracked']]" | grep -q "m2" \
  || { echo "$untracked"; fail "untracked manga m2 not persisted"; }
echo "untracked m2 recorded (state NEW, awaiting approval/auto-create)"

if [ "${1:-}" = "--no-failover" ]; then say "SKIPPING failover"; echo PASS; exit 0; fi

say "5/5 failover: kill the worker mid-job, the other one must finish"
# Slow mode = tracked map gains the marker id "slow" (DB is config authority,
# so this needs no bundle republish — which itself proves the overlay works).
curl -fsS -X PUT "$API/api/v1/admin/extensions/e2etest/tracked" -H "$ADMIN" \
  -H 'content-type: application/json' \
  -d '{"mangaId": "slow", "mdMangaId": "33333333-3333-4333-8333-333333333333"}' >/dev/null

run_id="$(trigger_run failover)"
echo "slow run: $run_id"

# Wait until some worker holds the lease.
lease_worker=""
for _ in $(seq 1 30); do
  lease_worker="$(curl -fsS "$API/api/v1/admin/runs/$run_id" -H "$ADMIN" \
    | json "next((j['leaseWorkerId'] for j in d['run']['jobs'] if j['leaseWorkerId']), '')")"
  [ -n "$lease_worker" ] && break
  sleep 2
done
[ -n "$lease_worker" ] || fail "no worker leased the slow job"
victim_name="$(curl -fsS "$API/api/v1/admin/workers" -H "$ADMIN" \
  | json "next(w['name'] for w in d['workers'] if w['id']=='$lease_worker')")"
echo "lease held by $victim_name — killing it"
$COMPOSE kill "$victim_name"

wait_run "$run_id" 300
survivor="$(curl -fsS "$API/api/v1/admin/runs/$run_id" -H "$ADMIN" \
  | json "next((j['leaseWorkerId'] for j in d['run']['jobs']), '')")"
[ "$survivor" != "$lease_worker" ] || fail "run completed on the killed worker's lease?!"
echo "run completed by a different worker after lease expiry"

# Cleanup: revive the victim, drop slow mode.
$COMPOSE start "$victim_name" >/dev/null
curl -fsS -X DELETE "$API/api/v1/admin/extensions/e2etest/tracked/slow" -H "$ADMIN" >/dev/null

say "PASS — full pipeline + failover verified"
