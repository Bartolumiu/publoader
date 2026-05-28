# Running with Docker

The published image lives on Docker Hub as
[`ardax/publoader`](https://hub.docker.com/r/ardax/publoader). Extensions
are fetched on demand from GitHub via `PubloaderUpdater` using the PAT in
`config.ini` — no host git clones, no SSH keys, no sidecar containers.

## Quick start

Put `docker-compose.yml` and `entrypoint.sh` in the same directory, then:

```bash
cp ../config.ini.example config.ini   # fill in your credentials + GITHUB_ACCESS_TOKEN
mkdir -p logs resources
docker compose up -d
```

On first start, the entrypoint sees an empty `extensions/` volume and runs
`python -m publoader.updater` once to bootstrap. Subsequent starts skip
the bootstrap (the volume is persistent).

## What's in the stack

| Service | Purpose |
| --- | --- |
| `publoader` | Scheduler, workers, IPC server. Bootstraps extensions on first start; thereafter receives `/pull` and `/refresh` via IPC from the bot. |
| `publoader-bot` | Discord control bot. Runs in its own container so it stays online even when the scheduler is down — `/status` will reply "instance not running" instead of going silent. Talks to the scheduler via the unix socket in `./resources` and to the docker daemon via the mounted socket, so `/start`, `/shutdown` and `/restart` can control the scheduler container even when its IPC is dead. |
| `watchtower` | Pulls fresh `ardax/publoader*` images on a daily cron (default 01:00). |
| `cloudflared` | Optional Cloudflare tunnel — needs `CLOUDFLARE_PUBLOADER_TUNNEL_TOKEN` in the environment. |

## Volumes and bind mounts

- `./config.ini` → `/app/config.ini` (read-only credentials + paths)
- `./logs` → `/app/logs`
- `./resources` → `/app/resources` (holds `publoader.db`, `publoader.sock`, `mdauth.json`, cached chapter data)
- `./entrypoint.sh` → `/app/entrypoint.sh`
- `/var/run/docker.sock` → `/var/run/docker.sock` on `publoader-bot` (so `/start`, `/shutdown`, `/restart` work)
- Named volume `extensions` → `/app/publoader/extensions` (persistent extension cache; `publoader-bot` mounts it read-only for `/extensions` listing)

The IPC unix socket lives at `/app/resources/publoader.sock`. Subsequent
invocations of `python run.py` inside the container forward over that socket
instead of starting a second instance.

## Updating

Pull new extension code via Discord:

- `/pull all` — fetch all three repos (`base`, `extensions`, `extensions-private`) via the GitHub tarball API
- `/pull <name>` — fetch one repo
- `/refresh` — `/pull all` + scheduler reload in one step
- `/reload` — reload Python modules without re-fetching

All authenticate with `[Repo] GITHUB_ACCESS_TOKEN` from `config.ini`. SHAs
are cached in `resources/<commits_path>`, so re-running `/pull` is a no-op
when nothing has changed remotely.

Watchtower still handles base-image upgrades nightly.
