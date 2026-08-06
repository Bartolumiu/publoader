#!/usr/bin/env node
/**
 * Reconcile `uploaded_chapters` against what MangaDex actually holds today, and
 * move the rows that have stopped being live uploads into the archive they
 * belong in — `unavailable_chapters` or `deleted_chapters`.
 *
 * Why this exists: those two archives are only ever written by the upload-task
 * workers (src/core/md/taskWorkers.ts), i.e. when *this platform* is the one
 * doing the marking or the deleting. Anything that happened to a chapter on
 * MangaDex's side — a publisher rotating an external URL out of readability, a
 * staff deletion, a takedown performed by hand — leaves `uploaded_chapters`
 * claiming the chapter is still up. This walks the whole table and fixes that.
 *
 * It is deliberately a standalone ESM script rather than a CLI subcommand:
 * src/cli/admin.ts is a thin API client that holds no database credentials, and
 * there is no admin endpoint for rewriting history (every mutating chapter route
 * enqueues a real MangaDex action instead, which is precisely what must NOT
 * happen here — these chapters are already unavailable/deleted, so re-running
 * the workers over them would re-upload cards and re-issue deletes). So it runs
 * inside the stack, against the database directly. See RUNNING below.
 *
 * Classification, per chapter, from the MangaDex API:
 *
 *   deleted      The id 404s on GET /chapter/{id}. Authoritative — a batch
 *                lookup omitting an id is not enough on its own, because the
 *                collection endpoint hides chapters for several reasons.
 *   unavailable  MangaDex itself will not serve it: it comes back from
 *                GET /chapter?ids[]=… only when `includeUnavailable=1` is set,
 *                or carries `isUnavailable: true`. Both tests are needed — the
 *                attribute is absent entirely on chapters whose records predate
 *                the field, so the differential is the reliable one and the
 *                attribute is the belt-and-braces.
 *   hidden       On MangaDex, fetchable by id, but absent from the collection
 *                even with `includeUnavailable=1` — a future `publishAt` is the
 *                usual cause. Reported and never written: "unavailable" is a
 *                specific claim and this is not evidence for it.
 *   live         Nothing to do.
 *
 * Deliberately NOT detected: chapters this platform has already replaced with
 * an unavailable card. There is no reliable signature for them — runUnavailable
 * repoints `externalUrl` at the series or domain root rather than clearing it
 * (resolveReplacementUrl), so a carded chapter is externally indistinguishable
 * from a live one without fetching its page. It also needs no backfill: the
 * worker that posts the card writes `unavailable_chapters` in the same step.
 * The gap this script closes is the other one — what MangaDex did on its own.
 *
 * Writes mirror archiveUnavailable/runDelete exactly: upsert the archive row
 * carrying every column across unchanged, stamp `extra.mdAttributes` with the
 * MangaDex snapshot for unavailable rows, then drop the row from
 * `uploaded_chapters` so a chapter lives in exactly one table. An id already
 * present in the target archive keeps its original timestamp.
 *
 * RUNNING (on the host running the core stack; core-uploader is the one service
 * attached to both the `data` and `edge` networks, so it has the database and
 * the internet at once):
 *
 *   cd /path/to/publoader
 *   docker compose -f docker/core/docker-compose.yml exec -T core-uploader \
 *     node --input-type=module - < scripts/backfill-md-chapter-state.mjs
 *
 * That is the dry run: it reads MangaDex, prints what it would do, and touches
 * nothing. To write, put the flags after the `-` (which is what makes node read
 * the script from stdin — without it node parses `--apply` as its own option
 * and exits):
 *
 *   docker compose -f docker/core/docker-compose.yml exec -T core-uploader \
 *     node --input-type=module - --apply < scripts/backfill-md-chapter-state.mjs
 *
 * Flags:
 *   --apply             Perform the writes. Without it, nothing is written.
 *   --keep-uploaded     Leave rows in uploaded_chapters instead of moving them.
 *   --extension=<name>  Restrict to one extension.
 *   --limit=<n>         Stop after n chapters (for a first look).
 *   --out=<path>        Write the full classification as JSON.
 *   --rps=<n>           MangaDex requests per second (default 3; the API's
 *                       global ceiling is 5).
 */
import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";

const API_BASE = (process.env["MANGADEX_API_URL"] ?? "https://api.mangadex.org").replace(/\/+$/, "");

// Only the ids MangaDex is asked about per request. 100 is the collection
// endpoint's own ceiling for `ids[]`.
const BATCH = 100;

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (name) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const options = {
  apply: has("--apply"),
  keepUploaded: has("--keep-uploaded"),
  extension: value("extension"),
  limit: value("limit") ? Number(value("limit")) : undefined,
  out: value("out"),
  rps: value("rps") ? Number(value("rps")) : 3,
};

if (options.limit !== undefined && !Number.isFinite(options.limit)) fail("--limit must be a number");
if (!Number.isFinite(options.rps) || options.rps <= 0) fail("--rps must be a positive number");

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

// --------------------------------------------------------------- MangaDex

/**
 * One request every `1/rps` seconds, serialised.
 *
 * MangaDex's global limit is 5 requests/second per IP and this script is not
 * the only thing on that IP — core-uploader is pushing chapters from the same
 * address. Staying under the ceiling on purpose keeps a long backfill from
 * starving the thing that actually publishes.
 */
let nextSlot = 0;
async function throttle() {
  const gap = 1000 / options.rps;
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + gap;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

/**
 * GET with retries. 429 and 5xx are transient here by definition — this is a
 * read-only sweep that can always be repeated — so they are retried with the
 * server's own Retry-After when it offers one. 404 is a *result*, not an error,
 * and is handed back to the caller as such.
 */
async function get(path, { allow404 = false } = {}) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    await throttle();
    let response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (attempt === 5) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      continue;
    }
    if (response.status === 404 && allow404) return null;
    if (response.ok) return response.json();
    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * attempt;
      if (attempt === 5) throw new Error(`MangaDex ${response.status} for ${path}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    throw new Error(`MangaDex ${response.status} for ${path}: ${(await response.text()).slice(0, 300)}`);
  }
  throw new Error(`MangaDex unreachable for ${path}`);
}

/**
 * The ids MangaDex returns for this batch, and their attributes.
 *
 * Two calls differing in exactly one parameter. `includeUnavailable` is a real
 * include toggle: with it off, MangaDex silently drops the chapters it will not
 * serve, so the set difference between the two responses *is* the unavailable
 * set — and it has to be measured this way, because `isUnavailable` is absent
 * from the attributes of every chapter whose record predates the field.
 *
 * The sibling parameters `includeExternalUrl`, `includeEmptyPages` and
 * `includeFuturePublishAt` are deliberately NOT sent, despite their names: on
 * this endpoint they are exclusive filters, not toggles. `includeExternalUrl=1`
 * returns *only* external chapters and drops everything else, so sending them
 * would silently classify most of the table as missing. Verified against the
 * live API; omitting all three is what returns the full set.
 */
async function lookupBatch(ids) {
  const query = (includeUnavailable) => {
    const params = new URLSearchParams();
    params.set("limit", String(BATCH));
    for (const id of ids) params.append("ids[]", id);
    if (includeUnavailable) params.set("includeUnavailable", "1");
    return `/chapter?${params.toString()}`;
  };

  const [withUnavailable, withoutUnavailable] = await Promise.all([
    get(query(true)),
    get(query(false)),
  ]);

  const attributes = new Map();
  for (const chapter of withUnavailable.data) attributes.set(chapter.id, chapter.attributes);
  const served = new Set(withoutUnavailable.data.map((chapter) => chapter.id));
  return { attributes, served };
}

// --------------------------------------------------------------- classify

/**
 * Confirm a batch miss one id at a time.
 *
 * A collection endpoint omitting an id means "not in this result set", which is
 * not the same as "gone" — a future publishAt, or any filter MangaDex applies by
 * default, produces the same silence. Deleting is the irreversible direction, so
 * an archive row claiming a chapter was deleted has to rest on a 404 against the
 * chapter's own endpoint and nothing weaker.
 */
async function confirmMissing(id) {
  const detail = await get(`/chapter/${id}`, { allow404: true });
  if (detail === null) return { state: "deleted", attributes: null };
  const attributes = detail.data.attributes;
  // It exists, and the collection hid it even with includeUnavailable=1 — so
  // unavailability is not the explanation unless the chapter says so itself.
  // A future publishAt is the common cause, and a chapter that has not been
  // published yet is not a chapter that has been taken down.
  if (attributes.isUnavailable === true) return { state: "unavailable", attributes };
  return { state: "hidden", attributes };
}

// ------------------------------------------------------------------ write

/** Every chapter column, shared verbatim by all four archive tables. */
const COLUMNS = [
  "extension",
  "chapterId",
  "chapterUrl",
  "chapterNumber",
  "chapterTitle",
  "chapterVolume",
  "chapterLanguage",
  "chapterTimestamp",
  "chapterExpire",
  "chapterLookup",
  "mangaId",
  "mangaName",
  "mangaUrl",
  "mdMangaId",
  "mdGroupId",
];

function columnsOf(row, mdAttributes) {
  const columns = {};
  for (const key of COLUMNS) columns[key] = row[key];
  // taskWorkers keeps the MangaDex snapshot under `extra.mdAttributes`; the
  // archive is the only record of how the chapter looked when it stopped being
  // readable, and that answer stops existing once MangaDex drops it.
  const extra = row.extra && typeof row.extra === "object" && !Array.isArray(row.extra) ? row.extra : {};
  columns.extra = mdAttributes ? { ...extra, mdAttributes } : (row.extra ?? undefined);
  return columns;
}

/**
 * Move one chapter into its archive, in a transaction so a row can never be
 * absent from both tables. An id already archived is left alone: its recorded
 * instant is when the platform first saw the change, and today's sweep is not a
 * better answer than that.
 */
async function archive(prisma, target, row, mdAttributes) {
  const columns = columnsOf(row, mdAttributes);
  await prisma.$transaction(async (tx) => {
    const model = target === "deleted" ? tx.deletedChapter : tx.unavailableChapter;
    await model.upsert({
      where: { mdChapterId: row.mdChapterId },
      create: { mdChapterId: row.mdChapterId, ...columns },
      update: {},
    });
    if (!options.keepUploaded) {
      await tx.uploadedChapter.deleteMany({ where: { mdChapterId: row.mdChapterId } });
    }
  });
}

// ------------------------------------------------------------------- main

async function main() {
  const prisma = new PrismaClient();
  const where = options.extension ? { extension: options.extension } : {};

  const total = await prisma.uploadedChapter.count({ where });
  const target = options.limit ? Math.min(options.limit, total) : total;
  console.log(
    `${total} chapter(s) in uploaded_chapters${options.extension ? ` for ${options.extension}` : ""}` +
      `${options.limit ? `, examining ${target}` : ""} — ${options.apply ? "APPLYING" : "dry run"}`,
  );

  const buckets = { unavailable: [], deleted: [], hidden: [], live: 0 };
  let seen = 0;
  let cursor;

  while (seen < target) {
    const take = Math.min(BATCH, target - seen);
    const rows = await prisma.uploadedChapter.findMany({
      where,
      orderBy: { id: "asc" },
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    seen += rows.length;

    const { attributes, served } = await lookupBatch(rows.map((row) => row.mdChapterId));

    for (const row of rows) {
      const attrs = attributes.get(row.mdChapterId);
      if (!attrs) {
        const confirmed = await confirmMissing(row.mdChapterId);
        if (confirmed.state === "live") buckets.live += 1;
        else buckets[confirmed.state].push({ row, attributes: confirmed.attributes });
        continue;
      }
      // In the includeUnavailable response but not the plain one: MangaDex is
      // refusing to serve it. This is the main signal — see lookupBatch.
      if (!served.has(row.mdChapterId) || attrs.isUnavailable === true) {
        buckets.unavailable.push({ row, attributes: attrs });
        continue;
      }
      buckets.live += 1;
    }

    console.log(
      `  ${seen}/${target} scanned — ${buckets.unavailable.length} unavailable, ` +
        `${buckets.deleted.length} deleted, ${buckets.hidden.length} hidden, ${buckets.live} live`,
    );
  }

  console.log("");
  console.log(`unavailable on MangaDex : ${buckets.unavailable.length}`);
  console.log(`deleted from MangaDex   : ${buckets.deleted.length}`);
  console.log(`hidden, cause unknown   : ${buckets.hidden.length} (not archived — review)`);
  console.log(`still live              : ${buckets.live}`);

  if (options.out) {
    const dump = (entries, state) =>
      entries.map(({ row }) => ({
        state,
        mdChapterId: row.mdChapterId,
        extension: row.extension,
        chapterNumber: row.chapterNumber,
        chapterLanguage: row.chapterLanguage,
        mangaName: row.mangaName,
        chapterUrl: row.chapterUrl,
      }));
    writeFileSync(
      options.out,
      JSON.stringify(
        [
          ...dump(buckets.unavailable, "unavailable"),
          ...dump(buckets.deleted, "deleted"),
          ...dump(buckets.hidden, "hidden"),
        ],
        null,
        2,
      ),
    );
    console.log(`\nclassification written to ${options.out}`);
  }

  if (!options.apply) {
    console.log("\ndry run — nothing written. Re-run with --apply to archive these.");
    await prisma.$disconnect();
    return;
  }

  let written = 0;
  for (const { row, attributes } of buckets.unavailable) {
    await archive(prisma, "unavailable", row, attributes);
    written += 1;
  }
  for (const { row } of buckets.deleted) {
    await archive(prisma, "deleted", row, null);
    written += 1;
  }
  console.log(
    `\narchived ${written} chapter(s)` +
      `${options.keepUploaded ? "" : " and removed them from uploaded_chapters"}.`,
  );
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
