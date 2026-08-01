# Running a publoader worker

A worker scrapes publisher sites and reports what it found. That's all it does.

Publishers rate-limit per source IP, so spreading the scraping across machines is
the whole point of running one — your IP does the fetching, the operator's core
does everything else.

You need Docker and an enrolment token. Nothing else: no source checkout, no Node,
no Python, no database, no open ports.

---

## What your machine is and isn't trusted with

Worth reading before you run somebody else's code on your hardware.

**A worker never holds MangaDex credentials.** It cannot upload, edit or delete
anything on MangaDex. Only the operator's core does that, from one process. If
your host is compromised, the attacker gets your worker token — which lets them
submit scrape results the core will *validate and probably reject*, and nothing
else.

**A worker never touches the database.** It has no connection string. Everything
it reports goes through an authenticated HTTPS API that checks it.

**Nothing listens.** There is no `ports:` and no `expose:` in the compose file, by
design — the agent long-polls the core and never accepts a connection. It works
behind NAT, on a laptop, on a home connection, with no firewall exception and no
inbound attack surface.

**The extension code is contained.** This container runs third-party scrapers, so
the hardening is a real boundary rather than box-ticking:

| | |
| --- | --- |
| `read_only: true` | The image is immutable. An extension that writes anywhere except `/tmp` and the state volume simply fails. |
| `/tmp` as `noexec,nosuid,nodev`, capped at 2g | Per-job scratch. `noexec` stops a downloaded payload being executed; the cap stops a runaway extension eating your RAM, since tmpfs *is* RAM. |
| `cap_drop: ALL` | A scraper needs no kernel capability at all. |
| `no-new-privileges` | No path to escalate. |
| `mem_limit`, `cpus` | Containment, not tidiness. |

Nothing an extension does survives a restart.

---

## Setup

**1. Ask the operator for an enrolment token.** It's single-use, expires, and is
sent over a private channel. They mint it in the dashboard under Workers → Enrol,
or with:

```bash
curl -sX POST https://publoader.ardax.dev/api/v1/admin/enroll-tokens \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"trust":"COMMUNITY","note":"<your host>","ttlHours":24}'
```

**2. Configure.** Copy the template and fill in two values:

```bash
cp .env.example .env && chmod 600 .env
```

```
WORKER_NAME=<something you'll recognise in an alert>
ENROLL_TOKEN=<the token they sent you>
```

`CORE_URL` already points at the public deployment. It must be HTTPS — the worker
token is a bearer credential sent on every request.

**3. Start it.**

```bash
docker compose up -d
docker compose logs -f
```

**4. Blank `ENROLL_TOKEN`.** On first boot the agent trades it once for a
permanent token stored in the `worker-state` volume. Keeping the enrolment token
in `.env` after that does nothing except leave a used credential lying around.

**Don't delete that volume.** It holds your identity and the bundle cache. Losing
it means asking the operator for a fresh enrolment token and having the old worker
revoked.

---

## Checking it works

```bash
docker compose ps          # healthy
docker compose logs -f     # "job leased" → "job produced envelope" → "result submitted"
```

That three-line sequence is a complete job. The operator also sees you under
Workers in the dashboard, with your last heartbeat.

The container's health check reads the agent's heartbeat file and fails if it is
staler than `WORKER_HEARTBEAT_MAX_AGE_SECONDS` (600s). That is deliberately the
signal rather than "the process is running": a worker whose lease loop has
quietly died still has a live process, and would otherwise look identical to an
idle one from the outside.

---

## Options

All optional; the defaults are fine.

| Variable | Default | When to change it |
| --- | --- | --- |
| `WORKER_MEM_LIMIT` | `2g` | Raise for image-heavy extensions. `/tmp` is a 2g tmpfs and counts against this. |
| `WORKER_CPUS` | `2.0` | |
| `LOG_LEVEL` | `info` | `debug` when something is wrong. |
| `PUBLOADER_WORKER_IMAGE` | `ardax/publoader-worker:2.1.1` | Pin an older release or a digest. Multi-arch: works on x86-64 and arm64. |
| `WORKER_HEARTBEAT_MAX_AGE_SECONDS` | `600` | Only alongside a matching change to the core's `LEASE_TTL_SECONDS`. |

Pin an extension set to this host from the operator's side — Workers → Change.
Takes effect on your next poll; no restart.

---

## When it goes wrong

**`exec format error`** — wrong CPU architecture. Use `2.1.1` or later, which is
multi-arch, and check what you actually pulled:

```bash
docker image inspect ardax/publoader-worker:2.1.1 --format '{{.Architecture}}'
```

Note `.env` overrides the compose default, so `docker compose pull` alone will not
move you off a bad tag — and Docker caches by tag, so remove the image first.

**`lstat /docker: no such file or directory`** — the compose files moved to the
repository root. Run from `docker/worker/`, not `platform/docker/worker/`, and
delete the leftover `platform/` directory.

**`invalid or used enrollment token`** — it's single-use and may have expired, or
the volume was deleted after a successful enrolment. Ask for a new one.

**401 on every request** — the worker was revoked, or the state volume is from a
different core. Ask the operator.

**Healthy but never leases a job** — normal if the platform is paused or there is
no work for the extensions you're pinned to. The operator can see both.

Anything else: `docker compose logs` and send them the output. The agent logs the
job id and extension on every line, which is what the operator needs to find the
matching run on their side.
