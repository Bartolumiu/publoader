# Glossary

Every term the codebase uses as a load-bearing noun, with the file that defines
it. When a doc and this page disagree, the code wins — the references here are
the code.

---

**artifact** — A checksummed binary blob, in practice a chapter page image. A
worker uploads pages one at a time to `POST /api/v1/worker/artifacts`, receives
an id, and puts those ids in the chapter's `imageArtifacts`. The store verifies
the declared sha256 against the received bytes and rejects a mismatch
(`platform/src/core/store/artifacts.ts:34-37`), accepts only png/jpeg/gif/webp
(`artifacts.ts:5-10`), caps a body at 20 MiB (`artifacts.ts:4`), and gives every
new row a 48-hour TTL (`artifacts.ts:12`). Artifacts referenced by a *committed*
result are pinned — their TTL is cleared — so the garbage collector cannot take
them (`artifacts.ts:58-65`, called from
`platform/src/core/ingest/ingest.ts:104-109`). The uploader deletes them once the
chapter is on MangaDex (`platform/src/core/md/taskWorkers.ts:538-541`).

**attempt** — The per-job retry counter, incremented **by the claim**, not by the
failure (`platform/src/core/store/jobs.ts:170`). A job may be attempted up to
`maxAttempts` times (default 3, from the manifest's `max_attempts`). The attempt
number is part of the result idempotency key, `res:<jobId>:<attempt>`
(`platform/src/contracts/envelope.ts:50-52`), which is what makes a retried
*delivery* of the same attempt a duplicate rather than a new result.

**break-glass token** — The `ADMIN_TOKEN` environment value. It is
owner-equivalent by construction and resolves to the wildcard scope `["*"]`
(`platform/src/core/api/auth.ts:137-142`), because it is the way back in when the
accounts table itself is the problem. Logging in with it attaches a session to
the seeded owner account (`platform/src/core/api/session.ts:199-203`), which is
how a fresh deployment bootstraps its first password. It should live in a vault,
not in a client; clients get [scoped tokens](#scope) instead. If it is unset, the
whole admin API answers 503 rather than opening up
(`auth.ts:103-106`).

**bundle** — A zip of one extension directory, addressed by the sha256 of the zip
bytes (`platform/src/core/store/bundles.ts`, `bundles` table). A bundle carries
the extension's built entrypoint, its `manifest.json`, and its declared
`data_files`. Bundles are immutable: the hash *is* the version pin that a job
carries, and a worker verifies the hash after download before executing anything
(`platform/src/worker/coreApi.ts:367-378`). Publishing a Python (extension API
v1) bundle is refused (`bundles.ts:37-43`). See
[extension-guide.md](extension-guide.md#publishing).

**commit marker** — The partial unique index
`result_committed_one_per_job` on `result_submissions (job_id) WHERE state =
'COMMITTED'` (`platform/prisma/migrations/20260729181006_result_commit_marker/migration.sql`).
It is the structural guarantee behind exactly-once: however many submissions
arrive for a job — duplicated, late, or hostile — the database admits one
`COMMITTED` row, and the loser is recorded as `SUPERSEDED`
(`platform/src/core/store/results.ts:70-97`). Proven against a real Postgres in
`platform/test/integration/lease.test.ts:142`.

**dead letter** — The terminal failure state for a job (`JobState.DEAD_LETTER`)
or an upload task (`UploadTaskState.DEAD_LETTER`). A job dead-letters when its
attempts are exhausted, or immediately on a `PERMANENT` or `POLICY` error
(`platform/src/core/store/jobs.ts:257-270`). Nothing retries a dead letter
automatically; an operator replays it, which resets the attempt counter to zero
(`jobs.ts:352-366`, `POST /api/v1/admin/jobs/:id/retry`). Note that jobs have no
`FAILED` state — exhaustion goes straight to `DEAD_LETTER`, which is why the
merged error feed filters jobs and upload tasks on different state sets
(`platform/src/core/api/routes/ops.ts:269-272`).

**envelope** (result envelope) — The single normalized document a worker submits
for one job, and the *only* way results enter the system: workers never write to
the database. Defined and strictly validated at
`platform/src/contracts/envelope.ts:21-48` — `.strict()`, so an unknown field is
a rejection, not a silently dropped key. Capped at 32 MiB and 20,000 chapters
per list (`envelope.ts:6-7`). See
[architecture-guide.md](architecture-guide.md#5-ingest-validates-the-envelope).

**extension** — A per-publisher plugin that discovers what chapters a source
currently offers. Under extension API v2 it is a single self-contained ESM file
that default-exports an `ExtensionFactory`, whose one job is to return an object
with a `collect()` method (`platform/src/contracts/extensionApi.ts:108-117`). An
extension is a *pure data producer*: it gets a sandboxed context and returns
chapters and manga. It holds no credentials, makes no MangaDex calls, and does
not decide what gets uploaded.

**job** — One unit of leasable work: an extension run, or one
[segment](#segment) of one. A job carries its own version pin (`bundleSha256`),
its retry budget, its timeout, and its `minTrust` requirement. See the [job state
machine](architecture-guide.md#the-job-state-machine).

**lease** — Time-bounded exclusive ownership of a job by one worker. Claiming a
job mints a fresh `leaseId` (a UUID) and sets `leaseExpiresAt`
(`platform/src/core/store/jobs.ts:144`, `166-171`). The lease id — not the worker
id — gates every subsequent transition: start, renew, complete, fail, and the
commit all name it in their `WHERE` clause, so a worker whose lease expired
cannot affect the job even if it is still running. Default TTL 300 s
(`LEASE_TTL_SECONDS`, `platform/src/config.ts:44`); the worker renews every
TTL/3 (`platform/src/worker/agent.ts:248-251`).

**manifest** — `manifest.json` in an extension directory: identity, languages,
schedule, `allowed_hosts`, partitioning, trust floor, and title-creation
defaults. It is validated *and enforced* — the core keeps its own copy for the
pinned bundle and checks worker output against it at ingest, because a worker
cannot vouch for itself (`platform/src/core/ingest/ingest.ts:120-155`). Schema:
`platform/src/contracts/manifest.ts:10-79`. Field reference:
[extension-guide.md](extension-guide.md#manifestjson-field-by-field).

**principal** — Who is calling and what they may do, resolved by the admin auth
hook into one of three kinds: `root` (the break-glass token, scopes `["*"]`),
`api-token` (a `pa_…` row, exactly its stored scopes), or `session` (a dashboard
login, scopes derived from the account's role)
(`platform/src/core/api/scopes.ts:65-72`, `platform/src/core/api/auth.ts:101-166`).

**quarantine** — What happens to an envelope that is well-formed but violates the
manifest or the database as policy: a URL on a host the manifest does not list, a
language it does not declare, a MangaDex title not in the extension's tracked map,
or a chapter claiming another extension's name. The submission is recorded
`QUARANTINED` with the exact reason, the violation is audited, and the job is
failed with error class `POLICY`
(`platform/src/core/ingest/ingest.ts:83-94`, checks at `ingest.ts:135-231`).
Nothing from a quarantined envelope reaches MangaDex. `POLICY` **retries** rather
than dead-lettering on first sight, because the envelope comes from a worker and a
hostile one could otherwise dead-letter every job it leases
(`platform/src/core/store/jobs.ts:246-268`). Distinct from `SUPERSEDED`, which
means "a valid submission that lost a race".

**removal mode** — How the platform takes a chapter off MangaDex when the
publisher no longer offers it. `"unavailable"` (the default) replaces the dead
link with a generated info card and repoints `externalUrl` away from it;
`"delete"` hard-deletes the chapter. Resolution order: the manifest's
`chapter_removal_mode`, else the global setting
(`platform/src/core/processor/processor.ts:170-171`;
`platform/src/core/store/settings.ts:4-8`). Duplicate chapters are always
hard-deleted regardless of the mode — an "unavailable" card on a duplicate would
just leave the duplicate in place (`processor.ts:575-579`).

**run** — One scheduled or manually triggered execution of one extension, and the
parent of one or more jobs. A run is created idempotently under a key: the
scheduler uses `sched:<extension>:<slot>`
(`platform/src/core/scheduler/service.ts:95`), so a scheduler that crashes and
restarts cannot double-create. Run kinds are `UPDATE` (the scheduled kind),
`CLEAN` (return the full catalogue so removals can be computed), and `FORCE` (the
default for a manual trigger).

**scope** — A permission string on an admin-audience credential, of the form
`<area>:read` / `<area>:write`, where write implies read within the same area and
nothing else implies anything (`platform/src/core/api/scopes.ts:82-89`). The
sixteen valid scopes are enumerated at `scopes.ts:20-37`; an unknown string is
rejected at mint time so a typo cannot produce a quietly powerless token
(`scopes.ts:56-63`). Every admin route declares the scope it needs. Full list:
[api-reference.md](api-reference.md#scopes).

**segment** — A slice of a partitioned run. When a manifest declares
`partition.mode: "tracked_manga"`, the scheduler splits the extension's tracked
manga ids into contiguous, **non-overlapping** chunks and creates one job per
chunk (`platform/src/core/scheduler/slots.ts:80-105`). Segment keys are a
deterministic hash of the inputs, so a replay addresses the same segments. Clean
runs are never partitioned — a missing segment must not read as "the publisher
removed everything" (`platform/src/core/scheduler/service.ts:116-118`).

**tracked / untracked manga** — A series is *tracked* when a `tracked_manga` row
maps its publisher-side id to a MangaDex title id; that table is the authority,
and it is delivered to workers on lease as `mangaIdMap`
(`platform/src/core/api/routes/worker.ts:118-136`). A series an extension reports
that has no such mapping is *untracked*: it lands in `untracked_manga` with state
`NEW` and either gets a MangaDex title created automatically (when the manifest
sets `auto_create_titles`) or waits for an operator to approve it
(`platform/src/core/md/titleService.ts:44-64`). Chapters of an untracked series
are dropped by the runner rather than travelling with a null title id
(`platform/runner-node/runner.mjs:613-622`).

**trust tier** — `TRUSTED` or `COMMUNITY`, assigned to a worker at enrollment
from the enroll token's tier (`platform/src/core/store/workers.ts:59-68`). A
manifest's `min_trust` sets a floor; the claim query filters it, so a `COMMUNITY`
worker can never lease a `TRUSTED`-only job
(`platform/src/core/store/jobs.ts:149-151`, tested at
`platform/test/integration/lease.test.ts:190`).

**upload task** — A queued MangaDex mutation, of kind `UPLOAD`, `EDIT`, `DELETE`
or `UNAVAILABLE`. The processor enqueues them; only `core-uploader` executes
them, because it is the only process holding MangaDex write credentials. Insertion
is `ON CONFLICT DO NOTHING` on `(kind, dedupeKey)`, so re-processing a run cannot
enqueue the same chapter twice
(`platform/src/core/store/uploadTasks.ts:26-35`).

**worker** — A host that leases jobs and executes extension code. It runs on
machines the operator may not control and therefore holds nothing worth stealing:
a worker token and whatever bundle it was handed. No database URL, no MangaDex
credentials, no Discord webhooks (`platform/docker/worker/Dockerfile:3-13`). One
job at a time, by design — scale out with more hosts, not more slots
(`platform/src/worker/agent.ts:43-50`).

---

## See also

| Document | For |
| --- | --- |
| [architecture-guide.md](architecture-guide.md) | how these pieces fit together, traced end to end |
| [data-model.md](data-model.md) | the tables these terms name |
| [api-reference.md](api-reference.md) | every endpoint and the scope it requires |
| [extension-guide.md](extension-guide.md) | writing an extension against the v2 contract |
| [security-trust-model.md](security-trust-model.md) | the threat model behind trust tiers and scopes |
