# Security and trust model

Date: 2026-07-29
Scope: the platform as implemented on this branch (v1).

The design problem: **run community-supplied code, on machines the operator
does not control, without giving those machines the ability to write to
MangaDex, read the database, or see any credential.**

The answer is a split of authority, not a sandbox:

- Workers **execute** extensions and **propose** results.
- The core **validates** every proposal against a manifest it holds itself, and
  is the only thing that can **act** — the only process that writes to Postgres
  and the only process that writes to MangaDex.

A worker's maximum achievable outcome is therefore "submit a plausible lie that
survives validation and MangaDex-side deduplication". Everything below is
either enforcing that ceiling or lowering it.

---

## 1. Control matrix

One section per component. "Trust level" is what the system assumes about it,
not how much you personally trust the person running it.

### 1.1 Public edge — `publoader.ardax.dev` / cloudflared

| | |
|---|---|
| **Assets** | The DNS name and TLS termination; the tunnel token, which *is* the identity that serves that hostname. |
| **Trust level** | Untrusted network position, trusted software. It is internet-facing by definition and gets exactly one hop. |
| **Authn/authz** | None of its own. It authenticates nothing and authorises nothing; it forwards to `core-api`, which does both. The tunnel token authenticates the tunnel *to Cloudflare*. |
| **Network exposure** | The only ingress path into the whole system. Nothing else is published on the host — no `ports:` on any core service. |
| **Hardening** | `read_only`, `cap_drop: ALL`, `no-new-privileges`, 256 MB cap, attached only to the `edge` network so it has **no route to Postgres**. Cloudflare-side WAF rules are load-bearing, not optional: block `/metrics`, `/healthz`, `/readyz` from the internet; hard rate limit `/api/v1/worker/enroll`; allow only `/api/v1/worker/*` and `/api/v1/admin/*`. |
| **Residual risks** | Cloudflare is a trusted third party with plaintext visibility — the worker and admin bearer tokens transit it. A stolen `TUNNEL_TOKEN` lets an attacker serve the hostname (phish workers into enrolling against a fake core, harvest worker tokens). Image tracks `latest`, so it changes without review. |

### 1.2 core-api

| | |
|---|---|
| **Assets** | `ADMIN_TOKEN` (in memory); the database connection; every worker token hash; every result envelope before validation. |
| **Trust level** | Fully trusted. It is the policy decision point. |
| **Authn/authz** | Two strictly separated bearer audiences (`platform/src/core/api/auth.ts`): `pw_…` worker tokens authorise **only** `/api/v1/worker/*`; the admin token authorises **only** `/api/v1/admin/*`. There is no shared session and no token that does both. Comparison is `timingSafeEqual`, with a burned comparison on length mismatch so length is the only observable difference. Worker tokens are sha256-hashed at rest and looked up by hash; the admin token is compared directly. |
| **Network exposure** | `expose: 8100` only — reachable from the compose network (i.e. from cloudflared) and nowhere else. |
| **Hardening** | `read_only` + noexec/nosuid tmpfs, `cap_drop: ALL`, `no-new-privileges`, non-root uid 10001, 768 MB cap. Per-IP rate limiter on enrol, per-worker limiter on the worker scope, per-IP limiter on admin. Body size caps on envelopes, artifacts, and bundles (64 MB). Fastify JSON Schema on transport, strict zod on payloads. Fails **closed**: no `ADMIN_TOKEN` → the admin API answers 503, not 200. |
| **Residual risks** | Single admin token, unscoped — it grants bundle publishing as well as pause/resume, and the bot and dashboard both hold it. A bug in envelope handling is reachable pre-validation by any enrolled worker. `/metrics` is unauthenticated and relies on the edge to block it; if the WAF rule is missing, fleet and queue topology leak. |

### 1.3 Admin surface — `/api/v1/admin/*`

| | |
|---|---|
| **Assets** | Every control operation: trigger runs, publish bundles, pause, drain/revoke workers, mint enroll tokens, change removal mode, edit the tracked-manga mapping and extension override options (the config authority), and approve untracked series into new MangaDex titles. |
| **Trust level** | Operator-only. Effectively equivalent to shell access to the control plane. |
| **Authn/authz** | Single bearer token. `X-Actor` header is **attribution, not authentication** — it is attacker-controlled and only meaningful because possession of the token is already proven. |
| **Network exposure** | Through the tunnel, same as everything else. |
| **Hardening** | Every mutating route writes an `AuditEvent` with actor, action, subject and detail. Extension names are regex-validated (`^[a-z0-9_]+$`) at the route before reaching any store. Removal mode is enum-validated. Rate limited. |
| **Residual risks** | No scopes and no per-client tokens: the Discord bot holds the same credential you do, so a compromised bot can publish a bundle, repoint a tracked-manga mapping, or approve a title into existence. No overlap window on rotation — changing the token breaks every client at once. `bundle publish` accepts any zip that passes manifest validation, so admin-token compromise is code execution on every worker. Repointing a `tracked_manga` mapping is the quietest destructive action available: it makes future chapters upload to the *wrong MangaDex title*, with nothing in the upload path to notice. |

### 1.4 core-scheduler

| | |
|---|---|
| **Assets** | Database write access to runs, jobs, and leases. |
| **Trust level** | Fully trusted. No external input at all — it reads the database and the clock. |
| **Authn/authz** | None needed; it has no listener. |
| **Network exposure** | `data` network only. No egress, no ingress. |
| **Hardening** | Same baseline as core-api. Exactly one replica — duplicate schedulers would race on slot creation (though idempotency keys make that safe, it is wasted work). Healthcheck disabled deliberately: a hung loop is detected out-of-band via `publoader_scheduler_lag_seconds`, rather than by mounting `docker.sock` for an autoheal container. That trade is explicit — the socket mount is a larger risk than the failure mode it fixes. |
| **Residual risks** | Single point of liveness: if it wedges, nothing is scheduled and no expired lease is swept. Detection is metric-based, so it depends on someone actually alerting on the lag gauge. |

### 1.5 core-processor

| | |
|---|---|
| **Assets** | MangaDex **read** credentials; database write access to `upload_tasks`. |
| **Trust level** | Fully trusted, but deliberately limited: it reads MangaDex and never writes to it. |
| **Authn/authz** | MangaDex OAuth for reads. |
| **Network exposure** | `data` + `edge`, with public DNS (the LAN resolver sinkholes `mangadex.org`). |
| **Hardening** | Same baseline; 1 GB cap. Consumes only **already-committed** envelopes, so everything it sees has passed schema and policy validation. |
| **Residual risks** | It holds MangaDex credentials that are technically write-capable at the account level — the restriction to reads is code discipline, not an API-enforced scope. A bug here cannot upload, but it can enqueue a wrong `DELETE`/`UNAVAILABLE` task, which the uploader will then act on. That is the most damaging realistic bug in the system, because deletion is not reversible. |

### 1.6 core-uploader — the MangaDex credential holder

| | |
|---|---|
| **Assets** | The MangaDex account: username, password, client id, client secret, and the live session. This is the crown jewel. Also hosts the **title service**, which creates MangaDex titles for untracked series. |
| **Trust level** | Fully trusted and maximally isolated. |
| **Authn/authz** | MangaDex OAuth. It is the **only** process in the entire system permitted to write to MangaDex — chapter uploads and **title creation** alike. |
| **Network exposure** | `data` + `edge`. No listener. |
| **Hardening** | Same baseline; 1.5 GB cap and a larger 1 GB tmpfs for image work; `stop_grace_period: 120s` so an in-flight chapter commit finishes rather than leaving a half-uploaded session. Exactly one replica — the MD upload session is per-account state and two uploaders would clobber each other. Every commit attempt is recorded in `upload_log` before and after, closing the legacy crash window between "MD commit succeeded" and "queue row removed". |
| **Residual risks** | Compromise here is total with respect to MangaDex — it can post, edit, delete, and now *create titles* with anything the account can do. Credentials are long-lived; rotation is manual. There is no second-person approval on destructive operations, so a `DELETE` task that reached the queue *will* be executed. With `auto_create_titles: true`, title creation is likewise unattended — see §2a. |

### 1.7 postgres

| | |
|---|---|
| **Assets** | Everything durable: chapter history, queues, leases, result envelopes, artifacts, bundle zips, worker token hashes, audit trail. |
| **Trust level** | Fully trusted; the single source of truth. Losing it loses the system. |
| **Authn/authz** | Password auth, one application role. |
| **Network exposure** | `data` network with `internal: true` — **no default gateway**, so it has no route to the internet and no route from the tunnel. No published host port. `docker compose exec` is the access path, deliberately not a port. |
| **Hardening** | `no-new-privileges`, 2 GB cap, pinned to a minor tag (`16.9-bookworm`) so a rebuild cannot jump a minor unnoticed, `--locale=C` so a glibc upgrade cannot silently reorder text indexes. Health-gated: `migrate` and every service wait on `pg_isready`. |
| **Residual risks** | One role for all four services — `core-api` has the same grants as `core-uploader`; per-service roles with narrower grants are not implemented. No encryption at rest beyond whatever the host provides. The `pgdata` volume is the entire blast radius of `docker compose down -v`. |

### 1.8 Bundles pipeline

| | |
|---|---|
| **Assets** | The extension code that every worker executes. This is the supply chain. |
| **Trust level** | Trusted at publish time, verified at execution time. |
| **Authn/authz** | Admin token to publish. Content-addressed by sha256 thereafter — no name-based resolution at execution. |
| **Network exposure** | Published via the admin API; served to workers over the worker API, keyed by sha256. |
| **Hardening** | `manifest.json` is required and validated with strict zod at publish (name regex, uuid group id, non-empty `allowed_hosts` and `languages`, entrypoint path shape). The existing AST static scan is retained as a publish-time gate. Jobs pin `bundleSha256`; a worker that cannot obtain exactly that bundle fails the job with a `POLICY` error rather than running something else. `sourceCommit` is recorded, and publishing is audited. Bundles are immutable and `yanked` rather than mutated. |
| **Residual risks** | **No signing.** sha256 pinning proves the worker ran what the core stored; it does not prove the core stored what the maintainer wrote. Anyone with the admin token can publish arbitrary code to the whole fleet. Sigstore signing is an explicit v2 item. Python dependencies are baked into the worker image at build time from `requirements.txt`, so a compromised PyPI package is a fleet-wide compromise with no verification step. |

### 1.9 Worker agent

| | |
|---|---|
| **Assets** | One worker token, scoped to `/api/v1/worker/*` on one deployment. Bundle cache. Job inputs. |
| **Trust level** | **Untrusted.** Assume the host operator is hostile and the extension code is buggy. |
| **Authn/authz** | Bearer `pw_…` token obtained by exchanging a single-use, expiring enroll token. Only the sha256 hash is stored server-side. Individually revocable. Self-rotatable (`POST /api/v1/worker/token/rotate`, atomic swap). Lease operations additionally require the matching `leaseId` — an expired lease cannot renew, complete, or overwrite its successor. |
| **Network exposure** | **Outbound only.** No `ports:`, no `expose:`. Works behind NAT, on a laptop, on a home connection, with no firewall exception and no inbound attack surface. |
| **Hardening** | `read_only` root fs; `/tmp` as `rw,noexec,nosuid,nodev,size=2g` (noexec blocks executing a downloaded payload); `cap_drop: ALL` — a scraper needs no kernel capability; `no-new-privileges`; `mem_limit` = `memswap_limit` so an over-memory extension is OOM-killed promptly instead of thrashing the host disk; `cpus`; `pids_limit: 512` as a fork-bomb ceiling; `nofile` ulimits. `stop_grace_period: 60s`, after which the core's lease sweeper reclaims the job — an abrupt kill loses time, not work. |
| **Residual risks** | The container boundary is the whole isolation story: a container escape is a host compromise on the worker's own host (not the operator's). A hostile worker can fabricate results — see §2. It can also selectively **withhold** results, which is harder to detect than fabricating them. |

### 1.10 Python runner / extension code

| | |
|---|---|
| **Assets** | Nothing of the operator's. It receives the job spec, the pinned bundle, and the extension's data files — that is all. |
| **Trust level** | **Untrusted code, running on an untrusted host.** The worst position in the system, which is why it holds nothing. |
| **Authn/authz** | None. It has no credential and no API access; it communicates by printing an envelope to stdout. |
| **Network exposure** | Outbound to the manifest's `allowed_hosts` only. |
| **Hardening** | Subprocess with a wall-clock timeout (`timeout_seconds`, 60s–6h, default 1h). In-process egress allowlist built from the manifest's `allowed_hosts` via requests/aiohttp hooks — the same technique as the existing rotation hooks, so **the manifest is enforced policy, not documentation**. For partitioned runs, the shim filters returned chapters to the segment's manga ids **regardless of what the extension returns**, so overlapping segment output is impossible by construction rather than by extension cooperation. Inherits every container control in §1.9. |
| **Residual risks** | The egress allowlist is in-process and in Python — an extension that deliberately bypasses `requests`/`aiohttp` (raw sockets, a subprocess, a C extension) is not stopped by it. It is a guardrail against accident and casual misbehaviour, not a containment boundary. The real boundary is that the extension has nothing worth stealing and cannot act on its output. Per-extension micro-VM or gVisor isolation is a documented v2 item. |

### 1.11 Discord bot and dashboard (API clients)

| | |
|---|---|
| **Assets** | The admin token. Discord bot token. |
| **Trust level** | Semi-trusted. They hold operator-equivalent credentials but are exposed to user input from Discord. |
| **Authn/authz** | Admin bearer token against `/api/v1/admin/*`; Discord's own auth for their users. They should forward the invoking user in `X-Actor`. |
| **Network exposure** | Outbound HTTPS to the API. The dashboard additionally serves a UI, which should stay behind Cloudflare Access. |
| **Hardening** | Command allowlisting on the client side is the only control that limits what a Discord user can reach, because the token itself is unscoped. Rate limiting on the admin scope backstops a runaway client. |
| **Residual risks** | **This is the weakest link in v1.** A compromised bot has full control-plane authority including `bundle publish`, i.e. code execution on every worker. The legacy bot additionally mounted `docker.sock`; removing that mount is a decommission-checklist item (`docs/migration-guide.md` stage 7) and should be treated as required, not optional. Per-client scoped tokens are the fix and are not implemented. |

---

## 2. Worker fabrication: threat analysis

**The threat.** An enrolled worker is handed a job, runs whatever it likes (or
nothing), and submits a result envelope of its choosing. It can:

1. Fabricate chapters that do not exist on the publisher's site.
2. Alter real chapters — wrong title, wrong number, wrong language, wrong manga.
3. Point `chapterUrl` at content it controls.
4. Omit chapters that do exist (withholding).
5. On a `CLEAN` run, report an empty chapter list, implying everything was
   removed — the most damaging variant, because removal is not reversible.
6. Replay or delay a stale envelope to overwrite a newer result.

**What actually happens to a fabricated envelope**, in order:

**a. Lease binding.** The submission must carry the `leaseId` currently
associated with the job. A worker whose lease expired and was reassigned cannot
complete or overwrite the successor; its late submission is recorded as
`SUPERSEDED`. It cannot submit for a job it was never leased.

**b. Schema validation.** Strict zod, unknown fields rejected, size-capped.
`ChapterRecord` is closed — there is no passthrough field to smuggle data
through. Malformed input never reaches business logic.

**c. Policy validation against the core's own manifest copy.** This is the
important one: the core validates against **its** stored manifest, not against
anything the worker sends. Enforced:

- Every chapter and manga URL host must match `allowed_hosts` (exact or
  subdomain). This defeats threat 3 outright — a worker cannot point a chapter
  at a domain the maintainer did not declare.
- Languages must be a subset of the manifest's `languages`.
- `mangadexGroupId` must equal the manifest's. A worker cannot upload under a
  different scanlation group.
- Counts must be within caps.

A violation is `QUARANTINED` + audited + metered, and **never touches canonical
state**. There is no approve-and-commit path for a quarantined envelope,
deliberately.

**d. Segment filtering.** For partitioned runs the runner filters to the
segment's manga ids, and the core knows which ids a segment covers. A worker
returning chapters for manga outside its segment is visible.

**e. Commit marker.** A partial unique index — one `COMMITTED` row per job —
makes duplicate and out-of-order deliveries structurally unable to double-ingest.
Losers become `SUPERSEDED`. This closes threat 6.

**f. MangaDex-side deduplication before upload.** The processor fetches the
manga's existing chapters from MangaDex and applies the ported duplicate / edit
/ skip decisions. A fabricated chapter that collides with a real one is a no-op.

**g. Central upload authority.** Even after all of the above, the worker has
only caused a row to appear in `upload_tasks`. The upload itself is performed by
`core-uploader` with the operator's credentials, and is recorded in `upload_log`.

**h. Trust tiers.** Manifests may set `min_trust: TRUSTED`. Jobs for those
extensions are never leased to `COMMUNITY` workers. Private-repo extensions
default to trusted-only.

**i. Audit and attribution.** Every submission carries `workerId`. If something
wrong reaches MangaDex, the worker that proposed it is identifiable, and
`workers revoke` is immediate.

**What remains, honestly:**

- **Plausible fabrication survives.** A chapter with a well-formed number, a
  declared language, a URL on an allowed host, and no MangaDex collision *will*
  be uploaded. Nothing in v1 checks that it corresponds to reality.
- **Withholding is not detected at all.** A worker that returns an empty
  `updatedChapters` looks identical to "the publisher posted nothing".
- **`CLEAN`-run removal is the highest-severity path.** The mitigation shipped
  is structural: a `CLEAN` run is **never processed from partial segments**
  (`requireAllSegments`), because absence of data must never be read as
  deletion. Combined with the default `removal_mode: unavailable` — which marks
  a chapter unavailable rather than deleting it, preserving the card on
  MangaDex — the realistic worst case from a hostile worker is chapters marked
  unavailable, which is recoverable. **Operators running `removal_mode: delete`
  with `COMMUNITY` workers are accepting an unrecoverable-loss risk.** Set
  `min_trust: TRUSTED` on extensions where you run delete mode.

**Documented for v2** (target-architecture §12): probabilistic verification
re-runs of the same job on a second worker with result comparison; reputation
scoring per worker; canary manga with known-correct expected output.

### 2a. Title creation from worker-reported candidates

The untracked-series pipeline is the one place where worker-reported data can
cause a **new object to be created on MangaDex**, so it deserves its own
analysis.

**The flow.** An extension reports manga in the envelope's `untrackedManga`
array → the processor persists `untracked_manga` rows → the title service
(inside `core-uploader`) creates the MangaDex title → the mapping lands in
`tracked_manga` → a Discord embed announces it.

**Where the authority sits.** Workers **propose candidates; they never create
titles.** `untrackedManga` entries are `MangaRecord`s — id, name, language, url
— and go through the same pipeline as everything else: strict schema
validation, host allowlist on `mangaUrl`, language ⊆ manifest languages, counts
within caps. A violation quarantines the **whole envelope**, so a worker cannot
smuggle a bogus title candidate past validation by attaching it to an otherwise
valid result. Persistence is idempotent on `(extension, mangaId, mangaLanguage)`,
so replaying a result cannot enqueue the same candidate twice, and creation is
a CAS claim (`NEW → CREATING`) so two uploader instances cannot double-create.

**What a hostile worker can achieve.** With `auto_create_titles: false` — the
default — **nothing without a human**. The row sits at `NEW` until an operator
runs `untracked approve`. This is the recommended posture for any extension
that community workers execute.

With `auto_create_titles: true`, a worker that survives policy validation can
cause the operator's account to create MangaDex titles with attacker-chosen
name, language, and source URL. The mitigations are: the manifest opt-in itself
(off by default, per-extension, set by the maintainer not the worker), the host
allowlist on `mangaUrl`, `title_defaults` in the manifest fixing the content
rating / status / original language so those are not worker-controlled, and the
audit + Discord announcement making every creation immediately visible.

**The honest residual risk:** `auto_create_titles: true` plus `COMMUNITY`
workers means unattended title creation driven by untrusted input. Titles are
not silently destructive the way chapter deletion is — they are visible,
attributable, and removable — but cleaning up a few hundred junk titles is slow
manual work. **Pair `auto_create_titles: true` with `min_trust: TRUSTED`**, and
leave it off for anything a community worker executes.

There is also a non-adversarial failure with the same blast radius, and it is
the more likely one: if `tracked_manga` is empty or wrong (a config seed that
did not land — see `docs/migration-guide.md` stage 3a), every series looks
untracked and the pipeline will duplicate the entire catalogue. The operational
guard is watching `untracked list` volume, documented as a runbook in
`docs/operations.md`.

**Rate limiting title creation is not implemented.** A per-run or per-hour cap
on automatic creations, refusing to proceed when the untracked count exceeds a
threshold, would turn the flood case from an incident into a stopped queue.
Recommended before enabling `auto_create_titles` on anything busy.

---

## 3. Secrets inventory

| Secret | Held by | Where it lives | Rotation |
|---|---|---|---|
| `POSTGRES_PASSWORD` | postgres; all four core services via `DATABASE_URL` | `.env` or Docker secret; never leaves the `data` network | `ALTER USER` + `docker compose up -d`. See `docs/operations.md` → "Database password". |
| `ADMIN_TOKEN` | core-api; operator CLI; Discord bot; dashboard | `.env` / `ADMIN_TOKEN_FILE`; in memory in core-api | `openssl rand -base64 48`, update `.env`, `up -d core-api`, then update every client. **No overlap window** — clients break until updated. |
| `MANGADEX_PASSWORD`, `MANGADEX_CLIENT_SECRET` | core-uploader, core-processor only | `.env` / `_FILE`; never in core-api, core-scheduler, or any worker | Pause, update `.env`, restart the two services, revoke the old client MangaDex-side. Revoke **first** if the credential leaked. |
| MangaDex session/refresh token | core-uploader (in memory) | Not persisted to a shared file — unlike the legacy `mdauth.json` | Automatic refresh; forced by restarting core-uploader. |
| `TUNNEL_TOKEN` | cloudflared | `.env` / Docker secret | Regenerate in the Cloudflare Zero Trust dashboard, update `.env`, restart cloudflared. Rotate on any suspicion — it is the hostname's identity. |
| `DISCORD_WEBHOOK_URLS` | core-processor, core-uploader | `.env` | Regenerate the webhook in Discord; update `.env`. |
| Enroll token (`pe_…`) | Operator, then one worker, once | sha256 hash in `enroll_tokens`; plaintext shown once at mint | Single-use and TTL-bounded by construction. Lost token → mint another, let the first expire. |
| Worker token (`pw_…`) | One worker | sha256 hash in `workers.token_hash`; plaintext only on the worker's state volume | Worker-initiated: `POST /api/v1/worker/token/rotate` (atomic). Operator-initiated: `workers revoke` + re-enrol. |
| Discord bot token | Discord bot | Bot's own config | Discord developer portal. |
| GitHub PAT (legacy `pull`) | **Retired** | Was in `config.ini` | **Revoke outright at decommission.** The bundle pipeline does not need it, and it had write-capable scope on the source tree of a running deployment. |

**Convention.** `platform/src/config.ts` honours `<VAR>_FILE` for **every**
variable, so any secret can come from a Docker secret file instead of the
environment — it then never appears in `docker inspect`, in shell history, or
in a compose file committed by accident. Prefer this for anything above.

---

## 4. What a worker can and cannot do

Stated explicitly, because this is the question every prospective worker
operator asks and the one the design exists to answer.

**A worker CAN see:**

- Its own job specs: extension name, kind, segment index, and the list of
  external manga ids in its segment.
- The pinned extension bundle and its data files — i.e. the extension's source
  code and its `manga_id_map`. For a private-repo extension this is the
  strongest disclosure in the system, which is why those default to
  `min_trust: TRUSTED`.
- MangaDex manga ids and previously-posted chapter ids for its tracked manga.
  These are public information on MangaDex.
- Its own worker token.
- Whatever the extension fetches from the publisher's site.

**A worker CANNOT see:**

- MangaDex credentials, session tokens, or any ability to authenticate as the
  operator's account.
- The database — no connection string, no route (Postgres is on an `internal`
  network with no gateway), no query endpoint.
- Any other worker's token, jobs, or results.
- The admin token, Discord webhooks, or the tunnel token.
- Bundles for extensions it has not been given a job for.
- The audit log, the quarantine queue, or fleet composition.

**A worker CAN do:**

- Lease jobs for extensions its trust tier permits, execute them, and submit
  result envelopes.
- **Propose** untracked series as title-creation candidates (§2a). Proposing is
  not creating: with the default `auto_create_titles: false` an operator must
  approve each one.
- Upload artifacts (page images) tied to its own leased job, sha256- and
  size-verified.
- Fetch bundles by sha256 for jobs it holds.
- Rotate its own token; heartbeat.
- Fail, stall, or return nothing — losing time, not data.

**A worker CANNOT do:**

- Write to MangaDex. Ever. Not once, not indirectly — chapters or titles.
  `core-uploader` is the only process with that authority.
- Write to Postgres directly.
- Change any configuration. `tracked_manga` and `extension_configs` are the
  config authority and are writable only through the admin API; a worker sees
  the tracked ids for its own job as *input* and cannot alter the mapping.
- Complete, renew, or overwrite a job whose lease it does not hold.
- Cause a second ingestion of a job that already committed (partial unique
  index).
- Escape the manifest: upload under a different group, use an undeclared
  language, or reference a host outside `allowed_hosts`.
- Return chapters for manga outside its segment (shim-side filtering).
- Trigger runs, pause the platform, publish bundles, enrol other workers, or
  reach any `/api/v1/admin/*` route — a `pw_…` token is rejected there by
  audience, not by permission check.
- Reach the operator's host. It has no inbound ports and no route in.

**The one thing to be clear about:** a worker can *lie* within the schema. It
cannot *act*. Everything in §2 is about narrowing what a survivable lie can
achieve, and everything in §1 is about making sure a lie is the only thing on
the table.
