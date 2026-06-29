# External Publisher MangaDex Uploader

Reads new chapter updates from extension modules (one per publisher) and posts
them to MangaDex. Extensions are pulled from the
[publoader-extensions](https://github.com/publoader/publoader-extensions)
repo (and optionally a private companion) and loaded dynamically.

When a chapter is no longer reachable on the source, the uploader does **not**
delete it on MangaDex — it strips the `externalUrl` and leaves a placeholder
info card (uploaded at first commit) as the visible page, and moves the row
into the `to_unavailable` collection on MongoDB. Duplicate-chapter cleanup
still hard-deletes.

## Running with Docker (recommended)

```bash
cp config.ini.example config.ini   # fill in credentials
cd docker
docker compose up -d
```

This brings up:

- `publoader` — main scheduler, workers, IPC server. On first start the
  entrypoint bootstraps the `extensions/` volume via `PubloaderUpdater`
  (GitHub tarball API, PAT-authed); afterwards updates come from the bot's
  `/pull` / `/refresh` commands.
- `publoader-bot` — Discord control bot in its own container (stays online
  even when the scheduler is stopped).
- `publoader-dash` — optional Discord-authenticated web control panel
  (see [Dashboard](#dashboard-web-control-panel)).
- `watchtower` — auto-pulls new images on a cron (defaults to 01:00).
- `cloudflared` — optional Cloudflare tunnel.
- `autoheal` — restarts the scheduler/dashboard if their healthcheck wedges.

State lives in `./resources/` (mounted into `/app/resources`):
- `publoader.db` — SQLite state DB (WAL mode, schedule overrides + run history)
- `publoader.sock` — IPC unix socket
- `mdauth.json` — MangaDex session cache

### Single-instance CLI

Once the scheduler is running, re-invoking `python run.py` forwards the command
over the IPC socket instead of starting a second instance:

```bash
python run.py -e mangaplus    # run one or more extensions
python run.py -f              # force-run everything
python run.py -c              # clean run (full reconcile)
python run.py -u              # restart via the updater
```

## Running locally without Docker

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python run.py
```

## Discord bot

Set `discord_bot_token` in `config.ini` (`[Credentials]`) — the entrypoint
starts the bot in the background. Run/error notifications keep going through
the configured `[Paths] webhook_url` (comma- or newline-separated for multiple
channels); the bot itself is **control-only**.

| Setting | `config.ini` key (`[Paths]`) | Env var |
| --- | --- | --- |
| Guild for fast slash sync | `discord_guild_id` | `PUBLOADER_DISCORD_GUILD` |
| Allowed channels / threads | `discord_allowed_channels` | `PUBLOADER_DISCORD_CHANNELS` |
| Admin user IDs | `discord_admin_users` | `PUBLOADER_ADMIN_USERS` |
| Admin role IDs | `discord_admin_roles` | `PUBLOADER_ADMIN_ROLES` |
| Prefix character | `discord_command_prefix` | — |

`discord_allowed_channels` accepts comma- or whitespace-separated channel and
thread IDs. Leave it empty to allow the bot anywhere. When inviting, include
the `applications.commands` scope.

### Commands

Every command exists as both prefix (default `!`) and slash. For prefix variants
without arguments, the bot sends a dropdown picker of on-disk extensions.

| Command | Description |
| --- | --- |
| `!ping` / `/ping` | Bot heartbeat, IPC reachability, scheduler PID + queued jobs |
| `!run [extension ...]` / `/run [extension]` | Run extensions on schedule |
| `!force [extension ...]` / `/force [extension]` | Force-run regardless of schedule |
| `!clean [extension ...]` / `/clean [extension]` | Clean reconcile run |
| `!reload` / `/reload` | Reload extensions in-place (no process restart) |
| `!restart` / `/restart` | Restart the scheduler (pulls new code via the updater) |
| `!status` / `/status` | Scheduler PID + queued jobs |
| `!pull [repo ...]` / `/pull [repo]` | `git pull --ff-only` for `base`, `extensions`, `extensions-private`, or `all` (admin) |
| `!schedule list` / `/schedule list` | Show effective schedule and DB overrides |
| `!schedule set <ext> <hour> <minute> [day]` / `/schedule set …` | Persist a per-extension schedule override (admin) |
| `!schedule remove <ext>` / `/schedule remove …` | Drop a DB override — falls back to `schedule.json` (admin) |

Slash variants accept a single comma/space-separated `extension` arg where the
prefix forms take varargs. Concurrent-run dedup is enforced: the same extension
can't be queued twice while one invocation is in flight.

### `/pull` paths

`/pull` resolves each repo from (in order): the env var, `config.ini` `[Repos]`
section, then a built-in default. Override per-repo when the working trees
aren't where the defaults expect them:

```ini
[Repos]
base = /opt/publoader
extensions = /opt/publoader/publoader/extensions
extensions_private = /opt/publoader-extensions-private
```

If a path isn't a git working tree (the production image doesn't ship `.git`),
`/pull` returns a hint to update via `docker compose pull && docker compose up -d`
or to let watchtower handle it.

## Push-based updates (GitHub webhooks)

By default updates are picked up by the daily restart job, which checks every
tracked repo once a day. Enable the webhook listener to instead download an
update **the moment code is pushed** — the daily job stays on as a fallback.

Pushes are handled per repo:

- **base** push → full download + process restart (core code needs a re-exec).
- **extensions / extensions-private** push → that repo is pulled and the
  extension modules are reloaded in place — no full restart.

Only pushes to each repo's **default branch** trigger an update; everything
else is acknowledged and ignored.

### 1. Enable in `config.ini`

```ini
[GithubWebhook]
ENABLED=true
HOST=0.0.0.0
PORT=8080
PATH=/webhook
SECRET=<random string, e.g. `openssl rand -hex 32`>
```

The listener **refuses to start without a secret** — an unauthenticated update
trigger would be a remote-code path. Every delivery is HMAC-verified
(`X-Hub-Signature-256`, constant-time compare), so the secret is the real
authentication; the transport below only needs to deliver GitHub's requests to
the container, not to add auth of its own.

All tracked repos must live under the same owner as `[Repo] repo_owner`, and
`extensions_private_repo_path` must be set or private-repo pushes are ignored.

### 2. Expose the endpoint with the Cloudflare Tunnel

GitHub's servers are on the public internet, so they need a public way to reach
the listener. The compose stack ships a `cloudflared` service for exactly this —
**no host port is published** (`publoader` only `expose`s 8080 on the internal
compose network), so the tunnel is the only path in and the origin IP stays
hidden.

1. Create a tunnel in the **Cloudflare Zero Trust dashboard**
   (Networks → Tunnels) and put its token in `CLOUDFLARE_PUBLOADER_TUNNEL_TOKEN`
   (the env var `docker-compose.yml` reads).
2. Under the tunnel's **Public Hostnames**, add one route:
   - **Subdomain/domain:** e.g. `hooks.yourdomain.com`
   - **Service:** `http://publoader:8080` — `publoader` resolves to the
     container over the compose network.
3. (Recommended) Lock the hostname down to GitHub's webhook source IPs with a
   Cloudflare WAF rule. GitHub publishes the ranges at
   `https://api.github.com/meta` under `hooks`; allow those and block the rest.
   The HMAC check already rejects forged payloads, so this is defence-in-depth.

GitHub then reaches the listener at `https://hooks.yourdomain.com/webhook`.

> Prefer Tailscale? Tailscale **Funnel** (not plain Tailscale — GitHub isn't on
> your tailnet) can replace `cloudflared`: funnel a public `*.ts.net` URL to
> `http://publoader:8080` and use that as the Payload URL. Cloudflare is the
> default here only because it's already wired up and supports the IP allowlist.

### 3. Add the webhook on GitHub

Configure **one webhook per tracked repo** (or a single org-level webhook that
covers them all — untracked repos are ignored):

- **Payload URL:** `https://hooks.yourdomain.com/webhook` (your tunnel hostname)
- **Content type:** `application/json` (required — the raw JSON body is
  HMAC-verified; `x-www-form-urlencoded` will fail the signature check)
- **Secret:** the same `SECRET` as above
- **Events:** just the `push` event

GitHub's "ping" on save returns `200 {"pong": true}`. A delivery returning
`401` means the secret doesn't match; `202 {"ignored": …}` means the push was
for an untracked repo or a non-default branch.

## Dashboard (web control panel)

A Discord-authenticated web UI that views all bot state (status, queues, stats,
schedule, extensions, run history, logs, MangaDex auth) and drives every control
command (run / force / **clean** run, pause/resume, restart, pull, reload,
worker restart, queue clear, extension enable/disable, removal mode, config).
It runs in the `publoader-dash` container and talks to the scheduler over the
same IPC socket the Discord bot uses — so it can do everything the bot can.

Access is gated by Discord OAuth login, restricted to an allowlist of Discord
user IDs (defaults to `[Paths] DISCORD_ADMIN_USERS`).

### 1. Create a Discord OAuth app

In the [Discord Developer Portal](https://discord.com/developers/applications)
open your bot's application → **OAuth2**:

- copy the **Client ID** and a **Client Secret**
- under **Redirects**, add `https://publoader.ardax.dev/auth/callback` (must
  exactly match `REDIRECT_URI` below)

### 2. Enable in `config.ini`

```ini
[Dashboard]
ENABLED=true
HOST=0.0.0.0
PORT=8090
DISCORD_CLIENT_ID=<oauth client id>
DISCORD_CLIENT_SECRET=<oauth client secret>
REDIRECT_URI=https://publoader.ardax.dev/auth/callback
# python -c "import secrets; print(secrets.token_urlsafe(48))"
SESSION_SECRET=<long random string>
# blank reuses [Paths]DISCORD_ADMIN_USERS
ALLOWED_USERS=
SESSION_TTL_MINUTES=720
```

The container binds `8090` on the internal compose network only (never the
host). When `ENABLED=false` or it's misconfigured, the container still answers
`/healthz` (so it stays healthy) but serves no app routes.

### 3. Route it through the tunnel

In the **Cloudflare Zero Trust dashboard**, under the tunnel's **Public
Hostnames**, point your dashboard URL at `http://publoader-dash:8090`. To keep
it on the same `publoader.ardax.dev` domain as the webhook, add **path-based**
rules (order matters — most specific first):

| Path | Service |
|------|---------|
| `/webhook` | `http://publoader:8080` |
| `/` (everything else) | `http://publoader-dash:8090` |

Or give it its own subdomain (e.g. `dash.publoader.ardax.dev → publoader-dash:8090`)
and set `REDIRECT_URI`/the Discord redirect to match.

Visit the hostname, click **Log in with Discord**, and — if your Discord ID is
on the allowlist — the full panel loads. The dashboard is locked down with
HMAC-signed `HttpOnly`/`Secure`/`SameSite=Lax` session cookies, a signed OAuth
`state` cookie, an Origin check on writes, and a fixed command allowlist.

## Extensions

Extension trees are mounted into `/app/publoader/extensions/src/<extension>/`.
Each tree must contain `<extension>.py`, `manifest.json`, and any data files
the extension reads at runtime. Extensions are loaded dynamically with a
static-AST safety scan that rejects modules using `eval`, `exec`,
`subprocess`, `ctypes`, etc. The scan is **not** a sandbox — upstream repos
are still trusted.

Extensions should import only from `publoader.api` — it pins a stable
public surface (`__api_version__`) re-exporting `Chapter`, `Manga`,
`PubloaderWebhook`, `setup_extension_logs`, `chapter_number_regex`,
`open_manga_id_map`, `open_title_regex`, `find_key_from_list_value`, and
`create_new_event_loop`. Anything else under `publoader.*` is internal.

For writing a new extension, see the
[extensions contributing guide](https://github.com/publoader/publoader-extensions/blob/master/README.md).

## Tests

```bash
.venv/bin/python -m pytest -q
```

The suite covers the IPC server, state DB, AST scanner, atomic writes,
webhook URL parsing, chapter dataclasses, chapter card generation, the
`/pull` git wiring, the GitHub push-webhook listener (signature verification,
push routing, pull+reload), the liveness heartbeat, and the web dashboard
(signed sessions, OAuth state, the user allowlist, and command auth gating).

## Contributing

Format code with [Black](https://pypi.org/project/black/) using default
settings. Open an issue or PR for changes.
