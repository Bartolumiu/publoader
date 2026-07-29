# The operator dashboard

Date: 2026-07-30
Audience: anyone who has to drive publoader without a shell on the host.

The dashboard is served by `core-api` itself, at `https://publoader.ardax.dev/`
(and `/dash`). It is the same admin API the CLI and the Discord bot use, with a
login screen in front of it — there is no second backend, no separate
deployment, and no CORS surface. Every button maps to one documented endpoint;
anything the dashboard can do, `padmin` can do, and vice versa.

The design goal is **self-sufficiency**: an operator should be able to answer
"what is broken and why" and then fix it, without `docker exec`. Where that is
not true, it is listed explicitly at the bottom of this page.

---

## Signing in

Three methods, in the order you should prefer them:

| Method | For | Notes |
|---|---|---|
| Email + password | Day-to-day | Minimum 12 characters. An OWNER sets it from the Users view; there is no self-service reset. |
| Discord | Teams already on Discord | Only shown when `DISCORD_CLIENT_ID` is configured. New accounts land unapproved and an OWNER must approve them — and only if self-signup is enabled. |
| Admin token | Break-glass | The `ADMIN_TOKEN`, exchanged for a session cookie. Use it when the accounts table is the problem. It is never stored in the browser. |

The session is an HttpOnly, `SameSite=Strict` cookie backed by a revocable row,
so signing someone out actually ends their access rather than asking their
browser to forget. Sessions expire after `SESSION_TTL_MINUTES`; an OWNER can
revoke any live one from the Users view.

Login is rate limited to 5 attempts per minute per IP, and every rejected
attempt is audited (`session.login.rejected`).

---

## Roles

Three roles. They differ in *authority*, and the dashboard renders accordingly.

| | OWNER | ADMIN | CONTRIBUTOR |
|---|---|---|---|
| Runs, jobs, queues, workers | yes | yes | — |
| Extensions, schedules, bundles | yes | yes | read-only catalogue |
| Pause / resume, settings | yes | yes | — |
| Series map: add a new mapping | yes | yes | yes |
| Series map: repoint or remove an existing mapping | yes | yes | — |
| Untracked queue: approve / skip | yes | yes | yes |
| Audit log | yes | yes | — |
| Accounts, sessions, client tokens | yes | — | — |
| Database backup | yes | — | — |

**CONTRIBUTOR is the role to hand a community volunteer.** It exists so the
tedious, valuable job — mapping external series ids to MangaDex titles and
working the untracked queue — can be delegated without also delegating the
ability to trigger runs, read the audit log, or change where existing uploads
go. A contributor can *add* facts to the series map; they cannot *change* one,
because repointing a mapping silently redirects a series' uploads to a
different MangaDex title, and removing one silently stops them.

**ADMIN is full operational authority minus account administration.** An admin
runs the platform but cannot grant access to it: no inviting, no promoting, no
setting anyone else's password, no minting client tokens, no reading the
accounts list. That is the only privilege boundary between operators, and it is
enforced per endpoint, not by hiding buttons.

Roles are enforced server-side on every request. The UI hiding a section is a
convenience so nobody clicks into a wall of 403s — never the control itself.

---

## The sections

| Section | Needs | Answers |
|---|---|---|
| **Overview** | `stats:read` | Queue depths, worker counts, pause state, and the MangaDex session's expiry. The first screen in an incident. |
| **Activity** | `runs:read` | One time-ordered feed of everything that happened, merged across runs, jobs, upload tasks, quarantine and the audit log, filterable by severity, time window, extension and free text. Every row has a permalink. |
| **Workers** | `workers:read` | The fleet: status, trust tier, heartbeat, agent version, which extensions each worker takes. Drain, activate, revoke, and mint an enrolment token. |
| **Extensions** | `extensions:read` | Published bundles, per-extension schedule and config, the series map, and the publish drop zone. Trigger `UPDATE` / `FORCE` / `CLEAN` runs. |
| **Runs** | `runs:read` | Recent runs, their jobs, per-job attempts and lease holders, plus the dead-letter queue with replay. |
| **Queues** | `runs:read` | The MangaDex upload queues by kind and state, with retry, cancel, and "requeue stale leases". |
| **Untracked** | `untracked:read` | Series an extension reported that have no mapping yet. Approve creates the MangaDex title; skip never does. |
| **Quarantine** | `runs:read` | Result envelopes the core refused to believe. The security-relevant queue, not just an error queue. |
| **Audit** | `audit:read` | Who did what, searchable by actor, action, subject, free text and time window. |
| **System** | `settings:read` | Migration state (is this database the schema this build expects?), the MangaDex session, and the database backup. |
| **Users** | OWNER | Accounts, roles, approvals, passwords, and live sessions. |
| **Tokens** | OWNER | Scoped `pa_…` client credentials: mint, list, revoke. |

Runbooks for the triage-shaped ones — stuck upload tasks, a bad MangaDex
session, issuing and rotating client tokens — are in
[operations.md](operations.md).

---

## Curating the series map

An extension reports chapters against *its own* manga ids. The series map
(`tracked_manga`) is what turns those into MangaDex titles, and it is the one
table where a wrong row means uploading to the wrong series. It lives under
**Extensions → (an extension) → Open**.

The table is searchable (external id, MangaDex id, or source) and paged 50 rows
at a time, so an extension with a few thousand mappings is still navigable.

Four ways to edit it:

1. **One row at a time.** Add or repoint a single mapping.
2. **Paste a list.** Lines of `externalId,mangadexTitleId`. Whitespace, tabs,
   semicolons and pipes all work as separators; `#` starts a comment; a header
   row is skipped; and the two columns may be in either order, because the
   parser identifies the MangaDex id by its UUID shape. Every line is judged
   and reported individually — pasting 200 lines and being told which three
   were wrong is the point. At most 2000 rows per batch.
3. **Remove**, one row or in bulk. Requires `tracked:write`.
4. **Export.** Downloads every mapping in exactly the format the paste box
   accepts. That closes the loop: export, edit in whatever you like, paste back,
   preview, apply — no file in git and no shell on the host at any point.

Per-row outcomes:

| Outcome | Meaning |
|---|---|
| `added` | New mapping created. |
| `updated` | Existing mapping repointed — the response says what it was before. |
| `unchanged` | Already mapped to exactly that title. |
| `removed` | Mapping deleted. |
| `rejected_needs_write` | The row would change or remove an existing mapping and the caller only holds `tracked:append`. |
| `not_found` | Asked to remove a mapping that does not exist. |
| `invalid` | Not a MangaDex id, or the same external id listed twice with different targets (the last one is used, and the duplicate is flagged). |

**Preview before you commit.** The dashboard never applies a paste directly: it
runs a dry run first, shows the per-row verdict, and only then offers an Apply
button labelled with the counts. `dryRun` reports what the batch would do and
writes nothing:

```bash
curl -sX POST "$API/api/v1/admin/extensions/mangaplus/tracked/batch" \
  -H "authorization: Bearer $PUBLOADER_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"dryRun": true, "text": "12345,4f1de6a2-f0c5-4ac5-bce5-02c7dbb67deb"}'
```

The preview covers **additions, repoints and removals** — every row is judged
exactly as the real batch would judge it, and the write transaction is skipped
entirely. Both dashboard modes go through it, so there is no second
implementation of the rules to drift out of step.

Worth knowing what this replaced, because the old shape is a trap worth
recognising if you see it elsewhere: the dry run used to apply the batch for real
and then delete the rows it had inserted. That undid the additions and left every
*repoint* in place — so previewing a paste could silently redirect a series'
uploads to a different MangaDex title, and the uncommitted mappings were briefly
visible to the scheduler. A preview that writes is not a preview.

A preview leaves no audit entry, because nothing happened. A real batch leaves
one (`tracked_manga.batch`) with the counts.

---

## Publishing a bundle

**Extensions → Publish an extension bundle.** Drop a `.zip`, choose one, or
choose the extension *directory* — the browser zips it for you, stripping the
directory's own name so `manifest.json` lands at the archive root. That last
part matters because zipping the folder instead of its contents is the single
most common publish mistake, and it used to surface as "bundle missing
manifest.json".

Nothing is published on drop. The archive goes to
`POST /api/v1/admin/bundles/inspect` first, which parses the manifest and
answers with either the reasons it cannot be published — one line per bad
field — or the facts you need before authorising it:

- name, version, runtime, entrypoint, languages, allowed hosts, group id;
- what is currently published, and whether this replaces the same version.

Only then does a **Publish** button appear. This is deliberate friction: a
publish is a code-execution change on every worker that runs the extension, so
the operator should be reading the parsed manifest before they confirm rather
than a 422 afterwards.

The preflight is advisory. `POST /api/v1/admin/bundles` re-validates everything
and remains the decision of record, so a preflight that drifts can only ever be
less helpful — never permissive.

---

## The Activity feed, and what it is not

**Activity** merges five tables into one timeline: runs, jobs (including the
last error of a job that is still retrying), upload tasks, result submissions,
and audit events. Filter by severity, time window, extension, or free text over
the subject and message.

Be precise about what this replaces. **It covers application-level events — every
row in it is a durable database row.** That is why it can be filtered, linked
to, and read back months later, and it is why triage now starts in a browser
instead of in a terminal.

**Container stdout is not here and cannot be.** A stack trace from a crash loop,
a Prisma engine that failed to load, anything a process emitted before it could
reach the database — none of that is written to Postgres, so no endpoint can
serve it. That still lives in `docker logs` on the host:

```bash
docker compose logs -f --tail=200 core-uploader
```

The intended workflow is to start in Activity, find the run, job or task id, and
then reach for `docker logs` only if the row does not already explain itself.
Most of the time it does — the point of the feed is that `lastError` and
`rejectReason` are already in front of you.

Each row carries a **permalink** (`Copy link`) of the form
`https://…/dash#run/<id>`. It is a URL fragment, so it is never sent to the
server and pasting one into chat cannot leak an id into an access log. Opening
one selects the right section and the right row; a link into a section the
recipient's role cannot open says so instead of failing with a 403.

Audit events are included only for a principal holding `audit:read`. When they
are withheld the feed says so in a banner rather than quietly returning a
shorter list, because "the platform has been quiet" and "you cannot see half of
this" must not look alike.

---

## How the UI decides what to show

On sign-in the dashboard calls `GET /api/v1/admin/whoami`, which returns the
principal's kind, role and **scope set**. Every section declares the scope it
needs, so the tab strip is built from what the server has already said it will
allow. A contributor does not see a Workers tab that would 403.

Two consequences worth knowing:

- If a call is refused anyway, the error names the missing scope
  (`missing scope: runs:write`) and the dashboard raises a toast saying so.
  Guessing which permission you lack is never necessary.
- `whoami` discloses nothing secret: no token, no session id, no password
  state. It answers "what may this credential do", which the caller already
  knows implicitly.

---

## Security contract

The dashboard is the only browser-facing surface, so it is deliberately boring:

- **No inline scripts or styles.** Served under `default-src 'self'` with no
  `'unsafe-inline'`, `frame-ancestors 'none'`, and `X-Frame-Options: DENY`.
- **No `innerHTML`, anywhere.** Every operator-supplied string — extension
  names, worker names, error text — is written with `textContent`, which is what
  keeps a chapter title from becoming script. There is a test asserting the
  served `app.js` contains no `innerHTML` sink and no inline handler.
- **Cookie-authenticated writes carry `x-requested-with: publoader-dash`.**
  `SameSite=Strict` is the first line of CSRF defence; a header no cross-origin
  form or image tag can set is the second. Bearer clients are exempt and should
  not send it.
- **`connect-src 'self'`.** Even a tampered asset cannot exfiltrate what it can
  read.

See [security-trust-model.md](security-trust-model.md) §1.3a for the full
control matrix and §3a for what each credential's leak would cost.

---

## What still needs host access

Being honest about the edges, because a dashboard that *claims* to cover
everything is worse than one with a documented boundary.

| Task | Why it is not a button | Do this instead |
|---|---|---|
| **Reading container logs** | Work runs in containers, and on remote worker hosts the core cannot read. There is no log API by design; logs are structured JSON on stdout for the host's log stack. | `docker compose logs -f core-uploader`. Start from Activity or `padmin errors` to find the run/job id, then correlate. |
| **Restoring a backup, and scheduled backups** | Taking a backup *is* in the UI — **System → Database backup**, see [operations.md](operations.md). Restoring is not: it means stopping the services that would write during it, and nothing that can take the API down should be reachable through the API. Recurring backups belong in cron on the host, not in a browser tab someone has to remember to open. | The restore procedure and the scheduled `pg_dump` in [operations.md](operations.md) → "Backup and restore". |
| **Upgrading the core or a worker** | Replacing an image is the host's job; a container must not rewrite and re-exec itself (that was a legacy failure mode). | `docker compose pull && up -d` per [deployment.md](deployment.md) → "Upgrading". |
| **Rotating a secret in `.env`** | `ADMIN_TOKEN`, `SESSION_SECRET`, the MangaDex credentials and the tunnel token are environment, not database. | [operations.md](operations.md) → "Rotate secrets". Note that clearing the *saved MangaDex session* IS in the UI — that is database state, and it is the fix for a stale token pair. |
| **Applying a migration** | The runtime image has no Prisma CLI on purpose: a long-lived service must not carry a tool that can rewrite the database. | The one-shot `migrate` compose service. The System view tells you *whether* you need to — it reports pending and failed migrations. |
| **Restarting, stopping or recreating a container** | This needs the Docker socket, and `/var/run/docker.sock` is deliberately **not** mounted into any container. A process that can talk to that socket can start a privileged container and mount the host filesystem — it is root on the host, so exposing it to an internet-facing service would trade every other control on this page for a convenience. It will not be added. | `docker compose restart core-uploader` on the host. In practice you rarely need it: there is no `restart_workers` equivalent because every unit of work is a durable row, so the fix for stuck work is **Queues → Requeue stale leases** or a job replay, not a restart. |
| **Anything at all when `core-api` is down** | The dashboard *is* `core-api`. A control plane cannot repair the process serving it. | The host. Check `docker compose ps` and `docker compose logs core-api`; `/healthz` (liveness) and `/readyz` (database reachable) are the two probes worth curling first. |

Everything else — pausing, scheduling, curating the series map, triaging
queues, publishing a bundle, enrolling a worker, minting and revoking
credentials, managing accounts — is in the dashboard.

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
| [dashboard.md](dashboard.md) | The operator dashboard: signing in, the roles, every section, and what still needs host access |
| [migration-guide.md](migration-guide.md) | Staged Mongo/SQLite to Postgres cutover, with a rollback at every stage |
| [ipc-to-api-mapping.md](ipc-to-api-mapping.md) | Which endpoint replaced each legacy IPC command |
| [bot.md](bot.md) | Discord bot setup, the admin-gating model, and the command reference |
| [webhooks.md](webhooks.md) | Publishing extension bundles from a GitHub push: setup, the signature check, and why CI-side publishing is preferred |
| [implementation-plan.md](implementation-plan.md) | Historical: the original milestone plan |
| [../README.md](../README.md) | What publoader is, and the five-minute quickstart |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Branch workflow, definition of done, and the review checklist |
