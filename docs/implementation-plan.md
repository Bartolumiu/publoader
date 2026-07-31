# Implementation Plan

Stack: TypeScript (Node 24) + Prisma + PostgreSQL; Python persists only as the
extension runner shim. New code lives under `platform/` in the `publoader` repo.

## Milestones

**M1 — Foundations (data model + contracts)**
- Prisma schema for all `platform` tables (workers, tokens, runs, jobs,
  results, artifacts, bundles, upload tasks, canonical chapter tables, upload
  log, settings/overrides/audit) + initial migration.
- zod contracts: manifest, chapter/manga records, result envelope, job spec.
- Config loader (env-driven, no config.ini), pino logging, prom-client
  metrics registry.

**M2 — Lease store + scheduler**
- `JobStore`: create (idempotent), claim (`FOR UPDATE SKIP LOCKED`), renew,
  submit, requeue/dead-letter sweeper, cancel — each a single guarded
  statement/transaction.
- `Scheduler` service: due-slot computation (manifest schedule ⊕ overrides ⊕
  pause/disable), run+job creation with slot idempotency keys, segmenting for
  partitionable extensions.

**M3 — Control-plane API + worker identity**
- Fastify `core-api`: enroll, heartbeat, lease (long-poll), renew, result
  submit, artifact upload, bundle download, admin (pause/resume, run-now,
  cancel/retry, workers list/drain/revoke, enroll-token mint, dead-letter,
  audit), `/healthz` `/readyz` `/metrics`.
- Auth: hashed bearer tokens, revocation, trust tiers, admin token.

**M4 — Worker agent + Python runner shim**
- TS agent: enroll-on-first-boot, lease loop, renew/cancel handling, bundle
  cache with sha256 verification, artifact upload, envelope submit with
  retries + idempotency keys.
- Python shim (`runner/`): loads bundle, instantiates `Extension`, calls the
  contract methods, applies segment filtering + egress allowlist + timeout,
  emits envelope JSON on stdout. Zero coordination logic.

**M5 — Ingestion + processor + MangaDex pipeline (TS port)**
- Envelope ingestion with policy validation, quarantine, commit markers.
- `MdClient`: OAuth (client credentials + refresh), rate limiting, retries.
- Processor: TS port of ExtensionUploader/MangaUploaderProcess decision logic
  (duplicate/edit/skip, volume backfill, removal-mode routing) → UploadTask.
- Uploader workers: upload-session flow, edit, delete, unavailable (card
  generation via sharp SVG), UploadLog idempotency, uploaded/uploaded_ids
  bookkeeping.

**M6 — Docker + e2e**
- Hardened multi-stage images (core TS; worker TS+Python).
- `docker/core`, `docker/worker`, `docker/dev` compose files; mock-MangaDex
  container; e2e: 1 core + 2 workers, failover exercise.

**M7 — Migration + docs + CI**
- `migrate-from-mongo` script (Mongo → Postgres, re-runnable, verified counts).
- SQLite settings import (schedule overrides, disabled extensions, removal
  mode).
- Operator runbooks (enroll/revoke/drain/upgrade/rollback/recover), security
  model doc, migration guide, CI workflow (typecheck, lint, unit, integration
  with Postgres service, docker build).

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| TS port of MD dedup logic diverges from Python behaviour | Port with table-driven unit tests mirroring the Python tests' cases; keep Python pipeline untouched on the branch for A/B comparison; migration guide prescribes staged cutover |
| Prisma can't express `SKIP LOCKED` claims | Use `$queryRaw` for the three hot statements (claim, sweep, task-claim); everything else via the Prisma client |
| Chapter-card generation parity (Pillow → sharp) | Deterministic SVG template; card is cosmetic — divergence is acceptable and reviewable |
| Image/`bytea` artifact growth | Size caps per artifact + per envelope; TTL cleanup; `ArtifactStore` interface ready for object storage |
| Worker Python deps drift from extensions' needs | Worker image builds `pip install` from each bundled extension's pinned requirements at image build; manifest lists requirements for validation |
| Long-poll lease vs proxies | 25s poll cap + jittered retry; plain poll fallback |

## Sequencing note

The legacy Python system remains fully functional on this branch; nothing is
deleted until the new platform passes its e2e suite (M6) and a staged cutover
(migration guide) completes. Obsolete-component removal is a follow-up PR by
design.


---

## Documentation map

This document is one of the set below. Start at
[architecture-guide.md](architecture-guide.md) if you are new to the platform.

| Document | One line |
| --- | --- |
| [architecture-guide.md](architecture-guide.md) | How it works: the planes, one run traced end to end, the job state machine, and why exactly-once holds |
| [development.md](development.md) | Local setup, running services from source, the Prisma workflow, the test layers, debugging a failing job |
| [api-reference.md](api-reference.md) | Every HTTP endpoint, its required scope, and its meaningful failures |
| [data-model.md](data-model.md) | Every table, column, index, and invariant |
| [extension-guide.md](extension-guide.md) | Writing an extension: the v2 contract, the manifest, the sandbox, publishing |
| [glossary.md](glossary.md) | Every load-bearing term, with the file that defines it |
| [target-architecture.md](target-architecture.md) | The binding design reference and the rationale for each choice |
| [architecture-assessment.md](architecture-assessment.md) | The legacy Python system and the failure modes that motivated the rewrite |
| [security-trust-model.md](security-trust-model.md) | Threat model, control matrix, secrets inventory, and what a worker can and cannot do |
| [deployment.md](deployment.md) | Standing up the core and worker hosts, the tunnel and WAF, upgrades, backups |
| [operations.md](operations.md) | Day-2 runbooks: triage, worker lifecycle, secret rotation, dead letters, incidents |
| [migration-guide.md](migration-guide.md) | Staged Mongo/SQLite to Postgres cutover, with a rollback at every stage |
| [ipc-to-api-mapping.md](ipc-to-api-mapping.md) | Which endpoint replaced each legacy IPC command |
| [bot.md](bot.md) | Discord bot setup, the admin-gating model, and the command reference |
| [webhooks.md](webhooks.md) | Publishing extension bundles from a GitHub push: setup, the signature check, and why CI-side publishing is preferred |
| [implementation-plan.md](implementation-plan.md) | Historical: the original milestone plan |
| [../README.md](../README.md) | What publoader is, and the five-minute quickstart |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Branch workflow, definition of done, and the review checklist |
