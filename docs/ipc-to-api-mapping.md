# Legacy IPC → Admin API mapping

Date: 2026-07-29

This is the migration contract for the two existing API clients — the Discord
bot and the dashboard. Both currently speak JSON-RPC over a Unix socket to
`run.py`'s in-process IPC server (`_setup_ipc_server`, 27 registered commands).
Both must move to HTTPS against the core admin API.

## How the transport changes

| | Legacy | Platform |
|---|---|---|
| Transport | Unix domain socket, newline-delimited JSON | HTTPS, JSON bodies |
| Location | same host, same container as the scheduler | `https://publoader.ardax.dev` (any host) |
| Auth | filesystem permissions on the socket | `Authorization: Bearer $PUBLOADER_ADMIN_TOKEN` |
| Attribution | none | `X-Actor: <name>` header, recorded in `audit_events` |
| Errors | `{"ok": false, "error": "..."}` | HTTP status + `{"error": "..."}` |
| Rate limit | none | per-IP limiter on the admin scope (429) |

Every mutating endpoint writes an `AuditEvent` naming the actor, so the bot
should forward the invoking Discord user in `X-Actor`
(e.g. `X-Actor: discord:ardax#0001`).

## Command mapping

Base path for every endpoint below is `/api/v1/admin`. "CLI" is the
`publoader-admin` equivalent (`platform/src/cli/admin.ts`).

### Direct equivalents

| Legacy IPC | Endpoint | CLI | Notes |
|---|---|---|---|
| `run` | `POST /runs` | `runs trigger <ext> [--kind]` | `force: true` → `kind: "FORCE"`; `clean: true` → `kind: "CLEAN"`; neither → `UPDATE`. One extension per call — the legacy `extensions: [...]` list becomes N calls. Returns `{runId, created}`; `created: false` means the idempotency key already existed. Returns 409 while paused, matching the legacy paused rejection. |
| `list_schedule` | `GET /schedules` | `schedules list` | Returns `{defaults, overrides}`. `defaults` now comes from each bundle's `manifest.json` rather than `schedule*.json` files on disk. |
| `set_schedule` | `PUT /schedules/:name` | `schedules set <ext> <hour> <minute> [--day]` | Body `{hour, minute, day?}`. No explicit reschedule step: the scheduler recomputes due slots every tick, so the change takes effect within one `SCHEDULER_INTERVAL_SECONDS`. |
| `remove_schedule` | `DELETE /schedules/:name` | `schedules remove <ext>` | Returns `{removed: boolean}`, same "no override existed" semantics. |
| `get_removal_mode` | `GET /removal-mode` | `removal-mode get` | Returns `{mode, validModes}`. The legacy `explicit` / `default` fields are dropped — read `settings` if you need to distinguish. |
| `set_removal_mode` | `POST /removal-mode` | `removal-mode set <mode>` | Body `{mode}`, validated against `unavailable \| delete`. |
| `list_extensions` | `GET /extensions` | `extensions list` | Source of truth changes: the legacy version scanned `publoader/extensions/src/` on the local disk; this lists **published bundles** with version, sha256, and disabled flag. An extension that exists in the repo but was never published does not appear — that is the intended behaviour. |
| `disable_extension` | `POST /extensions/:name/disable` | `extensions disable <name>` | |
| `enable_extension` | `POST /extensions/:name/enable` | `extensions enable <name>` | |
| `run_history` | `GET /runs?limit=&extension=` | `runs list` | Richer than the SQLite `run_history` rows: state machine state, segment count, bundle pin. Use `GET /runs/:id` (`runs show`) for per-job detail including `lastError`. |
| `stats` | `GET /stats` | `stats` | Returns job counts by state, upload-task depths by (kind, state), worker counts by status, quarantine count, pause flag. Replaces both `stats` and the queue-length half of `status`. |
| `pause` | `POST /pause` | `pause [--minutes]` | Body `{minutes?}`; omit for indefinite. Unlike the legacy version the pause is authoritative in Postgres, so it is honoured by every replica immediately rather than by one process's global. |
| `resume` | `POST /resume` | `resume` | |
| `status` | `GET /stats` + `GET /workers` | `stats`, `workers list` | Split in two. `pid` and the in-process `schedule` job list have no equivalent — see below. |
| `queue_peek` | `GET /stats` (depths only) | `stats` | **Partial.** Depths are covered; per-row sampling is not — see gaps. |

### New capabilities with no legacy counterpart

These have no IPC command to migrate from, but the bot and dashboard should
surface them because they are where operational problems now appear.

| Endpoint | CLI | What it is |
|---|---|---|
| `POST /enroll-tokens` | `enroll-token create` | Mint a single-use worker enrollment token. |
| `GET /workers` | `workers list` | Fleet inventory with heartbeat age and trust tier. |
| `POST /workers/:id/{drain,activate,revoke}` | `workers drain\|activate\|revoke` | Worker lifecycle. |
| `GET /runs/:id` | `runs show <id>` | Run detail with every job, attempt count, lease holder, and error. |
| `POST /jobs/:id/cancel` | `jobs cancel <id>` | Cancel one job. |
| `POST /jobs/:id/retry` | `jobs retry <id>` | Replay a dead-lettered job. |
| `GET /dead-letter` | `dead-letter` | Jobs that exhausted retries or hit a permanent/policy error. |
| `GET /quarantine` | `quarantine` | Result envelopes rejected by schema or policy validation — the signal that a worker is misbehaving. |
| `POST /bundles` | `bundle publish <dir>` | Publish a content-addressed extension bundle. |
| `GET /audit` | `audit` | Who did what, when. |

### Retired — and what replaces the capability

| Legacy IPC | Why it is gone | What to do instead |
|---|---|---|
| `reload` | Called `importlib.reload(publoader)` on a long-lived in-process module tree. There is no such tree: extension code is fetched per job as a sha256-pinned bundle and executed in a fresh subprocess on a worker host. | Publish a new bundle (`bundle publish`). The next job picks it up; no reload step exists. |
| `restart` | `worker.kill()` → GitHub tarball self-update → `pip install` → `os.execv`. A container must not rewrite and re-exec itself. | Redeploy the image: `docker compose pull && docker compose up -d`, then `prisma migrate deploy`. See `docs/operations.md` → "Upgrade the core". |
| `pull` | Downloaded a GitHub tarball with a PAT and `shutil.move`d it over the live source tree. Mutating a running deployment's source is exactly the supply-chain property the bundle pipeline removes. | Build bundles in CI from the extensions repos and `bundle publish --source-commit <sha>`. Bundles are immutable, versioned, hash-addressed, and recorded in the audit log. |
| `restart_workers` | Killed and respawned four `multiprocessing.Process` children inside one container. The upload workers are now separate container replicas and the scrape workers are remote hosts. | Upload-task workers: `docker compose restart core-uploader`. Scrape workers: `workers drain <id>` then restart the remote agent, then `workers activate <id>`. In-flight work is leased and requeues automatically either way. |
| `kill_tasks` | Drained an in-memory `queue.Queue` and restarted local children. There is no in-memory queue — every unit of work is a durable row. | `jobs cancel <id>` per job. **Bulk cancel is a gap** (see below). |
| `logs` | Tailed `*.log` files from the scheduler's own filesystem. Work now executes on machines the core cannot read. | Container logs via the host log driver (`docker compose logs -f core-api`). For a failure, the diagnostic path is `runs show <id>` → per-job `lastError` → `dead-letter` → `quarantine` → `audit`. **Centralised log aggregation is a gap** (see below). |
| `config_show` | Read a local `config.ini` through `configparser`. | Configuration is environment/Docker-secret driven (`platform/src/config.ts`). Inspect with `docker compose config` on the core host; secrets are deliberately not exposed over the API. |
| `config_set` | Rewrote `config.ini` in place and only affected that one process. | Edit the compose env / secret file and redeploy. Nothing that changes MangaDex credentials or database URLs should be settable from a Discord message. |
| `mdauth_status` | Read the local `mdauth.json`. | **Gap** — see below. Only `core-uploader` holds MD credentials now. |
| `force_login` | Forced a MangaDex password-grant login and rewrote `mdauth.json`; other processes kept stale copies. | **Gap** — see below. |
| `logout` | Deleted `mdauth.json` and poked private attributes on an in-process singleton. | **Gap** — see below. Credential revocation now means rotating the secret and redeploying `core-uploader`. |

## Gaps to close before the bot and dashboard can fully cut over

These are the commands with no v1 equivalent. Each is a small, well-scoped
addition to `platform/src/core/api/routes/admin.ts`; none blocks the data
migration, but the bot loses a feature until they land.

1. **MangaDex auth visibility** (`mdauth_status`, `force_login`, `logout`).
   Suggested: `GET /api/v1/admin/md/auth` returning `{authenticated, expiresAt,
   expiresInSeconds}` and `POST /api/v1/admin/md/reauth`. These must be served
   by whichever process owns the MD token (`core-uploader`), either by moving
   the token into a `settings`-style row that `core-api` can read, or by
   `core-uploader` publishing its auth state to a row on each refresh. The
   second is preferable: the credential stays in one process.
   *Deliberately not provided: an endpoint that logs out.* Revoking MD access
   is a credential rotation, documented in `docs/operations.md`.

2. **Upload-task inspection and cancellation** (`queue_peek`, `queue_clear`).
   Suggested: `GET /api/v1/admin/upload-tasks?kind=&state=&limit=` for the
   sample, and `POST /api/v1/admin/upload-tasks/:id/cancel`. A bulk purge
   equivalent to `queue_clear` should stay behind an explicit
   `?confirm=<count>` guard — the legacy version could empty a queue of
   thousands of pending uploads with one Discord message.

3. **Bulk cancel** (`kill_tasks`). Suggested: `POST /api/v1/admin/runs/:id/cancel`
   to cancel every job in a run, which covers the realistic case ("that FORCE
   run was a mistake"). Cancelling the entire queue is not a useful operation
   on a durable store.

4. **Log access** (`logs`). v1 has no centralised log API by design — logs are
   structured JSON on stdout with `runId`/`jobId`/`workerId` correlation, meant
   to be scraped by the host's logging stack. If the bot needs `/logs` back,
   the right shape is a query against a log aggregator, not a file-tailing
   endpoint on core-api.

5. **Effective schedule preview.** `list_schedule` returned the live
   `schedule` library job strings, i.e. the *next fire time*. `GET /schedules`
   returns configuration, not next-fire times. If the dashboard shows a
   countdown, add `nextRunAt` to the response computed from
   `core/scheduler/slots.ts`.

## Client migration notes

- **Idempotency.** `POST /runs` accepts an `idempotencyKey`. A bot that retries
  on network timeout should generate one key per user command
  (e.g. `discord:<interaction_id>`) so a retry cannot create two runs. Without
  a key the server generates a timestamped one and every retry creates a run.
- **Polling.** The legacy `run` command returned once the job was queued and the
  bot inferred completion from the queue length. Now poll `GET /runs/:id` until
  `state` is `PROCESSED`, `FAILED`, `DEAD_LETTER`, or `CANCELLED`.
- **Rate limiting.** The admin scope returns 429 under load. Clients must back
  off rather than retry immediately; a dashboard that polls `/stats` on a
  one-second timer will trip it.
- **Token scope.** There is one admin token in v1 and it grants everything,
  including `bundle publish`. The bot and dashboard both hold it. Per-client
  tokens with scopes are a follow-up; until then, treat the bot's token as
  equivalent to shell access to the platform's control plane and keep the bot's
  command surface allowlisted on the bot side.
