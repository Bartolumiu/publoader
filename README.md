# publoader

Mirrors chapters from external manga publishers onto
[MangaDex](https://mangadex.org), automatically and exactly once.

A per-publisher **extension** discovers what chapters a source currently offers.
The **control plane** validates that report, compares it against the live MangaDex
state, and decides what to upload, edit, or remove. One process — and only one —
holds the MangaDex credentials and performs the writes.

---

## The distributed model

Scraping is the part that changes most often, is most likely to be contributed by
somebody other than the operator, and wants to be spread across hosts because
publisher sites rate-limit per source IP. Uploading is the opposite: it must be
centralised, because MangaDex upload sessions are per-account state, and because a
duplicate upload is a visible mess on a public catalogue.

So the two are split. **Untrusted, credential-free workers** lease jobs, run
extension code in a sandboxed Node process, and submit one validated document — a
result envelope. **The control plane** decides what that document means. Workers
never write to the database and never talk to MangaDex; their entire blast radius
is one revocable token and whatever bundle they were handed. Exactly-once is not a
convention but six layers of enforcement, four of which are database constraints.

```
   publisher sites                                            MangaDex
        ▲                                                        ▲
        │ scrape (guarded fetch, host allowlist)                 │ read + write
        │                                                        │
┌───────┴────────────────┐                    ┌──────────────────┴─────────────┐
│  WORKER HOSTS  (many)  │                    │  CONTROL PLANE  (one host)     │
│                        │   lease job ───▶   │                                │
│  agent                 │                    │  core-api        HTTP + dash   │
│   └─ node --permission │   ◀─── envelope    │  core-scheduler  the clock     │
│       runner.mjs       │                    │  core-processor  decides work  │
│       + extension      │      HTTPS only    │  core-uploader   ONLY writer   │
│                        │                    │                                │
│  no DB, no MangaDex    │                    │  PostgreSQL — single source    │
│  credential, no        │                    │  of truth: runs, jobs, leases, │
│  listening socket      │                    │  envelopes, chapters, config   │
└────────────────────────┘                    └────────────────────────────────┘
```

[docs/architecture-guide.md](docs/architecture-guide.md) traces one scheduled run
all the way through.

---

## Get running in five minutes

Requires Node 24, pnpm, and Docker. Everything runs from `platform/`.

```bash
cd platform
pnpm install
pnpm exec prisma generate

# The whole system on one machine, with MangaDex faked.
./scripts/publoader dev up -d --build
```

That brings up Postgres, the four core services, a mock MangaDex, and **two**
worker agents already enrolled. Then:

```bash
export PUBLOADER_API_URL=http://127.0.0.1:8100
export PUBLOADER_ADMIN_TOKEN=dev-admin-not-a-secret
alias padmin='pnpm exec tsx src/cli/admin.ts'

padmin workers list                                  # two ACTIVE workers
padmin bundle publish test/e2e/fixtures/e2etest      # publish an extension
padmin runs trigger e2etest --kind FORCE             # run it
padmin runs list                                     # watch it reach PROCESSED

curl -s http://127.0.0.1:8200/_test/uploads | jq     # what the uploader did
```

The operator dashboard is at <http://127.0.0.1:8100/> — sign in with the admin
token via "Use the admin token instead".

Prove the whole thing, including killing a worker mid-job and watching the other
one finish the run:

```bash
./test/e2e/run-e2e.sh
```

Tear it down with `./scripts/publoader dev down -v`.

> The dev stack is deliberately insecure — a fixed admin token, a trivial database
> password, automated enrollment, loopback-only ports. Never run it on a host that
> accepts traffic from anywhere else.

---

## Environments

`platform/scripts/publoader` is the single entry point for all three
environments. It exists because three things have to agree for two environments to
coexist safely — the env file, the compose project name (which namespaces
containers, networks, **and the database volume**), and the ingress overlay — and
getting one wrong is how a staging deploy ends up writing to the production
database.

```bash
./scripts/publoader dev     up -d --build     # local, self-contained, mock MangaDex
./scripts/publoader staging up -d             # staging, with the MangaDex mock
./scripts/publoader prod    up -d             # production

./scripts/publoader prod logs -f core-api
./scripts/publoader prod migrate              # apply pending migrations
./scripts/publoader prod upgrade 2.1.0        # pull → migrate → restart, in order
./scripts/publoader prod rollback 2.0.0       # back to a known-good tag
./scripts/publoader prod admin stats          # the CLI, inside the network
./scripts/publoader prod backup               # gzipped pg_dump
./scripts/publoader prod psql                 # a shell on the database
```

`prod` reads `docker/core/.env.production`, `staging` reads
`docker/core/.env.staging`; both start as copies of the `.example` files beside
them. `dev` needs no env file. The Discord bot and the Cloudflare tunnel are
optional compose profiles.

Published images:

| Image | Runs |
| --- | --- |
| `ardax/publoader-core:2.1.1` | `core-api`, `core-scheduler`, `core-processor`, `core-uploader`, and the Discord bot — one image, several entry points |
| `ardax/publoader-core-migrate:2.1.1` | The one-shot migration container, the only thing able to alter the schema |
| `ardax/publoader-worker:2.1.1` | The worker agent and the extension runtime |

Base images are pinned by digest; the tag in an env file is what a deploy runs.
Full procedure in [docs/deployment.md](docs/deployment.md).

---

## Documentation

| Document | One line |
| --- | --- |
| [architecture-guide.md](docs/architecture-guide.md) | How it works: the planes, one run traced end to end, the job state machine, and why exactly-once holds |
| [development.md](docs/development.md) | Local setup, running services from source, the Prisma workflow, the three test layers, debugging a failing job |
| [api-reference.md](docs/api-reference.md) | Every HTTP endpoint, its required scope, and its meaningful failures |
| [data-model.md](docs/data-model.md) | Every table, column, index, and invariant, plus why five columns are still JSONB |
| [extension-guide.md](docs/extension-guide.md) | Writing an extension: the v2 contract, the manifest, the sandbox, publishing |
| [glossary.md](docs/glossary.md) | Every load-bearing term, with the file that defines it |
| [security-trust-model.md](docs/security-trust-model.md) | Threat model, control matrix, secrets inventory, and what a worker can and cannot do |
| [deployment.md](docs/deployment.md) | Standing up the core and worker hosts, the Cloudflare tunnel and WAF, upgrades, backups |
| [operations.md](docs/operations.md) | Day-2 runbooks: triage, worker lifecycle, secret rotation, dead letters, incidents |
| [migration-guide.md](docs/migration-guide.md) | Staged Mongo/SQLite → Postgres cutover, with a rollback at every stage |
| [ipc-to-api-mapping.md](docs/ipc-to-api-mapping.md) | Which endpoint replaced each legacy IPC command |
| [bot.md](docs/bot.md) | Discord bot setup, the admin-gating model, and the command reference |
| [webhooks.md](docs/webhooks.md) | Publishing extension bundles from a GitHub push: setup, the signature check, and why CI-side publishing is preferred |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Branch workflow, definition of done, and the review checklist |

---

## Layout

```
platform/                     everything current
├── prisma/
│   ├── schema.prisma         the single source of truth for state
│   └── migrations/           versioned; two are hand-written to preserve data
├── src/
│   ├── contracts/            the wire contracts: envelope, manifest, extension API
│   ├── core/
│   │   ├── api/              Fastify server, auth, scopes, routes, dashboard assets
│   │   ├── scheduler/        the clock, slot arithmetic, segmentation
│   │   ├── ingest/           the only path by which worker output enters
│   │   ├── processor/        envelopes → upload/edit/skip/remove decisions
│   │   ├── md/               MangaDex client, upload workers, card rendering
│   │   ├── store/            durable state; every transition is guarded SQL
│   │   └── observability/    metrics listener, DB-derived gauges, heartbeat
│   ├── extsdk/               the guarded fetch and the extension context
│   ├── worker/               the agent: lease, bundle cache, sandboxed executor
│   ├── bot/                  the Discord control bot
│   ├── cli/                  publoader-admin, and the legacy importers
│   └── services/             the six process entry points
├── runner-node/runner.mjs    the sandbox. Self-contained; no platform imports
├── test/                     unit / integration (real Postgres) / browser (Chrome) / e2e (Docker)
├── docker/                   core, worker, and dev compose stacks + Dockerfiles
└── scripts/publoader         the dev/staging/prod entry point
docs/                         the documentation set above
```

Extensions live in their own repositories:
[publoader-extensions](https://github.com/publoader/publoader-extensions) for
public sources, plus a private companion. They depend on this repo only through the
[v2 extension contract](docs/extension-guide.md#the-v2-contract) and are published
into a running platform with `publoader-admin bundle publish`.

---

## Getting help

- **How does something work?** Start with
  [docs/architecture-guide.md](docs/architecture-guide.md), then the code — the
  comments in `platform/src/core/store/jobs.ts`, `core/api/scopes.ts`, and
  `core/ingest/ingest.ts` carry the reasoning behind the parts that look
  surprising.
- **Something is broken in a deployment?**
  [docs/operations.md](docs/operations.md), starting with the incident checklist.
- **Contributing?** [CONTRIBUTING.md](CONTRIBUTING.md) has the branch workflow, the
  definition of done, and the review checklist.
- **Otherwise** — open an issue, or ask in the operators' Discord channel.

Licensed under the GNU General Public License v3.0. See [LICENSE](LICENSE).
