# Operations runbooks

Date: 2026-07-29
Audience: whoever is on the other end of "publoader stopped uploading".

Every procedure here assumes:

```bash
export PUBLOADER_API_URL=https://publoader.ardax.dev
export PUBLOADER_ADMIN_TOKEN=<admin token>
alias padmin='node /path/to/publoader/platform/dist/src/cli/admin.js'
```

`padmin` sends your `$USER` as `X-Actor`, so everything you do below appears in
`padmin audit`. If you are running from inside the core compose network instead,
use `PUBLOADER_API_URL=http://core-api:8100`.

**The two commands to run first, always:**

```bash
padmin stats        # queue depths, worker counts, pause state
padmin dead-letter  # what has already given up
```

---

## The dashboard

Everything in this document can also be done from a browser at
`https://publoader.ardax.dev/`. It is the same admin API with a login screen,
so the CLI remains authoritative and the two are interchangeable — every
dashboard action lands in `padmin audit` exactly like a CLI one.

**Sign in** with your email and password, or with Discord if this deployment
has OAuth configured. Your account name becomes the audit actor, so "who paused
the platform" is answerable without anyone having to set a header.

If you have no account yet, or nobody does — a fresh database seeds one `OWNER`
(`DASH_OWNER_EMAIL`) with no credentials — use **"Use the admin token
instead"** on the login page, then **Users → Set password**. That is the
bootstrap path and the break-glass path both.

Sessions last `SESSION_TTL_MINUTES` (12h default) and are individually
revocable from **Users → Live sessions**. Full setup, including the Discord
OAuth application, is in `docs/deployment.md` → "Dashboard".

### Someone left the team

```
Users → their row → Delete        # revokes their sessions by cascade
```

If you want to keep the account but cut access now, **Revoke** each of their
live sessions and change their password — a password change on its own does
*not* invalidate sessions already issued.

To take away only their ability to manage other operators, set them to `ADMIN`.
Be clear-eyed about what that does and does not contain: an `ADMIN` still has
full control-plane authority, including publishing bundles, which is code
execution on every worker. It is not a safe role for someone you no longer
trust — deletion is.

### Approving a new operator

With self-signup on (**Users → Self-signup**), a Discord login by someone
unknown creates an unapproved `ADMIN` row and shows them "awaiting approval".
Nothing else happens until you act: they cannot sign in, and no endpoint is
reachable. Approve from **Users**, or leave it and delete the row.

With self-signup off (the default), an unknown Discord login is refused
outright. Invite them instead — **Users → Invite** with their email — and they
get in by linking Discord with that same verified email, or by you setting a
password for them.

Three operational flows are worth calling out because they are easier to get
wrong in a UI than on a command line.

### Enrol a worker from the dashboard

**Workers → Enroll new worker.** Pick the trust tier (leave `COMMUNITY` unless
you control the machine), a note naming the host, and a TTL.

The token is displayed **once**, inside a ready-made compose snippet with
`CORE_URL` and `ENROLL_TOKEN` already filled in. Copy it before closing the
dialog — there is no way to retrieve it, and the only recovery is minting
another and letting the first expire. Send it over a private channel; it is a
bearer credential until it is spent.

Everything else matches the CLI flow below: the agent exchanges the token for a
permanent one on first contact, and the row appears under **Workers** once it
heartbeats.

### Approve an untracked series

**Untracked → filter `NEW` → Approve.** This creates a real MangaDex title
synchronously and **cannot be undone from the dashboard**, so it asks for
confirmation first.

Check the series name, language, and source URL before approving — the common
mistake is approving something that already exists on MangaDex under a
different name, which produces a duplicate title. When it already exists, use
**Extensions → Configure → Tracked manga** to point the external id at the
existing MangaDex UUID instead, and **Skip** the untracked row.

On success the toast contains the new `https://mangadex.org/title/<id>` link,
and the row moves to `TRACKED` with the same link in the table.

### Trigger a run — and what `Clean` means

**Extensions** gives each published bundle three buttons:

| Button | Kind | What it does |
|---|---|---|
| Run | `UPDATE` | Normal incremental run. |
| Force | `FORCE` | Ignores the schedule and the already-posted set. |
| Clean | `CLEAN` | Re-reads the extension's entire back catalogue. |

`Clean` is destructive and confirms before firing. A clean run compares the
full catalogue against what is on MangaDex and can queue **deletions** for
chapters the extension no longer reports — a source-side outage that hides
chapters therefore looks identical to chapters being removed. Check the
extension is healthy first — **Runs** tab, or `padmin runs list`.

Note you cannot pre-pause as a safety net: `POST /runs` returns 409 while the
platform is paused. The recovery lever is the other way round — if a clean run
does queue deletions you did not want, hit **Pause** on the Overview tab
immediately. The uploader honours the pause gate, so queued upload tasks stop
before they execute and you can inspect them.

Runs started from the dashboard get a server-generated idempotency key, so
double-clicking creates two runs. Watch the **Runs** tab rather than clicking
again.

---

## Enrol a worker

Workers are outbound-only: they need no inbound ports, no static IP, and no
firewall changes. Enrolment is a one-time token exchange.

**1. Mint a token** (operator side). Default trust is `COMMUNITY`; pass
`--trust` only for machines you control.

```bash
padmin enroll-token create --note "hetzner-fsn-1" --ttl-hours 24
padmin enroll-token create --trust --note "arda-desktop" --ttl-hours 4
```

The token is displayed once. It is single-use and expires; there is no way to
retrieve it again, so if you lose it, mint another and let the first expire.

**2. Start the agent** (worker side).

```bash
cd publoader/platform/docker/worker
cp .env.example .env
# WORKER_NAME=hetzner-fsn-1
# ENROLL_TOKEN=pe_...
docker compose up -d --build
docker compose logs -f worker-agent
```

The agent exchanges the token for a permanent worker token, persists it to the
`worker-state` volume, and starts long-polling. Once it has enrolled, remove
`ENROLL_TOKEN` from `.env` — it is spent.

**3. Confirm** (operator side).

```bash
padmin workers list
```

`STATUS` should be `ACTIVE` and `HEARTBEAT` under a minute. If the worker never
appears, the enrolment failed — check `padmin audit` for a
`worker.enroll.rejected` event, which records the source IP and the name that
was attempted.

**Enrolling by hand** (useful when debugging, or provisioning without compose):

```bash
curl -fsS -X POST https://publoader.ardax.dev/api/v1/worker/enroll \
  -H 'content-type: application/json' \
  -d '{"enrollToken":"pe_...","name":"hetzner-fsn-1","agentVersion":"1.0.0"}'
# -> 201 {"workerId":"...","workerToken":"pw_...","trust":"COMMUNITY"}
```

Store the returned `workerToken` as `WORKER_TOKEN` in the worker's `.env`. A
403 here means the enroll token is invalid, expired, or already used.

---

## Drain, revoke, and re-enrol a worker

**Drain** — take a worker out of rotation without interrupting its current job.
Use this for planned maintenance, host reboots, and agent upgrades.

```bash
padmin workers drain <workerId>
```

The worker finishes its in-flight job and its next lease request returns 204
with a `drained` flag, so it idles instead of polling hard. Watch `padmin stats`
until no job is leased to it, then do your maintenance.

```bash
padmin workers activate <workerId>     # back into rotation
```

**Revoke** — permanently invalidate the credential. Use this when a host is
decommissioned, a token may have leaked, or a community worker is misbehaving.

```bash
padmin workers revoke <workerId>
```

Revocation is immediate: the next request from that token gets 401. Any job it
holds a lease on keeps that lease until it expires, then the sweeper requeues
it — so expect a job to be re-run within `LEASE_TTL_SECONDS` (default 300).
There is no way to un-revoke; re-enrol instead.

**Re-enrol** after revocation or after wiping the worker's state volume:

```bash
# operator
padmin enroll-token create --note "hetzner-fsn-1 re-enrol"
# worker
docker compose down
docker volume rm worker_worker-state      # only if the old identity is dead
# set ENROLL_TOKEN in .env
docker compose up -d
# operator: the old worker row is now a zombie — revoke it
padmin workers revoke <oldWorkerId>
```

A revoked worker row is kept deliberately: it is the audit record of what that
worker submitted.

---

## Upgrade the core

Core services are stateless; the schema is not. Migration runs first, as a
one-shot container, and every service waits on it.

```bash
cd platform/docker/core

# 1. Quiesce. Not strictly required for additive migrations, but it means an
#    in-flight MangaDex upload cannot be interrupted by a restart.
padmin pause --minutes 30

# 2. New image.
#    Set PUBLOADER_CORE_IMAGE in .env to the new tag, or rebuild from source:
docker compose build

# 3. Migrate + restart. `up -d` reruns `migrate deploy` (idempotent — it applies
#    only migrations absent from _prisma_migrations) before starting services.
docker compose up -d

# 4. Verify.
docker compose ps                                  # migrate exited 0
curl -fsS https://publoader.ardax.dev/healthz
docker compose exec core-api node -e "fetch('http://127.0.0.1:8100/readyz').then(r=>r.text()).then(console.log)"
padmin stats

# 5. Resume.
padmin resume
```

**If migrate exits non-zero**, no application service starts and the old
containers keep running until you `up` successfully — the stack fails closed.
Read `docker compose logs migrate`, fix the migration, retry. Do not run
`prisma migrate reset` against production; it drops the database.

**Rolling back a core upgrade** is only safe if the migration was additive. If
it was not, restore from backup (below) — which is why you take one before a
schema-changing upgrade.

---

## Upgrade a worker fleet

Workers are independent and versions may be mixed, because every job pins the
extension bundle it needs by sha256. There is no fleet-wide flag day.

Rolling upgrade, one worker at a time:

```bash
# operator
padmin workers drain <workerId>
# wait until it holds no lease
padmin stats

# worker host
cd platform/docker/worker
docker compose pull      # or: docker compose build
docker compose up -d

# operator
padmin workers activate <workerId>
padmin workers list      # AGENT column shows the new version after a heartbeat
```

If you skip the drain, nothing breaks — the agent's in-flight job loses its
lease, the sweeper requeues it, and another worker picks it up. Draining just
avoids the wasted work.

For community workers you cannot drain-and-upgrade on demand: publish the new
image tag, and let operators update at their own pace. If an old agent version
becomes incompatible, `workers revoke` is the enforcement mechanism.

---

## Rotate secrets

### Dashboard credentials

An operator password: **Users → Set password** (owner), or the operator does it
themselves from their own row. Minimum 12 characters, scrypt-hashed at rest.
Then revoke their live sessions — a password change does *not* invalidate
sessions already issued.

To sign *everyone* out there is no single lever: revoke each session under
**Users → Live sessions**, or in an emergency go straight at the table.

```bash
psql "$DATABASE_URL" -c "UPDATE admin_sessions SET revoked = true"
```

Rotating `SESSION_SECRET` does not log anyone out — it signs the OAuth state
cookie only, so rotating it breaks Discord logins that are mid-flight and
nothing else. Rotating `ADMIN_TOKEN` likewise leaves existing sessions alive,
including any created with the old token.

### Worker token

Workers can rotate their own credential without operator involvement — the swap
is atomic and the old token dies with it:

```bash
curl -fsS -X POST https://publoader.ardax.dev/api/v1/worker/token/rotate \
  -H "authorization: Bearer $WORKER_TOKEN"
# -> {"workerToken":"pw_..."}
```

The agent persists the new token to its state volume. Operator-side, the
alternative is `workers revoke` + re-enrol, which also changes the worker id.

### Admin token

The admin token is held by you and the Discord bot. (The dashboard no longer
holds a copy — operators sign in with their own accounts, and the token is only
its break-glass path.) Rotating it breaks the CLI and the bot until they are
updated, so do it in this order:

```bash
NEW=$(openssl rand -base64 48)

# 1. Update .env: ADMIN_TOKEN=$NEW
# 2. Restart only core-api — the other services do not read it.
docker compose up -d core-api
# 3. Update your own shell, then the bot's config, then restart it.
export PUBLOADER_ADMIN_TOKEN=$NEW
padmin stats
```

There is one admin token and no overlap window in v1, so expect a brief period
where the bot returns errors. Rotate at a quiet time.

If `ADMIN_TOKEN` is unset, the admin API answers 503 — it fails closed. A typo
in `.env` locks you out of the API but does not stop uploads.

### MangaDex credentials

Only `core-uploader` and `core-processor` hold these. Nothing else in the system
— and definitely no worker — ever sees them.

```bash
padmin pause --minutes 15          # let in-flight uploads finish
# Change MANGADEX_PASSWORD / MANGADEX_CLIENT_SECRET in .env
docker compose up -d core-uploader core-processor
docker compose logs -f core-uploader     # watch for a successful auth
padmin resume
```

Then revoke the old MangaDex API client in the MangaDex account settings. If
you are rotating because the credential leaked, revoke **first** and accept the
downtime — a live stolen credential is worse than a paused queue.

### Database password

```bash
docker compose exec postgres psql -U publoader -d publoader \
  -c "ALTER USER publoader WITH PASSWORD '<new>';"
# Update POSTGRES_PASSWORD (and DATABASE_URL if you set it explicitly) in .env
docker compose up -d
```

---

## Stuck jobs and the dead-letter queue

A job reaches `DEAD_LETTER` when it exhausts `maxAttempts` on transient errors,
or immediately on a `PERMANENT` or `POLICY` error.

```bash
padmin dead-letter
padmin runs show <runId>        # per-job attempt count, lease holder, lastError
```

Read the `CLASS` column first — it tells you what kind of problem you have:

| Class | Meaning | What to do |
|---|---|---|
| `TRANSIENT` | Retried and kept failing. Site down, rate limited, network. | Fix the cause, then `padmin jobs retry <id>`. |
| `PERMANENT` | The extension raised something that will not succeed on retry. | Read `lastError`. Usually an extension bug or a site layout change — fix the extension, `bundle publish`, then trigger a fresh run rather than retrying the old job (the old job is pinned to the old bundle sha). |
| `POLICY` | The worker refused to run it, or the result violated the manifest. | Almost always a manifest problem: `allowed_hosts` missing a domain the extension fetches, a language not declared, wrong `mangadex_group_id`, or a bundle sha the worker could not obtain. Fix and republish. |

**Retry** a dead-lettered job:

```bash
padmin jobs retry <jobId>
```

This resets it to `PENDING` with the attempt counter cleared. It re-executes on
whichever worker claims it next.

**Cancel** instead, when the job should not run at all:

```bash
padmin jobs cancel <jobId>
```

**A job stuck in `LEASED` or `RUNNING`** is not stuck — it holds a lease that
expires. The sweeper (`SWEEP_INTERVAL_SECONDS`, default 30) requeues it once
`leaseExpiresAt` passes. If you see a job whose `LEASE EXPIRES` is in the past
and it has not moved after two sweep intervals, the scheduler is not running:

```bash
docker compose ps core-scheduler
docker compose logs --tail 100 core-scheduler
curl -s http://core-api:8100/metrics | grep publoader_scheduler_lag_seconds
```

---

## Quarantine triage

A quarantined result is a worker that submitted something the core refused to
believe. This is the security-relevant queue, not just an error queue.

```bash
padmin quarantine
```

Each row names the worker and the reason. Group them mentally:

**Reasons that mean "manifest is wrong"** — the common case, and not an attack:

- `host not in allowed_hosts` — the extension fetches a domain the manifest
  does not declare. Add it, republish, re-run.
- `language not in manifest languages` — the extension returned a language the
  manifest does not list.
- `mangadexGroupId mismatch` — the extension returned a group id different from
  the manifest's. Verify which one is correct before "fixing" the manifest;
  uploading under the wrong group is worse than a quarantined result.

**Reasons that mean "look harder"**:

- Schema violations (unknown fields, wrong types) from a worker running a
  bundle sha you published. The core and the worker validate against the same
  contract, so a mismatch here means the worker is not producing what the
  runner shim produces — i.e. it is not running the code you think it is.
- Counts over cap, or chapter ids for manga outside the job's segment. The
  runner filters to the segment's manga ids, so seeing others means the filter
  was bypassed.

**If one worker accounts for most of the quarantine:**

```bash
padmin quarantine | awk '{print $3}' | sort | uniq -c | sort -rn
padmin workers drain <workerId>      # stop giving it work
padmin audit --limit 200             # what else has it done
```

Then decide: a `COMMUNITY` worker producing invalid envelopes gets revoked. A
`TRUSTED` worker doing so is a bug in the agent or the shim, and you should
find it before re-activating.

**Nothing quarantined ever reaches MangaDex.** Quarantine is terminal for that
submission — the job is retried and re-run rather than the envelope being
"fixed". There is no approve-and-commit path, deliberately.

---

## Triage a stuck upload task

Upload tasks are the MangaDex-facing half of the pipeline: one row per chapter
to upload, edit, delete, or mark unavailable. A chapter that scraped fine but
never appeared on MangaDex is stuck here, not in a job.

```bash
padmin queues list                                  # depths + rows
padmin queues list --state DEAD_LETTER               # the ones that gave up
padmin queues list --kind DELETE --state PENDING
```

Read the state first:

| State | Meaning | What to do |
|---|---|---|
| `PENDING` | Waiting for an uploader to claim it. `NOT BEFORE` in the future means it is backing off after a failure. | Nothing, unless `NOT BEFORE` is long past and nothing moves — then `core-uploader` is not running. |
| `LEASED` | An uploader is working on it right now. | Nothing. Look at `core-uploader`'s logs if it never leaves this state. |
| `FAILED` / `DEAD_LETTER` | Retries exhausted, or a permanent MangaDex rejection. `ERROR` says which. | Fix the cause, then `padmin queues retry <id>`. |
| `DONE` | Finished — or cancelled. A cancelled row says so in `ERROR`. | Nothing. |

**Retry** once the cause is fixed. This clears the attempt counter, so the task
gets a full budget rather than dead-lettering on the first hiccup:

```bash
padmin queues retry <taskId>
```

**Cancel** when the task should never run. There is no `CANCELLED` state, so the
row is marked `DONE` with an operator note in `lastError` — a bare `DONE` would
be indistinguishable from a chapter that actually uploaded:

```bash
padmin queues cancel <taskId>
```

Cancel refuses (409) on a `LEASED` row. An uploader owns that task; forcing it
`DONE` would race that process into either a duplicate upload or a lost result.

**Nothing is draining at all.** The usual cause is an uploader that died holding
leases. Leases expire on their own, but you can reclaim them now:

```bash
padmin queues requeue-stale       # only touches leases already past expiry
docker compose ps core-uploader
docker compose logs --tail 100 core-uploader
```

If tasks are `PENDING` with `NOT BEFORE` in the past and `requeue-stale`
reclaims nothing, the queue is fine and the consumer is not: check the pause
gate (`padmin stats`) before anything else.

**Everything that failed, in one list.** Dead-lettered jobs, failed upload
tasks, and quarantined submissions merged and time-ordered — the fastest way to
see whether a bad hour was one cause or three:

```bash
padmin errors --limit 100
```

This is deliberately *not* a log endpoint. **Container logs stay on the host**:
work executes in containers (and on remote worker hosts) that the core cannot
read, so `docker compose logs -f core-uploader` remains the way to read them.
`padmin errors` reports platform state; `docker logs` reports processes. The
same split holds in the dashboard: Errors shows the feed, and nothing in the UI
tails a log file.

---

## Clear a bad MangaDex session

The MangaDex token pair lives in the `settings` table (`mdauth_access` /
`mdauth_refresh`) so a restarted or replaced container resumes the same session.
The failure mode that creates is a *persistently* bad session: a refresh token
MangaDex no longer honours survives a restart, and every upload keeps failing to
authenticate.

Check first — this never prints the tokens themselves:

```bash
padmin mangadex auth
# accessToken   saved
# refreshToken  saved
# expiresAt     2026-07-29T22:41:03.000Z
# expired       true
# expiresIn     -12m
```

`expired true`, or repeated auth failures in `core-uploader`'s logs, means the
saved pair is the problem:

```bash
padmin mangadex clear-auth
```

The next MangaDex call authenticates from `MANGADEX_USERNAME` /
`MANGADEX_PASSWORD` / `MANGADEX_CLIENT_*` and writes a fresh pair. In-flight
uploads may fail once and retry. The action is audit-logged.

What this does **not** do:

- It does not revoke anything MangaDex-side. If the credential itself leaked,
  that is a rotation — see "MangaDex credentials" above, and revoke the client
  in MangaDex first.
- It does not change the configured credentials. If those are wrong, clearing
  the session just makes the failure louder.

`expiresAt unknown` is not a fault: the expiry is read from the access token's
`exp` claim without verifying it, and a token shape we cannot parse is reported
as unknown rather than assumed dead. Do not clear a session on that alone.

---

## Issue, rotate, and revoke a client token

Machine clients (the Discord bot, CI, a monitoring probe) authenticate with a
scoped `pa_…` token carrying only the scopes that client needs, so a leaked
credential is confined to its area. `ADMIN_TOKEN` is break-glass only and should
not be a client's day-to-day credential.

**Issue.** Start from a preset — the easy path should also be the
least-privilege one:

```bash
padmin tokens scopes                       # taxonomy + recommended sets
padmin tokens create --name discord-bot \
  --scopes runs:write,workers:read,extensions:read,untracked:write,stats:read,audit:read
padmin tokens create --name ci-publisher --scopes bundles:write --ttl-days 90
```

The secret is printed once and is unrecoverable — the database stores only its
sha256. Hand it over through a private channel.

**Rotate.** There is no reveal endpoint, so rotation is mint-then-revoke, which
also gives you an overlap window the `ADMIN_TOKEN` rotation does not have:

```bash
padmin tokens create --name discord-bot-2026-07 --scopes <same scopes>
# update the client's config, restart it, confirm it works
padmin tokens list                         # LAST USED confirms the new one is live
padmin tokens revoke <oldTokenId>
```

**Revoke.** Immediate and irreversible:

```bash
padmin tokens revoke <tokenId>
```

Revoke on any suspicion. `LAST USED` (throttled to one write per token per
minute, so treat it as approximate) is how you tell a dead credential from one
still in use before pulling it.

All of this is also in the dashboard's **Tokens** view, which is OWNER-only:
minting a token can grant any scope, so it is privilege escalation and stays a
human, owner-level action. No `pa_…` token — not even one scoped `*` — can mint
another token or touch accounts.

---

## Untracked series triage

When an extension reports a series that has no `tracked_manga` mapping, the
processor records an `untracked_manga` row instead of dropping it. What happens
next depends on the extension's manifest:

- `auto_create_titles: true` — the title service (inside `core-uploader`)
  creates and commits the MangaDex title automatically, writes the mapping into
  `tracked_manga`, and announces it to Discord with a
  `https://mangadex.org/title/<id>` link.
- `auto_create_titles: false` (the default) — the row sits at `NEW` until an
  operator approves or skips it. Nothing is created on MangaDex without you.

```bash
padmin untracked list                 # everything
padmin untracked list --state NEW     # awaiting your decision
padmin untracked list --state FAILED  # creation was attempted and failed
```

### States

| State | Meaning |
|---|---|
| `NEW` | Reported, nothing done. Awaiting auto-creation or your approval. |
| `CREATING` | A title service instance has claimed it (CAS) and is calling MangaDex. Transient. |
| `CREATED` | The MangaDex title exists but the mapping is not yet written. Transient. |
| `TRACKED` | Done. `mdMangaId` is set and a `tracked_manga` row exists. |
| `FAILED` | Creation was attempted and failed. `lastError` says why. |
| `SKIPPED` | You decided this series should never get a title. Terminal. |

### Triaging `NEW`

For each row, decide whether the series should exist on MangaDex at all.
Check `MANGA`, `LANG`, and the source URL first — the common reasons to skip
are a series that already has a MangaDex title under a different name (the
mapping is missing, not the title), a duplicate the extension emitted under two
ids, or something the group does not actually translate.

```bash
# Already on MangaDex under a different id — map it instead of creating one.
padmin tracked set <extension> <externalMangaId> <mdMangaId>
padmin untracked skip <id>

# Genuinely new — create it now.
padmin untracked approve <id>
# -> prints the new mdMangaId and its mangadex.org URL

# Should never exist.
padmin untracked skip <id>
```

`approve` is synchronous: it creates the title, writes the mapping, announces
it, and returns the `mdMangaId`. It returns 409 if the row is not in `NEW` or
`FAILED`, and 503 if you hit an API instance without the title service
configured.

**Approval is not reversible from here.** There is no un-create — deleting a
MangaDex title is a MangaDex-side operation. Read the row before approving.

### Triaging `FAILED`

`lastError` is the MangaDex API's complaint. The usual causes:

- **Validation rejected the draft** — a missing or malformed field in the
  manifest's `title_defaults` (original language, content rating, status). Fix
  the manifest, republish, then approve. Approving a `FAILED` row resets its
  attempt budget.
- **Rate limited or transient 5xx** — just approve again.
- **Duplicate title** — MangaDex already has it. Map it by hand with
  `tracked set` and then `untracked skip`.

```bash
padmin untracked list --state FAILED
padmin untracked approve <id>       # retries with a fresh attempt budget
```

### Rows stuck in `CREATING`

`CREATING` is a CAS claim held by one title-service instance. If a row has sat
there for more than a few minutes, the uploader died mid-creation. Check
whether the title actually got made on MangaDex before doing anything else — if
it did, map it with `tracked set` and skip the row, or you will create a
duplicate.

```bash
docker compose logs --tail 200 core-uploader | grep -i untracked
```

### A flood of untracked rows

Dozens or hundreds of `NEW` rows appearing at once is almost never a real
publisher event. It means the platform thinks nothing is tracked:

```bash
padmin tracked list <extension> | tail -1     # expect thousands, not zero
```

If that count is zero or implausibly low, the bundle's config seed did not land
(see `docs/migration-guide.md` stage 3a). **`padmin pause` immediately** if any
affected extension has `auto_create_titles: true` — otherwise the title service
will start creating hundreds of duplicate MangaDex titles, and cleaning that up
is manual and slow. Fix the tracking data, then skip the bogus rows in bulk
before resuming.

---

## Config lives in the database, not in JSON files

`manga_id_map.json` and `override_options.json` are **seed data**, imported
once when a bundle is first published. After that the database wins and
republishing does not overwrite it. Editing the files on a live deployment
changes nothing.

```bash
padmin tracked list <extension>
padmin tracked set <extension> <externalMangaId> <mdMangaId>
padmin tracked remove <extension> <externalMangaId>

padmin ext-config get <extension>                 # prints JSON
padmin ext-config set <extension> ./overrides.json
padmin ext-config get ext-a | padmin ext-config set ext-b   # or from stdin
```

`ext-config set` **replaces** the whole document — it is not a merge. Get it,
edit it, set it back:

```bash
padmin ext-config get mangaplus > /tmp/o.json
$EDITOR /tmp/o.json
padmin ext-config set mangaplus /tmp/o.json
```

Both are audited, so `padmin audit` shows who repointed a mapping and when.

---

## Lease-expiry storms

Symptom: `publoader_lease_expiries_total` climbing fast, jobs cycling
`PENDING → LEASED → PENDING`, `publoader_jobs_requeued_total` rising, and
little or nothing succeeding.

```bash
curl -s http://core-api:8100/metrics | grep -E 'lease_expiries|jobs_requeued|job_queue_depth'
padmin workers list      # heartbeat ages
```

Diagnose in this order:

1. **Is one worker taking leases and dying?** Check `runs show` for jobs whose
   `WORKER` is the same id repeatedly. Drain it.
2. **Are jobs genuinely slower than the lease TTL?** A big extension on a slow
   host can exceed `LEASE_TTL_SECONDS` between renewals. The agent renews
   mid-job; if renewal is failing (network flaky, core overloaded) the lease
   dies while the work is still running — and the work is then done twice.
   Raise `LEASE_TTL_SECONDS` in the core `.env` and restart `core-api` and
   `core-scheduler`.
3. **Is the core overloaded?** If `core-api` is returning 429 or 5xx to renew
   calls, every worker's lease expires at once. Check `docker compose logs
   core-api` and the rate-limiter settings.
4. **Did a network partition just heal?** A batch of leases all expiring
   together after a connectivity blip is self-correcting — the jobs requeue and
   run. Watch rather than intervene.

**Emergency stop** while you work it out:

```bash
padmin pause
```

This stops new leases being granted. Existing leases still expire and requeue,
but nothing new starts, and the churn dies down.

---

## Pause and resume

```bash
padmin pause                 # indefinite
padmin pause --minutes 30    # auto-resume
padmin resume
padmin stats                 # confirm
```

Pause is stored in Postgres, so every replica honours it immediately — there is
no per-process state to get out of sync. It gates: new scheduler runs, new job
leases, and upload-task draining. It does **not** abort in-flight work; a
chapter mid-upload finishes.

Use pause for: upgrades, credential rotation, "something is wrong and I need to
think", and any time you are unsure whether the platform is about to do
something to MangaDex that you cannot undo.

---

## Backup and restore

The only durable state is the `pgdata` volume. Bundles, artifacts, chapter
history, queues, and audit all live there.

**Backup** (run on a schedule — daily is reasonable):

```bash
cd platform/docker/core
docker compose exec -T postgres pg_dump -U publoader -Fc publoader \
  > "$HOME/backups/publoader-$(date +%F-%H%M).dump"
```

`-Fc` (custom format) is compressed and restores selectively. Keep at least
two weeks, and keep at least one copy off the host.

Artifacts (page images) are stored as `bytea` and dominate the dump size. If
backups get unwieldy, exclude them and accept that in-flight uploads would need
re-scraping after a restore:

```bash
docker compose exec -T postgres pg_dump -U publoader -Fc \
  --exclude-table-data=artifacts publoader > .../publoader-noart-$(date +%F).dump
```

**Restore**:

```bash
padmin pause
docker compose stop core-api core-scheduler core-processor core-uploader

docker compose exec -T postgres dropdb -U publoader publoader
docker compose exec -T postgres createdb -U publoader publoader
docker compose exec -T postgres pg_restore -U publoader -d publoader --no-owner \
  < "$HOME/backups/publoader-2026-08-01-0300.dump"

docker compose up -d        # migrate runs, then services start
padmin stats
padmin resume
```

**Test the restore path at least once**, into a scratch database, before you
need it. A dump that has never been restored is a hypothesis.

---

## Incident: an extension is failing repeatedly

Symptoms: the same extension appears repeatedly in `dead-letter`, or its runs
never reach `PROCESSED`.

**1. Establish the blast radius.** Is it one extension or all of them?

```bash
padmin dead-letter
padmin stats
```

If every extension is failing, it is not the extension — go to the lease-storm
or core-health runbooks instead.

**2. Stop the bleeding.** A broken extension retrying on a schedule wastes
worker capacity and fills the dead-letter queue:

```bash
padmin extensions disable <name>
```

This stops it being scheduled. It does not touch already-queued work.

**3. Read one failure properly.**

```bash
padmin runs list --extension <name> --limit 10
padmin runs show <runId>            # lastError on each job
padmin quarantine                   # is it failing validation rather than execution?
```

Distinguish three cases:

- **Execution failures** (dead-letter, `PERMANENT`): the extension code raised.
  Site layout changed, an API moved, a dependency broke. Fix in the extensions
  repo, `bundle publish`, re-enable.
- **Policy failures** (dead-letter, `POLICY`): the manifest disagrees with what
  the extension does. Fix the manifest.
- **Validation failures** (quarantine): the extension ran and produced output
  the core rejected. See quarantine triage above.

**4. Check whether it is the site, not us.** Try the source manually. If the
publisher is down or rate-limiting, the correct action is to leave the
extension disabled and re-enable later — not to raise `maxAttempts` and hammer
them.

**5. Fix forward.**

```bash
cd $EXTENSIONS_REPO
# ... fix ...
padmin bundle publish ./src/<name> --source-commit "$(git rev-parse HEAD)"
padmin extensions enable <name>
padmin runs trigger <name> --kind UPDATE
padmin runs show <runId>
```

Jobs are pinned to the bundle sha they were created with, so retrying an old
dead-lettered job runs the **old** code. After publishing a fix, trigger a new
run instead of retrying old jobs.

**6. Record it.** `padmin audit` has what you did; add a note to the extension's
repo about what broke and why, so the next person does not re-derive it.

---

## Failover test procedure

Run this after setup and after any change to lease handling. It proves the
property the whole distributed design rests on: **a worker dying mid-job loses
no work.**

**Setup:** two enrolled workers, both `ACTIVE`, both healthy.

```bash
padmin workers list        # expect two ACTIVE with fresh heartbeats
padmin stats
```

**1. Start a run** on an extension that takes long enough to interrupt (a
minute or more):

```bash
padmin runs trigger <extension> --kind FORCE
padmin runs show <runId>
```

**2. Identify the lease holder.** In `runs show`, note the `WORKER` column and
the `LEASE EXPIRES` time.

**3. Kill that worker hard.** Not a graceful stop — a graceful stop is a
different (easier) test:

```bash
# on the worker host
docker kill publoader-worker
```

**4. Observe the job stay leased and then requeue.** For up to
`LEASE_TTL_SECONDS` (default 300) nothing happens — this is correct. The core
cannot distinguish "crashed" from "slow", so it waits for the lease to expire
rather than double-running the job.

```bash
watch -n 15 "padmin runs show <runId>"
```

Expected sequence: job stays `LEASED`/`RUNNING` with the dead worker → lease
expires → sweeper requeues it as `PENDING` with `attempt` incremented → the
surviving worker claims it → `SUCCEEDED`.

**5. Confirm the run completes** and the result is committed exactly once:

```bash
padmin runs show <runId>            # state PROCESSED
padmin quarantine                   # still empty
curl -s http://core-api:8100/metrics | grep -E 'lease_expiries|envelopes_(committed|superseded)'
```

`publoader_lease_expiries_total` should have incremented by one.

**6. Restart the killed worker** and confirm it rejoins:

```bash
docker compose up -d
padmin workers list
```

**7. The late-submission case.** If the killed worker had already finished and
was mid-submit, it may submit after the successor. That envelope must be
recorded as `SUPERSEDED`, not committed twice —
`publoader_envelopes_superseded_total` increments and
`publoader_envelopes_committed_total` does not. To force this case, pause the
worker's network instead of killing it (`docker network disconnect`), let the
lease expire, then reconnect.

**Pass criteria:** the run completes, exactly one result is committed per job,
nothing is quarantined, and no chapter is uploaded twice.

---

## Monitoring quick reference

`/metrics` on `core-api` (Prometheus format). It is **not** authenticated and
must be blocked at the Cloudflare edge — it leaks fleet and queue topology.
Scrape it from inside the compose network.

Metric names are defined in `platform/src/metrics.ts`.

### Counters

| Metric | Labels | Watch for |
|---|---|---|
| `publoader_jobs_created_total` | extension, kind | Flat when it should not be = scheduler is not ticking. |
| `publoader_jobs_leased_total` | extension | Flat with a non-zero queue = no workers claiming. |
| `publoader_jobs_succeeded_total` | extension | The success signal. |
| `publoader_jobs_requeued_total` | extension, reason | Rising = retry churn. |
| `publoader_jobs_dead_letter_total` | extension | Any increase deserves a look. |
| `publoader_lease_expiries_total` | extension | Rising = workers dying or renewals failing. |
| `publoader_envelopes_received_total` | extension | |
| `publoader_envelopes_quarantined_total` | extension, reason | **Security signal.** Any sustained rise is an incident. |
| `publoader_envelopes_superseded_total` | extension | Late/duplicate results. Small numbers are normal after a failover. |
| `publoader_envelopes_committed_total` | extension | Should track `received` minus quarantined/superseded. |
| `publoader_md_uploads_total` | outcome | `outcome="failure"` rising = MangaDex problem or bad credential. |

### Gauges

| Metric | Labels | Watch for |
|---|---|---|
| `publoader_job_queue_depth` | state | `PENDING` growing without bound = not enough worker capacity. |
| `publoader_upload_tasks` | kind, state | `DEAD_LETTER` non-zero = uploads failing permanently. |
| `publoader_workers` | status | `ACTIVE` dropping = fleet shrinking. |
| `publoader_scheduler_lag_seconds` | — | Seconds since the last scheduler tick. **The single best liveness signal for the control plane.** |

### Histogram

`publoader_job_duration_seconds{extension}` — lease-to-submit. Buckets 10s to
1h. A p95 approaching `LEASE_TTL_SECONDS` predicts lease-expiry storms before
they happen.

### Suggested alerts

Tune to your traffic; these are starting points, not tuned thresholds.

| Alert | Condition | Severity | Why |
|---|---|---|---|
| Scheduler stalled | `publoader_scheduler_lag_seconds > 180` for 5m | page | Nothing is being scheduled or swept. Everything else follows from this. |
| No active workers | `sum(publoader_workers{status="ACTIVE"}) == 0` for 10m | page | No capacity at all. |
| Queue backing up | `publoader_job_queue_depth{state="PENDING"} > 50` for 30m | warn | Capacity shortfall, or nothing is claiming. |
| Dead-letters | `increase(publoader_jobs_dead_letter_total[1h]) > 5` | warn | An extension or the platform is broken. |
| Quarantine | `increase(publoader_envelopes_quarantined_total[1h]) > 0` | warn | Security-relevant; investigate every time until you know the cause. |
| Quarantine burst | `increase(publoader_envelopes_quarantined_total[15m]) > 10` | page | A worker is submitting garbage at volume. |
| Lease churn | `rate(publoader_lease_expiries_total[15m]) > rate(publoader_jobs_succeeded_total[15m])` | warn | More jobs are timing out than completing. |
| Upload failures | `increase(publoader_md_uploads_total{outcome="failure"}[15m]) > 5` | page | Credential expired, MangaDex down, or a bad payload. |
| Upload dead-letter | `publoader_upload_tasks{state="DEAD_LETTER"} > 0` | warn | Chapters that will never be posted without intervention. |
| Job duration creep | `histogram_quantile(0.95, publoader_job_duration_seconds) > 0.8 * LEASE_TTL_SECONDS` | warn | Lease-expiry storm forming. |

### Health endpoints

- `GET /healthz` — process is alive. This is the container healthcheck.
- `GET /readyz` — Postgres reachable and migrations applied. Deliberately
  **not** the container healthcheck: a Postgres restart should not cascade into
  killing the API.

Both are unauthenticated and both are blocked at the edge.

---

## Incident checklist

Print this. Work top to bottom.

1. `padmin stats` — is it paused? are there workers? how deep are the queues?
2. `padmin dead-letter` — what has already failed?
3. `padmin quarantine` — is a worker submitting bad data? (security-relevant)
4. `padmin untracked list --state NEW` — is a flood of series about to have
   MangaDex titles created for it? If yes, `padmin pause` before anything else.
5. `padmin workers list` — heartbeat ages; is the fleet there?
6. `curl -s http://core-api:8100/metrics | grep scheduler_lag` — is the clock running?
7. `docker compose ps` — is everything up? did `migrate` exit 0?
8. `docker compose logs --tail 200 core-api core-scheduler core-uploader`
9. **If unsure, `padmin pause`.** Stopping is cheap; an incorrect upload to
   MangaDex is not.
10. `padmin audit --limit 100` — did a human change something just before this started?
11. Once resolved: `padmin resume`, then verify with `padmin stats` and a spot
    check on MangaDex.
