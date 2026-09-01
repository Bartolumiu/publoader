# Working on publoader

## Never run anything locally. Go through the admin API.

Every operation against the live platform — running an extension, publishing a
bundle, editing or deleting a chapter, reconciling, pausing, restarting — goes
through the admin API at `https://publoader.ardax.dev`. No exceptions, and no
"just this once to check something".

This is not a style preference. The API is the only path that leaves a record:

- **the audit trail.** Every mutating endpoint calls `ctx.audit.record(...)`
  with the actor, so `GET /api/v1/admin/audit` can answer *who did this*. The
  CLI sends `$USER` as `X-Actor` precisely so the answer is a person.
- **the log store.** Services write to `log_events`, readable at
  `GET /api/v1/admin/logs` with `q`, `since`, `before` and `minLevel`. That is
  the only durable record of what the uploader actually sent to MangaDex.
- **the queue.** Writes to MangaDex go through `upload_tasks`, which is where
  deduplication, retry, the ownership check (`ownership()` in
  `core/md/taskWorkers.ts`) and the archives live. A write that skips the queue
  skips all four.

A local run produces none of that. It looks identical while it is happening and
leaves nothing behind afterwards, which is the worst combination: the platform's
own tables end up describing a world that no longer exists, and nobody can tell
when or why they stopped being true.

**Why this rule exists.** A chapter went missing from MangaDex and the question
was whether publoader had deleted it. The answer came from three places, all of
them API-side: the uploader log showed MangaDex accepting the commit and
returning that chapter id; there was no `DELETE` task for it in any state; and
there was no audit entry. Those three facts together proved the deletion came
from outside the platform. Had any part of that upload been done locally, the
honest answer would have been "we cannot tell" — and the investigation would
have stopped there.

### What that means concretely

| doing this | use |
|---|---|
| run an extension | `POST /api/v1/admin/runs` |
| publish an extension | `POST /api/v1/admin/sysops/extensions/install-github` — the server fetches the ref, builds it in its sandbox and publishes |
| edit a chapter | `PATCH /api/v1/admin/chapters/:mdChapterId` |
| delete chapters | `POST /api/v1/admin/chapters/bulk/delete` (`dryRun` first) |
| find deleted/untracked chapters | `POST /api/v1/admin/chapters/reconcile` |
| change per-extension config | `PUT /api/v1/admin/extensions/:name/config` |

The `publoader-admin` CLI is fine, and preferred: every subcommand is a thin
wrapper over one of these endpoints, it holds no database credentials, and it
never talks to Postgres directly. "Local" means bypassing the API, not
bypassing the browser.

**Never** call the MangaDex API directly to change something. Reading MangaDex
to check a result is fine and often necessary; writing to it is what the queue
is for, and a direct write leaves the platform's mirror silently wrong.

**Never** run an extension against a publisher on your own machine to see what
it collects. Publish it to a branch and run it — the run records the extension
version and the bundle sha it used, which is what makes a surprising result
diagnosable a week later.

### Dry run first

The bulk chapter routes (`bulk/delete`, `bulk/edit`, `bulk/unavailable`,
`bulk/restore`) and `chapters/reconcile` default to `dryRun: true` and report
what they *would* do. A bulk write additionally needs `confirm: true`, so a
missing flag is a no-op rather than a mistake. Use both. Deleting a chapter on
MangaDex is not reversible, and the dry run costs one request.

`POST /api/v1/admin/maps/sync` is the exception: it defaults to
`dryRun: false`. Pass `{"dryRun": true}` explicitly the first time — it writes
to a git repository that contributors read.
