import type { Prisma, PrismaClient, UploadTask } from "@prisma/client";
import type { Config } from "../../config.js";
import type { Logger } from "../../logging.js";
import { metrics } from "../../metrics.js";
import { generateChapterCard } from "./card.js";
import { chapterFromJson, chapterToColumns, uploadedChapterColumns } from "./chapterRows.js";
import type { MdChapterDetail, MdExtendedApi } from "./client.js";
import type { DiscordEmbedInput, DiscordNotifier } from "./webhook.js";
import { queueEmbed, queueFinishedEmbed, queueSummaryEmbed } from "./webhookEmbeds.js";
import type { Chapter } from "./types.js";

/**
 * Execution of a single claimed UploadTask — the TypeScript port of
 * publoader/workers/{uploader,editor,deleter,unavailable}.py.
 *
 * The Python workers deleted their queue row on success and left it in place on
 * failure. Here the caller owns the task lifecycle: `execute` either returns
 * (task is DONE) or throws (task goes back to UploadTaskStore.fail, which
 * handles backoff and dead-lettering). Nothing in here retries the task itself.
 *
 * The upload path is the one that must survive a crash mid-flight, so it is
 * bracketed by UploadLog rows: a `committing` marker before the session opens
 * and a `committed` row carrying the MangaDex chapter id after. A retry that
 * finds a prior `committed` row verifies the chapter still exists on MangaDex
 * before skipping — a recorded id that MangaDex never indexed must re-upload,
 * not silently vanish.
 */

const IMAGE_BATCH_SIZE = 10;
const MD_CHAPTER_URL = "https://mangadex.org/chapter/";
const MD_MANGA_URL = "https://mangadex.org/manga/";

/** Failure that should send the task back to the queue with its message intact. */
export class TaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskError";
  }
}

export interface TaskWorkerDeps {
  prisma: PrismaClient;
  md: MdExtendedApi;
  notifier: DiscordNotifier;
  config: Config;
  log: Logger;
}

export class UploadTaskWorkers {
  private pending: DiscordEmbedInput[] = [];

  constructor(private readonly deps: TaskWorkerDeps) {}

  /** Run one claimed task. Throws on failure; the caller requeues. */
  async execute(task: UploadTask): Promise<void> {
    const log = this.deps.log.child({
      taskId: task.id,
      kind: task.kind,
      dedupeKey: task.dedupeKey,
    });
    const raw = asRecord(task.chapter) ?? {};
    const chapter = chapterFromJson(raw);

    switch (task.kind) {
      case "UPLOAD":
        return this.runUpload(task, chapter, log);
      case "EDIT":
        return this.runEdit(chapter, raw, log);
      case "DELETE":
        return this.runDelete(chapter, log);
      case "UNAVAILABLE":
        return this.runUnavailable(chapter, raw, log);
      default:
        throw new TaskError(`unknown upload task kind ${String(task.kind)}`);
    }
  }

  /** Post everything queued since the last flush. Never throws. */
  async flushNotifications(): Promise<void> {
    if (this.pending.length === 0) return;
    const embeds = this.pending;
    this.pending = [];
    await this.deps.notifier.send(embeds);
  }

  /**
   * The end-of-drain messages the Python queue workers sent.
   *
   * `processed` counts per kind rather than per worker thread, which is the
   * closest this architecture has: Python named the embed after the thread, and
   * here one uploader drains typed queues, so the kind IS the queue.
   *
   * Nothing is sent when nothing was processed — Python only spoke when it had
   * done something, and a per-tick "finished 0 items" would be constant noise.
   */
  async flushQueueSummary(counts: Map<string, { processed: number; failed: number }>): Promise<void> {
    if (!this.deps.notifier.enabled) return;
    const embeds: DiscordEmbedInput[] = [];
    for (const [kind, count] of counts) {
      if (count.processed === 0 && count.failed === 0) continue;
      // UNAVAILABLE was summary-only in Python: a per-chapter embed for a bulk
      // "mark these unavailable" pass is hundreds of messages nobody reads.
      if (kind === "UNAVAILABLE") {
        embeds.push(queueSummaryEmbed(kind, count.processed, count.failed));
      }
      embeds.push(queueFinishedEmbed(kind));
    }
    if (embeds.length > 0) await this.deps.notifier.send(embeds);
  }

  // -------------------------------------------------------------- UPLOAD

  private async runUpload(task: UploadTask, chapter: Chapter, log: Logger): Promise<void> {
    const { prisma, md } = this.deps;
    const mdMangaId = chapter.mdMangaId;
    const mdGroupId = chapter.mdGroupId;
    if (!mdMangaId) throw new TaskError("upload task has no mdMangaId");
    if (!mdGroupId) throw new TaskError("upload task has no mdGroupId");

    const prior = await prisma.uploadLog.findFirst({
      where: { dedupeKey: task.dedupeKey, outcome: "COMMITTED", NOT: { mdChapterId: null } },
      orderBy: { createdAt: "desc" },
    });
    if (prior?.mdChapterId) {
      const found = await md.chaptersByIds([prior.mdChapterId]);
      if (found.some((entry) => entry.id === prior.mdChapterId)) {
        log.info({ mdChapterId: prior.mdChapterId }, "chapter already committed, skipping upload");
        await this.recordUploadedChapter(chapter, prior.mdChapterId);
        await this.deleteArtifacts(chapter.imageArtifacts);
        metrics.uploadsTotal.inc({ outcome: "upload_already_committed" });
        this.queue("Upload", chapter, prior.mdChapterId, true, "Already on MangaDex.");
        return;
      }
      log.warn(
        { mdChapterId: prior.mdChapterId },
        "prior commit is not on MangaDex, re-uploading chapter",
      );
    }

    await prisma.uploadLog.create({ data: { dedupeKey: task.dedupeKey, outcome: "COMMITTING" } });

    // MangaDex allows one open upload session per account.
    const existingSession = await md.currentUploadSession();
    if (existingSession) {
      log.debug({ sessionId: existingSession.id }, "removing stale upload session");
      await md.deleteUploadSession(existingSession.id);
    }

    const session = await md.createUploadSession(mdMangaId, [mdGroupId]);
    log.info({ sessionId: session.id, images: chapter.imageArtifacts.length }, "upload session opened");

    let mdChapterId: string | null = null;
    try {
      const files = await this.loadImages(chapter.imageArtifacts);
      const { pageOrder, failed } = await this.uploadPages(session.id, files, log);
      if (failed) {
        // uploader.py still commits when pages fail: the chapter lands as an
        // external-only entry rather than being lost entirely.
        log.error({ sessionId: session.id }, "some pages failed to upload, committing without pages");
      }
      const committed = await md.commitUploadSession(
        session.id,
        {
          volume: chapter.chapterVolume,
          chapter: chapter.chapterNumber,
          title: chapter.chapterTitle,
          translatedLanguage: chapter.chapterLanguage ?? "",
          externalUrl: chapter.chapterUrl,
        },
        failed ? [] : pageOrder,
      );
      mdChapterId = committed?.id ?? null;
    } catch (err) {
      const message = errorMessage(err);
      await this.safeDeleteSession(session.id, log);
      await prisma.uploadLog.create({
        data: { dedupeKey: task.dedupeKey, outcome: "FAILED", detail: message.slice(0, 4000) },
      });
      metrics.uploadsTotal.inc({ outcome: "upload_failed" });
      this.queue("Upload", chapter, null, false, message);
      throw err;
    }

    await prisma.uploadLog.create({
      data: { dedupeKey: task.dedupeKey, mdChapterId, outcome: "COMMITTED" },
    });
    if (mdChapterId) await this.recordUploadedChapter(chapter, mdChapterId);
    await this.deleteArtifacts(chapter.imageArtifacts);

    metrics.uploadsTotal.inc({ outcome: "upload_committed" });
    log.info({ mdChapterId }, "chapter committed to MangaDex");
    this.queue("Upload", chapter, mdChapterId, true);
  }

  /** Read page bytes back out of the artifact store, in chapter page order. */
  private async loadImages(artifactIds: string[]): Promise<{ name: string; data: Buffer }[]> {
    if (artifactIds.length === 0) return [];
    const rows = await this.deps.prisma.artifact.findMany({ where: { id: { in: artifactIds } } });
    const byId = new Map(rows.map((row) => [row.id, row]));

    return artifactIds.map((id, index) => {
      const row = byId.get(id);
      if (!row) throw new TaskError(`artifact ${id} referenced by the chapter is missing`);
      // MangaDex echoes the filename back as originalFileName, and page order is
      // rebuilt from it — so the name must be the page's index and nothing else.
      return { name: String(index), data: Buffer.from(row.content) };
    });
  }

  /**
   * Port of `_upload_images`: batches of 10, each retried up to
   * `config.uploadRetry` times, and a partial success narrows the next attempt
   * to just the files MangaDex didn't acknowledge.
   */
  private async uploadPages(
    sessionId: string,
    files: { name: string; data: Buffer }[],
    log: Logger,
  ): Promise<{ pageOrder: string[]; failed: boolean }> {
    const uploadedByIndex = new Map<number, string>();
    let failed = false;

    for (const batch of chunk(files, IMAGE_BATCH_SIZE)) {
      let remaining = batch;
      let batchFailed = true;

      for (let attempt = 1; attempt <= this.deps.config.uploadRetry; attempt++) {
        let results: { id: string; originalFileName: string }[];
        try {
          results = await this.deps.md.uploadImages(sessionId, remaining);
        } catch (err) {
          log.warn({ err, attempt, pages: remaining.map((f) => f.name) }, "page batch upload failed");
          continue;
        }
        if (results.length === 0) {
          log.warn({ attempt }, "page batch upload returned no data");
          continue;
        }

        for (const image of results) {
          const index = Number(image.originalFileName);
          if (Number.isInteger(index)) uploadedByIndex.set(index, image.id);
        }
        if (results.length === remaining.length) {
          batchFailed = false;
          break;
        }

        const acknowledged = new Set(results.map((image) => image.originalFileName));
        remaining = remaining.filter((file) => !acknowledged.has(file.name));
        log.warn({ pages: remaining.map((f) => f.name) }, "some pages didn't upload, retrying");
      }

      if (batchFailed) {
        failed = true;
        break;
      }
    }

    const pageOrder = [...uploadedByIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, id]) => id);
    return { pageOrder, failed };
  }

  // ---------------------------------------------------------------- EDIT

  private async runEdit(
    chapter: Chapter,
    raw: Record<string, unknown>,
    log: Logger,
  ): Promise<void> {
    const { md } = this.deps;
    const mdChapterId = chapter.mdChapterId;
    if (!mdChapterId) throw new TaskError("edit task has no mdChapterId");

    const payload = asRecord(raw.payload);
    if (!payload || Object.keys(payload).length === 0) {
      throw new TaskError("edit task has no payload");
    }
    const oldInfo = asRecord(raw.oldInfo);

    const [current] = await md.chaptersByIds([mdChapterId]);
    if (!current) throw new TaskError(`chapter ${mdChapterId} not found on MangaDex`);

    // ChapterEdit requires the whole body, not just the changed keys, so start
    // from what MangaDex currently holds and lay the payload over it.
    const groups = current.relationships
      .filter((rel) => rel.type === "scanlation_group")
      .map((rel) => rel.id);
    const body: Record<string, unknown> = {
      volume: current.attributes.volume,
      chapter: current.attributes.chapter,
      title: current.attributes.title,
      translatedLanguage: current.attributes.translatedLanguage,
      groups,
      ...payload,
      version: current.attributes.version,
    };

    try {
      const edited = await md.editChapter(mdChapterId, body);
      if (!edited) throw new TaskError(`MangaDex rejected the edit for ${mdChapterId}`);
    } catch (err) {
      metrics.uploadsTotal.inc({ outcome: "edit_failed" });
      this.queue("Edit", chapter, mdChapterId, false, errorMessage(err));
      throw err;
    }

    await this.appendEdit(mdChapterId, chapter, oldInfo, payload);
    await this.recordUploadedChapter(chapter, mdChapterId);

    metrics.uploadsTotal.inc({ outcome: "edit_ok" });
    log.info({ mdChapterId, fields: Object.keys(payload) }, "chapter edited");
    this.queue("Edit", chapter, mdChapterId, true);
  }

  private async appendEdit(
    mdChapterId: string,
    chapter: Chapter,
    oldInfo: Record<string, unknown> | null,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const { prisma } = this.deps;
    const existing = await prisma.editedChapter.findUnique({ where: { mdChapterId } });
    const previous = existing?.edits;
    const edits = (Array.isArray(previous) ? [...previous] : []) as Prisma.InputJsonValue[];
    edits.push({
      editedAt: new Date().toISOString(),
      old: oldInfo ?? null,
      new: payload,
    } as unknown as Prisma.InputJsonValue);

    const columns = chapterToColumns({ ...chapter, mdChapterId });
    await prisma.editedChapter.upsert({
      where: { mdChapterId },
      create: { mdChapterId, ...columns, edits },
      update: { ...columns, edits, lastEditedAt: new Date() },
    });
  }

  // -------------------------------------------------------------- DELETE

  private async runDelete(chapter: Chapter, log: Logger): Promise<void> {
    const mdChapterId = chapter.mdChapterId;
    if (!mdChapterId) throw new TaskError("delete task has no mdChapterId");

    let deleted: boolean;
    try {
      deleted = await this.deps.md.deleteChapter(mdChapterId);
    } catch (err) {
      metrics.uploadsTotal.inc({ outcome: "delete_failed" });
      this.queue("Delete", chapter, mdChapterId, false, errorMessage(err));
      throw err;
    }
    if (!deleted) {
      metrics.uploadsTotal.inc({ outcome: "delete_failed" });
      const message = `MangaDex refused to delete chapter ${mdChapterId}`;
      this.queue("Delete", chapter, mdChapterId, false, message);
      throw new TaskError(message);
    }

    // Archive first, then drop the live row — deletion is irreversible, so the
    // record of what was removed outlives it (legacy deleter.py appended to the
    // `deleted` collection for exactly this reason).
    const columns = chapterToColumns({ ...chapter, mdChapterId });
    await this.deps.prisma.deletedChapter.upsert({
      where: { mdChapterId },
      create: { mdChapterId, ...columns },
      update: { ...columns, deletedAt: new Date() },
    });
    await this.deps.prisma.uploadedChapter.deleteMany({ where: { mdChapterId } });
    metrics.uploadsTotal.inc({ outcome: "delete_ok" });
    log.info({ mdChapterId }, "chapter deleted from MangaDex and archived");
    this.queue("Delete", chapter, mdChapterId, true);
  }

  // --------------------------------------------------------- UNAVAILABLE

  /**
   * Replace a taken-down external chapter with an info card, mirroring
   * unavailable.py: fetch the chapter, render the card, open an *edit* upload
   * session for that chapter, attach the card as its only page, then repoint the
   * publisher link away from the dead URL via PUT /chapter.
   */
  private async runUnavailable(
    chapter: Chapter,
    raw: Record<string, unknown>,
    log: Logger,
  ): Promise<void> {
    const { md } = this.deps;
    const mdChapterId = chapter.mdChapterId;
    if (!mdChapterId) throw new TaskError("unavailable task has no mdChapterId");

    let detail: MdChapterDetail | null;
    try {
      detail = await md.chapterById(mdChapterId, ["scanlation_group", "manga"]);
    } catch (err) {
      metrics.uploadsTotal.inc({ outcome: "unavailable_failed" });
      this.queue("Unavailable", chapter, mdChapterId, false, errorMessage(err));
      throw err;
    }

    if (detail === null) {
      // Gone from MangaDex already — archiving is the correct end state.
      log.info({ mdChapterId }, "chapter already gone from MangaDex, archiving");
      await this.archiveUnavailable(mdChapterId, chapter, null);
      metrics.uploadsTotal.inc({ outcome: "unavailable_already_gone" });
      this.queue("Unavailable", chapter, mdChapterId, true, "Chapter no longer on MangaDex.");
      return;
    }

    const attrs = detail.attributes;
    if (!attrs.externalUrl) {
      log.info({ mdChapterId }, "chapter already has no externalUrl, archiving");
      await this.archiveUnavailable(mdChapterId, chapter, null);
      metrics.uploadsTotal.inc({ outcome: "unavailable_already_done" });
      this.queue("Unavailable", chapter, mdChapterId, true, "Already marked unavailable.");
      return;
    }

    const groups = detail.relationships
      .filter((rel) => rel.type === "scanlation_group")
      .map((rel) => rel.id);

    try {
      const card = await generateChapterCard({
        mangaName: resolveMangaName(detail, chapter),
        chapterNumber: attrs.chapter ?? chapter.chapterNumber,
        chapterTitle: attrs.title ?? chapter.chapterTitle,
        extensionName: chapter.extensionName ?? "Unknown",
        chapterLanguage: attrs.translatedLanguage || chapter.chapterLanguage,
        chapterUrl: attrs.externalUrl ?? chapter.chapterUrl,
        availableFrom: chapter.chapterTimestamp,
        availableTo: readString(raw, "unavailableAt") ?? chapter.chapterExpire,
      });

      const session = await md.beginEditSession(mdChapterId, attrs.version);
      try {
        const pageId = await this.uploadCard(session.id, card, log);
        if (!pageId) throw new TaskError(`couldn't upload the chapter card for ${mdChapterId}`);

        const committed = await md.commitUploadSession(
          session.id,
          {
            volume: attrs.volume,
            chapter: attrs.chapter,
            title: attrs.title,
            translatedLanguage: attrs.translatedLanguage,
            externalUrl: attrs.externalUrl,
          },
          [pageId],
        );

        // The commit bumps the version and PUT /chapter needs the current one.
        let version = committed?.attributes?.version ?? null;
        if (version === null) {
          const refetched = await md.chapterById(mdChapterId);
          version = refetched?.attributes.version ?? attrs.version;
        }

        const replacementUrl = resolveReplacementUrl(attrs.externalUrl, chapter);
        const edited = await md.editChapter(mdChapterId, {
          volume: attrs.volume,
          chapter: attrs.chapter,
          title: attrs.title,
          translatedLanguage: attrs.translatedLanguage,
          groups,
          externalUrl: replacementUrl,
          version,
        });
        if (!edited) {
          throw new TaskError(`couldn't repoint externalUrl for chapter ${mdChapterId}`);
        }
        log.info(
          { mdChapterId, replacementUrl: replacementUrl ?? "cleared" },
          "chapter marked unavailable",
        );
      } catch (err) {
        await this.safeDeleteSession(session.id, log);
        throw err;
      }
    } catch (err) {
      metrics.uploadsTotal.inc({ outcome: "unavailable_failed" });
      this.queue("Unavailable", chapter, mdChapterId, false, errorMessage(err));
      throw err;
    }

    // archiveUnavailable moves the row out of uploaded_chapters as it writes.
    await this.archiveUnavailable(mdChapterId, chapter, detail);
    metrics.uploadsTotal.inc({ outcome: "unavailable_ok" });
    this.queue("Unavailable", chapter, mdChapterId, true);
  }

  /** Upload the card as page "0", retrying the way `_upload_card` does. */
  private async uploadCard(sessionId: string, card: Buffer, log: Logger): Promise<string | null> {
    for (let attempt = 1; attempt <= this.deps.config.uploadRetry; attempt++) {
      try {
        const uploaded = await this.deps.md.uploadImages(sessionId, [
          { name: "0.png", data: card },
        ]);
        const first = uploaded[0];
        if (first) return first.id;
        log.warn({ attempt }, "card upload returned no data");
      } catch (err) {
        log.warn({ err, attempt }, "card upload failed");
      }
    }
    return null;
  }

  private async archiveUnavailable(
    mdChapterId: string,
    chapter: Chapter,
    detail: MdChapterDetail | null,
  ): Promise<void> {
    // The MangaDex attribute snapshot is an external API resource, not our
    // shape, so it is one of the few things `extra` legitimately carries.
    const columns = chapterToColumns(
      { ...chapter, mdChapterId },
      detail ? { mdAttributes: detail.attributes } : {},
    );
    await this.deps.prisma.unavailableChapter.upsert({
      where: { mdChapterId },
      create: { mdChapterId, ...columns },
      update: { ...columns, unavailableAt: new Date() },
    });
    await this.deps.prisma.uploadedChapter.deleteMany({ where: { mdChapterId } });
  }

  // ------------------------------------------------------------- shared

  private async recordUploadedChapter(chapter: Chapter, mdChapterId: string): Promise<void> {
    const { prisma } = this.deps;
    const columns = uploadedChapterColumns({ ...chapter, mdChapterId });

    await prisma.uploadedChapter.upsert({
      where: { mdChapterId },
      create: { mdChapterId, ...columns },
      update: columns,
    });

    if (columns.extension && chapter.chapterId) {
      await prisma.uploadedId.upsert({
        where: {
          extension_chapterId: { extension: columns.extension, chapterId: chapter.chapterId },
        },
        create: { extension: columns.extension, chapterId: chapter.chapterId, mdChapterId },
        update: { mdChapterId },
      });
    }
  }

  private async deleteArtifacts(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.deps.prisma.artifact.deleteMany({ where: { id: { in: ids } } });
  }

  private async safeDeleteSession(sessionId: string, log: Logger): Promise<void> {
    try {
      await this.deps.md.deleteUploadSession(sessionId);
    } catch (err) {
      log.warn({ err, sessionId }, "couldn't clean up the upload session");
    }
  }

  private queue(
    action: string,
    chapter: Chapter,
    mdChapterId: string | null,
    success: boolean,
    detail?: string,
  ): void {
    if (!this.deps.notifier.enabled) return;
    const lines = [
      `Manga: ${chapter.mangaName ?? "unknown"}`,
      `Chapter: ${chapter.chapterNumber ?? "-"}${chapter.chapterTitle ? ` — ${chapter.chapterTitle}` : ""}`,
      `Language: \`${chapter.chapterLanguage ?? "-"}\``,
    ];
    if (mdChapterId) lines.push(`MangaDex chapter: ${MD_CHAPTER_URL}${mdChapterId}`);
    if (chapter.mdMangaId) lines.push(`MangaDex manga: ${MD_MANGA_URL}${chapter.mdMangaId}`);
    if (chapter.chapterUrl) lines.push(`Source: ${chapter.chapterUrl}`);
    if (detail) lines.push("", detail);

    // The Python shape, not a per-action status line: one field carrying
    // Success/Manga/Chapter/Extension plus the language, title, expiry and the
    // four links, titled after the queue that did the work. A channel that has
    // been reading these for years should not have to relearn them.
    this.pending.push(queueEmbed(action, chapter, success));
  }
}

// ------------------------------------------------------------------ helpers

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Series title for the card. Prefer the manga relationship MangaDex returned
 * (via includes[]=manga) over whatever the queue row carried — the queued name
 * is often absent, which is what used to render cards as "Untitled".
 */
function resolveMangaName(detail: MdChapterDetail, chapter: Chapter): string {
  const manga = detail.relationships.find((rel) => rel.type === "manga");
  const attrs = manga?.attributes;
  if (attrs) {
    const title = asRecord(attrs.title) ?? {};
    const altTitles = Array.isArray(attrs.altTitles) ? attrs.altTitles : [];
    const alt: Record<string, unknown> = {};
    for (const entry of altTitles) {
      const record = asRecord(entry);
      if (!record) continue;
      for (const [lang, value] of Object.entries(record)) {
        if (!(lang in alt)) alt[lang] = value;
      }
    }
    const pick = (lang: string): string | null => {
      const value = title[lang] ?? alt[lang];
      return typeof value === "string" && value !== "" ? value : null;
    };
    const originalLanguage = typeof attrs.originalLanguage === "string" ? attrs.originalLanguage : null;
    const resolved =
      pick("en") ??
      (originalLanguage ? (pick(`${originalLanguage}-ro`) ?? pick(originalLanguage)) : null) ??
      firstString(title) ??
      firstString(alt);
    if (resolved) return resolved;
  }
  return chapter.mangaName ?? "Untitled";
}

function firstString(source: Record<string, unknown>): string | null {
  for (const value of Object.values(source)) {
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

function isHttpUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url.trim());
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host !== "";
  } catch {
    return false;
  }
}

function domainRoot(url: string | null | undefined): string | null {
  if (!isHttpUrl(url)) return null;
  const parsed = new URL((url ?? "").trim());
  return `${parsed.protocol}//${parsed.host}/`;
}

/**
 * What externalUrl to leave behind once the chapter link is dead: the
 * publisher's manga page if we have one, else the publisher's site root, else
 * nothing — port of `_resolve_replacement_url`.
 */
function resolveReplacementUrl(liveExternalUrl: string | null, chapter: Chapter): string | null {
  const mangaUrl = (chapter.mangaUrl ?? "").trim();
  if (isHttpUrl(mangaUrl)) return mangaUrl;
  for (const candidate of [liveExternalUrl, chapter.chapterUrl, chapter.mangaUrl]) {
    const root = domainRoot(candidate);
    if (root) return root;
  }
  return null;
}
