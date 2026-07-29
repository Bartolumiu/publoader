# Publoader Architecture Assessment

Date: 2026-07-29
Scope: `publoader` (core), `publoader-extensions` (public), `publoader-extensions-private` (private), with
[dexchan](https://github.com/Bartolumiu/dexchan) as an external architectural reference.

This document maps the system as it exists today, identifies what is worth keeping,
and enumerates the concurrency, durability, security, and operational failure modes
that motivate the target architecture in `docs/target-architecture.md`.

---

## 1. Current system map

### 1.1 Process topology

Everything runs on **one host** via `docker/docker-compose.yml`:

| Container | Role | Notes |
|---|---|---|
| `publoader` | Scheduler + extension execution + result processing, all in one process (`run.py`) | The only executor of work |
| `publoader-bot` | Discord control bot | Talks to scheduler over a **Unix socket in a shared bind mount**; mounts **`/var/run/docker.sock`** to restart the scheduler container |
| `publoader-dash` | Web control panel (Discord OAuth) | Same Unix-socket IPC path |
| `cloudflared` | Ingress tunnel for GitHub webhook + dashboard | |
| `watchtower` / `autoheal` | Image updates / unhealthy-container restarts | Both mount the Docker socket |

### 1.2 Execution flow (one scheduled run)

```
Scheduler (in-process `scheduler` lib, run.py)
  └─ main() → publoader.open_extensions()               [holds threading.Lock]
       └─ load_extensions()      importlib loads Extension classes from
       │                         publoader/extensions/src/<name>/<name>.py
       │                         (AST "dangerous call" scan, no sandbox)
       └─ run_extensions()       calls extension methods IN-PROCESS:
       │                         update_external_data(), get_updated_chapters(),
       │                         get_all_chapters(), get_updated_manga()
       └─ run_updates() → ExtensionUploader → MangaUploaderProcess
                            ├─ queries MangaDex API for existing chapters (dedup)
                            ├─ decides upload / edit / skip / delete / unavailable
                            └─ upserts into Mongo queues: to_upload, to_edit,
                               to_delete, to_unavailable (+ images into GridFS)
Watcher subprocesses (multiprocessing, one per queue)
  └─ Mongo change streams + startup backlog fetch → per-item processing
       └─ uploader.py: create MD upload session → upload images → commit
          → delete queue row → upsert `uploaded` / `uploaded_ids`
```

### 1.3 State

| Store | Contents |
|---|---|
| **MongoDB** (canonical) | `uploaded`, `uploaded_ids`, `edited`, `unavailable`, queues `to_upload`/`to_edit`/`to_delete`/`to_unavailable`, `images` (GridFS) |
| **SQLite** (`resources/publoader.db`, bind-mounted) | schedule overrides, run history, settings (pause, removal mode), disabled extensions |
| **Files (bind mounts)** | `config.ini` (all secrets), `mdauth.json` (MangaDex OAuth tokens), `manga_data.json` cache, extension repos, logs |
| **In-memory only** | run lock, in-flight extension set, IPC job queue, uploaded-chapter dequeue for index checks |

### 1.4 Extension contract (the compatibility surface)

An extension is a directory `src/<name>/` with `<name>.py` exposing `class Extension`,
constructed with the extension path. Consumed members (`load_extensions.py`):

- Attributes: `name`, `disabled`, `tracked_mangadex_ids: list[str]`,
  `mangadex_group_id`, `override_options: dict` (`same`, `multi_chapters`,
  `custom_language`), `extension_languages: list[str]`,
  optional `chapter_removal_mode`.
- Methods: `run_at() -> time`, `daily_check_run() -> bool`, `clean_at() -> list[int]|None`,
  `update_external_data(posted_chapter_ids, clean_db)`,
  `get_updated_chapters() -> list[Chapter]`, `get_all_chapters() -> list[Chapter]|None`,
  `get_updated_manga() -> list[Manga]`.
- Data shapes: pydantic dataclasses `Chapter` (16 fields incl. `images: list[bytes]`)
  and `Manga` (4 fields), defined in `publoader/models/dataclasses.py`.
- `manifest.json` (extensions repo) already declares: `name`, `version`,
  `publoader_api`, `entrypoint`, `class_name`, `mangadex_group_id`, `languages`,
  `allowed_hosts`, `permissions` (network / filesystem / subprocess),
  `schedule`, `data_files`, `maintainers`. **Today the core does not read or
  enforce any of this** — scheduling comes from `schedule.json` + SQLite
  overrides, permissions are unenforced documentation.

Key observation: everything **after** the extension returns its chapter lists
(MangaDex dedup, upload decisions, uploads) runs centrally and requires MangaDex
credentials + the canonical DB. The distributable unit is the **scrape phase**:
"given tracked ids and posted-chapter ids, return normalized Chapter/Manga lists."
This is a clean, serializable result envelope.

### 1.5 Controls & observability

- Discord bot + dashboard drive ~27 IPC commands (run/pause/schedule/queues/logs/
  config/auth). IPC = JSON over a Unix socket in the shared `resources/` mount.
- GitHub push webhook triggers repo pulls + module reload; daily self-restart via
  `os.execv` re-downloads repos as tarballs.
- Liveness: heartbeat file in `/tmp` + compose healthcheck + autoheal.
- Logging: rotating per-scope files; Discord webhooks as de-facto alerting.
- 35 test files (~150 tests) covering utilities, IPC, workers, dashboard, retry.

---

## 2. What works and should be retained (as behaviour, not necessarily code)

1. **The canonical data itself.** All chapter history (`uploaded`,
   `uploaded_ids`, `edited`, `unavailable`, queue backlogs) is preserved —
   migrated from MongoDB into the new PostgreSQL store by a scripted,
   re-runnable import (per the operator's TypeScript + Prisma + PostgreSQL
   directive; Postgres additionally gives us `FOR UPDATE SKIP LOCKED` and
   transactional unique constraints, the exact primitives leases and
   idempotency need).
2. **The central upload pipeline semantics.** `to_upload`/`to_edit`/`to_delete`/
   `to_unavailable` queues, upsert-by-`md_chapter_id`/`chapter_id` dedup,
   the unavailable-vs-delete removal-mode routing, chapter-card flow, and the
   `uploaded`/`uploaded_ids` bookkeeping are battle-tested MangaDex semantics.
   They stay, wrapped behind a validated ingestion layer.
3. **The extension data contract** (`Chapter`/`Manga` shapes, method names).
   Extensions keep working unmodified; the platform wraps them.
4. **The manifest format** in the extensions repo — it already anticipates
   policy enforcement (`allowed_hosts`, `permissions`); it becomes enforced.
5. **Operational controls** (pause/resume, disable extension, run-now, queue
   inspection, run history) — re-exposed over the new control plane.
6. **Discord webhooks for notifications**, cloudflared for ingress.

## 3. What must be replaced

| Current mechanism | Problem | Replacement |
|---|---|---|
| In-process, in-memory scheduler (`scheduler` lib + `threading.Lock` + `_inflight_extensions` set) | Not durable; crash mid-run loses all queued work; single host; no attempts/backoff/dead-letter | Durable `jobs` collection with lease/claim state machine (§target) |
| `importlib` + `reload()` of extensions inside the core process | A hung or malicious extension wedges/compromises the whole core incl. MangaDex + Mongo credentials; runtime `pip install` into the live venv | Isolated worker runtime executing extensions in containers with enforced manifests |
| Unix-socket IPC in a shared bind mount | Single-host only; no auth beyond filesystem | Authenticated HTTP control-plane API |
| Docker socket mounted into bot container | Root-equivalent host access from a Discord-facing process | Admin API endpoints (pause/cancel/drain) on the control plane; container restarts stay host-side (compose healthchecks/autoheal) |
| SQLite in a bind mount for scheduling state | Cross-host inaccessible; second source of truth | Consolidated into MongoDB (`platform_*` collections), SQLite kept read-compatible during migration |
| `os.execv` daily self-restart + tarball self-update | Mutates the running container; races in-flight work; unauditable | Immutable images + versioned extension bundles fetched by workers |
| Runtime `pip install -r` on boot (entrypoint + `install_requirements`) | Non-reproducible; supply-chain exposure in the credential-holding process | Deterministic worker images / bundled deps, content-addressed bundles |
| AST "dangerous call" scan as only guard | Trivially bypassable; not a sandbox | Container isolation + least privilege + egress allowlists from manifest |
| In-memory `uploaded_list` deque for index checks | Lost on crash | Persisted on the run/attempt record |

## 4. Failure modes of the current design

**Concurrency**
- The only duplicate-run guard is a process-local set; a container restart mid-run
  forgets in-flight state, and a second `run.py` on another host would happily
  double-run everything (nothing cross-host exists at all).
- Watcher "singletons" are per-process opinions; a respawned container plus a
  wedged old process can double-drain a queue (change streams deliver to both).

**Durability**
- Scheduler state and the IPC job queue are memory-only: a crash between "IPC
  accepted /run" and execution silently drops the run.
- A crash after MD upload commit but before `to_upload.delete_one` re-uploads the
  chapter on restart; only the later MD-side dupe check catches it — the
  window exists because there is no attempt/outcome record.
- Pause state is best-effort mirrored to SQLite; errors are swallowed.

**Security**
- Extensions execute with the core's full privileges: MangaDex tokens, Mongo URI,
  Discord bot token, GitHub PAT, and (via compose) reachability of the Docker
  socket-holding neighbours. `manifest.json` permissions are not enforced.
- No worker identity/authn exists; the system cannot accept third-party capacity
  at all without granting all of the above.
- Secrets live in a world-readable `config.ini` bind mount; `config_set` writes
  it back over IPC.

**Operational**
- "Process alive" (heartbeat file) is the only health signal; there is no
  "safe to receive work", queue-depth alerting, lease/attempt metrics, or stuck-job
  detection beyond Discord messages scrolling past.
- Extension failures are webhook messages, not classified, counted, or quarantined.

## 5. Dexchan reference — what to borrow

Dexchan is a Discord bot for MangaDex (Node.js) rather than a job platform; with
the platform rewrite landing on TypeScript, its stack conventions carry over
directly, but the useful architectural ideas are structural, not literal:
- Versioned, declarative per-module metadata and localization files validated at
  load time → mirrors our move to *validated, enforceable* manifests.
- Clean separation of API-client concerns (rate-limit-aware fetch wrappers) from
  feature logic → mirrors core-held MangaDex client vs worker-held scrapers.
- Its single-process deployment model, ad-hoc caching, and interaction-driven
  control flow are **not** applicable to a distributed executor and are not copied.

## 6. Conclusion

The system's *domain logic* (MangaDex semantics, extension contract, dedup rules)
is sound and must be preserved. Its *coordination fabric* (in-memory scheduler,
in-process execution, socket IPC, single-host assumptions, unenforced manifests)
is the bottleneck and is replaced wholesale by the control-plane/data-plane/worker
architecture specified in `docs/target-architecture.md`.
