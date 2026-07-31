# Publoader platform

The TypeScript rewrite of publoader as a **Docker-first distributed extension
execution platform**.

A central core (this codebase) owns the database, the schedule, result
validation, and every MangaDex upload. Worker hosts — including machines the
operator does not control — enroll over an authenticated HTTPS control plane,
lease scrape jobs, run the extension in an isolated runner, and submit
schema-validated result envelopes. Workers hold no credentials and never write
to the database.

"Distributed" means execution capacity. Canonical state and upload authority
are centralised by design.

**The database is the config authority.** There are no runtime JSON config
files. `manga_id_map.json` and `override_options.json` are seed data, imported
once when a bundle is first published, into `tracked_manga` and
`extension_configs`; after that the database wins and republishing does not
overwrite it. Schedules, disabled extensions, removal mode, and pause live
there too. Everything is edited through the admin API — see
`publoader-admin tracked` and `publoader-admin ext-config`.

Full design: [`../docs/target-architecture.md`](../docs/target-architecture.md).

## What runs where

```
CORE (operator's host)                    WORKER HOST(S)
├── core-api        control + data plane  └── worker-agent
├── core-scheduler  runs, jobs, sweeper       ├── bundle fetch (sha256-verified)
├── core-processor  results → upload tasks    ├── node runner (ESM)   
├── core-uploader   the ONLY MD writer        └── envelope → artifacts → submit
├── postgres        single source of truth
└── cloudflared     the one public entrance      outbound HTTPS only, no inbound
```

## Layout

| Path | What it is |
|---|---|
| `prisma/schema.prisma` | The durable data model. Jobs, leases, results, chapter history, bundles, audit. |
| `prisma/migrations/` | Applied in order by `prisma migrate deploy`. Includes the partial unique index that makes double-ingestion structurally impossible. |
| `src/config.ts` | All configuration, environment-driven. Every variable also accepts `<VAR>_FILE` for Docker secrets. |
| `src/contracts/` | The wire contracts: result `envelope`, `records` (ChapterRecord/MangaRecord), extension `manifest`. zod, strict, shared by core and worker. |
| `src/core/api/` | Fastify server. `routes/worker.ts` (enroll, lease, renew, submit, bundles) and `routes/admin.ts` (operator surface) with strictly separated token audiences. |
| `src/core/store/` | Data access. `jobs.ts` holds the `FOR UPDATE SKIP LOCKED` lease claim; `uploadTasks.ts` the MangaDex work queues. |
| `src/core/scheduler/` | Due-slot computation and run/job creation. |
| `src/core/ingest/` | Envelope validation, policy checks, quarantine, commit marker. |
| `src/core/processor/` | MangaDex-side dedup — the port of the legacy `ExtensionUploader` decisions. |
| `src/core/md/` | MangaDex client, upload task workers, chapter-card generation, Discord webhooks, and the title service that auto-creates MangaDex titles for untracked series. |
| `src/worker/` | The worker agent: lease loop, bundle cache, credential persistence, runner execution. |
| `src/services/` | Process entrypoints, one per container. |
| `src/cli/` | `admin.ts` (operator CLI), `migrate-from-mongo.ts`, `import-sqlite.ts`. |
| `runner-node/` | `runner.mjs`, the extension API v2 runner. Executes the extension under Node's permission model, enforces the manifest's egress allowlist, prints an envelope. |
| `runner/` | The Python 3.11 shim. **Deprecated** — python bundles are refused at publish, so this only serves jobs still pinned to a bundle published before the v2 cutover. |
| `docker/core/`, `docker/worker/`, `docker/dev/` | Compose stacks and multi-stage Dockerfiles. |
| `test/unit/`, `test/integration/` | vitest. Integration runs against a real PostgreSQL — lease semantics cannot be proven against mocks. |
| `test/browser/` | Real-Chrome assertions for the dashboard. jsdom cannot see cascade-origin bugs; these caught five the other suites passed. |

## Dev quickstart

Requires Node 24 and Docker.

```bash
cd platform
corepack enable
pnpm install

# Postgres for development.
docker compose -f docker/dev/docker-compose.yml up -d postgres

export DATABASE_URL="postgresql://publoader:dev@localhost:55432/publoader"
pnpm exec prisma migrate dev
pnpm exec prisma generate
```

Run services individually with `tsx` (no build step, reloads on demand):

```bash
export ADMIN_TOKEN="$(openssl rand -base64 48)"

pnpm exec tsx src/services/api.ts       # :8100
pnpm exec tsx src/services/scheduler.ts
pnpm exec tsx src/services/processor.ts
pnpm exec tsx src/services/uploader.ts  # needs MANGADEX_* to do anything
```

Then drive it with the CLI:

```bash
export PUBLOADER_API_URL=http://localhost:8100
export PUBLOADER_ADMIN_TOKEN="$ADMIN_TOKEN"

pnpm exec tsx src/cli/admin.ts stats
pnpm exec tsx src/cli/admin.ts enroll-token create --trust
pnpm exec tsx src/cli/admin.ts bundle publish ../publoader/extensions/src/mangaplus
```

### Full local stack

`docker/dev/docker-compose.yml` brings up core + Postgres + **two workers** +
a mock MangaDex on one network — the environment the end-to-end and failover
tests need:

```bash
docker compose -f docker/dev/docker-compose.yml up --build
```

Two workers is deliberate: it is the minimum that exercises lease contention
and the failover path (`docs/operations.md` → "Failover test procedure").

## Tests

```bash
pnpm test                  # unit only, no database needed
pnpm run test:integration   # needs Postgres on TEST_DATABASE_URL
pnpm run test:all
```

Integration tests need a real PostgreSQL:

```bash
docker run -d -p 55432:5432 -e POSTGRES_PASSWORD=devpass postgres:16-alpine
```

`test/globalSetup.ts` creates and migrates a dedicated `publoader_test`
database. If no server is reachable it prints a warning and the integration
files skip themselves, so `pnpm test` always works offline.

## Checks

```bash
pnpm run typecheck    # tsc --noEmit
pnpm run lint         # eslint src test
pnpm run build        # tsc -> dist/
```

CI runs all of these plus both Docker builds on every push touching
`platform/**` — see [`../.github/workflows/platform-ci.yml`](../.github/workflows/platform-ci.yml).

## Operator CLI

Built as `dist/src/cli/admin.js`; `pnpm run admin` is the shortcut.

```bash
export PUBLOADER_API_URL=https://publoader.ardax.dev
export PUBLOADER_ADMIN_TOKEN=...

pnpm run admin -- stats
pnpm run admin -- workers list
pnpm run admin -- runs trigger mangaplus --kind FORCE
pnpm run admin -- dead-letter
pnpm run admin -- --help
```

Config and the untracked-series pipeline are driven from the same CLI:

```bash
pnpm run admin -- tracked list mangaplus
pnpm run admin -- tracked set mangaplus <externalId> <mdMangaId>
pnpm run admin -- ext-config get mangaplus            # prints JSON
pnpm run admin -- ext-config set mangaplus ./o.json   # or pipe to stdin

pnpm run admin -- untracked list --state NEW
pnpm run admin -- untracked approve <id>   # creates the MangaDex title
pnpm run admin -- untracked skip <id>
```

## Migration from the legacy stack

Two one-shot, re-runnable scripts. Do not run them without reading the guide
first — the ordering around the cutover is what keeps both systems from
uploading at once.

```bash
node dist/src/cli/migrate-from-mongo.js [--dry-run] [--refresh]
node dist/src/cli/import-sqlite.js [path/to/publoader.db]
```

## Documentation

| Document | Read it when |
|---|---|
| [`../docs/target-architecture.md`](../docs/target-architecture.md) | You want to know why any of this is shaped the way it is. Binding design reference. |
| [`../docs/architecture-assessment.md`](../docs/architecture-assessment.md) | You want the problems in the legacy system that motivated the rewrite. |
| [`../docs/migration-guide.md`](../docs/migration-guide.md) | You are cutting over from the legacy stack. Staged, with a rollback at every step. |
| [`../docs/operations.md`](../docs/operations.md) | Something is broken, or you are enrolling a worker, rotating a secret, or upgrading. |
| [`../docs/security-trust-model.md`](../docs/security-trust-model.md) | You are deciding whether to let someone run a worker, or reviewing the trust boundaries. |
| [`../docs/ipc-to-api-mapping.md`](../docs/ipc-to-api-mapping.md) | You are porting the Discord bot or the dashboard off the Unix-socket IPC. |
| [`../docs/deployment.md`](../docs/deployment.md) | You are deploying: compose stacks, Cloudflare tunnel setup, secrets. |

## Conventions

- **ESM, strict TypeScript.** Relative imports carry the `.js` suffix
  (`NodeNext` resolution) — this is required, not stylistic.
- **`console.log` only in `src/cli/`.** Services log structured JSON through
  pino (`src/logging.ts`) with `runId`/`jobId`/`workerId` correlation.
- **Every state transition is one guarded statement.** The `WHERE` clause names
  the expected prior state and, for worker-driven transitions, the `leaseId`.
  Zero rows updated means you lost the race. There is no read-then-write.
- **Idempotency is structural.** Run/job idempotency keys, lease CAS, the
  per-job commit marker, and `(kind, dedupe_key)` uniqueness turn at-least-once
  delivery into exactly-once effects. Prefer a constraint over a check.
