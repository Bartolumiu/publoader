# Deployment

Operator guide for the distributed platform: the core control plane you run,
and the worker hosts other people run.

Everything here assumes you are at the repository root and that the public URL
is `https://publoader.ardax.dev`. Substitute your own hostname throughout.

- [What you are deploying](#what-you-are-deploying)
- [Prerequisites](#prerequisites)
- [Core bring-up](#core-bring-up)
- [First run](#first-run)
- [Cloudflare tunnel and WAF](#cloudflare-tunnel-and-waf)
- [Enrolling a worker host](#enrolling-a-worker-host)
- [Scaling to multiple workers](#scaling-to-multiple-workers)
- [Upgrading](#upgrading)
- [Draining and revoking workers](#draining-and-revoking-workers)
- [Failover test](#failover-test)
- [Backup and restore](#backup-and-restore)
- [Local end-to-end stack](#local-end-to-end-stack)
- [Troubleshooting](#troubleshooting)

## What you are deploying

Two independently deployed things that only ever meet over HTTPS.

**Core** (`platform/docker/core/`) runs on your host and holds everything
sensitive: PostgreSQL, the MangaDex account, the Discord webhooks, the admin
token. Five containers — `postgres`, `core-api`, `core-scheduler`,
`core-processor`, `core-uploader` — plus a one-shot `migrate` and the
`cloudflared` tunnel. Nothing is published on the host; the tunnel is the only
way in.

**Workers** (`platform/docker/worker/`) run anywhere, including on machines you
do not control. One container that long-polls the core API for a job, runs an
extension in a Python sandbox, and posts back a result envelope. A worker holds
a single revocable token and nothing else. It cannot upload to MangaDex — only
`core-uploader` can, and only after the result has passed validation, dedup and
audit. See `docs/target-architecture.md` §8 for the full trust model.

**There are no configuration files to deploy.** No `config.ini`, no
`config.json`, and no compose service bind-mounts one. Deployment configuration
is environment variables (or Docker secrets — `config.ts` reads any `VAR` from
`VAR_FILE`), and runtime configuration — tracked manga, per-extension override
options, schedules, pause state — lives in Postgres and is changed through the
admin API. This is the main operational difference from the legacy stack: there
is no file on the core host to edit, and nothing to keep in sync across hosts.

## Prerequisites

- Docker Engine 24+ with Compose v2 (`docker compose version`).
- A Cloudflare account with the zone for your hostname, and Zero Trust enabled.
- A MangaDex account with API client credentials.
- Roughly 4 GB RAM and 20 GB disk for the core host. Artifacts (uploaded page
  images awaiting processing) live in Postgres, so disk grows with backlog.

Three things must be committed for the images to build. All three are in the
repository today; each fails the build loudly if one ever goes missing:

| What | Why | If missing |
| --- | --- | --- |
| `platform/pnpm-lock.yaml` | Images install with `--frozen-lockfile` so the dependency tree is the reviewed one | `cd platform && pnpm install`, commit the lockfile — do not drop the flag |
| `platform/prisma/migrations/` | The `migrate` service runs `prisma migrate deploy`, which applies committed migrations and never infers a schema | `cd platform && pnpm prisma migrate dev --name init` against a scratch database, commit the result |
| `platform/runner/` | The worker image installs `runner/requirements.txt` and ships the Python shim | Part of the worker runtime |

The base image is pinned by digest in all three Dockerfiles — the multi-arch
index digest of `node:24-bookworm-slim` as of 2026-07-29, so builds are
reproducible on amd64 and arm64 alike. Refresh it deliberately (on a schedule,
and whenever a base CVE lands) rather than letting a tag drift:

```bash
docker pull node:24-bookworm-slim
docker buildx imagetools inspect node:24-bookworm-slim   # take "Digest:"
# update NODE_IMAGE in all three, together:
#   platform/docker/core/Dockerfile
#   platform/docker/worker/Dockerfile
#   platform/docker/dev/mock-md/Dockerfile
```

A digest that no longer exists fails the build immediately, so a stale pin is a
loud problem rather than a silent one. To build unpinned (development only):
`docker build --build-arg NODE_IMAGE=node:24-bookworm-slim ...`.

One detail to preserve if you ever regenerate migrations: the partial unique
index enforcing one committed result per job cannot be expressed in the Prisma
schema and is applied by hand-written SQL (currently in the
`result_commit_marker` migration). Without it, that invariant is enforced only
by application logic:

```sql
CREATE UNIQUE INDEX result_committed_one_per_job
  ON result_submissions (job_id) WHERE state = 'COMMITTED';
```

## Core bring-up

```bash
cd platform/docker/core
cp .env.example .env
chmod 600 .env
```

Fill in `.env`. Five values are mandatory and the stack refuses to start
without them:

```bash
openssl rand -base64 36   # POSTGRES_PASSWORD
openssl rand -base64 48   # ADMIN_TOKEN
```

plus `MANGADEX_USERNAME` / `MANGADEX_PASSWORD` / `MANGADEX_CLIENT_ID` /
`MANGADEX_CLIENT_SECRET`, and `TUNNEL_TOKEN` (see the next section — bring the
tunnel up first if you would rather not restart later).

`ADMIN_TOKEN` is a root-equivalent credential: it can trigger runs, publish
bundles, mint worker tokens and revoke workers. If it is unset the entire admin
API answers 503, which is the intended fail-closed behaviour. For more than a
single-operator host, use Docker secrets instead — every variable is also
accepted as `<VAR>_FILE`, and the commented `secrets:` block at the bottom of
`docker-compose.yml` shows the wiring.

Then bring it up from the repository root:

```bash
docker compose -f platform/docker/core/docker-compose.yml up -d --build
docker compose -f platform/docker/core/docker-compose.yml ps
```

Expected: `postgres` healthy, `migrate` exited 0, four core services up,
`cloudflared` up. Startup order is enforced — `migrate` waits for Postgres to
accept connections, and the four services wait for `migrate` to exit
successfully, so the stack cannot come up half-migrated.

Verify from inside the network (nothing is published on the host, by design):

```bash
docker compose -f platform/docker/core/docker-compose.yml exec core-api \
  node -e "fetch('http://127.0.0.1:8100/readyz').then(r=>r.text()).then(console.log)"
```

`/healthz` means the process is alive; `/readyz` additionally means Postgres is
reachable. Only `/healthz` is the container healthcheck — a database blip must
not cause an orchestrator to kill an otherwise healthy API.

## First run

Export the admin token once so the commands below are readable:

```bash
export ADMIN=https://publoader.ardax.dev
export ADMIN_TOKEN='…the value from .env…'
auth=(-H "authorization: Bearer $ADMIN_TOKEN" -H 'x-actor: your-name')
```

`x-actor` is optional but recorded in the audit log — set it to something that
identifies you, because "who paused the platform" is a question you will ask.

Publish an extension bundle. The API expects the zip itself as the body, reads
`manifest.json` out of it, validates it and stores it content-addressed:

```bash
curl -sX POST "$ADMIN/api/v1/admin/bundles" "${auth[@]}" \
  -H 'content-type: application/zip' \
  -H "x-source-commit: $(git -C ../publoader-extensions rev-parse HEAD)" \
  --data-binary @mangaplus.zip
```

Publishing also seeds that extension's runtime data into Postgres, which is why
there are no config files to deploy alongside it:

- `manga_id_map.json` in the bundle becomes `TrackedManga` rows (inserted with
  `skipDuplicates`, so re-publishing adds new titles and disturbs nothing).
- `override_options.json` becomes the extension's `ExtensionConfig` row
  **create-only** — once it exists, the database wins and a re-publish will not
  overwrite operator edits. Change options through the admin API, not by
  editing a bundle.

Workers receive this configuration in the job payload at lease time, so a
change takes effect on the next run without rebuilding or redeploying anything.

Then confirm what the platform knows:

```bash
curl -s "$ADMIN/api/v1/admin/extensions" "${auth[@]}"   # published bundles
curl -s "$ADMIN/api/v1/admin/stats"      "${auth[@]}"   # queue depths, fleet
curl -s "$ADMIN/api/v1/admin/audit"      "${auth[@]}"   # everything so far
```

Nothing will run until at least one worker is enrolled — the scheduler will
happily create jobs, and they will sit `PENDING` until a worker leases them.
Enrol a worker before triggering a run:

```bash
curl -sX POST "$ADMIN/api/v1/admin/runs" "${auth[@]}" \
  -H 'content-type: application/json' \
  -d '{"extension":"mangaplus","kind":"FORCE"}'
```

## Cloudflare tunnel and WAF

The tunnel is token-managed: it is created and configured in the Cloudflare
dashboard, and the container only needs the token. This matches the legacy
stack.

1. **Zero Trust → Networks → Tunnels → Create a tunnel** (type: Cloudflared).
   Copy the token into `TUNNEL_TOKEN` in `.env`.
2. **Public Hostname** on that tunnel:
   - Subdomain/domain: `publoader.ardax.dev`
   - Service: `HTTP` → `core-api:8100`

   `core-api` resolves over the compose network; no host port is involved.
3. Restart the tunnel if you added the token after bring-up:
   `docker compose -f platform/docker/core/docker-compose.yml up -d cloudflared`

### WAF rules

These are load-bearing, not hardening theatre. The core API is exposed to the
internet so that workers on other hosts can reach it, which also means the
internet can reach it.

**Block the observability endpoints** (Security → WAF → Custom rules). None of
them requires authentication — that is intentional, because they are meant for
the internal network only (see `src/core/api/server.ts`), and `/metrics` leaks
queue depths, fleet size and per-extension failure rates.

```
(http.host eq "publoader.ardax.dev" and
 http.request.uri.path in {"/metrics" "/healthz" "/readyz"})
→ Block
```

**Allow only the two API surfaces**, block the rest. There is no web UI on this
hostname; anything else is probing.

```
(http.host eq "publoader.ardax.dev" and
 not starts_with(http.request.uri.path, "/api/v1/worker/") and
 not starts_with(http.request.uri.path, "/api/v1/admin/"))
→ Block
```

**Rate limit enrollment** (Security → WAF → Rate limiting rules).
`/api/v1/worker/enroll` is the only unauthenticated write endpoint in the
system. The API has its own per-IP limiter, but that is a backstop that runs
after the request has already arrived.

```
Match:      http.request.uri.path eq "/api/v1/worker/enroll"
Rate:       5 requests per 1 hour, per IP
Action:     Block for 1 hour
```

**Rate limit the admin API** as a brute-force ceiling on the bearer token:

```
Match:      starts_with(http.request.uri.path, "/api/v1/admin/")
Rate:       60 requests per 1 minute, per IP
Action:     Managed challenge
```

Two settings worth checking while you are in the dashboard:

- **Do not enable Zero Trust Access on `/api/v1/worker/*`.** Workers
  authenticate with bearer tokens and cannot complete an interactive login. You
  *can* put Access with a service token in front of `/api/v1/admin/*`, and it is
  a good idea — it makes the admin token the second factor rather than the only
  one.
- The lease endpoint long-polls for up to `LEASE_POLL_WAIT_SECONDS` (25s by
  default). Keep it comfortably below Cloudflare's ~100s idle timeout; if you
  raise one, check the other.

## Enrolling a worker host

Enrollment is deliberately manual and operator-initiated: you mint a
single-use, expiring token and hand it to a host you have decided to trust.

**On the core host**, mint the token:

```bash
curl -sX POST "$ADMIN/api/v1/admin/enroll-tokens" "${auth[@]}" \
  -H 'content-type: application/json' \
  -d '{"trust":"COMMUNITY","note":"arda-desktop","ttlHours":24}'
# → {"token":"pe_…","expiresAt":"…"}
```

`trust` is `COMMUNITY` or `TRUSTED`. Extensions whose manifest sets
`min_trust: TRUSTED` are never leased to a `COMMUNITY` worker, so use
`COMMUNITY` for anything you do not personally administer.

**On the worker host**:

```bash
git clone https://github.com/publoader/publoader && cd publoader
cd platform/docker/worker
cp .env.example .env && chmod 600 .env
# set WORKER_NAME and paste the pe_… token into ENROLL_TOKEN
cd -
docker compose -f platform/docker/worker/docker-compose.yml up -d --build
docker compose -f platform/docker/worker/docker-compose.yml logs -f
```

The agent exchanges the enroll token for a permanent worker token on first
boot and persists it to the `worker-state` volume. The enroll token is spent at
that point and can be removed from `.env`.

**Verify from the core host** — the worker should appear with a recent
heartbeat:

```bash
curl -s "$ADMIN/api/v1/admin/workers" "${auth[@]}"
```

If `lastHeartbeatAt` is null or stale, see [Troubleshooting](#troubleshooting).

The worker publishes no ports and accepts no inbound connections, so it works
behind NAT, on a laptop, or on a home connection with no firewall changes.

## Scaling to multiple workers

Throughput is workers, not core services. `core-scheduler` and `core-uploader`
must each stay at exactly one replica — the scheduler would race itself on slot
creation, and MangaDex upload sessions are per-account state that two uploaders
would clobber.

To add capacity, repeat the enrollment walkthrough on another host. Each worker
needs its own enroll token and its own state volume; sharing either means
sharing an identity, which breaks revocation.

Several workers on one machine work too — copy the compose file, and give each
a distinct project name, `WORKER_NAME` and volume:

```bash
docker compose -p publoader-worker-2 \
  -f platform/docker/worker/docker-compose.yml up -d
```

Size the fleet by watching `PENDING` job depth in
`GET /api/v1/admin/stats`: if it is persistently non-zero while workers are
busy, add a worker. Each worker runs one job at a time.

## Upgrading

Migrations run automatically on every `up`: the `migrate` service applies any
migrations not yet recorded in `_prisma_migrations` and exits, and the app
services wait for that exit code. `migrate deploy` never generates, resets or
drops anything, so re-running it is safe.

**Building from source** (the default):

```bash
git pull
docker compose -f platform/docker/core/docker-compose.yml up -d --build
```

**From a registry** — set `PUBLOADER_CORE_IMAGE` and `PUBLOADER_MIGRATE_IMAGE`
in `.env` to a digest-pinned tag, then:

```bash
docker compose -f platform/docker/core/docker-compose.yml pull
docker compose -f platform/docker/core/docker-compose.yml up -d
```

Workers upgrade independently and can lag the core by a version; the API is
versioned (`/api/v1/`) for exactly that reason. Rolling the fleet is: drain,
wait for the current job to finish, `up -d --build`, un-drain (next section).

Watch the first minutes after an upgrade:

```bash
docker compose -f platform/docker/core/docker-compose.yml logs -f --tail=100
curl -s "$ADMIN/api/v1/admin/stats" "${auth[@]}"
```

### Rollback

Code-only rollback (no new migration in the bad release) is just the previous
tag:

```bash
PUBLOADER_CORE_IMAGE=ghcr.io/publoader/core:1.0.0 \
  docker compose -f platform/docker/core/docker-compose.yml up -d
```

If the bad release **did** apply a migration, the old code is running against a
newer schema. Additive migrations (new nullable column, new table) are usually
tolerated; destructive ones are not. In order of preference:

1. **Roll forward.** Write a new migration that undoes the change and deploy
   it. This keeps the migration history linear and honest, and it is almost
   always the right answer.
2. **Restore from backup** (next section) if the migration destroyed data.
3. Only if a migration failed *partway* and left the history table marked
   failed, unblock it explicitly:

   ```bash
   # Mark a failed migration as rolled back, after manually reverting its SQL:
   docker compose -f platform/docker/core/docker-compose.yml run --rm \
     migrate migrate resolve --rolled-back 20260101120000_bad_migration

   # Or mark one as applied, if you applied its SQL by hand:
   docker compose -f platform/docker/core/docker-compose.yml run --rm \
     migrate migrate resolve --applied 20260101120000_partly_applied
   ```

   `migrate resolve` only edits Prisma's bookkeeping — it runs no SQL and fixes
   no data. Reverting the actual schema change is your job, first.

Never edit a migration that has already been deployed. Prisma checksums them
and the next `deploy` will refuse to run.

**Postgres major upgrades** (16 → 17) are not in-place: dump, recreate the
volume with the new image, restore.

## Draining and revoking workers

Three states, and the difference matters:

```bash
# Drain: finish the current job, take no new ones. The polite one — use it
# before rebooting a worker host or rolling the fleet.
curl -sX POST "$ADMIN/api/v1/admin/workers/$WORKER_ID/drain" "${auth[@]}"

# Activate: back into rotation.
curl -sX POST "$ADMIN/api/v1/admin/workers/$WORKER_ID/activate" "${auth[@]}"

# Revoke: the token stops working immediately. Use it when a host is
# compromised, gone, or no longer trusted. Not reversible — the host must
# re-enroll with a fresh token.
curl -sX POST "$ADMIN/api/v1/admin/workers/$WORKER_ID/revoke" "${auth[@]}"
```

A drained worker gets `204` with `x-publoader-drained` on its next lease poll
and idles quietly rather than hammering the API. A revoked worker's in-flight
job is not cancelled by the revocation itself — its result submission will be
rejected, and the lease will expire and be reassigned. To stop the work sooner,
cancel the job:

```bash
curl -sX POST "$ADMIN/api/v1/admin/jobs/$JOB_ID/cancel" "${auth[@]}"
```

After revoking, on the worker host: `docker compose down -v` to remove the
state volume containing the dead token.

## Failover test

Worth running once after setup and after any change to lease handling. It
proves the property the whole distributed design rests on: a worker dying
mid-job loses nothing but time.

Do it on the [local stack](#local-end-to-end-stack), where `LEASE_TTL_SECONDS`
is 30 instead of 300:

```bash
cd platform/docker/dev
docker compose up -d --build
export DEV=http://127.0.0.1:8100
dev_auth=(-H 'authorization: Bearer dev-admin-not-a-secret')

# 1. Both workers enrolled and heartbeating?
curl -s "$DEV/api/v1/admin/workers" "${dev_auth[@]}"

# 2. Trigger a run.
curl -sX POST "$DEV/api/v1/admin/runs" "${dev_auth[@]}" \
  -H 'content-type: application/json' \
  -d '{"extension":"mangaplus","kind":"FORCE"}'

# 3. Find who leased it.
docker compose logs worker-a worker-b | grep -i lease

# 4. Kill the holder mid-job — SIGKILL, no graceful shutdown, exactly like a
#    host losing power.
docker compose kill worker-a

# 5. Watch the sweeper reclaim it and the other worker pick it up.
docker compose logs -f core-scheduler worker-b
```

Expected: within `LEASE_TTL_SECONDS + SWEEP_INTERVAL_SECONDS` (~35s here), the
scheduler logs the expired lease, the job returns to `PENDING`, and `worker-b`
leases it on its next poll. The job's `attempt` counter increments; it
dead-letters only after `maxAttempts`.

Then confirm nothing was double-uploaded — the mock records every write, and a
correct run commits each chapter exactly once:

```bash
curl -s http://127.0.0.1:8200/_test/uploads | jq '.commits | length'
```

Bring `worker-a` back with `docker compose up -d worker-a`; its identity
survives in its state volume.

## Backup and restore

Postgres is the only durable state. The named volume `pgdata` is the whole
system: queues, leases, results, artifacts, bundles, chapter history, audit.
Everything else is rebuildable from the repository.

**Backup** — a custom-format dump, which restores selectively and compresses:

```bash
docker compose -f platform/docker/core/docker-compose.yml exec -T postgres \
  pg_dump -U publoader -Fc publoader > publoader-$(date +%F).dump
```

Automate it daily and keep the dumps off this host. Artifacts (page images) are
stored as bytea, so dumps grow with backlog; if size becomes a problem, dump
`--exclude-table-data=artifacts` — they are transient and re-fetchable, unlike
everything else.

**Restore** into an empty database:

```bash
# Stop everything that writes; leave postgres running.
docker compose -f platform/docker/core/docker-compose.yml stop \
  core-api core-scheduler core-processor core-uploader

docker compose -f platform/docker/core/docker-compose.yml exec -T postgres \
  dropdb -U publoader --if-exists publoader
docker compose -f platform/docker/core/docker-compose.yml exec -T postgres \
  createdb -U publoader publoader
docker compose -f platform/docker/core/docker-compose.yml exec -T postgres \
  pg_restore -U publoader -d publoader --no-owner < publoader-2026-07-29.dump

docker compose -f platform/docker/core/docker-compose.yml up -d
```

Verify the restore before trusting it — the migration history in particular,
because that is what decides whether the next deploy tries to re-apply
everything:

```bash
docker compose -f platform/docker/core/docker-compose.yml exec -T postgres \
  psql -U publoader -d publoader -c \
  'select migration_name, finished_at from _prisma_migrations order by finished_at desc limit 5;'
```

Test a restore into a scratch stack occasionally. An untested backup is a
hypothesis.

Jobs that were `LEASED` at dump time come back leased with an expiry in the
past; the sweeper reclaims them on its next tick, which is the correct
behaviour and needs no intervention.

## Local end-to-end stack

`platform/docker/dev/docker-compose.yml` runs the entire system on one machine
with MangaDex replaced by a mock. It is the only place the failover, dedup and
concurrency behaviours can be exercised for real.

```bash
docker compose -f platform/docker/dev/docker-compose.yml up -d --build
```

You get: Postgres (tmpfs — `down` really resets), `migrate`, all four core
services, `mock-md`, and two workers that enrol themselves automatically. The
API is on `127.0.0.1:8100` with the admin token `dev-admin-not-a-secret`; the mock is on
`127.0.0.1:8200`.

The mock's test surface:

```bash
curl -s http://127.0.0.1:8200/_test/uploads   # every write it received
curl -s http://127.0.0.1:8200/_test/state     # fixtures + counters
curl -sX POST http://127.0.0.1:8200/_test/seed -H 'content-type: application/json' \
  -d '{"chapters":[…],"manga":[…],"aggregate":{}}'
curl -sX POST http://127.0.0.1:8200/_test/reset
```

`_test/uploads` also lists `unrouted` requests — endpoints the client called
that the mock does not implement. Check it first when an e2e test fails
mysteriously.

This stack is **not secure and not meant to be**: fixed weak credentials,
automated enrollment, published ports. Do not run it on a host that accepts
traffic from anywhere else.

## Troubleshooting

**`migrate` exits non-zero, everything else stays down.** Read its logs first —
this is the designed failure mode, not a bug. `No migration found in
prisma/migrations` means the prerequisite above was skipped. A checksum
mismatch means a deployed migration was edited.

**`core-api` is up but `/readyz` returns 503.** Postgres is unreachable. Check
`docker compose ps postgres` and its logs; usually a wrong `POSTGRES_PASSWORD`
after a `.env` edit, and note that changing it does *not* change the password
inside an existing `pgdata` volume — `ALTER USER` for that.

**Every admin call returns 503.** `ADMIN_TOKEN` is unset or shorter than 16
characters. The admin API fails closed.

**A worker enrolls, then never heartbeats.** Almost always the tunnel or the
WAF. From the worker host:
`curl -sv https://publoader.ardax.dev/api/v1/worker/heartbeat` should give 401
(reached the API, no token), not 403/404/timeout. A 403 usually means a WAF rule
is matching more than intended.

**Enrollment returns 403.** The token was single-use and already spent, or it
expired, or it was revoked. Mint a fresh one — they are cheap.

**Jobs sit `PENDING` with idle workers.** Either the platform is paused (check
`paused` in `/api/v1/admin/stats`, resume with
`POST /api/v1/admin/resume`), the extension is disabled, or the job's
`min_trust` is `TRUSTED` and every worker is `COMMUNITY`.

**MangaDex calls fail with "Connection refused" from `core-processor` or
`core-uploader`.** A filtering DNS resolver on the LAN is sinkholing
`mangadex.org`. Both services already override DNS to `1.1.1.1`/`8.8.8.8` for
this reason (see the `x-public-dns` anchor); remove it if your network does not
filter, and check it first if you changed it.

**A service restarts in a loop with `EROFS` or a permissions error.** Something
is writing outside `/tmp`. That is the `read_only: true` root filesystem working
as intended — fix the write path rather than removing the flag.

**The scheduler seems stuck.** It has no healthcheck (no port, no heartbeat
file) and autoheal is deliberately absent, because autoheal requires mounting
`docker.sock` into the stack — a much larger risk than the failure mode it
fixes. Detect a wedged scheduler with the scheduler-lag metric on
`/metrics`, and restart it by hand.
