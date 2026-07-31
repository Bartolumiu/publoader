# Extension author's guide

An extension answers one question: **what chapters does this publisher currently
offer?** It does not decide what gets uploaded, it does not talk to MangaDex, and
it holds no credentials. Everything downstream of "here is what I found" is the
control plane's job.

Extensions live in a separate repository (`publoader-extensions`, plus
`publoader-extensions-private`) and are published into the platform as
[bundles](glossary.md).

**Contents**

- [The v2 contract](#the-v2-contract)
- [A complete minimal extension](#a-complete-minimal-extension)
- [manifest.json field by field](#manifestjson-field-by-field)
- [The sandbox](#the-sandbox)
- [Worked example: how mangaplus avoids most of its work](#worked-example-how-mangaplus-avoids-most-of-its-work)
- [Testing locally](#testing-locally)
- [Publishing](#publishing)
- [Versioning and pinning](#versioning-and-pinning)
- [Porting a legacy Python extension](#porting-a-legacy-python-extension)

---

## The v2 contract

Defined in
[`src/contracts/extensionApi.ts`](../src/contracts/extensionApi.ts).
A module default-exports a factory; the factory returns something with one
method.

```ts
export type ExtensionFactory = (
  ctx: ExtensionContext,
) => ExtensionRuntime | Promise<ExtensionRuntime>;

export interface ExtensionRuntime {
  collect(input: CollectInput): Promise<CollectResult>;
}
```

This replaces v1's five methods and six attributes. Identity (name, group id,
languages) now comes from the manifest, and configuration (the tracked map,
override options, the schedule) comes from the database — the extension no longer
duplicates either (`extensionApi.ts:3-26`).

### `CollectInput` — what you are told

```ts
interface CollectInput {
  /** Chapter ids already uploaded for this extension. Empty on clean runs. */
  postedChapterIds: readonly string[];
  /** Clean run: return the full catalogue in allChapters. */
  cleanRun: boolean;
  /** One segment of a partitioned run: fetch only these external manga ids. */
  trackedSubset: readonly string[] | null;
}
```

`trackedSubset` is an **optimization, not a correctness requirement** — the runner
filters your output to that set regardless (`runner.mjs:637-642`). Honour it
anyway: it is the whole point of partitioning, which exists to spread load across
worker hosts without multiplying requests to the publisher.

### `CollectResult` — what you return

```ts
{
  updatedChapters: ChapterInput[],        // default []
  allChapters: ChapterInput[] | null,     // default null
  untrackedManga: MangaInput[],           // default []
}
```

**`allChapters` is the field to get right.** It means "this is everything the
publisher has for the series I looked at", and the platform uses it to decide what
to *remove* from MangaDex. Return `null` unless your run genuinely gathered a full
listing. `null` means "no removal information"; an empty array means "the publisher
has nothing here any more" — and those are very different instructions
(`extensionApi.ts:65-67`, `processor/dedupe.ts:46-63`). Getting it backwards turns
a partial scrape into a mass deletion.

The rule in practice: `allChapters` is non-null when `cleanRun` is true and you
fetched the whole catalogue, and `null` otherwise.

### `ChapterInput`

`extensionApi.ts:29-50`. Validated with zod at `.strict()` — an unknown field is a
rejection, not a dropped key.

| Field | Type | Notes |
| --- | --- | --- |
| `chapterId` | string ≤512 | **required.** The publisher's chapter identity. A chapter without it is dropped |
| `chapterUrl` | string ≤2048 | **required.** Must be on a host in `allowed_hosts` — enforced at ingest, so a mistake here quarantines the run |
| `mangaId` | string ≤512 | **required.** The publisher's series id |
| `mdMangaId` | uuid \| null | Omit or `null` — the runner resolves it from `ctx.mangaIdMap`, and an unresolvable chapter is dropped |
| `chapterNumber` | string ≤64 \| null | A **string**, not a number: `"12.5"`, `"ex"`, `"0"` |
| `chapterTitle` | string ≤1024 \| null | |
| `chapterVolume` | string ≤64 \| null | Leave null and the processor backfills it from the MangaDex aggregate |
| `chapterLanguage` | string ≤16 \| null | Must be declared in the manifest's `languages`, or be a value `custom_language` maps into |
| `chapterTimestamp` | ISO-8601 **with offset** \| null | When it was published |
| `chapterExpire` | ISO-8601 **with offset** \| null | When the publisher will take it down |
| `mangaName`, `mangaUrl` | string \| null | The MangaDex title wins over `mangaName` during processing |
| `images` | `Uint8Array[]` ≤500 | Rare. Page images for a chapter that has no public URL |

The runner is tolerant on the way in even though the wire schema is strict: it
accepts a `Date` or a number where an ISO string is expected, stringifies numeric
ids, and drops an individual unusable chapter rather than failing the whole run
(`runner.mjs:341-404`).

### `MangaInput`

All four fields required: `mangaId`, `mangaName`, `mangaLanguage`, `mangaUrl`
(`extensionApi.ts:52-60`). Report a series here when you find one you have no
MangaDex mapping for; the platform will either create the title automatically or
queue it for an operator. See
[the untracked-title pipeline](architecture-guide.md#the-untracked-title-pipeline).

### `ExtensionContext` — your entire world

`extensionApi.ts:86-106`. Anything not on this object you have to reach for
through Node directly, which is what the sandbox refuses.

| Member | What it is |
| --- | --- |
| `manifest` | Your own manifest, frozen and read-only |
| `mangaIdMap` | `ReadonlyMap<externalMangaId, mdMangaId>` from the platform's `tracked_manga` table — **including titles auto-created since your bundle was published** |
| `fetch(input, init?)` | The only sanctioned network primitive. Same signature as global `fetch`. Enforces `allowed_hosts`, applies a per-host politeness delay, a timeout, and bounded retries |
| `dataFile(name)` | Read a bundled data file, by `data_files` key or by relative path. Cannot escape the bundle directory |
| `log(message, fields?)` | Structured logging into the job's log stream. Never stdout |

---

## A complete minimal extension

This is the platform's own e2e fixture — real, executed by the real runner in CI,
and deliberately plain ESM with no build step
([`test/e2e/fixtures/e2etest/`](../test/e2e/fixtures/e2etest/)).

`index.mjs`:

```js
const MANGA_ID = "m1";

/** An ExtensionFactory: takes the context, returns something with collect(). */
const factory = (ctx) => ({
  async collect({ postedChapterIds, cleanRun }) {
    // Whatever you already uploaded is not news. Cheapest possible filter —
    // do it before you fetch anything, not after.
    const posted = new Set(postedChapterIds);

    const now = new Date();
    const expire = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const updatedChapters = [];
    for (const number of ["1", "2"]) {
      const chapterId = `c${number}`;
      if (posted.has(chapterId)) continue;

      updatedChapters.push({
        chapterTimestamp: now.toISOString(),   // ISO-8601 WITH an offset
        chapterExpire: expire.toISOString(),
        chapterLanguage: "en",                 // must be in manifest.languages
        chapterNumber: number,                 // a string, always
        chapterTitle: `E2E Chapter ${number}`,
        chapterVolume: null,                   // processor backfills from MD
        chapterId,
        chapterUrl: `https://e2e.example.com/chapter/${chapterId}`,
        mangaId: MANGA_ID,
        // Left unresolved on purpose: the runner fills it from the platform's
        // tracked map, so a title tracked after publish still works.
        mdMangaId: null,
        mangaName: "E2E Test Manga",
        mangaUrl: `https://e2e.example.com/manga/${MANGA_ID}`,
      });
    }

    // Goes to the job's log stream, never stdout — stdout is the envelope.
    ctx.log("collected", { updated: updatedChapters.length, cleanRun });

    return {
      updatedChapters,
      // The one field that can cause damage if you get it wrong. Non-null only
      // when this run really did gather the full catalogue.
      allChapters: cleanRun ? [] : null,
      // A series with no MangaDex mapping yet. The platform takes it from here.
      untrackedManga: [
        {
          mangaId: "m2",
          mangaName: "Untracked E2E Manga",
          mangaLanguage: "en",
          mangaUrl: "https://e2e.example.com/manga/m2",
        },
      ],
    };
  },
});

export default factory;
```

`manifest.json`:

```json
{
  "name": "e2etest",
  "version": "2.0.0",
  "publoader_api": "^2.0.0",
  "runtime": "node",
  "entrypoint": "index.mjs",
  "mangadex_group_id": "22222222-2222-4222-8222-222222222222",
  "languages": ["en"],
  "allowed_hosts": ["e2e.example.com"],
  "permissions": {
    "network": false,
    "filesystem_read": ["manga_id_map.json"],
    "filesystem_write": [],
    "subprocess": false
  },
  "data_files": { "manga_id_map": "manga_id_map.json" },
  "maintainers": ["publoader"],
  "timeout_seconds": 120,
  "max_attempts": 3
}
```

That is a complete, publishable extension. Everything else in this guide is about
doing it *well*.

---

## `manifest.json` field by field

Schema and defaults:
[`src/contracts/manifest.ts:10-79`](../src/contracts/manifest.ts).
The schema is `.passthrough()`, so extra keys are preserved rather than rejected —
but nothing reads them.

### Required

| Field | Rules |
| --- | --- |
| `name` | Must match `^[a-z0-9_]+$`. This is the extension's identity everywhere: the directory name, the audit subject, the `extension` column |
| `version` | 1–32 chars. Free-form; semver by convention |
| `entrypoint` | Must match `^[a-zA-Z0-9_./-]+\.(py\|mjs\|js)$`. For a node bundle it must be `.mjs` or `.js`, must exist in the zip, must be non-empty, and must contain a default export — all checked at publish (`store/bundles.ts:181-209`). This is the **built** file, not your TypeScript source |
| `mangadex_group_id` | uuid. Enforced at ingest: an envelope naming a different group id is quarantined (`ingest.ts:148-150`) |
| `languages` | ≥1 entry, each 2–16 chars. **Enforced as policy**: a chapter in an undeclared language quarantines the run |
| `allowed_hosts` | ≥1 entry. See below — this is the most consequential field in the file |

### `allowed_hosts` is enforced policy, twice

Matching is exact-host or subdomain: `example.com` matches `example.com` and
`api.example.com`, but **not** `notexample.com`
(`manifest.ts:89-100`, tested at
`test/unit/guardedFetch.test.ts:52`).

It is enforced at two independent points:

1. **Before any packet leaves.** `ctx.fetch` refuses a disallowed host, and
   re-checks **every redirect hop** — a 302 to an unlisted host is the obvious way
   to turn an allowlisted request into an arbitrary one
   (`extsdk/guardedFetch.ts:195-214`).
2. **On the way back in.** Ingest checks every `chapterUrl` you report against the
   core's own copy of your manifest. A URL on an unlisted host **quarantines the
   envelope and dead-letters the job** (`ingest.ts:176-181`).

An empty list blocks everything (`guardedFetch.test.ts:88`). List every host you
fetch *and* every host you build URLs on — mangaplus lists two for exactly that
reason: the API host it calls, and the web host its `chapterUrl` values point at.

### Optional, with defaults

| Field | Default | Notes |
| --- | --- | --- |
| `publoader_api` | `"^1.0.0"` | Set it to `"^2.0.0"`. When `runtime` is omitted this is what selects the runtime: major 1 → python, anything else → node (`manifest.ts:82-86`) |
| `runtime` | inferred | `"node"` for anything new. `"python"` survives only so historical bundles remain describable, and publishing one is refused |
| `class_name` | `"Extension"` | v1 vestige; unused by the v2 runner |
| `permissions` | network on, no fs, no subprocess | **Descriptive, not enforced.** The real sandbox is the runner's argv and the guarded fetch. Fill it in honestly as documentation of intent |
| `schedule` | none | `{hour: 0..23, minute: 0..59, day?: 0..6, timezone: "UTC"}`. `day` 0 = **Monday** (Python's `weekday()`, not JS's `getUTCDay()` — the conversion is in `slots.ts:57`). Without it the extension is never scheduled and can only be run manually. Operators can override it in the database |
| `data_files` | `{}` | Logical name → filename in the bundle. Two names are special: `manga_id_map` and `override_options` seed `tracked_manga` and `extension_configs` at first publish (`store/bundles.ts:103-132`) |
| `partition` | none | `{mode: "tracked_manga", maxSegments: 2..32 (4), minMangaPerSegment: ≥1 (25)}`. See [partitioned execution](architecture-guide.md#partitioned-execution). Declare it once you have enough tracked series that one host cannot get through them politely |
| `min_trust` | `"COMMUNITY"` | Set `"TRUSTED"` to restrict this extension to workers the operator vouched for. Enforced in the claim query, so it is not bypassable |
| `chapter_removal_mode` | none | `"unavailable"` or `"delete"`, overriding the global setting for this extension |
| `auto_create_titles` | `false` | When true, untracked series get a MangaDex title created and committed automatically. When false they queue for operator approval — the safer default, and what mangaplus uses |
| `title_defaults` | `{originalLanguage: "ja", contentRating: "safe", status: "ongoing"}` | Used when auto-creating. `contentRating` is one of safe/suggestive/erotica/pornographic; `status` one of ongoing/completed/hiatus/cancelled |
| `timeout_seconds` | `3600` | 60–21600. Becomes the job's `timeoutSeconds`; the worker hard-kills the runner's process group at that wall clock, and the runner emits a diagnosable envelope at 95% of it |
| `max_attempts` | `3` | 1–10. The job's retry budget |
| `maintainers`, `homepage`, `requirements` | `[]` / none / `[]` | Informational. `requirements` is a v1 vestige — a node bundle has no runtime install step |

---

## The sandbox

Your extension runs in a **separate Node process** from the worker agent, spawned
with these flags (`worker/executor.ts:314-336`):

```
node --disallow-code-generation-from-strings
     --permission
     --allow-fs-read=<bundleDir>   --allow-fs-read=<runnerDir>
     --allow-fs-read=<workdir>
     --allow-fs-write=<outputDir>  --allow-fs-write=<workdir>
     runner-node/runner.mjs …
```

### What is forbidden, and why

| Forbidden | Mechanism | Why |
| --- | --- | --- |
| `eval`, `new Function` | `--disallow-code-generation-from-strings` | A bundle is a single pre-built file reviewed at publish. Fetching code and evaluating it at run time is never legitimate here |
| `child_process`, `worker_threads` | `--permission` denies both outright | Otherwise you could shell out or spawn a thread and escape the guarded fetch entirely. This is most of the reason the permission model is on |
| Reading anything outside the bundle, the workdir, and the runner directory | `--allow-fs-read` allowlist | Your bundle's own files are your business; the worker's credential file is not |
| Writing anywhere except the workdir and output directory | `--allow-fs-write` allowlist | No persistence between jobs. A bundle cannot leave anything behind |
| Reaching a host not in `allowed_hosts` | the guarded fetch, checked again on every redirect | Egress control. See above |
| Reading the worker's own configuration | a minimal spawn environment — `PATH`, `HOME`, `TMPDIR`, `LANG` and nothing else | The worker token, the core URL, and everything else the agent was configured with stay out of your process (`executor.ts:363-368`) |
| Writing to stdout | `runner.mjs` captures `process.stdout.write` and the `console` methods **before any bundle code runs** and redirects them to stderr | stdout is the envelope channel. Libraries write to fd 1 without asking (`runner.mjs:61-78`) |

Directory grants **are** recursive, so nested data files resolve. Network is
deliberately *not* restricted by the permission model — it has no network
component — so DNS and TLS work with no further grants and egress control is the
guarded fetch's job alone.

### Consequences for how you write code

- **No `fs`, no `path` tricks to read your data files.** Use `ctx.dataFile()`. It
  resolves through `data_files` or as a relative path and refuses to escape the
  bundle, with a clear error rather than an `ERR_ACCESS_DENIED` stack
  (`extsdk/context.ts:65-89`).
- **No ambient `fetch`.** Use `ctx.fetch`. The global one is not blocked by the
  permission model, but nothing stops ingest from quarantining whatever you bring
  back from a host your manifest does not list — so you gain nothing and lose the
  politeness delay, timeout, retries, and `Retry-After` handling.
- **No native modules, no runtime dependency install.** The publish step bundles
  your dependencies into one self-contained ESM file with `external: []`, so
  everything must be pure JS that esbuild can inline.
- **Do not use TypeScript parameter properties** if you intend to run your tests
  under Node's type-stripping loader — it does not implement them. mangaplus
  declares fields explicitly for this reason.
- **Throw for a site problem; let the runner classify.** A throw from inside
  `collect()` is treated as `TRANSIENT` and the job retries. A bad import, a
  factory that throws, or a malformed return value is `PERMANENT` — a retry against
  the same pinned bundle would fail identically (`runner.mjs:566-599`, `754`).

---

## Worked example: how mangaplus avoids most of its work

`publoader-extensions/src/mangaplus/` is the reference implementation, and its
interesting property is that a typical run makes **three cheap requests plus a
handful of expensive ones**, instead of one expensive request per tracked series.

Manga Plus has ~700 tracked series and one detail endpoint,
`title_detailV3?title_id=<id>`, that must be called per series. At the guarded
fetch's default 500 ms per-host interval, calling it for everything is a six-minute
run that mostly re-learns nothing.

So it separates *evidence gathering* from *fetching*:

**Step 1 — three cheap listing calls, in parallel** (`src/index.ts:382-387`):

```ts
const [catalogue, webHome, updated] = await Promise.all([
  this.requestApi("title_list/allV2"),
  this.requestApi("web/web_homeV4"),
  this.requestApi("title_list/updated"),
]);
```

**Step 2 — reduce those into per-title evidence** (`src/listing.ts:86-135`): is
the title in the catalogue at all, did a feed say it updated recently, and what is
the newest chapter id and timestamp anyone advertised for it. Where a title appears
several times on the home page, only the newest release supplies the chapter id.

**Step 3 — decide who actually needs a detail call** (`src/planner.ts:112-148`).
Four skip reasons:

| Reason | Meaning |
| --- | --- |
| `absent-from-listing` | not in the catalogue — nothing to fetch |
| `latest-chapter-posted` | the advertised newest chapter id is already in `postedChapterIds`, and no feed contradicts that with a newer timestamp |
| `no-update-signal` | neither update feed mentioned it |
| `outside-update-window` | its newest advertised chapter predates the update window |

**Step 4 — fetch only the survivors**, four at a time
(`index.ts:259-261`, `TITLE_CONCURRENCY = 4`).

Three details make this safe rather than merely fast, and they are the transferable
lessons:

- **`trackedSubset` narrows the candidate set *before* any skip predicate runs**
  (`planner.ts:92-100`), so partitioning composes with the skipping instead of
  fighting it.
- **It fails *open*, never quiet.** If both update feeds are dead, or if they
  answer but name zero updated titles, the planner fetches everything
  (`planner.ts:167-175`, `listing.ts:150`). "Feeds answered with no updates" is
  the signature of protobuf schema drift, not of a quiet day — so it is treated as
  *no evidence*, not as evidence of nothing.
- **An absent timestamp is unknown, not zero.** proto3 omits default values, so a
  missing `updatedTimeStamp` never justifies a skip (`planner.ts:140-146`).

Other things it gets right that a first extension usually gets wrong:

- `requestApi` **returns `null` rather than throwing** (`index.ts:310-369`) and
  logs four failure classes distinctly: non-200, transport throw, decode failure,
  and an API-level error where the response carries an error payload instead of a
  `success` body. One dead series does not fail the run.
- It decodes protobuf with a ~450-line dependency-free decoder
  (`src/proto.ts`) rather than a runtime, because only two wire types occur. The
  decoder mimics Python's `MessageToDict` — proto3 defaults are *omitted*, which
  is what the "absent means unknown" logic depends on.
- Language resolution is explicit and ordered: `custom_language[mangaId]` wins,
  then an already-MangaDex code passes through, then a built-in map
  (`index.ts:172-184`).
- Untracked detection reuses the catalogue it already fetched — zero extra
  requests — and tests membership against the **whole** `mangaIdMap`, so a
  partitioned segment never claims another segment's title
  (`index.ts:417-447`).
- One source chapter can legitimately become several MangaDex chapters, so its
  normalizer returns an array of numbers and fans out
  (`src/normalise.ts:339-348`).
- Its pure modules — `listing.ts`, `planner.ts`, `normalise.ts` — do no I/O and are
  unit-tested with `node:test` against hand-encoded protobuf bytes
  (`src/planner.test.ts`, `src/listing.test.ts`).

If you write one extension well, copy that structure: **an impure shell that
fetches, and pure functions that decide.**

---

## Testing locally

### Unit-test the pure parts

Keep decisions in functions that take data and return data, then test them with no
network and no platform. mangaplus uses `node:test` with no framework:

```bash
cd src/<your-extension>
npm run typecheck     # tsc --noEmit, plus the test tsconfig
npm test              # node --test --experimental-transform-types "src/**/*.test.ts"
npm run build         # esbuild → index.mjs
```

Note that mangaplus's `tsconfig.json` sets `"types": []` — Node globals are
structurally denied to extension source, and only its test config adds them. That
is a good habit to copy: it makes an accidental `fs` import a compile error rather
than a runtime denial.

### Run it through the real runner

The runner is the thing that will actually execute your bundle, and you can drive
it by hand. Write a `job.json` shaped like the runner's input protocol
(`runner.mjs:16-22`), then:

```bash
node --disallow-code-generation-from-strings --permission \
     --allow-fs-read="$PWD/bundle" --allow-fs-read="$PWD/runner-node" \
     --allow-fs-read="$PWD/work" \
     --allow-fs-write="$PWD/work" --allow-fs-write="$PWD/work/out" \
     runner-node/runner.mjs \
     --bundle "$PWD/bundle" --job "$PWD/work/job.json" --output "$PWD/work/out"
```

The last line of stdout is your envelope; everything else is stderr. Running it
under the real flags is the only way to find out that you were relying on
something the sandbox denies.

`test/unit/nodeRunner.test.ts` does exactly this against the e2e fixture
and is worth reading as a template — it covers segment filtering, dropped
unmapped chapters, `postedChapterIds` handling, and stdout hygiene.

### Run it through the whole platform

Bring up the local stack, publish your bundle, trigger a run:

```bash
./scripts/publoader dev up -d --build

export PUBLOADER_API_URL=http://127.0.0.1:8100
export PUBLOADER_ADMIN_TOKEN=dev-admin-not-a-secret

pnpm exec tsx src/cli/admin.ts bundle publish /path/to/your-extension
pnpm exec tsx src/cli/admin.ts runs trigger your_extension --kind FORCE
pnpm exec tsx src/cli/admin.ts runs list
pnpm exec tsx src/cli/admin.ts errors
```

MangaDex is faked by `mock-md` in that stack, so nothing reaches the real
catalogue, and `GET http://127.0.0.1:8200/_test/uploads` shows what the uploader
actually did. See [development.md](development.md#the-local-stack).

---

## Publishing

```bash
publoader-admin bundle publish <extension-dir> [--source-commit <sha>]
```

The build-and-zip step lives in
[`src/core/webhooks/bundleBuilder.ts`](../src/core/webhooks/bundleBuilder.ts),
not in the CLI, because **two callers need it**: an operator on a laptop, and the
[GitHub push webhook](webhooks.md) building a directory it just extracted from a
repo archive. Both must produce byte-identical archives for the same input — the
sha256 of the zip is the version pin a worker verifies, so two publish paths that
disagreed would be two different programs (`bundleBuilder.ts:1-16`).

`buildExtensionBundle(root)` (`bundleBuilder.ts:217-249`):

1. Reads `<dir>/manifest.json` and requires `name` and `version` — locally, so you
   do not upload megabytes to be told about a typo.
2. Detects a source entrypoint: `index.ts`, then `src/index.ts`, else `main` from a
   `package.json` that declares a `build` script (`bundleBuilder.ts:137-159`). No
   match means the directory is already plain ESM and is zipped as-is.
3. If it found one, **builds it with esbuild**: `bundle: true`, `format: "esm"`,
   `platform: "node"`, `target: "node24"`, **`external: []`**
   (`bundleBuilder.ts:98-134`). Dependencies are inlined, so the sha256 pins your
   whole program and not just your own source. The flip side: every import must
   resolve from the extension directory — a node builtin or a relative path.
4. Stages only what ships: the built `index.mjs`, a manifest **rewritten** with
   `entrypoint: "index.mjs"`, and each declared `data_files` value — failing if one
   is missing (`bundleBuilder.ts:167-193`). Source, tests, `node_modules`, and
   lockfiles are left behind. A bundle is the program, not the project.
5. Zips **deterministically** (`bundleBuilder.ts:51-76`): entries in sorted order,
   `__pycache__`/`.git`/`node_modules`/`dist`/`.turbo` excluded, and every entry
   stamped with a fixed mtime rather than the filesystem's. That last detail
   matters — a repo archive extracts with "now" as its mtime, so without it the
   webhook would compute a different sha256 than the CLI for the very same commit,
   and every redelivery would look like a new version of identical code.

Then the CLI posts it to `POST /api/v1/admin/bundles` with
`content-type: application/zip`, adding `x-source-commit` when given
(`src/cli/admin.ts:629-680`). Output tells you `extension`, `version`, `sha256`,
and whether it was `created`; `created: false` means byte-identical content was
already published.

If a build is needed and esbuild is not installed, the error says so and tells you
to run `pnpm install` at the repo root or ship a prebuilt `index.mjs`
(`bundleBuilder.ts:105-110`).

Publishing needs the `bundles:write` scope — the `ci-publisher` preset is exactly
that one scope, and nothing else.

**Rejections** (all 422, all with a readable reason):

| Reason | Fix |
| --- | --- |
| python runtime without `--allow-legacy-runtime` | Port to v2 |
| missing `manifest.json`, or invalid zip | — |
| manifest failed schema validation | The message names the field |
| entrypoint missing from the bundle | Check `entrypoint` matches the built filename |
| entrypoint is empty | — |
| entrypoint is not `.mjs`/`.js` for a node runtime | Point it at the built file, not the source |
| entrypoint has no default export | `export default factory` |

The entrypoint checks are deliberately a shallow smell test, not a parser — the
real validation is the runner importing the file and refusing it if `default` is
not a function. The point is to fail at publish, where an operator is watching,
rather than on a worker an hour later (`store/bundles.ts:172-180`).

### Publishing from a push

A GitHub push to an extensions repository can build and publish automatically, via
`POST /webhook` on the control plane. It uses the same `buildExtensionBundle`, so
the bytes are identical to what the CLI would have produced. Because
`external: []` requires every import to resolve from the extension directory, that
path is limited to dependency-free extensions. Setup, the signature check, and why
CI-side publishing is preferred: [webhooks.md](webhooks.md).

---

## Versioning and pinning

- **The sha256 of the zip is the version pin.** Every job carries it, the worker
  verifies the downloaded bytes against it, and ingest rejects an envelope whose
  `bundleSha256` disagrees with the job's pin.
- **`(extension, version)` is unique.** Republishing the same `version` with
  different content *replaces* the row and produces a new sha. Jobs already pinned
  to the old sha keep their pin but can no longer fetch the bytes — so **bump the
  version** rather than republishing over one, if you need both to remain runnable
  (`store/bundles.ts:64-73`).
- **The scheduler pins the latest non-yanked bundle** at run-creation time
  (`store/bundles.ts:135-141`). A run in flight is unaffected by a publish.
- **Yanking** (`bundle yank`, or `store/bundles.ts:163-169`) removes a version from
  `latest()` and from the scheduler's sweep. It does not break existing pins.
- **Rolling back** is publishing the known-good version again, or yanking the bad
  one so `latest()` falls back.

---

## Porting a legacy Python extension

The v1 Python contract is gone: publishing a python bundle is refused at the
publish endpoint (`store/bundles.ts:37-43`), and the worker image ships no
interpreter. There is an audited `--allow-legacy-runtime` escape hatch, and it
exists so a rollback to a known-good legacy bundle is possible without a code
change — not for new work.

The mapping:

| v1 (Python) | v2 (TypeScript) |
| --- | --- |
| `class Extension` with five methods | one factory returning `{ collect() }` |
| `get_updated_chapters()` | `collect()` → `updatedChapters` |
| `get_all_chapters()` | `collect()` → `allChapters` — **but return `null`, not `[]`, unless you really gathered everything** |
| `get_updated_manga()` | `collect()` → `untrackedManga` |
| `name`, `mangadex_group_id`, `languages` attributes | `manifest.json` fields |
| `open_manga_id_map()` reading `manga_id_map.json` | `ctx.mangaIdMap`, from the database and therefore current |
| `override_options.json` read by the extension | `extension_configs` in the database; the core applies them, you do not |
| `self.tracked_manga` | `[...ctx.mangaIdMap.keys()]`, narrowed by `trackedSubset` |
| `requests` / `httpx` | `ctx.fetch` |
| `open()` on a bundled file | `ctx.dataFile(name)` |
| `print()` / `logging` | `ctx.log(message, fields)` |
| `chapter_removal_mode` attribute | `chapter_removal_mode` in the manifest |
| `requirements.txt`, installed into the worker image | esbuild inlines dependencies at publish; the worker needs no install |
| snake_case `Chapter` fields | camelCase `ChapterInput` fields |
| datetimes as `datetime` objects | ISO-8601 strings **with an offset** (a `Date` is also accepted) |
| `md_manga_id` resolved by the extension | leave `mdMangaId: null`; the runner resolves it |

Two behavioural notes for porters:

- **`md_manga_id is None` filtering moved.** v1 dropped chapters whose series had
  no MangaDex mapping; the runner now does it for you
  (`runner.mjs:613-622`). Do not filter them yourself and do not invent an id.
- **Politeness is no longer your problem, and no longer your choice.** The
  monolith relied on extensions being polite; `ctx.fetch` imposes a per-host
  minimum interval regardless (`guardedFetch.ts:12-18`). Budget your run's
  `timeout_seconds` accordingly — a 700-request run at 500 ms is six minutes
  before you count the site's own latency, which is the arithmetic that motivates
  [targeted fetching](#worked-example-how-mangaplus-avoids-most-of-its-work).

See [ipc-to-api-mapping.md](ipc-to-api-mapping.md) for the operator-facing half of
the port, and [migration-guide.md](migration-guide.md) for the data cutover.

---

## See also

| Document | For |
| --- | --- |
| [architecture-guide.md](architecture-guide.md#4-the-runner-executes-the-extension-under-the-permission-model) | what happens to your bundle after `collect()` returns |
| [api-reference.md](api-reference.md#bundles) | the publish endpoint |
| [glossary.md](glossary.md) | bundle, manifest, segment, trust tier |
| [security-trust-model.md](security-trust-model.md) | why the sandbox is shaped this way |
| [development.md](development.md) | the local stack and the test layers |
