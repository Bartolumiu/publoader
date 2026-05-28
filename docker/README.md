# Running with Docker

The published image lives on Docker Hub as
[`ardax/publoader`](https://hub.docker.com/r/ardax/publoader). The extension
sidecar is [`ardax/publoader-extensions`](https://hub.docker.com/r/ardax/publoader-extensions).
Either pull the images directly or use the `docker-compose.yml` in this
directory for a fully wired stack.

## Quick start

Put `docker-compose.yml`, `entrypoint.sh`, and the host-side files referenced
by the compose file in the same directory, then:

```bash
cp ../config.ini.example config.ini   # fill in your credentials
mkdir -p logs resources
# Optional: clone the private extensions repo if you have access. The
# publoader-extensions-private service expects it at ./publoader-extensions-private.
git clone git@github.com:ArdaxHz/publoader-extensions-private.git
docker compose up -d
```

If you don't have access to the private repo, either remove the
`publoader-extensions-private` service from `docker-compose.yml` or create
the directory empty: `mkdir -p publoader-extensions-private/src` — the sync
will simply find nothing to copy and exit cleanly.

## What's in the stack

| Service | Purpose |
| --- | --- |
| `publoader` | Scheduler, watchers, IPC server. |
| `publoader-bot` | Discord control bot. Runs in its own container so it stays online even when the scheduler is down — `/status` will reply "instance not running" instead of going silent. Talks to the scheduler via the unix socket in `./resources` and to the docker daemon via the mounted socket, so `/start`, `/shutdown` and `/restart` can control the scheduler container even when its IPC is dead. |
| `publoader-extensions` | Sidecar. Runs `sync_extensions.py` to atomically populate the `extensions` named volume from the public image, then exits. |
| `publoader-extensions-private` | Same as above, but sources from the host-mounted private repo (`./publoader-extensions-private`) since it isn't published as an image. Reuses the public sidecar image. Runs after the public sync. |
| `watchtower` | Pulls fresh `ardax/publoader*` images on a daily cron (default 01:00). |
| `cloudflared` | Optional Cloudflare tunnel — needs `CLOUDFLARE_PUBLOADER_TUNNEL_TOKEN` in the environment. |

## Volumes and bind mounts

- `./config.ini` → `/app/config.ini` (read-only credentials + paths)
- `./logs` → `/app/logs`
- `./resources` → `/app/resources` (holds `publoader.db`, `publoader.sock`, `mdauth.json`, cached chapter data)
- `./entrypoint.sh` → `/app/entrypoint.sh`
- `./publoader-extensions-private` → `/extensions:ro` on the private sidecar (host clone of the private repo)
- `/var/run/docker.sock` → `/var/run/docker.sock` on `publoader-bot` (so `/start`, `/shutdown`, `/restart` work)
- Named volume `extensions` → `/app/publoader/extensions` (populated by both sidecars)

The IPC unix socket lives at `/app/resources/publoader.sock`. Subsequent
invocations of `python run.py` inside the container forward over that socket
instead of starting a second instance.

## Updating

The recommended path is the watchtower cron — it pulls and recreates the
containers automatically. For a manual refresh from the host:

```bash
docker compose pull
docker compose up -d
```

If you are running with the source tree bind-mounted as a `.git` working tree
(useful for development), you can use the bot's `/pull` command to fast-forward
the base or extension repos in place without recreating the container.
