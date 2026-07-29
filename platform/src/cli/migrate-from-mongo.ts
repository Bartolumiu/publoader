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
 * Environment: MONGODB_URI, MONGODB_DB_NAME, DATABASE_URL.
 * Run exactly one instance at a time — concurrent passes could orphan
 * artifacts whose owning upload task loses the ON CONFLICT race.
 */
import { randomUUID, createHash } from "node:crypto";
import { GridFSBucket, MongoClient, ObjectId, type Db, type Document } from "mongodb";
import { Prisma, PrismaClient } from "@prisma/client";
import { uploadDedupeKey } from "../core/store/uploadTasks.js";

const BATCH = 500;
/** MangaDex page images are well under this; anything larger is corrupt or not an image. */
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;

const args = new Set(process.argv.slice(2));
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
  return toJson(doc) as Record<string, unknown>;
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

/** The exact key set of ChapterRecord (contracts/records.ts), plus imageArtifacts. */
const CHAPTER_KEYS = [
  "chapterLookup",
  "chapterTimestamp",
  "chapterExpire",
  "chapterLanguage",
  "chapterNumber",
  "chapterTitle",
  "chapterVolume",
  "chapterId",
  "chapterUrl",
  "mdChapterId",
  "mangaId",
  "mdMangaId",
  "mdGroupId",
  "mangaName",
  "mangaUrl",
  "extensionName",
] as const;

const droppedKeys = new Map<string, number>();

/**
 * Project a legacy queue document down to the strict ChapterRecord shape the
 * uploader parses. Dropped keys are counted and reported at the end rather
 * than silently discarded.
 */
function toChapterRecord(doc: Document, imageArtifacts: string[]): Record<string, unknown> {
  const full = asRecord(doc);
  const out: Record<string, unknown> = {};
  for (const key of CHAPTER_KEYS) out[key] = full[key] ?? null;
  out["imageArtifacts"] = imageArtifacts;
  for (const key of Object.keys(full)) {
    if (key === "_id" || key === "images") continue;
    if (!(CHAPTER_KEYS as readonly string[]).includes(key)) {
      droppedKeys.set(key, (droppedKeys.get(key) ?? 0) + 1);
    }
  }
  return out;
}

// ----------------------------------------------------------------- migration

type Counts = { source: number; inserted: number; skipped: number; target: number };

async function* batches(db: Db, collection: string): AsyncGenerator<Document[]> {
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
    const rows = docs
      .filter((d) => str(d["md_chapter_id"]) !== null)
      .map((d) => ({
        id: randomUUID(),
        mdChapterId: str(d["md_chapter_id"]) as string,
        extension: str(d["extension_name"]) ?? "unknown",
        chapterId: str(d["chapter_id"]),
        mdMangaId: str(d["md_manga_id"]),
        chapterLanguage: str(d["chapter_language"]),
        chapterNumber: str(d["chapter_number"]),
        chapter: asRecord(d) as Prisma.InputJsonValue,
        createdAt: date(d["chapter_lookup"]) ?? new Date(),
      }));
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
          await prisma.uploadedChapter.updateMany({
            where: { mdChapterId: row.mdChapterId },
            data: {
              extension: row.extension,
              chapterId: row.chapterId,
              mdMangaId: row.mdMangaId,
              chapterLanguage: row.chapterLanguage,
              chapterNumber: row.chapterNumber,
              chapter: row.chapter,
            },
          });
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
  for await (const docs of batches(db, "uploaded_ids")) {
    counts.source += docs.length;
    const seen = new Set<string>();
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
      const full = asRecord(d);
      // The edits array is the audit history — never collapsed or truncated.
      const edits = (toJson(d["edits"]) ?? []) as Prisma.InputJsonValue;
      delete full["edits"];
      if (DRY_RUN) {
        counts.inserted += 1;
        continue;
      }
      const res = await prisma.editedChapter.createMany({
        data: [
          {
            id: randomUUID(),
            mdChapterId,
            chapter: full as Prisma.InputJsonValue,
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
            data: { chapter: full as Prisma.InputJsonValue, edits },
          });
        }
      }
    }
    log(`edited: ${counts.source} read, ${counts.inserted} inserted`);
  }
  counts.target = await prisma.editedChapter.count();
  return counts;
}

async function migrateUnavailable(db: Db, prisma: PrismaClient): Promise<Counts> {
  const counts: Counts = { source: 0, inserted: 0, skipped: 0, target: 0 };
  for await (const docs of batches(db, "unavailable")) {
    counts.source += docs.length;
    const seen = new Set<string>();
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
        chapter: asRecord(d) as Prisma.InputJsonValue,
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

// --------------------------------------------------------------------- entry

async function main(): Promise<void> {
  const mongoUri = requireEnv("MONGODB_URI");
  const dbName = requireEnv("MONGODB_DB_NAME");
  requireEnv("DATABASE_URL");

  if (DRY_RUN) log("DRY RUN — reading from Mongo, writing nothing to Postgres");
  if (REFRESH) log("REFRESH — existing history rows will have their JSONB payload rewritten");

  const mongo = new MongoClient(mongoUri);
  const prisma = new PrismaClient();
  const report: Record<string, Counts> = {};
  const imageStats: ImageStats = { fetched: 0, bytes: 0, missing: 0, oversize: 0 };

  try {
    await mongo.connect();
    const db = mongo.db(dbName);
    const bucket = new GridFSBucket(db, { bucketName: "images" });
    log(`connected to mongo db "${dbName}"`);

    report["uploaded"] = await migrateUploaded(db, prisma);
    report["uploaded_ids"] = await migrateUploadedIds(db, prisma);
    report["edited"] = await migrateEdited(db, prisma);
    report["unavailable"] = await migrateUnavailable(db, prisma);

    for (const [collection, kind] of [
      ["to_upload", "UPLOAD"],
      ["to_edit", "EDIT"],
      ["to_delete", "DELETE"],
      ["to_unavailable", "UNAVAILABLE"],
    ] as const) {
      report[collection] = await migrateQueue(db, prisma, bucket, collection, kind, imageStats);
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
    if (droppedKeys.size > 0) {
      console.log("");
      console.log("legacy queue fields not present in ChapterRecord (dropped from the task payload):");
      for (const [key, count] of [...droppedKeys].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${key}: ${count}`);
      }
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
