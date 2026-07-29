# Development

Getting the platform running locally, changing it, and proving the change works.

Everything in this document runs from `platform/` unless stated otherwise.

**Contents**

- [Prerequisites](#prerequisites)
- [First-time setup](#first-time-setup)
- [The local stack](#the-local-stack)
- [Running services from source](#running-services-from-source)
- [The Prisma workflow](#the-prisma-workflow)
- [Tests](#tests)
- [Debugging a failing job](#debugging-a-failing-job)
- [Code conventions](#code-conventions)
- [Common tasks](#common-tasks)

---

## Prerequisites

| Tool | Version | Why |
| --- | --- | --- |
| Node | **24** | The images pin `node:24-bookworm-slim` by digest, esbuild targets `node24`, and the runner's permission flags were verified against 24 — notably that a comma-separated `--allow-fs-read` list is no longer accepted (`src/worker/executor.ts:290-293`). `package.json` says `>=22`, but develop on 24 |
| pnpm | 10.12.1 | Pinned in the Dockerfiles via corepack. `corepack enable && corepack prepare pnpm@10.12.1 --activate` |
| Docker + Compose v2 | recent | The local stack and the e2e suite |
| Postgres | 16 | Only if you want integration tests without the dev stack; otherwise the stack publishes one on `127.0.0.1:55432` |

`python3`, `zip`, and `curl` are needed by `test/e2e/run-e2e.sh`. You do **not**
need Python for anything else — the worker image ships no interpreter.

---

## First-time setup

```bash
git clone <repo> && cd publoader/platform
pnpm install
pnpm exec prisma generate     # required before tsc: src/ imports the generated types
pnpm run typecheck
pnpm test                     # unit tests, no database needed
```

`prisma generate` is the step people forget. The TypeScript in `src/` imports
`@prisma/client`'s generated types, so `tsc` fails confusingly without it.

---

## The local stack

One command brings up the whole system with MangaDex faked:

```bash
./scripts/publoader dev up -d --build
```

`--build` on the first run (and after changing `src/`), since the dev images are
built locally. The switcher's `dev` branch is a thin wrapper — it just pins the
compose file and the project name `publoader-dev`
(`scripts/publoader:55-59`), so `docker compose -f docker/dev/docker-compose.yml`
works identically if you prefer.

What comes up (`docker/dev/docker-compose.yml`):

| Container | Notes |
| --- | --- |
| `postgres` | **tmpfs-backed**, so `down -v` genuinely starts clean. Published on `127.0.0.1:55432` |
| `migrate` | Runs `prisma db push` (not `migrate deploy`) plus the partial unique index by hand |
| `mock-md` | Stands in for `api.mangadex.org` **and** `auth.mangadex.org`. Published on `127.0.0.1:8200` |
| `core-api` | Published on `127.0.0.1:8100`. `ADMIN_TOKEN=dev-admin-not-a-secret` |
| `dev-bootstrap` | Mints one enroll token per worker and drops it in a shared volume, so `up` yields a live fleet with no manual step |
| `core-scheduler`, `core-processor`, `core-uploader` | Same code and commands as production |
| `worker-a`, `worker-b` | **Two**, because the interesting bugs are the concurrent ones: double-leasing, a lease expiring into a second worker mid-run, two envelopes racing |

Dev-specific tuning, so failure modes are observable within a test's patience
rather than after five minutes: `LEASE_TTL_SECONDS=30`,
`SWEEP_INTERVAL_SECONDS=5`, `SCHEDULER_INTERVAL_SECONDS=5`,
`MANGADEX_RATELIMIT_MS=0`.

The container hardening (`read_only`, `cap_drop: ALL`, non-root) is **identical to
production on purpose**: a container that only works when writable should fail on
a laptop, not on the night of the deploy.

> This stack is not secure and is not meant to be. The admin token is
> `dev-admin-not-a-secret`, the database password is `dev`, enrollment is
> automated, and the API is on loopback. Never run it on a host that accepts
> traffic from anywhere else.

### Poke at it

```bash
export PUBLOADER_API_URL=http://127.0.0.1:8100
export PUBLOADER_ADMIN_TOKEN=dev-admin-not-a-secret
alias padmin='pnpm exec tsx src/cli/admin.ts'

padmin workers list
padmin stats
padmin bundle publish test/e2e/fixtures/e2etest
padmin runs trigger e2etest --kind FORCE
padmin runs list
padmin errors

curl -s http://127.0.0.1:8200/_test/uploads | jq   # what the uploader actually did
```

The dashboard is at <http://127.0.0.1:8100/> — sign in with the admin token via
"Use the admin token instead".

### Tear it down

```bash
./scripts/publoader dev down -v      # -v also drops the worker state volumes
```

---

## Running services from source

Fast iteration: run the stack for Postgres and `mock-md`, stop the service you are
changing, and run it under `tsx` against the same database.

```bash
./scripts/publoader dev up -d --build
./scripts/publoader dev stop core-api

export DATABASE_URL='postgresql://publoader:dev@127.0.0.1:55432/publoader?schema=public'
export ADMIN_TOKEN=dev-admin-not-a-secret
export LOG_LEVEL=debug
export MANGADEX_API_URL=http://127.0.0.1:8200
export MANGADEX_AUTH_URL=http://127.0.0.1:8200/realms/mangadex/protocol/openid-connect
export MANGADEX_USERNAME=dev MANGADEX_PASSWORD=dev
export MANGADEX_CLIENT_ID=dev-client MANGADEX_CLIENT_SECRET=dev-secret
export MANGADEX_RATELIMIT_MS=0

pnpm exec tsx src/services/api.ts
```

Every entry point works this way:

| Service | Command | Extra env |
| --- | --- | --- |
| `core-api` | `tsx src/services/api.ts` | `PORT` (8100), `ADMIN_TOKEN` |
| `core-scheduler` | `tsx src/services/scheduler.ts` | `METRICS_PORT` if 8101 is taken |
| `core-processor` | `tsx src/services/processor.ts` | MangaDex vars; `METRICS_PORT` if 8102 is taken |
| `core-uploader` | `tsx src/services/uploader.ts` | MangaDex vars; `METRICS_PORT` if 8103 is taken |
| `publoader-bot` | `tsx src/services/bot.ts` | `DISCORD_BOT_TOKEN`, `BOT_API_TOKEN`, `CORE_URL`, the `DISCORD_*` authz vars |
| worker agent | `tsx src/services/worker.ts` | `CORE_URL`, `ENROLL_TOKEN` or `WORKER_TOKEN`, `WORKER_STATE_PATH` (point it at a scratch dir), optional `WORKER_EXTENSIONS` |

Two gotchas. If you run a second `core-scheduler` alongside the containerised one,
give it a different `METRICS_PORT` — an unbindable port is a deliberate boot
failure. And running a worker from source needs a writable
`WORKER_STATE_PATH`: the agent proves the directory is writable **before**
enrolling, because enrollment spends a single-use token and a host that enrolls
and then cannot persist the credential is permanently bricked
(`src/worker/credentials.ts:54-81`).

Every variable also accepts a `<NAME>_FILE` form pointing at a file whose contents
are the value — the Docker-secrets convention, honoured for *all* config
(`src/config.ts:10-16`).

---

## The Prisma workflow

**Never let `prisma migrate dev` write the SQL for a change that touches existing
columns.** It generates drop-and-add, and it has twice tried to discard every
chapter snapshot the platform holds. The two hand-written migrations in this repo
exist because that was caught in review, not in production
(see [data-model.md](data-model.md#migrations)).

The workflow:

```bash
# 1. Edit prisma/schema.prisma.

# 2. Generate the migration DIRECTORY but not the SQL you will ship.
pnpm exec prisma migrate dev --create-only --name describe_the_change

# 3. Read what it generated. If it contains DROP COLUMN, DROP TABLE, a type
#    change, or a rename it turned into drop-and-add — REPLACE IT.
#    Hand-write data-preserving SQL instead:
#      * renames        ALTER TABLE … RENAME COLUMN
#      * type changes   ADD COLUMN / UPDATE / DROP / RENAME (Postgres rejects a
#                       subquery in an ALTER … USING transform)
#      * promotions     ADD the columns, COPY the data across, park the residue,
#                       and only THEN drop the source column
#    Comment WHY, and note that it is replayable against a populated database.

# 4. Apply it and verify against data.
pnpm exec prisma migrate deploy
pnpm exec prisma generate

# 5. Prove it. Ideally against a restored backup, at minimum against a dev
#    database you seeded first.
```

Verifying step 5 properly means: seed rows before the migration, apply it, and
assert the rows are still there and still correct. `platform/test/unit/chapterRows.test.ts`
covers the round-trip through the mapping module; the migration SQL itself is
verified by applying it to a populated database.

Useful commands:

```bash
pnpm exec prisma migrate status     # what is applied
pnpm exec prisma migrate deploy     # apply pending (what the migrate container runs)
pnpm exec prisma studio             # browse the data
./scripts/publoader dev exec postgres psql -U publoader -d publoader
```

Dev and production deliberately differ: the dev stack uses `db push` because that
database is created and destroyed constantly and pushing works before a migration
history exists; production uses versioned `migrate deploy` in a one-shot container
that is the only thing in the system able to alter the schema
(`docker/core/Dockerfile`, the `migrate` target).

---

## Tests

Three layers, and each one tests something the layer below cannot.

### Unit — no database, no network

```bash
pnpm test                                    # vitest run test/unit
pnpm exec vitest run test/unit/dedupe.test.ts # one file
pnpm exec vitest watch test/unit             # watch mode
```

Fast, and covers the pure decision logic that would otherwise only be exercisable
through a full run: the upload/edit/skip/remove matrix
(`test/unit/dedupe.test.ts`), scope implication (`scopes.test.ts`), segment
determinism and non-overlap (`slots.test.ts`), the guarded fetch's allowlist and
redirect re-checking (`guardedFetch.test.ts`), bundle publish rejection rules
(`bundlePublish.test.ts`), the contracts (`contracts.test.ts`,
`extensionApi.test.ts`), and the real runner against the real fixture
(`nodeRunner.test.ts`).

### Integration — needs a real Postgres

```bash
pnpm run test:integration      # vitest run test/integration --no-file-parallelism
```

**These need a real database and mocks would prove nothing** — `SKIP LOCKED` and
partial unique indexes *are* the system under test (`test/globalSetup.ts:3-11`).

`globalSetup.ts` creates and migrates a dedicated `publoader_test` database, and
sets `TEST_DB_READY`. If the server is unreachable the integration files **skip
themselves** rather than fail, which is convenient and is also how a green run can
be meaningless — check for skips.

Point it at any server:

```bash
export TEST_DATABASE_URL='postgresql://postgres:devpass@localhost:55432/publoader_test'
```

The default assumes `postgres:16-alpine` on `55432` with password `devpass`; the
dev stack's Postgres works too (user `publoader`, password `dev`). Files share one
database and `resetDb()` truncates between tests, which is why
`--no-file-parallelism` is not optional.

What lives here: lease races and the commit marker (`lease.test.ts`), token
audience separation and the full lease→results flow (`api.test.ts`), scope
confinement (`ops.test.ts`, `tokens.test.ts`), and dashboard sessions, CSRF, and
account administration (`dashboard.test.ts`).

`test/integration/lease.test.ts` is the file to read if you want to understand the
exactly-once guarantees — each `it()` is one of the layers described in
[architecture-guide.md](architecture-guide.md#why-exactly-once-holds).

### End-to-end — the whole system in Docker

```bash
./scripts/publoader dev up -d --build
./test/e2e/run-e2e.sh                 # or --no-failover to skip step 5
```

Five steps (`test/e2e/run-e2e.sh`): publish the fixture bundle, trigger a `FORCE`
run, watch it lease to one of two real workers and execute in the real Node runner,
assert the mock MangaDex received the uploads, assert the untracked series was
persisted — then **failover**: switch the fixture into slow mode, `docker compose
kill` the worker holding the lease, and assert the *other* worker completes the
run.

That last step is the one nothing else can prove. It also demonstrates the
DB-as-config-authority property incidentally: slow mode is enabled by adding a
`tracked_manga` row through the API, with no bundle republish.

### Everything

```bash
pnpm run typecheck && pnpm run lint && pnpm test && pnpm run test:integration
```

That is the [verification sweep](../CONTRIBUTING.md#the-verification-sweep).
`pnpm run test:all` runs unit and integration together.

---

## Debugging a failing job

In roughly this order.

### 1. The dashboard's Errors view

<http://127.0.0.1:8100/> → **Errors**. One time-ordered feed merging
dead-lettered jobs, failed upload tasks, and quarantined submissions
(`GET /api/v1/admin/errors`). Each source is queried at the full limit before
merging, so a burst in one is not hidden behind old rows from another.

### 2. The CLI

```bash
padmin errors --limit 50      # the same merged feed
padmin dead-letter            # jobs that exhausted their attempts
padmin quarantine             # envelopes rejected on policy grounds
padmin runs show <runId>      # the run and every one of its jobs
padmin queues list --state DEAD_LETTER
padmin stats
```

`padmin errors` prints a note that container logs are *not* aggregated — that is
deliberate. Container logs describe processes; the API describes platform state
(`src/core/api/routes/ops.ts:10-19`).

### 3. Read the error class

It tells you what happened before you read anything else:

| `errorClass` | Meaning | Where it came from |
| --- | --- | --- |
| `TRANSIENT` | the upstream site, a timeout, a lease expiry | a throw inside `collect()`, or the sweeper |
| `PERMANENT` | the bundle is wrong — will not import, factory throws, malformed result | the runner's classification (`runner.mjs:754`) |
| `POLICY` | the envelope violated the manifest | ingest gate 4; there will be a matching quarantine row with the exact reason |

A `POLICY` failure is never fixed by a retry. Read the quarantine reason: it names
the offending URL or language.

### 4. Container logs, with correlation ids

```bash
./scripts/publoader dev logs -f core-api
./scripts/publoader dev logs -f worker-a
./scripts/publoader dev logs core-uploader | tail -100
```

Logs are structured JSON (pino), and every line on a job path carries
`runId`, `jobId`, `attempt`, `workerId`, and `extension`. Grep by the id you have:

```bash
./scripts/publoader dev logs core-api | jq -c 'select(.jobId == "<uuid>")'
./scripts/publoader dev logs worker-a | jq -c 'select(.runId == "<uuid>")'
```

`x-request-id` on an HTTP response correlates one API call to its log lines.

### 5. The runner's own output

Extension logs and runner diagnostics go to **stderr**, which the agent forwards
at `debug` level (`src/worker/executor.ts:417-423`). So:

```bash
LOG_LEVEL=debug ./scripts/publoader dev up -d worker-a
./scripts/publoader dev logs -f worker-a
```

If the runner produced no envelope at all, the agent logs the last 256 KiB of its
stderr with the reason — timed out, or exited without an envelope.

### 6. The database

```bash
./scripts/publoader dev exec postgres psql -U publoader -d publoader
```

```sql
-- one job's full history
SELECT state, attempt, error_class, last_error, lease_worker_id, lease_expires_at
FROM jobs WHERE id = '<uuid>';

-- every submission for it, and why each was judged as it was
SELECT state, reject_reason, worker_id, lease_id, created_at
FROM result_submissions WHERE job_id = '<uuid>' ORDER BY created_at;

-- did an upload actually reach MangaDex?
SELECT outcome, md_chapter_id, detail, created_at
FROM upload_logs WHERE dedupe_key = '<key>' ORDER BY created_at;

-- who did what
SELECT actor, action, subject, created_at
FROM audit_events ORDER BY created_at DESC LIMIT 40;
```

### 7. Metrics

```bash
curl -s http://127.0.0.1:8100/metrics | grep publoader_
```

In the dev stack the other three services' listeners are on the compose network
only (8101/8102/8103); reach them with
`./scripts/publoader dev exec core-scheduler node -e "fetch('http://127.0.0.1:8101/metrics').then(r=>r.text()).then(console.log)"`.

For production triage see
[operations.md](operations.md#monitoring-quick-reference).

---

## Code conventions

Not aspirational — these are what the codebase actually does, and a review will
ask about a deviation.

**Strict TypeScript.** `strict`, `noUncheckedIndexedAccess`,
`noImplicitOverride` (`tsconfig.json`). Indexed access yields `T | undefined` and
you handle it. No `any`; `unknown` plus a narrowing check instead.

**ESM with `.js` import suffixes.** `module: NodeNext`, so a relative import of a
TypeScript file is written `./foo.js`:

```ts
import { JobStore } from "../store/jobs.js";   // yes — even though it's jobs.ts
import { JobStore } from "../store/jobs";      // no
```

**pino, never `console.log`.** Structured logging with correlation fields via child
loggers (`src/logging.ts`). The two intentional exceptions are `runner.mjs`, which
is outside the platform tree and writes JSON lines to stderr by hand, and
`src/cli/admin.ts`, whose output *is* a terminal UI.

**Comments explain WHY.** The bar throughout this codebase is that a comment
records a constraint, a rejected alternative, or a past incident — something the
code cannot show. Not what the next line does. Read
`src/core/store/jobs.ts:4-17` or `src/core/api/scopes.ts:1-18` for the register.

**Guarded SQL transitions, never read-then-write.** Every state change is one
statement whose `WHERE` names the expected prior state (and the lease id, for
worker-driven changes), and the affected count is the success signal:

```ts
const res = await this.prisma.job.updateMany({
  where: { id: jobId, leaseId, state: "LEASED" },
  data: { state: "RUNNING" },
});
return res.count === 1;      // 0 means we lost the race — reject the transition
```

`if (job.state === "LEASED") { … update … }` is a bug, however obvious it looks.

**Zod at every boundary, `.strict()` where the shape is ours.** Envelopes, the
manifest, request bodies. `.strict()` on the envelope means an unknown field is a
rejection rather than a silently dropped key; the manifest is `.passthrough()`
because extensions may carry extra keys.

**Validation errors are 400, not 500.** A bare `schema.parse` throws a `ZodError`
that the server's handler reports as "internal error" — actively misleading for a
caller who mistyped a filter. Use the `parseOrThrow` pattern with
`statusCode: 400` (`src/core/api/routes/ops.ts:28-44`).

**Secrets are hashed at rest and never returned.** sha256 for tokens, scrypt for
passwords, constant-time comparison, plaintext shown exactly once.

**Errors carry a class.** `TRANSIENT` / `PERMANENT` / `POLICY` decides retry
behaviour; pick deliberately. "Would running this again against the same pinned
bundle produce the same result?" — if yes, it is not `TRANSIENT`.

**Lint:** `pnpm run lint` (`eslint src test`, typescript-eslint).

---

## Common tasks

### Add an admin endpoint

1. Pick the scope. Reuse an existing area if the endpoint belongs to one; only add
   a scope if it is a genuinely new area of authority.
2. Add the route inside the registered scope in `src/core/api/routes/admin.ts`
   (or `ops.ts` for triage endpoints), **with `requireScope` in its
   `preHandler`**:

   ```ts
   scope.post(
     "/api/v1/admin/things/:id/poke",
     { preHandler: requireScope("things:write") },
     async (req, reply) => {
       const { id } = parseOrThrow(z.object({ id: z.string().uuid() }), req.params);
       const res = await ctx.prisma.thing.updateMany({
         where: { id, state: "IDLE" },        // guard the transition
         data: { state: "POKED" },
       });
       if (res.count !== 1) {
         return reply.code(409).send({ error: "thing is not pokeable" });
       }
       await ctx.audit.record(actor(req), "thing.poke", id);
       return { ok: true };
     },
   );
   ```

3. Audit every mutation, using the `actor(req)` helper already in the file so
   attribution stays consistent.
4. Return a meaningful failure. `409` for "wrong state" — and say what the state
   actually is, the way the upload-task routes do (`ops.ts:160-169`).
5. Add an integration test asserting the endpoint is **confined to its scope** —
   `test/integration/ops.test.ts:347` is the pattern, and a reviewer will look for
   it.
6. If a client should use it, wire the CLI (`src/cli/admin.ts`) and/or the bot
   (`src/bot/apiClient.ts` + `src/bot/commands.ts`).

### Add a scope

1. Append it to `SCOPES` in `src/core/api/scopes.ts:20-37`. That array is the
   whole taxonomy — `parseScopes` rejects anything not in it, so a token cannot be
   minted with a scope that does not exist yet.
2. Use `<area>:read` / `<area>:write` naming. Write implies read for free
   (`scopes.ts:86-87`); anything else you want implied has to be coded, and the
   default answer is "do not".
3. Consider whether a preset should include it (`SCOPE_PRESETS`,
   `scopes.ts:103-119`). `test/unit/scopes.test.ts:81` asserts every preset
   contains only valid scopes, so a typo there fails the suite.
4. `scopesForRole` gives `ADMIN` everything except `users:admin`
   (`scopes.ts:92-96`) — a new scope is granted to dashboard admins automatically.
   If that is wrong for your scope, exclude it there explicitly.
5. Add cases to `test/unit/scopes.test.ts`.

### Add a metric

1. Declare it in `src/metrics.ts` with the `c` / `g` / `h` helpers. Namespace it
   `publoader_`; counters end `_total`.
2. Decide who records it. Counters go where the event happens. **Database-derived
   gauges go in `src/core/observability/inventory.ts`**, which the scheduler loop
   calls — that is the one process that already ticks and can see everything.
3. If it is a gauge with labels, **seed every label value to zero** before applying
   counts (`inventory.ts:8-21`). Otherwise a drained queue keeps reading its last
   value, or the series does not exist at all and an alert on `> 0` can never fire.
4. If it is about liveness, **do not** write a "seconds since X" gauge from the
   process being measured. It reads 0 while healthy and 0 forever once wedged.
   Export a timestamp and let the scraper subtract — see the note at
   `metrics.ts:19-33`.
5. Document it in [api-reference.md](api-reference.md#exported-metrics) and, if it
   is alertable, in [operations.md](operations.md#monitoring-quick-reference).

### Add a dashboard view

The dashboard is vanilla JS with no build step, served from
`src/core/api/dashboard/` and read once at boot.

1. Write `async function viewThings()` in `app.js` returning a DOM node, built with
   the `el` / `card` / `row` / `table` helpers.
2. Register it in `VIEWS` (`app.js:374-386`) and add a tab to `TABS`
   (`app.js:330-345`). `{ owner: true }` makes it owner-only —
   `visibleTabs()` filters on `state.owner`, which is what the *server* answered,
   not what the session payload claimed, so the page never offers a control that
   403s (`app.js:207-221`).
3. Add the section name to the `<noscript>` list in `index.html`. This is not
   cosmetic: `test/integration/dashboard.test.ts:462` asserts every section is
   named in **both** the HTML and the registered tabs, because a section in one and
   not the other is either an unreachable view or a tab that renders nothing.
4. **No `innerHTML`, ever.** The CSP has no `unsafe-inline`; use `textContent` and
   `addEventListener`. There is no `innerHTML` anywhere in the file today and that
   is what keeps operator-supplied strings from becoming script.
5. Cookie-authenticated writes need the CSRF header — the `api()` helper already
   sends it.
6. `pnpm run build` copies the assets into `dist/` (`copy:dashboard`); the
   Dockerfile does the same and asserts they landed.

### Add a bot command

1. Add the definition to `COMMANDS` in `src/bot/commands.ts`, with its
   `sensitivity`: `read`, `mutate`, or `destructive`.
2. Choose the sensitivity honestly. `mutate` requires an admin allowlist and an
   allowed channel, and **fails closed** when neither is configured
   (`src/bot/authz.ts:104-153`). `destructive` additionally means the handler must
   require a `confirm: true` option — that check lives in the handler, not in
   authz.
3. Add the API call to `src/bot/apiClient.ts` with its `scope` (client-side
   metadata used for error messages) and a timeout if the operation is slow.
4. If the response contains secret material — an enroll token, a minted token —
   send it by **DM**, never to a channel (`src/bot/bot.ts:258-273` is the DM path with an
   ephemeral fallback; `/enroll` is the worked example).
5. `resolveSensitivity` defaults a missing subcommand key to `destructive`
   (`src/bot/commands.ts:78-82`), so a subcommand you forget to classify fails safe.
6. Test it in `test/unit/botCommands.test.ts` and, for the gating,
   `test/unit/botAuthz.test.ts`.
7. Update [bot.md](bot.md#5-command-reference).

Retiring a command? Do not delete it — add it to the retired list
(`commands.ts:1168-1262`) so typing the muscle-memory name gets a pointer to the
replacement instead of "unknown command".

---

## See also

| Document | For |
| --- | --- |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | branch workflow, definition of done, review checklist |
| [architecture-guide.md](architecture-guide.md) | what all this code is doing |
| [data-model.md](data-model.md) | the schema and its invariants |
| [api-reference.md](api-reference.md) | every endpoint |
| [extension-guide.md](extension-guide.md) | writing an extension |
| [deployment.md](deployment.md) | standing up staging and production |
| [operations.md](operations.md) | day-2 runbooks |
