# GitHub push webhook

Date: 2026-07-29

A push to a tracked extensions repo publishes a new bundle for each extension it
changed, so the next scheduled run executes the new code. This replaces the
legacy standalone listener (`publoader/github_webhook.py`), which answered a push
by `git pull`ing the repo and re-importing the changed modules in-process.

There is no in-process extension code any more. Workers execute
content-addressed bundles pinned by sha256, and the scheduler pins each job to
`BundleStore.latest(extension)` — so the modern equivalent of "pull and reload"
is "publish a bundle".

> **Read §6 before you configure this.** Publishing from CI is the better
> arrangement for most deployments, and this endpoint exists mainly so a
> deployment with *no* CI still gets code out of a push. The trade-off is real
> and §6 is honest about it.

## 1. What happens, per repo

The mapping is driven by config, and every gate rejects with a reason that is
echoed in the response body — so a GitHub delivery log entry explains itself
without anyone reading server logs.

| Repo role | Config | A push does |
|---|---|---|
| extensions | `GITHUB_EXTENSIONS_REPOS` | Downloads the repo at the pushed sha, builds and publishes a bundle per changed extension |
| core | `GITHUB_CORE_REPO` | **Nothing.** Answers 200 with "core deploys are image-based" |
| anything else | — | 202 `untracked repo '<name>'` |

One delivery is deliberately ignored on top of those rules: a push whose commits
are **all** marked `[map-sync]`. Those are this platform's own weekly write-back
of `manga_id_map.json`, and republishing a bundle for them would churn every
extension's sha256 pin once a week for a data file the workers do not read from
the bundle. A push mixing one of ours with a human's commit still publishes —
the test is *every* commit, not any.

Three conditions must all hold before anything is published, ported from the
legacy `slot_for_push`:

- The repo is named in `GITHUB_EXTENSIONS_REPOS` (or `GITHUB_CORE_REPO`).
- The owner in `repository.full_name` matches `GITHUB_REPO_OWNER`,
  case-insensitively. A fork named `publoader-extensions` under someone else's
  account cannot publish into your deployment.
- The push is on that repository's **default branch** (`ref` equals
  `refs/heads/${repository.default_branch}`). Feature branches and tags do not
  ship code.

### The core repo does not self-deploy

Core is deployed as an image: CI builds `ardax/publoader-core` and
`./scripts/publoader prod upgrade <tag>` rolls it out. A running container
cannot and should not rewrite its own code — the image is read-only at runtime
(see `docs/deployment.md` §Upgrading). A push to core is answered 200 with that
explanation rather than ignored, so the delivery is green and the reason is
discoverable from GitHub's UI.

### Which extensions a push touched

Extension directories live at `src/<extension>/…` in both extensions repos. The
handler reads `commits[].added`, `.modified` and `.removed`, plus `head_commit`
— GitHub truncates `commits` to 20 entries on a large push but always sends
`head_commit`, and missing an extension because a push was big would silently
leave stale code running.

Paths outside `src/<extension>/` are ignored, so a README or workflow change
publishes nothing. A directory name that the manifest schema would reject
(uppercase, dashes) is ignored too.

Deleting an extension's whole directory does **not** yank it. The delivery
reports `skipped` and points at `publoader-admin extensions disable <name>` —
taking a live extension out of rotation is not a decision to automate off a
push.

## 2. Configuration

### Environment

| Variable | Required | Meaning |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | **yes** | Shared HMAC secret. Minimum 16 characters. Without it the endpoint answers 503 to everything |
| `GITHUB_REPO_OWNER` | yes | GitHub account/org that must own the pushing repo. Default `publoader` |
| `GITHUB_EXTENSIONS_REPOS` | yes | Comma-separated repo names, e.g. `publoader-extensions,publoader-extensions-private` |
| `GITHUB_CORE_REPO` | no | Repo name for the core service. Set it only to get the explanatory 200 instead of `untracked repo` |
| `GITHUB_TOKEN` | for private repos | Access to the extensions repos. A fine-grained PAT with **Contents: read** is enough for the webhook; the weekly series-map sync (docs/operations.md §"Series-map sync") additionally needs **Contents: write** |
| `GITHUB_API_URL` | no | Default `https://api.github.com` |

All of these follow the platform's Docker-secrets convention: any `VAR` may be
supplied as `VAR_FILE` pointing at a file holding the value.

Generate the secret with something you will not have to think about again:

```bash
openssl rand -hex 32
```

### The GitHub webhook

Repo → **Settings → Webhooks → Add webhook**, once per extensions repo:

- **Payload URL**: `https://publoader.ardax.dev/webhook`
- **Content type**: `application/json` (the HMAC is computed over the raw body;
  `application/x-www-form-urlencoded` is not accepted)
- **Secret**: the same value as `GITHUB_WEBHOOK_SECRET`
- **SSL verification**: enabled
- **Which events**: *Just the push event*
- **Active**: checked

`POST /api/v1/webhooks/github` is an alias for the same handler. `/webhook` is
kept at exactly that path because existing webhooks already point there; prefer
the `/api/v1/` form for anything new.

### Cloudflare

The endpoint must stay reachable. If you have added WAF rules per
`docs/deployment.md` §WAF rules, make sure none of them blocks `/webhook` — it
is unauthenticated in the platform's own terms and can look like something worth
blocking. Do **not** put Cloudflare Access in front of it: GitHub cannot
complete an interactive login.

## 3. Testing it

**The ping.** GitHub sends one `ping` when you create the webhook. It is
answered 200 with `{"ok":true,"pong":true}`, so a freshly-created webhook shows
a green delivery immediately. If it does not:

| Response | Cause |
|---|---|
| 503 `webhook is not configured` | `GITHUB_WEBHOOK_SECRET` is unset in core-api's environment |
| 401 `invalid signature` | The secret in GitHub does not match the one in `.env` |
| 404 | Request never reached core-api — check the tunnel's public hostname and any WAF rule |

You can replay it any time with **Recent Deliveries → Redeliver**.

**A real push.** Push a trivial change to an extension and read the response
body in the delivery log. Then confirm it landed:

```bash
publoader-admin extensions list
publoader-admin audit --limit 5   # actor: github:publoader-extensions@1a2b3c4
```

**By hand**, without GitHub:

```bash
SECRET='…'
BODY='{"ref":"refs/heads/main","after":"'$(printf '%040d' 0)'",
 "repository":{"name":"publoader-extensions",
 "full_name":"publoader/publoader-extensions","default_branch":"main"},
 "commits":[{"added":["src/mangaplus/index.ts"],"modified":[],"removed":[]}]}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)"
curl -sS https://publoader.ardax.dev/webhook \
  -H "content-type: application/json" \
  -H "x-github-event: push" \
  -H "x-hub-signature-256: $SIG" \
  --data-raw "$BODY" | jq
```

## 4. Reading a delivery

The response body is the diagnostic. Status codes:

| Code | Meaning |
|---|---|
| 200 | Everything asked for succeeded (or there was nothing to do) |
| 202 | Deliberately ignored; `ignored` names the reason |
| 207 | Partial — at least one extension failed or was skipped, the rest published |
| 400 | Empty or unparseable body |
| 401 | Missing or invalid `X-Hub-Signature-256` |
| 413 | Body over 5 MiB (checked before parsing) |
| 429 | Per-IP rate limit |
| 503 | No `GITHUB_WEBHOOK_SECRET` configured — fails closed |

A push to an extensions repo reports one outcome per extension:

```json
{
  "ok": false,
  "commit": "1a2b3c4d…",
  "outcomes": [
    { "extension": "mangaplus", "status": "published", "version": "3.1.0", "sha256": "…" },
    { "extension": "viz", "status": "failed", "detail": "esbuild failed:\n  Could not resolve \"cheerio\"" }
  ]
}
```

- `published` — a new bundle exists and the next run will use it.
- `unchanged` — byte-identical to what was already published. Builds are
  reproducible, so a redelivery of the same push is a no-op rather than a new
  version of the same code.
- `failed` — `detail` is the actionable reason. One bad extension never stops the
  others.
- `skipped` — not attempted: the directory is gone at that commit, the
  five-extension-per-delivery cap was hit, or the delivery ran out of time.

`detail` deliberately carries only reasons an operator can act on. Anything
unexpected is logged with the error and reported as
`publish failed; see core-api logs` — a webhook response is a public surface the
moment the secret leaks, and stack traces name filesystem paths.

Every publish also writes an audit event, actor `github:<repo>@<short sha>`,
action `bundle.publish`, detail including `via: "github-webhook"`. That is the
authority on what happened, which matters because of the next paragraph.

### GitHub's 10-second timeout

GitHub gives a webhook about **10 seconds** to respond. Downloading a repo
archive, running esbuild and writing a bundle can take longer than that. The work
is done synchronously so the response can carry per-extension outcomes, which
means a slow delivery may be recorded red ("timed out") in GitHub's log **even
though it succeeded**. GitHub does not retry automatically, so nothing is
duplicated. Check `publoader-admin extensions list` and the audit log before
concluding a timed-out delivery did nothing.

This is the single ugliest thing about the webhook, and it is another reason to
read §6.

## 5. Limits

Everything is bounded, because a webhook is a request from the internet that
names a repository whose size nobody here controls.

| Limit | Value | Why |
|---|---|---|
| Request body | 5 MiB | Matches the legacy listener; enforced before the body is buffered |
| Repo archive download | 32 MiB | Aborted mid-download when exceeded. core-api runs with a 256 MiB tmpfs and a 768 MiB memory cap |
| Archive fetch timeout | 30 s | |
| Extensions per delivery | 5 | A push touching more is a repo-wide reformat or a long branch merge; the excess is reported so it can be published deliberately |
| Total handler budget | 90 s | Extensions not reached in time are reported `skipped` |
| Per-IP rate limit | burst 10, refill 1 per 10 s | GitHub sends one request per push |

Archive entries are checked to resolve inside the extraction directory before
anything is written, so a crafted path in a repo cannot write outside the temp
directory.

### Extensions built this way cannot use npm dependencies

The bundle ships one self-contained ESM file, and esbuild inlines everything it
imports (`external: []`) so the sha256 pins the complete program. The webhook
builds from a bare repo archive — there is no `node_modules` and no package
install step. An extension that imports a third-party package builds fine on an
operator's laptop (where `pnpm install` has run) and fails here with
`Could not resolve "<package>"`.

Node builtins and relative imports are fine. If you need a real dependency, use
CI-side publishing.

## 6. Prefer CI-side publishing

**This webhook is the zero-CI option, not the recommended one.** Running it
means core-api holds:

- a **GitHub token** with read access to your private extensions repo, in a
  process that is also reachable from the internet; and
- a **build toolchain** (esbuild) that runs against code fetched at request time,
  triggered by a signed HTTP request.

Neither is required for the platform to work. Both are avoidable. The webhook
also inherits the 10-second problem above, cannot install dependencies, and gives
you a five-extension cap that a repo-wide change will hit.

The alternative is a GitHub Actions workflow that publishes with a scoped token.
The build happens on a runner that already has a checkout and a package manager;
core-api needs no GitHub credential, no compiler and no inbound webhook.

Mint the credential with only what publishing needs:

```bash
publoader-admin tokens create --name ci-extensions --scopes bundles:write
```

Store it as the repository secret `PUBLOADER_TOKEN`, then:

```yaml
# .github/workflows/publish.yml
name: publish extension bundles
on:
  push:
    branches: [main]
    paths: ['src/**']

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 2 }

      - name: which extensions changed
        id: changed
        run: |
          git diff --name-only "${{ github.event.before }}" "${{ github.sha }}" \
            | sed -n 's|^src/\([a-z0-9_]\+\)/.*|\1|p' | sort -u > changed.txt
          echo "list=$(paste -sd' ' changed.txt)" >> "$GITHUB_OUTPUT"

      - uses: actions/setup-node@v4
        with: { node-version: '24' }
      - run: npm install --no-save esbuild

      - name: publish
        env:
          PUBLOADER_API_URL: https://publoader.ardax.dev
          PUBLOADER_ADMIN_TOKEN: ${{ secrets.PUBLOADER_TOKEN }}
        run: |
          for ext in ${{ steps.changed.outputs.list }}; do
            npx publoader-admin bundle publish "src/$ext" \
              --source-commit "${{ github.sha }}"
          done
```

What you get over the webhook:

- The GitHub token never leaves GitHub, and core-api holds no repo credential.
- No compiler in the service that fronts the internet.
- `pnpm install` has run, so extensions may use real dependencies.
- No 10-second budget: the job takes as long as it takes, and a red run is
  unambiguously a failure.
- A build log per publish, kept by GitHub.

What you give up:

- A CI system has to exist and be configured.
- Publishing depends on Actions being up.

If you run CI, use CI. If you do not, the webhook is a reasonable way to avoid
publishing by hand — set it up, read §5, and know what it costs.
