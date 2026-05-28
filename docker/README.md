# Running with Docker

The published image lives on Docker Hub as
[`ardax/publoader`](https://hub.docker.com/r/ardax/publoader). Extensions
are no longer delivered via a separate sidecar image — both the public and
private repos are bind-mounted as host git clones and synced into the
runtime extensions dir by publoader's entrypoint on every start.

## Quick start

Put `docker-compose.yml`, `entrypoint.sh`, `sync_extensions.py`, and the
host-side files referenced by the compose file in the same directory, then:

```bash
cp ../config.ini.example config.ini   # fill in your credentials
mkdir -p logs resources
git clone git@github.com:publoader/publoader-extensions.git
# Optional: clone the private extensions repo if you have access.
git clone git@github.com:ArdaxHz/publoader-extensions-private.git
docker compose up -d
```

If you don't have the private repo, either remove the
`./publoader-extensions-private` volume line from `docker-compose.yml` or
create an empty directory at that path with a `src/` subdir — the sync
will simply find nothing to copy and skip it.

## What's in the stack

| Service | Purpose |
| --- | --- |
| `publoader` | Scheduler, watchers, IPC server. On start, its entrypoint runs `sync_extensions.py` over each `/sources/<name>/` bind mount before launching `run.py`. |
| `publoader-bot` | Discord control bot. Runs in its own container so it stays online even when the scheduler is down — `/status` will reply "instance not running" instead of going silent. Talks to the scheduler via the unix socket in `./resources` and to the docker daemon via the mounted socket, so `/start`, `/shutdown` and `/restart` can control the scheduler container even when its IPC is dead. |
| `watchtower` | Pulls fresh `ardax/publoader*` images on a daily cron (default 01:00). |
| `cloudflared` | Optional Cloudflare tunnel — needs `CLOUDFLARE_PUBLOADER_TUNNEL_TOKEN` in the environment. |

## Volumes and bind mounts

- `./config.ini` → `/app/config.ini` (read-only credentials + paths)
- `./logs` → `/app/logs`
- `./resources` → `/app/resources` (holds `publoader.db`, `publoader.sock`, `mdauth.json`, cached chapter data)
- `./entrypoint.sh` → `/app/entrypoint.sh`
- `./sync_extensions.py` → `/app/sync_extensions.py` (read-only)
- `./publoader-extensions` → `/sources/public` (host clone of the public repo)
- `./publoader-extensions-private` → `/sources/private` (host clone of the private repo)
- `/var/run/docker.sock` → `/var/run/docker.sock` on `publoader-bot` (so `/start`, `/shutdown`, `/restart` work)
- Named volume `extensions` → `/app/publoader/extensions` (populated by the entrypoint; `publoader-bot` mounts it read-only for `/extensions` listing)

The IPC unix socket lives at `/app/resources/publoader.sock`. Subsequent
invocations of `python run.py` inside the container forward over that socket
instead of starting a second instance.

## Updating

The canonical refresh path is host-side `git pull` followed by either a
container restart or the bot's `/refresh` command:

```bash
git -C publoader-extensions pull
git -C publoader-extensions-private pull
docker compose restart publoader        # re-runs the entrypoint sync
```

Or, without bouncing the scheduler, run `/pull all` then `/refresh` in
Discord — `/pull` updates the bind-mounted clones in place, `/refresh`
re-syncs into the runtime dir and queues a module reload.

Watchtower still handles base-image upgrades nightly; since the entrypoint
re-syncs on every start, that doubles as a daily extension refresh as long
as the host clones have been pulled.
