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

## Outgoing IP rotation

MangaDex rate-limits (and, on abuse, bans) by source IP. To spread requests
across multiple addresses, configure the `[Network]` section of `config.ini`.
Everything is optional — blank keeps the single-outbound-IP behaviour.

### Proxy pool (works anywhere, no host setup)

```ini
[Network]
PROXIES=http://user:pass@1.2.3.4:8080, socks5://5.6.7.8:1080
```

A random proxy is picked **per request, process-wide**. This is the option to
use when you need the **extension scrapers** proxied: extensions run in-process
and make their own `requests`/`cloudscraper` calls, and on startup publoader
installs a class-level `requests.Session` hook so every one of those calls (plus
MangaDex uploads and GitHub fetches) goes out through a random proxy from the
pool. `http(s)://` works out of the box; `socks5://` needs `requests[socks]`
(add `PySocks` to `requirements.txt`). When `PROXIES` is set it takes precedence
over the source-IP options below.

**aiohttp extensions** are covered too, but differently: aiohttp is a separate
HTTP stack with no native SOCKS support, so publoader installs a second hook on
`aiohttp.ClientSession.__init__` that gives each session an `aiohttp_socks`
`ProxyConnector` built from a random proxy in the pool. This works for
`socks5://`, `socks4://` and `http(s)://` — but rotation is **per session**, not
per request (a `ClientSession` keeps its proxy for its lifetime). `aiohttp_socks`
ships in `requirements.txt` for this. An extension that passes its own
`connector=` is left alone.

An extension that sets its own `session.proxies`/`connector`, or uses yet
another client (`httpx`, `urllib`, raw sockets), is left alone. To force
*everything* in the container through one proxy regardless of library, set
standard proxy env vars on the `publoader` service instead — **single proxy, no
rotation, and a single value only (not a comma-separated list)**:

```yaml
    environment:
      - HTTP_PROXY=http://user:pass@1.2.3.4:8080
      - HTTPS_PROXY=http://user:pass@1.2.3.4:8080
```

Note: aiohttp ignores these env vars unless a session is created with
`trust_env=True`, so the `ClientSession` hook above (not env vars) is what
proxies aiohttp extensions.

### Source-IP rotation over a routed IPv6 subnet

If your host has a routed IPv6 prefix (most VPS providers hand out a `/64`),
publoader can bind each outgoing connection to a random address inside it —
effectively unlimited source IPs. Set the subnet in `config.ini`:

```ini
[Network]
SOURCE_IPV6_SUBNET=2001:db8:abcd::/64
SOURCE_IP_POOL_SIZE=64
```

Binding to arbitrary addresses in the prefix needs three things on the
container, all wired up in `docker-compose.yml` (uncomment the block on the
`publoader` service) plus `entrypoint.sh`:

1. **Non-local bind** — `sysctls: net.ipv6.ip_nonlocal_bind=1`.
2. **`NET_ADMIN`** capability, so the entrypoint can add the route.
3. **AnyIP local route** — the entrypoint runs
   `ip -6 route replace local $PUBLOADER_ANYIP_SUBNET dev $PUBLOADER_ANYIP_DEV`
   when `PUBLOADER_ANYIP_SUBNET` is set, telling the kernel to accept binds to
   any address in the prefix.

You must also make sure the `/64` is actually **routed to this host** by your
provider and reaches the container's interface. On a plain bridge network the
container has private addressing, so for real IPv6 egress either run the
`publoader` service on an IPv6-enabled Docker network (`enable_ipv6: true` with
your prefix as the subnet) or use `network_mode: host`. Verify from inside the
container:

```bash
docker compose exec publoader python - <<'PY'
import requests
print(requests.get("https://api64.ipify.org").text)
PY
```

Run it a few times — the address should vary across the pool. If it doesn't
change or you see connection errors, the prefix isn't routed/bindable yet;
recheck the three requirements above.

### Explicit source IPs

If the container already holds several addresses, list them instead:

```ini
[Network]
SOURCE_IPS=203.0.113.10, 203.0.113.11, 203.0.113.12
```
