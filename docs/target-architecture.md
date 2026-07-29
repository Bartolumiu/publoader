# Publoader Target Architecture

Date: 2026-07-29
Stack: **TypeScript (Node.js 24) + Prisma + PostgreSQL** (operator directive).
Status: implemented in this branch (v1); follow-ups listed in §12.

## 0. Summary

Publoader becomes a **Docker-first distributed extension execution platform**:

- A **central core** (TypeScript services) is the single authority for the
  canonical database (PostgreSQL), scheduling, result validation/ingestion, and
  **all MangaDex uploads**.
- **Worker hosts** — including community-operated machines — enroll over an
  authenticated HTTPS control plane, lease extension *scrape jobs*, execute the
  (Python) extension inside an isolated runner, and submit **normalized,
  schema-validated result envelopes**. Workers never hold MangaDex, database,
  Discord, or GitHub credentials, and never write to the database.
- Coordination is durable: jobs, leases, attempts, results, and worker identity
  live in PostgreSQL with transactional state transitions
  (`SELECT … FOR UPDATE SKIP LOCKED` for claims, unique constraints for
  idempotency). No in-memory locks, no shared filesystems, no Unix sockets.

"Decentralised" = distributed execution capacity. Canonical state and upload
authority are centralized by design.

## 1. Technology choices (and why)

| Concern | Choice | Rationale |
|---|---|---|
| Platform language | **TypeScript / Node.js 24** | Operator directive; aligns with the dexchan reference; single typed codebase for API, scheduler, ingestion, upload pipeline, and worker agent |
| Durable state | **PostgreSQL 16 + Prisma** | Operator directive; `FOR UPDATE SKIP LOCKED` is the canonical job-queue/lease primitive; unique constraints give transactional idempotency keys; Prisma migrations version the schema |
| Extension runtime | **Python 3.11 runner shim** (only place Python remains) | The extension contract (`class Extension`, `Chapter`/`Manga` shapes) is Python and must be preserved; the shim executes the extension and emits an envelope JSON on stdout — no coordination logic in Python |
| Control-plane API | **Fastify** | Fast, schema-first (JSON Schema validation on every route), first-class TypeScript |
| Validation | **zod** (envelopes, manifests) + Fastify JSON Schema (transport) | One source of truth for the result-envelope and manifest contracts |
| Worker→core transport | Outbound HTTPS only (long-poll lease) | Community workers sit behind NAT; no inbound ports on workers; TLS via reverse proxy / cloudflared (already deployed) |
| Job/queue library | None (lease store on Postgres, ~500 lines, fully tested) | BullMQ/Temporal/graphile-worker would still need our manifest-policy, envelope-ingest, and MD-idempotency layers; `SKIP LOCKED` + CAS transitions cover the coordination need without a broker |
| Artifacts (chapter images) | Postgres `bytea` rows with sha256, size/type caps (v1) | Image payloads are small card/page sets today; object storage is a documented v2 swap behind the same `ArtifactStore` interface |
| Metrics | `prom-client` Prometheus endpoint | Standard scrape path |
| Tests | vitest (unit) + real Postgres via Docker (integration/e2e) | Lease semantics must be proven against real Postgres locking, not mocks |

## 2. Planes

```
┌───────────────────────────── CORE (operator-controlled) ─────────────────────────────┐
│  core-api (Fastify):                                                                 │
│    control plane: enroll, auth, lease, renew, heartbeat, admin, health, metrics      │
│    data plane:    result envelopes, artifact upload, bundle download                 │
│  core-scheduler: due-slot → run/job creation; lease sweeper; retry/backoff; DLQ      │
│  core-processor: committed results → MD dedup (ported) → upload tasks                │
│  core-uploader:  upload/edit/delete/unavailable task workers → MangaDex API          │
│  postgresql (canonical state, queues, artifacts, audit)                              │
│  (optional) discord bot, dashboard, cloudflared — control via the API               │
└──────────────────────────────────────────────────────────────────────────────────────┘
                     ▲ HTTPS (bearer worker tokens, TLS)
┌────────────────────┴───────────── WORKER HOST(S) ────────────────────────────────────┐
│  worker-agent (TypeScript): enroll → lease loop → heartbeat/renew                    │
│    └─ bundle fetch (content-addressed, sha256-verified)                              │
│    └─ spawn python runner shim: executes Extension, enforces manifest egress         │
│       allowlist + timeouts, prints envelope JSON (non-root, read-only fs, limits)    │
│    └─ envelope build → artifact upload → result submit (idempotency key)             │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## 3. Data model (Prisma schema, `platform/prisma/schema.prisma`)

Core tables (all with `createdAt`/`updatedAt`; ids UUID):

- **Worker** — `id`, `name`, `tokenHash` (sha256), `status`
  (`ACTIVE|DRAINED|REVOKED`), `trust` (`TRUSTED|COMMUNITY`), `capabilities`
  (JSON: extensions allowed), `lastHeartbeatAt`, `agentVersion`.
- **EnrollToken** — `tokenHash` (unique), `expiresAt`, `singleUse`, `usedByWorkerId`,
  `revoked`, `trust`, `note`.
- **Run** — `id`, `idempotencyKey` (**unique**, e.g. `sched:mangaplus:2026-07-29T15:05`),
  `extension`, `kind` (`UPDATE|CLEAN|FORCE`), `segmentsTotal`, `state`
  (`PENDING|EXECUTING|INGESTING|PROCESSED|FAILED|DEAD_LETTER|CANCELLED`),
  `triggeredBy`, timings.
- **Job** — `id`, `idempotencyKey` (**unique**), `runId`, `extension`,
  `extensionVersion`, `bundleSha256` (pinning), `kind`, `segmentIndex`,
  `segmentTotal`, `segmentKey`, `segmentMangaIds` (JSON), `state` (§4),
  `attempt`, `maxAttempts`, `notBefore`, `timeoutSeconds`,
  `leaseId`, `leaseWorkerId`, `leaseExpiresAt`,
  `errorClass` (`TRANSIENT|PERMANENT|POLICY`), `lastError`, `cancelRequested`.
  Indexes: `(state, notBefore)`, `(runId)`.
- **ResultSubmission** — `id`, `jobId`, `attempt`, `leaseId`, `workerId`,
  `envelope` (JSONB, size-capped), `state`
  (`RECEIVED|QUARANTINED|COMMITTED|SUPERSEDED`), `rejectReason`.
  **Partial unique index on `(jobId) WHERE state = 'COMMITTED'`** — the commit
  marker that makes duplicate/late results structurally unable to double-ingest
  (segments are separate jobs, so job-level uniqueness covers segment-level).
- **Artifact** — `id`, `sha256`, `size`, `contentType`, `data` (bytea),
  `jobId`, `workerId`, expiry state.
- **Bundle** — `extension`, `version`, `sha256` (content address, unique),
  `manifest` (validated JSONB), `sourceCommit`, `data` (bytea zip), `yanked`.
- **UploadTask** — replaces Mongo `to_upload`/`to_edit`/`to_delete`/`to_unavailable`:
  `id`, `kind` (`UPLOAD|EDIT|DELETE|UNAVAILABLE`), `state`
  (`PENDING|LEASED|DONE|FAILED|DEAD_LETTER`), `chapter` (JSONB canonical shape),
  `dedupeKey` (**unique per kind**: upload = `chapterId+number+language`,
  others = `mdChapterId`), lease fields, attempts. Insert uses
  `ON CONFLICT DO NOTHING` — same effective semantics as today's
  `$setOnInsert` upserts.
- **UploadedChapter** — canonical mirror of Mongo `uploaded`
  (unique `mdChapterId`) and **UploadedId** — mirror of `uploaded_ids`
  (unique `chapterId+extension`); **EditedChapter**, **UnavailableChapter**
  mirrors for `edited`/`unavailable`.
- **UploadLog** — append-only record of every MangaDex upload commit attempt
  (`dedupeKey`, `mdChapterId`, outcome) — closes today's crash window between
  "MD commit succeeded" and "queue row deleted".
- **ScheduleOverride / DisabledExtension / Setting / AuditEvent** — replace the
  SQLite state store and add the audit trail.

## 4. Job state machine

```
            ┌────────────────────────────────────────────┐
            ▼                                            │ (retryable error /
 PENDING ──claim──▶ LEASED ──start──▶ RUNNING ──submit──▶│  lease expiry,
    ▲                 │                  │               │  attempt < max)
    │                 │ lease expiry     │ lease expiry  │
    │                 ▼                  ▼               │
    └──────────── (requeue: attempt+1, backoff) ─────────┘
                      │ attempt ≥ maxAttempts or PERMANENT/POLICY error
                      ▼
                 DEAD_LETTER        CANCELLED (operator, any pre-terminal state)
 RUNNING ──submit(ok)──▶ SUCCEEDED
```

Every transition is one SQL statement (or one transaction) whose `WHERE` clause
names the expected prior state — and, for worker-driven transitions, the
`leaseId`. Zero rows updated = lost the race; there is no read-then-write.

**Lease claim** (the exclusivity primitive):

```sql
WITH candidate AS (
  SELECT id FROM "Job"
  WHERE state = 'PENDING' AND "notBefore" <= now()
    AND "cancelRequested" = false AND extension = ANY($1)
  ORDER BY "notBefore" ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE "Job" j SET state = 'LEASED', "leaseId" = $2, "leaseWorkerId" = $3,
  "leaseExpiresAt" = now() + $4::interval, attempt = attempt + 1
FROM candidate WHERE j.id = candidate.id
RETURNING j.*;
```

`SKIP LOCKED` guarantees two concurrent claimers cannot select the same row;
renewal and completion require the matching `leaseId`, so a worker whose lease
expired (and was reassigned) cannot renew, complete, or overwrite the successor
— its late submission is stored as `SUPERSEDED` unless it wins the commit
marker first (§6).

**Retry policy**: exponential backoff with jitter (`base · 2^attempt`, capped),
`maxAttempts` per job kind; error classes `TRANSIENT|PERMANENT|POLICY`;
`PERMANENT`/`POLICY` go straight to `DEAD_LETTER` (operator-visible,
replayable).

**Cancellation**: `cancelRequested` flag; the sweeper cancels `PENDING` jobs
immediately; running workers observe the flag in the renew response and abort;
a lease that stops renewing → sweeper requeues or dead-letters after expiry.

**Version pinning**: jobs carry `bundleSha256`; the worker executes exactly
that bundle or fails the job with a `POLICY` error.

## 5. Scheduling

`core-scheduler` service loop (safe to run replicated — every action is CAS):

1. Effective schedule = manifest/`schedule*.json` defaults ⊕ `ScheduleOverride`
   rows (same precedence as today), honoring `DisabledExtension` and pause
   settings.
2. Each due slot inserts Run + Jobs with idempotency key
   `sched:<ext>:<UTC slot>`; unique-violation = already created (crash-safe,
   duplicate-scheduler-safe).
3. Manual triggers (`run/force/clean`) create runs via the admin API with
   operator-supplied or generated idempotency keys.
4. The **sweeper** (same loop) requeues/dead-letters expired leases, applies
   cancellations and run-level timeouts, and emits metrics.

## 6. Partitioned execution

- Only extensions whose manifest declares it are partitionable:
  ```json
  "partition": {"mode": "tracked_manga", "maxSegments": 4, "minMangaPerSegment": 25}
  ```
- Segmenting is deterministic: the sorted external manga-id list from the
  bundle's `manga_id_map` data file is chunked into N contiguous segments;
  `segmentKey = sha256(extension|runId|index|total|ids).slice(0,16)`.
- The runner shim **filters returned chapters to the segment's manga ids**
  regardless of extension behaviour — overlapping segment outputs are
  impossible by construction, not by extension cooperation.
- Each segment is its own Job; the per-job `COMMITTED` unique marker makes
  duplicate and out-of-order segment deliveries `SUPERSEDED` no-ops.
- The processor aggregates only when all of a run's jobs are `SUCCEEDED`
  (default `requireAllSegments: true`). **`CLEAN` runs are never processed from
  partial segments** — absence of data must never be read as deletion.
- Non-partitionable extensions always run as a single whole-extension job under
  one lease (model 1 of the product requirements).

## 7. Result envelopes & ingestion

Envelope (zod-validated, size-capped):

```json
{
  "envelopeVersion": 1,
  "jobId": "…", "leaseId": "…", "segmentKey": null,
  "extension": "mangaplus", "bundleSha256": "…",
  "idempotencyKey": "res:<jobId>:<attempt>",
  "status": "ok | error",
  "error": {"class": "TRANSIENT|PERMANENT", "message": "…"},
  "updatedChapters": [ChapterRecord…], "allChapters": [ChapterRecord…] | null,
  "untrackedManga": [MangaRecord…],
  "trackedMangadexIds": ["uuid…"], "mangadexGroupId": "uuid",
  "overrideOptions": {...}, "extensionLanguages": ["en"…],
  "stats": {"durationS": 123, "httpRequests": 456}
}
```

`ChapterRecord` mirrors the Python `Chapter` dataclass (camelCased on the wire,
mapped 1:1); `images` become `imageArtifacts: [artifactId…]` (uploaded
separately, sha256 + size verified, type/size caps enforced).

Ingestion pipeline (core-api):
1. **Authn**: worker token valid and not revoked; lease matches the job (a
   stale lease → recorded as `SUPERSEDED`, acknowledged, never ingested).
2. **Schema validation** (strict zod; unknown fields rejected).
3. **Policy validation** against the *core's* copy of the manifest:
   chapter/manga URLs must be on `allowed_hosts` domains; languages ⊆ manifest
   languages; `mangadexGroupId` must equal the manifest's; counts within caps.
   Violations → `QUARANTINED` + audit + metric (never touch canonical state).
4. **Commit marker**: transactional flip to `COMMITTED` guarded by the partial
   unique index; losers become `SUPERSEDED`.
5. Job → `SUCCEEDED`; run advances when all jobs committed.
6. **Processor** (core, TypeScript port of `ExtensionUploader` /
   `MangaUploaderProcess` semantics): fetches existing external chapters from
   the MangaDex API per manga, applies the same duplicate / edit / skip /
   removal decisions (`same`, `multi_chapters`, `custom_language` override
   options, volume backfill from the aggregate endpoint, unavailable-vs-delete
   removal-mode resolution), and inserts `UploadTask` rows with
   `ON CONFLICT DO NOTHING`. Upload authority never leaves the core.

At-least-once network semantics become exactly-once effects via: run/job
idempotency keys (creation), lease CAS (execution), commit markers (ingestion),
`dedupeKey` unique constraints (task queueing), `UploadLog` + MD-side dedup
(upload).

## 8. Worker trust & security model

- **Enrollment**: operator mints a single-use, expiring enroll token (CLI /
  admin API). The worker exchanges it once for `{workerId, workerToken}`; only
  sha256 hashes are stored server-side. Tokens are individually revocable;
  `drain` stops new leases while the current one finishes.
- **Transport**: TLS (reverse proxy or cloudflared in front of core-api);
  bearer tokens; constant-time comparison (`timingSafeEqual`).
- **Least privilege**: a worker receives exactly: the job spec, the pinned
  extension bundle, and the extension's data files. No MangaDex/Postgres/
  Discord/GitHub credentials, no docker.sock, no shared volumes with core.
- **Runtime isolation** (worker compose defaults): non-root user, read-only
  root fs + tmpfs scratch, `cap_drop: ALL`, `no-new-privileges`, memory/CPU/pids
  limits. The Node runner runs as a subprocess with a wall-clock timeout, under
  Node's permission model (`--permission` with fs read/write scoped to the
  bundle, runner and job workdir; `child_process` and `worker_threads` denied;
  `--disallow-code-generation-from-strings`), and reaches the network only
  through a guarded fetch that enforces the manifest's `allowed_hosts` on the
  initial request and on every redirect hop — so the manifest is enforced
  policy, not documentation. Caveat: the permission model does not restrict
  sockets, so the allowlist remains a guardrail rather than a containment
  boundary (§1.10 of the trust model).
- **Supply chain**: bundles are content-addressed (sha256) zips built from the
  extensions repos at a recorded commit; workers verify the hash against the
  job's pin before execution; manifests are validated at publish, and a bundle
  is built to one self-contained ESM file with its dependencies inlined, so the
  sha256 pins the whole program. Base images pinned by digest; npm dependencies
  locked (`pnpm-lock.yaml` + `--frozen-lockfile`).
- **Trust tiers**: workers are `TRUSTED` or `COMMUNITY`. Manifests may set
  `min_trust`; private-repo extensions default to trusted-only. Sensitive jobs
  are never leased to lower tiers.
- **Residual risks (explicit)**: a worker can observe job inputs (tracked ids,
  posted-chapter ids — non-secret) and can fabricate plausible results.
  Mitigations shipped: schema+policy validation, host allowlists, tracked-id
  filtering, MD-side dedup before upload, quarantine + audit, trust tiers,
  central upload authority. Documented for v2: probabilistic verification
  re-runs on a second worker, reputation scoring, canary manga.

## 9. Docker-first deployment

- `platform/docker/core/docker-compose.yml`: `postgres`, `core-api`,
  `core-scheduler`, `core-processor`, `core-uploader` (+ optional `cloudflared`).
  Secrets via env/Docker secrets; volumes only for Postgres data. Healthchecks
  distinguish live vs ready.
- `platform/docker/worker/docker-compose.yml`: single `worker-agent` service;
  config = `CORE_URL` + `WORKER_TOKEN` (or `ENROLL_TOKEN` on first boot,
  exchanged and persisted to a named volume). Hardened per §8. No shared
  filesystem with core.
- Multi-stage Dockerfiles (build → prune → distroless-ish runtime), pinned
  bases, non-root user, `HEALTHCHECK`s. The worker image is the core image's
  Node build plus `runner-node/`; it carries no interpreter and no
  per-extension dependencies, so publishing an extension no longer requires
  rebuilding and redeploying workers.
- Local dev/e2e: `platform/docker/dev/docker-compose.yml` = core + postgres +
  2 workers + mock-MangaDex on one network for end-to-end tests.

## 10. Observability & operations

- **Structured JSON logs** (pino) with `runId/jobId/attempt/workerId`
  correlation on every line.
- **Metrics** (`/metrics`): queue depths, scheduler lag, lease expiries, job
  durations, retries, dead-letters, envelope validation failures, quarantines,
  worker liveness, upload outcomes, per-extension failure streaks.
- **Health**: `/healthz` (process alive) vs `/readyz` (Postgres reachable,
  migrations applied, not draining).
- **Admin controls** (API + CLI, consumed by bot/dash): pause/resume (global &
  per-extension), enable/disable extension, run-now/force/clean, retry/cancel
  job or run, worker list/drain/revoke, enroll-token mint, dead-letter
  inspect/replay, audit trail query.
- The Discord bot and dashboard migrate from Unix-socket IPC to the admin API;
  a compatibility table maps every existing IPC command to its endpoint.

## 11. Extension API v2 — the TypeScript contract

**Replace, don't wrap.** Extension API v2 (`publoader_api: ^2.0.0`,
`runtime: "node"`) is THE extension API. Extensions are TypeScript/ESM modules
executed by `platform/runner-node/runner.mjs`. Python is gone: the worker image
carries no interpreter, `BundleStore.publish()` refuses `runtime: "python"`
bundles, and the v1 runner survives only so bundles pinned before the cutover
remain executable (behind a loud deprecation warning and an audit-logged
`x-allow-legacy-runtime: true` publish override).

**The contract** (`src/contracts/extensionApi.ts`). A bundle default-exports an
`ExtensionFactory`:

```ts
import type { ExtensionFactory } from "publoader-extension-api";

const factory: ExtensionFactory = (ctx) => ({
  async collect({ postedChapterIds, cleanRun, trackedSubset }) {
    const res = await ctx.fetch("https://example.com/api/updates");
    return { updatedChapters: [...], allChapters: null, untrackedManga: [] };
  },
});
export default factory;
```

One method replaces v1's five methods and six attributes. Identity (name, group
id, languages) comes from the manifest; configuration (tracked map, override
options, schedule) comes from the database (§12). An extension no longer
duplicates, and can no longer contradict, either.

- `collect(input)` receives `postedChapterIds` (empty on clean runs),
  `cleanRun`, and `trackedSubset` — the segment's manga ids, or null. Honouring
  the subset is an optimisation: **the runner filters the output to it
  regardless** (§6), so non-overlapping segment output is structural.
- It resolves to `{updatedChapters, allChapters, untrackedManga}`. `allChapters`
  is `null` when no catalogue was gathered — absence means "no removal
  information", never "everything was removed".
- Chapters may omit `mdMangaId`; the runner fills it from the platform's
  tracked map and **drops chapters whose external id has no mapping**, the same
  filter v1 applied.

**The context** is the extension's entire world:

- `ctx.fetch` — the only sanctioned I/O. Enforces `allowed_hosts` (exact or
  subdomain) before connecting *and on every redirect hop*, applies a per-host
  politeness delay, a wall-clock timeout, bounded retries on 5xx/transport
  failures, and honours `Retry-After` on 429. Implemented in
  `src/extsdk/guardedFetch.ts` and duplicated inline in the runner, which
  cannot import from the platform tree.
- `ctx.mangaIdMap` — external id → MangaDex title id, inverted from the
  database-authoritative lease payload, so titles auto-tracked since the bundle
  was published are visible without republishing.
- `ctx.dataFile(name)` — a bundled data file, resolved through the manifest's
  `data_files` and refused if it escapes the bundle directory.
- `ctx.log(message, fields)` — JSON lines on **stderr**. stdout is the envelope
  channel; the runner redirects `process.stdout` and `console.*` to stderr
  before any bundle code runs.

**Build at publish, not at run.** `publoader-admin bundle publish <dir>` detects
a TypeScript source (`index.ts`, `src/index.ts`, or a `package.json` build
script) and runs esbuild (`format: "esm"`, `platform: "node"`,
`target: "node24"`, `bundle: true`, `external: []`) to a single self-contained
`index.mjs`, then zips that plus the manifest and data files. Directories that
are already plain `.mjs` are zipped as-is. Consequences:

- dependencies are **inlined into the artefact**, so the sha256 pins the
  complete program — nothing resolves differently later on a worker;
- workers need no compiler, no package manager, and no network to a registry;
- adding an extension no longer means rebuilding and redeploying worker images,
  which was the worst ergonomic cost of the Python design.

Publish-time validation rejects a node bundle whose entrypoint is missing,
empty, not `.mjs`/`.js`, or has no default export.

**Execution.** The worker spawns `process.execPath` with Node's permission
model on: `--permission` with `--allow-fs-read` scoped to the bundle, the
runner directory and the job workdir, `--allow-fs-write` scoped to the output
and workdir, plus `--disallow-code-generation-from-strings`. That also denies
`child_process` and `worker_threads`, so an extension cannot shell out around
the guarded fetch (§8).

## 12. Database-authoritative configuration (no JSON config files)

Operator directive: runtime configuration lives in PostgreSQL, not files.

- `TrackedManga` replaces `manga_id_map.json` as the source of truth for the
  external-id → MangaDex-title map; `ExtensionConfig` replaces
  `override_options.json`. Bundle publishing seeds both **once** from the
  bundle's data files (migration convenience); afterwards the DB wins and is
  edited via the admin API/CLI.
- Workers receive the map and override options in the lease payload; the runner
  inverts the map and serves it as `ctx.mangaIdMap`, so extensions pick up
  newly tracked titles without a bundle republish.
- The processor ignores worker-supplied override options entirely and reads
  them from `ExtensionConfig` — config can never be injected through a result
  envelope.
- Platform configuration is environment/Docker-secrets only (`VAR` or
  `VAR_FILE`); `manifest.json` remains as the *package descriptor* whose
  policy fields are enforced (it is metadata about code, not runtime config).

## 13. Automated untracked-series pipeline

When an extension reports manga it doesn't have a MangaDex mapping for:

1. The processor persists them durably (`UntrackedManga`, deduped on
   extension+id+language, state `NEW`).
2. The **TitleService** (runs inside core-uploader — the MD-credential holder)
   picks up `NEW` rows: if the extension manifest sets
   `auto_create_titles: true`, it creates a MangaDex title draft
   (`POST /manga` with `title_defaults` from the manifest) and commits it
   (`POST /manga/draft/{id}/commit`); otherwise rows wait for operator
   approval (`POST /api/v1/admin/untracked/:id/approve`, or `skip`).
   Creation is CAS-claimed (`NEW → CREATING`) so replicas never double-create,
   with attempts capped and failures parked in `FAILED` for triage.
3. The new mapping is written to `TrackedManga` (source `auto` or
   `operator:<actor>`), which immediately flows to workers via the lease
   payload — the next run uploads the series' chapters.
4. Discord receives an embed per batch linking every created title
   (`https://mangadex.org/title/<id>`) with the source URL and extension.

Workers only *report* candidates (validated, quarantine-able data); title
creation authority stays in the core.

## 14. Follow-ups explicitly out of v1 scope

Verification re-runs / quorum for community workers; per-extension micro-VM or
gVisor isolation; object-storage artifact backend + GC service; Kubernetes
manifests; bundle signing with sigstore (sha256 pinning ships in v1); Grafana
dashboards; porting the Discord bot/dashboard UIs themselves to TypeScript
(they keep working against the admin API compatibility layer).
