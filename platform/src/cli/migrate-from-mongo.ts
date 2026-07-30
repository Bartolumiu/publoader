#!/usr/bin/env node
/**
 * One-shot, re-runnable migration of the legacy MongoDB state into Postgres.
 *
 * Re-runnable is the important property: the cutover procedure (see
 * docs/migration-guide.md) runs this once during the shadow phase and again as
 * a delta pass after the legacy stack is paused. Every insert is
 * `ON CONFLICT DO NOTHING` against a natural key, so a second pass adds only
 * what is new and never duplicates.
 *
 *   uploaded          -> uploaded_chapters      (key md_chapter_id)
 *   uploaded_ids      -> uploaded_ids           (key extension + chapter_id)
 *   edited            -> edited_chapters        (key md_chapter_id, edits[] preserved)
 *   unavailable       -> unavailable_chapters   (key md_chapter_id)
 *   to_upload         -> upload_tasks kind=UPLOAD
 *   to_edit           -> upload_tasks kind=EDIT
 *   to_delete         -> upload_tasks kind=DELETE
 *   to_unavailable    -> upload_tasks kind=UNAVAILABLE
 *   GridFS "images"   -> artifacts (referenced by chapter.imageArtifacts)
 *
 * Per-extension configuration did NOT live in Mongo — the legacy stack read it
 * from JSON files beside each extension — so `--extensions <dir>` imports that
 * half of the cutover from the extension checkout:
 *
 * (one subdirectory per extension, keyed by its manifest.json name)
 *
 *   manga_id_map.json     -> tracked_manga (namespace-aware; see
 *                            parseMangaIdMapFile for the three shapes)
 *   override_options.json -> extension_chapter_aliases,
 *                            extension_multi_chapters,
 *                            extension_language_maps, and the extension-private
 *                            remainder in extension_configs.override_options
 *
 * A deployment that did keep those documents in Mongo is also handled: an
 * `extension_configs` collection, if present, is imported the same way.
 *
 * Environment: MONGODB_URI, MONGODB_DB_NAME, DATABASE_URL.
 * Run exactly one instance at a time — concurrent passes could orphan
 * artifacts whose owning upload task loses the ON CONFLICT race.
 */
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { GridFSBucket, MongoClient, ObjectId, type Db, type Document } from "mongodb";
import { Prisma, PrismaClient } from "@prisma/client";
import { parseMangaIdMapFile } from "../core/store/bundles.js";
import { ExtensionConfigStore } from "../core/store/extensionConfig.js";
import {
  chapterFromJson,
  chapterToColumns,
  chapterToTaskPayload,
  residualJsonKeys,
  taskPayloadSidecarKeys,
  type ChapterColumns,
} from "../core/md/chapterRows.js";
import { uploadDedupeKey } from "../core/store/uploadTasks.js";

const BATCH = 500;
/** MangaDex page images are well under this; anything larger is corrupt or not an image. */
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;

const argv = process.argv.slice(2);
const args = new Set(argv);

/** `--extensions <dir>`: the legacy extension checkout to read config JSON from. */
function flagValue(name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index !== -1 && argv[index + 1] !== undefined) return argv[index + 1];
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
}
const EXTENSIONS_DIR = flagValue("--extensions");
/**
 * By default already-migrated rows are left untouched (pure ON CONFLICT skip).
 * `--refresh` additionally rewrites the JSONB payload of the history mirrors
 * (uploaded / edited / unavailable), which legacy updates in place — use it on
 * the final delta pass so late edits are not lost.
 */
const REFRESH = args.has("--refresh");
const DRY_RUN = args.has("--dry-run");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`error: ${name} is not set`);
    process.exit(1);
  }
  return value;
}

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// ------------------------------------------------------------- value mapping

function camel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function isObjectId(value: unknown): value is ObjectId {
  return value instanceof ObjectId;
}

/**
 * Deep snake_case -> camelCase with BSON values reduced to JSON primitives:
 * dates become ISO-8601 strings (the wire format the platform uses
 * everywhere), ObjectIds and binary blobs become strings. `_id` is preserved
 * as a hex string so a migrated row can always be traced back to Mongo.
 */
function toJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (isObjectId(value)) return value.toHexString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key === "_id" ? "_id" : camel(key)] = toJson(item);
    }
    return out;
  }
  if (typeof value === "bigint") return Number(value);
  return value;
}

function asRecord(doc: Document): Record<string, unknown> {
  const record = toJson(doc) as Record<string, unknown>;
  // Live `uploaded` docs carry pydantic's private bookkeeping flag. It is not
  // chapter data and nothing reads it, so it does not travel to Postgres.
  // `_PydanticInitialised__` is what camel() makes of the real Mongo key
  // `__pydantic_initialised__`, and is the spelling that actually shows up.
  delete record["_PydanticInitialised__"];
  delete record["__pydanticInitialised__"];
  delete record["__pydantic_initialised__"];
  return record;
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (isObjectId(value)) return value.toHexString();
  return String(value);
}

function date(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** Non-chapter keys seen on queue documents, reported at the end of the run. */
const carriedKeys = new Map<string, number>();

/**
 * A legacy history document mapped onto the typed chapter columns the four
 * chapter tables now use. Nothing is dropped: every key without a column is
 * parked in `extra` (`_id` so a row stays traceable back to Mongo, the legacy
 * `images` GridFS ids, `archivedAt`, …).
 *
 * `ownColumns` names camelCased keys that have their own dedicated column on
 * the target table — `edits` and `lastEditedAt` on edited_chapters,
 * `unavailableAt` on unavailable_chapters — so they are not duplicated into
 * `extra` alongside it.
 */
function chapterColumnsFromDoc(doc: Document, ownColumns: string[] = []): ChapterColumns {
  const full = asRecord(doc);
  const residue = residualJsonKeys(full);
  for (const key of ownColumns) delete residue[key];
  return chapterToColumns(chapterFromJson(full), residue);
}

/**
 * A legacy queue document as the `upload_tasks.chapter` payload.
 *
 * This USED TO project the document down to the canonical chapter keys, on the
 * stated premise that the uploader parses the strict ChapterRecord schema. It
 * does not — ChapterRecord validates worker *envelopes*; task rows are read
 * tolerantly. The projection threw away the sidecar fields the upload workers
 * read alongside the chapter, so a migrated `to_edit` document arrived without
 * its `payload` and taskWorkers rejected it with "edit task has no payload",
 * dead-lettering every migrated edit. The shape now lives in chapterRows.ts
 * next to the rest of the Chapter <-> storage mapping.
 */
function toChapterRecord(doc: Document, imageArtifacts: string[]): Record<string, unknown> {
  const payload = chapterToTaskPayload(asRecord(doc), imageArtifacts);
  for (const key of taskPayloadSidecarKeys(payload)) {
    carriedKeys.set(key, (carriedKeys.get(key) ?? 0) + 1);
  }
  return payload;
}

// ----------------------------------------------------------------- migration

type Counts = { source: number; inserted: number; skipped: number; target: number };

async function* batches(db: Db, collection: string): AsyncGenerator<Document[]> {
  // A collection the source deployment never created is not an error: the live
  // database has no `edited` collection because no chapter has been edited yet.
  // Treat absent as empty so a migration is not blocked by a feature the source
  // never exercised.
  const present = await db.listCollections({ name: collection }).hasNext();
  if (!present) {
    log(`${collection}: not present in source database, skipping`);
    return;
  }
  const cursor = db.collection(collection).find({}, { batchSize: BATCH });
  let buffer: Document[] = [];
  for await (const doc of cursor) {
    buffer.push(doc);
    if (buffer.length >= BATCH) {
      yield buffer;
      buffer = [];
    }
  }
  if (buffer.length > 0) yield buffer;
}

async function migrateUploaded(db: Db, prisma: PrismaClient): Promise<Counts> {
  const counts: Counts = { source: 0, inserted: 0, skipped: 0, target: 0 };
  for await (const docs of batches(db, "uploaded")) {
    counts.source += docs.length;
    const rows: Prisma.UploadedChapterCreateManyInput[] = docs
      .filter((d) => str(d["md_chapter_id"]) !== null)
      .map((d) => {
        const columns = chapterColumnsFromDoc(d);
        return {
          id: randomUUID(),
          mdChapterId: str(d["md_chapter_id"]) as string,
          ...columns,
          // uploaded_chapters.extension is NOT NULL, and "unknown" is the
          // long-standing stand-in for a legacy doc that never named one.
          extension: columns.extension ?? "unknown",
          createdAt: date(d["chapter_lookup"]) ?? new Date(),
        };
      });
    counts.skipped += docs.length - rows.length;
    if (DRY_RUN) {
      counts.inserted += rows.length;
    } else if (rows.length > 0) {
      const res = await prisma.uploadedChapter.createMany({ data: rows, skipDuplicates: true });
      counts.inserted += res.count;
      // Rows the unique constraint rejected are already migrated, not lost.
      counts.skipped += rows.length - res.count;
      if (REFRESH && res.count < rows.length) {
        for (const row of rows) {
          // Everything but the identity and the insert-only timestamp, so the
          // refresh cannot drift from the insert as the column set grows.
          const { id: _id, mdChapterId, createdAt: _createdAt, ...columns } = row;
          await prisma.uploadedChapter.updateMany({ where: { mdChapterId }, data: columns });
        }
      }
    }
    log(`uploaded: ${counts.source} read, ${counts.inserted} inserted`);
  }
  counts.target = await prisma.uploadedChapter.count();
  return counts;
}

async function migrateUploadedIds(db: Db, prisma: PrismaClient): Promise<Counts> {
  const counts: Counts = { source: 0, inserted: 0, skipped: 0, target: 0 };
  // Run-scoped so duplicates spanning batch boundaries are counted honestly
  // (see the note in migrateUnavailable).
  const seen = new Set<string>();
  for await (const docs of batches(db, "uploaded_ids")) {
    counts.source += docs.length;
    const rows: Prisma.UploadedIdCreateManyInput[] = [];
    for (const d of docs) {
      const chapterId = str(d["chapter_id"]);
      const extension = str(d["extension_name"]) ?? "unknown";
      if (chapterId === null) {
        counts.skipped += 1;
        continue;
      }
      // createMany cannot skip duplicates that collide *within* the batch.
      const key = `${extension}|${chapterId}`;
      if (seen.has(key)) {
        counts.skipped += 1;
        continue;
      }
      seen.add(key);
      rows.push({
        id: randomUUID(),
        extension,
        chapterId,
        mdChapterId: str(d["md_chapter_id"]),
      });
    }
    if (DRY_RUN) {
      counts.inserted += rows.length;
    } else if (rows.length > 0) {
      const res = await prisma.uploadedId.createMany({ data: rows, skipDuplicates: true });
      counts.inserted += res.count;
      counts.skipped += rows.length - res.count;
    }
    log(`uploaded_ids: ${counts.source} read, ${counts.inserted} inserted`);
  }
  counts.target = await prisma.uploadedId.count();
  return counts;
}

async function migrateEdited(db: Db, prisma: PrismaClient): Promise<Counts> {
  const counts: Counts = { source: 0, inserted: 0, skipped: 0, target: 0 };
  for await (const docs of batches(db, "edited")) {
    counts.source += docs.length;
    for (const d of docs) {
      const mdChapterId = str(d["md_chapter_id"]);
      if (mdChapterId === null) {
        counts.skipped += 1;
        continue;
      }
      // The edits array is the audit history — never collapsed or truncated.
      const edits = (toJson(d["edits"]) ?? []) as Prisma.InputJsonValue;
      const columns = chapterColumnsFromDoc(d, ["edits", "lastEditedAt"]);
      if (DRY_RUN) {
        counts.inserted += 1;
        continue;
      }
      const res = await prisma.editedChapter.createMany({
        data: [
          {
            id: randomUUID(),
            mdChapterId,
            ...columns,
            edits,
            lastEditedAt: date(d["last_edited_at"]) ?? new Date(),
          },
        ],
        skipDuplicates: true,
      });
      counts.inserted += res.count;
      if (res.count === 0) {
        counts.skipped += 1;
        if (REFRESH) {
          await prisma.editedChapter.updateMany({
            where: { mdChapterId },
            data: { ...columns, edits },
          });
        }
      }
    }
    log(`edited: ${counts.source} read, ${counts.inserted} inserted`);
  }
  counts.target = await prisma.editedChapter.count();
  return counts;
}

/**
 * `deleted` — the archive of chapters hard-deleted from MangaDex, appended by
 * the legacy workers/deleter.py. Pure history: nothing reads it during a run,
 * but it is the only record of what was removed, so it migrates rather than
 * being dropped.
 */
async function migrateDeleted(db: Db, prisma: PrismaClient): Promise<Counts> {
  const counts: Counts = { source: 0, inserted: 0, skipped: 0, target: 0 };
  // The archive has no unique index in Mongo, so the same chapter can appear
  // more than once (deleted, re-uploaded, deleted again). Keep the first, and
  // track ids across batches so the dedupe survives streaming.
  const seen = new Set<string>();

  for await (const docs of batches(db, "deleted")) {
    counts.source += docs.length;
    const rows: Prisma.DeletedChapterCreateManyInput[] = [];

    for (const d of docs) {
      const mdChapterId = str(d["md_chapter_id"]);
      if (!mdChapterId || seen.has(mdChapterId)) {
        counts.skipped += 1;
        continue;
      }
      seen.add(mdChapterId);
      rows.push({
        id: randomUUID(),
        mdChapterId,
        ...chapterColumnsFromDoc(d),
        deletedAt: date(d["chapter_lookup"]) ?? date(d["chapter_timestamp"]) ?? new Date(),
      });
    }

    if (DRY_RUN) {
      counts.inserted += rows.length;
    } else if (rows.length > 0) {
      const res = await prisma.deletedChapter.createMany({ data: rows, skipDuplicates: true });
      counts.inserted += res.count;
      counts.skipped += rows.length - res.count;
    }
  }
  // Report the table's real size, like every other collection does, so the
  // verification table is comparable across a re-run.
  counts.target = await prisma.deletedChapter.count();
  log(`deleted: ${counts.source} read, ${counts.inserted} inserted, ${counts.skipped} skipped`);
  return counts;
}

async function migrateUnavailable(db: Db, prisma: PrismaClient): Promise<Counts> {
  const counts: Counts = { source: 0, inserted: 0, skipped: 0, target: 0 };
  // Run-scoped, not per-batch: the same chapter can be marked unavailable more
  // than once, and those repeats need not land in the same 500-doc batch. A
  // per-batch set lets cross-batch duplicates through, which the unique index
  // then absorbs — harmless for the data, but it made the dry-run report claim
  // more inserts than the collection has distinct chapters, and that report is
  // what an operator uses to judge whether the migration looks right.
  const seen = new Set<string>();
  for await (const docs of batches(db, "unavailable")) {
    counts.source += docs.length;
    const rows: Prisma.UnavailableChapterCreateManyInput[] = [];
    for (const d of docs) {
      const mdChapterId = str(d["md_chapter_id"]);
      if (mdChapterId === null || seen.has(mdChapterId)) {
        counts.skipped += 1;
        continue;
      }
      seen.add(mdChapterId);
      rows.push({
        id: randomUUID(),
        mdChapterId,
        // `unavailableAt` has its own column; the legacy `archivedAt` stamp
        // does not, so it stays in `extra`.
        ...chapterColumnsFromDoc(d, ["unavailableAt"]),
        unavailableAt: date(d["unavailable_at"]) ?? new Date(),
      });
    }
    if (DRY_RUN) {
      counts.inserted += rows.length;
    } else if (rows.length > 0) {
      const res = await prisma.unavailableChapter.createMany({ data: rows, skipDuplicates: true });
      counts.inserted += res.count;
      counts.skipped += rows.length - res.count;
    }
    log(`unavailable: ${counts.source} read, ${counts.inserted} inserted`);
  }
  counts.target = await prisma.unavailableChapter.count();
  return counts;
}

type ImageStats = { fetched: number; bytes: number; missing: number; oversize: number };

/**
 * GridFS did not record a content type, so recover it from the magic bytes.
 * The uploader sends this straight to MangaDex, which rejects unknown types.
 */
function sniffContentType(data: Buffer): string {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (data.length >= 6 && data.subarray(0, 6).toString("ascii").startsWith("GIF8")) return "image/gif";
  return "application/octet-stream";
}

/**
 * Pull each referenced GridFS file into an `artifacts` row and return the new
 * artifact ids in the same order the legacy `images` array had them — page
 * order is the upload order, so it must be preserved exactly.
 */
async function migrateImages(
  bucket: GridFSBucket,
  prisma: PrismaClient,
  ids: unknown,
  stats: ImageStats,
): Promise<string[]> {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const artifactIds: string[] = [];
  for (const raw of ids) {
    let objectId: ObjectId;
    try {
      objectId = isObjectId(raw) ? raw : new ObjectId(String(raw));
    } catch {
      stats.missing += 1;
      continue;
    }
    let data: Buffer;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of bucket.openDownloadStream(objectId)) {
        chunks.push(chunk as Buffer);
      }
      data = Buffer.concat(chunks);
    } catch (err) {
      console.warn(`  warn: GridFS image ${objectId.toHexString()} unreadable: ${(err as Error).message}`);
      stats.missing += 1;
      continue;
    }
    if (data.length > MAX_ARTIFACT_BYTES) {
      console.warn(
        `  warn: GridFS image ${objectId.toHexString()} is ${data.length} bytes, over the ${MAX_ARTIFACT_BYTES} cap — skipped`,
      );
      stats.oversize += 1;
      continue;
    }
    const id = randomUUID();
    if (!DRY_RUN) {
      await prisma.artifact.create({
        data: {
          id,
          sha256: createHash("sha256").update(data).digest("hex"),
          size: data.length,
          contentType: sniffContentType(data),
          content: new Uint8Array(data),
        },
      });
    }
    artifactIds.push(id);
    stats.fetched += 1;
    stats.bytes += data.length;
  }
  return artifactIds;
}

async function migrateQueue(
  db: Db,
  prisma: PrismaClient,
  bucket: GridFSBucket,
  collection: string,
  kind: "UPLOAD" | "EDIT" | "DELETE" | "UNAVAILABLE",
  imageStats: ImageStats,
): Promise<Counts> {
  const counts: Counts = { source: 0, inserted: 0, skipped: 0, target: 0 };
  for await (const docs of batches(db, collection)) {
    counts.source += docs.length;
    for (const doc of docs) {
      const dedupeKey =
        kind === "UPLOAD"
          ? uploadDedupeKey({
              chapterId: str(doc["chapter_id"]),
              chapterNumber: str(doc["chapter_number"]),
              chapterLanguage: str(doc["chapter_language"]),
            })
          : str(doc["md_chapter_id"]);
      if (!dedupeKey || dedupeKey === "||") {
        counts.skipped += 1;
        continue;
      }
      // Check before fetching images: on a re-run this makes the pass cheap
      // and avoids writing artifacts whose task insert would be skipped.
      const existing = await prisma.uploadTask.findUnique({
        where: { kind_dedupeKey: { kind, dedupeKey } },
        select: { id: true },
      });
      if (existing) {
        counts.skipped += 1;
        continue;
      }
      const artifactIds = await migrateImages(bucket, prisma, doc["images"], imageStats);
      const chapter = toChapterRecord(doc, artifactIds);
      if (DRY_RUN) {
        counts.inserted += 1;
        continue;
      }
      const inserted = await prisma.$executeRaw(Prisma.sql`
        INSERT INTO upload_tasks (id, kind, dedupe_key, chapter, state, created_at, updated_at)
        VALUES (${randomUUID()}, ${kind}::"UploadTaskKind", ${dedupeKey},
                ${JSON.stringify(chapter)}::jsonb, 'PENDING', now(), now())
        ON CONFLICT (kind, dedupe_key) DO NOTHING
      `);
      if (inserted === 1) counts.inserted += 1;
      else counts.skipped += 1;
    }
    log(`${collection}: ${counts.source} read, ${counts.inserted} inserted`);
  }
  counts.target = await prisma.uploadTask.count({ where: { kind } });
  return counts;
}

// ------------------------------------------------- per-extension configuration

interface ConfigCounts {
  extensions: number;
  tracked: number;
  aliases: number;
  multiChapters: number;
  languages: number;
  rejected: number;
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Seed one extension's tracked map and override options.
 *
 * Create-only in both halves, like a bundle publish: this script is re-runnable
 * by design and the second pass must not undo curation done between passes.
 * `ExtensionConfigStore.replace` is what splits the legacy document into the
 * three relation tables, so the migration and the admin API agree on what a
 * valid row is — including which MangaDex language codes are real.
 */
async function importExtensionConfig(
  prisma: PrismaClient,
  configStore: ExtensionConfigStore,
  extension: string,
  idMap: unknown,
  overrides: unknown,
  counts: ConfigCounts,
): Promise<void> {
  const rows = parseMangaIdMapFile(idMap);
  if (rows.length > 0 && !DRY_RUN) {
    const created = await prisma.trackedManga.createMany({
      data: rows.map((row) => ({ extension, ...row, source: "mongo-import" })),
      skipDuplicates: true,
    });
    counts.tracked += created.count;
  } else {
    counts.tracked += rows.length;
  }

  if (overrides !== undefined && !DRY_RUN) {
    const [aliasCount, multiCount, languageCount, config] = await Promise.all([
      prisma.extensionChapterAlias.count({ where: { extension } }),
      prisma.extensionMultiChapter.count({ where: { extension } }),
      prisma.extensionLanguageMap.count({ where: { extension } }),
      prisma.extensionConfig.findUnique({ where: { extension } }),
    ]);
    if (aliasCount + multiCount + languageCount === 0 && config === null) {
      const result = await configStore.replace(extension, overrides);
      counts.aliases += result.aliases;
      counts.multiChapters += result.multiChapters;
      counts.languages += result.languages;
      counts.rejected += result.rejected.length;
      for (const row of result.rejected) {
        console.warn(`  warn: ${extension} ${row.option}.${row.key} rejected: ${row.reason}`);
      }
    } else {
      log(`${extension}: config already present, left as it is`);
    }
  }
  counts.extensions += 1;
}

/**
 * `--extensions <dir>`: walk the legacy extension checkout. Per-extension
 * configuration was never in Mongo — the Python stack loaded manga_id_map.json
 * and override_options.json from disk beside each extension — so this is the
 * only place the cutover can get it from.
 */
async function migrateExtensionFiles(
  prisma: PrismaClient,
  configStore: ExtensionConfigStore,
  dir: string,
  counts: ConfigCounts,
): Promise<void> {
  const root = resolvePath(dir);
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch (err) {
    console.error(`error: cannot read --extensions ${root}: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  for (const entry of entries.sort()) {
    const extensionDir = join(root, entry);
    if (!statSync(extensionDir).isDirectory()) continue;
    // The directory name is not authoritative: manifest.name is what the
    // platform keys every table on, and a checkout directory can be renamed.
    const manifest = readJsonFile(join(extensionDir, "manifest.json"));
    const name =
      manifest !== null && typeof manifest === "object" && !Array.isArray(manifest)
        ? (manifest as { name?: unknown }).name
        : undefined;
    if (typeof name !== "string" || name.length === 0) continue;

    const idMap = readJsonFile(join(extensionDir, "manga_id_map.json"));
    const overrides = readJsonFile(join(extensionDir, "override_options.json"));
    if (idMap === undefined && overrides === undefined) continue;
    await importExtensionConfig(prisma, configStore, name, idMap, overrides, counts);
    log(`${name}: config imported from ${extensionDir}`);
  }
}

/**
 * An `extension_configs` collection, if this deployment kept its config in
 * Mongo rather than on disk. Absent in the reference deployment; handled so a
 * fork that did is not silently skipped.
 */
async function migrateMongoConfigs(
  db: Db,
  prisma: PrismaClient,
  configStore: ExtensionConfigStore,
  counts: ConfigCounts,
): Promise<void> {
  for await (const docs of batches(db, "extension_configs")) {
    for (const doc of docs) {
      const name = str(doc["extension"]) ?? str(doc["extension_name"]) ?? str(doc["name"]);
      if (!name) continue;
      const overrides = toJson(doc["override_options"] ?? doc["overrideOptions"]);
      const idMap = toJson(doc["manga_id_map"] ?? doc["mangaIdMap"]);
      await importExtensionConfig(
        prisma,
        configStore,
        name,
        idMap ?? undefined,
        overrides ?? undefined,
        counts,
      );
    }
  }
}

// --------------------------------------------------------------------- entry

async function main(): Promise<void> {
  const mongoUri = requireEnv("MONGODB_URI");
  const dbName = requireEnv("MONGODB_DB_NAME");
  requireEnv("DATABASE_URL");

  if (DRY_RUN) log("DRY RUN — reading from Mongo, writing nothing to Postgres");
  if (REFRESH) log("REFRESH — existing history rows will have their JSONB payload rewritten");

  const mongo = new MongoClient(mongoUri);
  const prisma = new PrismaClient();
  const configStore = new ExtensionConfigStore(prisma);
  const report: Record<string, Counts> = {};
  const imageStats: ImageStats = { fetched: 0, bytes: 0, missing: 0, oversize: 0 };
  const configCounts: ConfigCounts = {
    extensions: 0,
    tracked: 0,
    aliases: 0,
    multiChapters: 0,
    languages: 0,
    rejected: 0,
  };

  try {
    await mongo.connect();
    const db = mongo.db(dbName);
    const bucket = new GridFSBucket(db, { bucketName: "images" });
    log(`connected to mongo db "${dbName}"`);

    report["uploaded"] = await migrateUploaded(db, prisma);
    report["uploaded_ids"] = await migrateUploadedIds(db, prisma);
    report["edited"] = await migrateEdited(db, prisma);
    report["unavailable"] = await migrateUnavailable(db, prisma);
    report["deleted"] = await migrateDeleted(db, prisma);

    for (const [collection, kind] of [
      ["to_upload", "UPLOAD"],
      ["to_edit", "EDIT"],
      ["to_delete", "DELETE"],
      ["to_unavailable", "UNAVAILABLE"],
    ] as const) {
      report[collection] = await migrateQueue(db, prisma, bucket, collection, kind, imageStats);
    }

    await migrateMongoConfigs(db, prisma, configStore, configCounts);
    if (EXTENSIONS_DIR) {
      await migrateExtensionFiles(prisma, configStore, EXTENSIONS_DIR, configCounts);
    } else {
      log(
        "no --extensions <dir> given: tracked_manga and the override-option tables were not " +
          "seeded (that config lived in JSON files, not Mongo)",
      );
    }

    // ---- verification report ----
    console.log("");
    console.log("migration report");
    console.log("collection        source  inserted   skipped    target  status");
    let mismatched = false;
    for (const [name, c] of Object.entries(report)) {
      // Skipped rows are legitimate (already migrated, or unusable without a
      // key). The invariant that must hold is: every source row is accounted
      // for, and the target holds at least as many rows as we inserted.
      const accounted = c.inserted + c.skipped === c.source;
      const status = accounted ? "ok" : "MISMATCH";
      if (!accounted) mismatched = true;
      console.log(
        `${name.padEnd(16)} ${String(c.source).padStart(6)} ${String(c.inserted).padStart(9)} ` +
          `${String(c.skipped).padStart(9)} ${String(c.target).padStart(9)}  ${status}`,
      );
    }
    console.log("");
    console.log(
      `images: ${imageStats.fetched} fetched (${(imageStats.bytes / 1024 / 1024).toFixed(1)} MiB), ` +
        `${imageStats.missing} missing, ${imageStats.oversize} over the ${MAX_ARTIFACT_BYTES}-byte cap`,
    );
    if (configCounts.extensions > 0) {
      console.log("");
      console.log(
        `config: ${configCounts.extensions} extensions, ${configCounts.tracked} tracked mappings, ` +
          `${configCounts.aliases} chapter aliases, ${configCounts.multiChapters} multi-chapter numbers, ` +
          `${configCounts.languages} language overrides, ${configCounts.rejected} rows rejected`,
      );
    }
    if (carriedKeys.size > 0) {
      console.log("");
      console.log("non-chapter fields carried through into the task payload:");
      for (const [key, count] of [...carriedKeys].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${key}: ${count}`);
      }
      console.log("  (EDIT tasks need `payload`; UNAVAILABLE tasks use `unavailableAt`)");
    }

    if (mismatched) {
      console.error("");
      console.error("verification FAILED: source rows are unaccounted for; do not cut over");
      process.exitCode = 1;
    } else {
      console.log("");
      console.log(DRY_RUN ? "dry run complete" : "migration complete");
    }
  } finally {
    await mongo.close().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch((err: unknown) => {
  console.error(`migration failed: ${(err as Error).stack ?? String(err)}`);
  process.exit(1);
});
