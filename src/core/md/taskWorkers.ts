import { setTimeout as sleep } from "node:timers/promises";
import type { Prisma, PrismaClient, UploadTask } from "@prisma/client";
import type { Config } from "../../config.js";
import type { Logger } from "../../logging.js";
import { metrics } from "../../metrics.js";
import { generateChapterCard } from "./card.js";
import { unavailableCardOptions } from "./unavailableCard.js";
import { chapterFromJson, chapterToColumns, uploadedChapterColumns } from "./chapterRows.js";
import type { MdChapterDetail, MdExtendedApi } from "./client.js";
import type { DiscordEmbedInput, DiscordNotifier } from "./webhook.js";
import { queueEmbed, queueFinishedEmbed, queueSummaryEmbed } from "./webhookEmbeds.js";
import { botUserIdFromClientId, isCarded, type Chapter } from "./types.js";
import type { UnavailableReason } from "./card.js";
import type { SettingsStore } from "../store/settings.js";

/**
 * Execution of a single claimed UploadTask; the TypeScript port of
 * publoader/workers/{uploader,editor,deleter,unavailable}.py.
 *
 * The workers delete their queue row on success and leave it in place on
 * failure. Here the caller owns the task lifecycle: `execute` either returns
 * (task is DONE) or throws (task goes back to UploadTaskStore.fail, which
 * handles backoff and dead-lettering). Nothing in here retries the task itself.
 *
 * The upload path is the one that must survive a crash mid-flight, so it is
 * bracketed by UploadLog rows: a `committing` marker before the session opens
 * and a `committed` row carrying the MangaDex chapter id after. A retry that
 * finds a prior `committed` row verifies the chapter still exists on MangaDex
 * before skipping; a recorded id that MangaDex never indexed must re-upload,
 * not silently vanish.
 */

const IMAGE_BATCH_SIZE = 10;

/**
 * How hard to look for the card before deciding it did not land.
 *
 * Only reached when the commit echoed nothing useful; the echo is checked
 * first and does not lag. This is the fallback, and it is generous on purpose:
 * three attempts two seconds apart was NOT enough, and every premature verdict
 * failed a task whose commit had worked, which then retried and uploaded
 * another card. Twenty seconds of waiting is far cheaper than that.
 */
const CARD_CONFIRM_ATTEMPTS = 5;
const CARD_CONFIRM_DELAY_MS = 5_000;

/** Failure that should send the task back to the queue with its message intact. */
export class TaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskError";
  }
}

/**
 * The chapter as MangaDex holds it after an edit: the extension's chapter with
 * the fields the edit actually sent laid over it.
 *
 * `body` is the full edit body, so its values are the post-edit truth whether
 * they came from the payload or from what MangaDex already had. Only the four
 * fields our own rows carry are copied; `groups`, `version` and `externalUrl`
 * live elsewhere or are not ours to restate.
 */
export function appliedChapter(chapter: Chapter, body: Record<string, unknown>): Chapter {
  const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return {
    ...chapter,
    chapterVolume: str(body["volume"]),
    chapterNumber: str(body["chapter"]),
    chapterTitle: str(body["title"]),
    chapterLanguage: str(body["translatedLanguage"]) ?? chapter.chapterLanguage,
  };
}

export interface TaskWorkerDeps {
  prisma: PrismaClient;
  md: MdExtendedApi;
  notifier: DiscordNotifier;
  settings: SettingsStore;
  config: Config;
  log: Logger;
}

export class UploadTaskWorkers {
  private pending: DiscordEmbedInput[] = [];
  /**
   * Whether per-chapter embeds are sent for uploads that succeeded. Refreshed
   * once per drain rather than read per chapter: a setting changed halfway
   * through a batch should not split it into two different reporting styles,
   * and it saves a query per task.
   */
  private sendSuccesses = false;
  /**
   * Work done per kind since that kind's queue was last empty.
   *
   * A drain is not a single pass: while a run is processing, tasks arrive in a
   * trickle and the uploader wakes for one at a time. Reporting each pass
   * produced a message a minute, every one of them claiming the queue was
   * finished. These totals wait until it actually is.
   */
  private readonly queueTotals = new Map<string, { processed: number; failed: number }>();

  constructor(private readonly deps: TaskWorkerDeps) {}

  /** The MangaDex account publoader uploads as; see `uploadedByBot`. */
  private get botUserId(): string | null {
    return this.deps.config.mdBotUserId ?? botUserIdFromClientId(this.deps.config.mdClientId);
  }

  /**
   * May this task write to this chapter?
   *
   * The ownership gate in `dedupe.ts` decides what gets QUEUED. It does not run
   * here, so anything already in the queue -- or put back by a retry -- reaches
   * the write with no check at all. That is not hypothetical: four chapters
   * uploaded by another account dead-lettered on DELETE with 403, and retrying
   * the dead letters re-queued them as UNAVAILABLE, which would have uploaded a
   * card over somebody else's chapter and repointed their externalUrl.
   *
   * So the check runs again at the point of the write. Chapters are not
   * transferred between accounts, so "not ours" is permanent: the task is
   * finished rather than failed, because retrying it forever only produces
   * noise and 403s.
   */
  private async ownership(
    mdChapterId: string,
  ): Promise<
    | { ok: true; detail: MdChapterDetail }
    | { ok: false; gone: true }
    | { ok: false; gone: false; reason: string }
  > {
    const detail = await this.deps.md.chapterById(mdChapterId, [
      "scanlation_group",
      "manga",
      "user",
    ]);
    if (detail === null) return { ok: false, gone: true };

    const uploader = detail.relationships.find((rel) => rel.type === "user")?.id ?? null;
    const bot = this.botUserId;
    if (!bot) {
      return { ok: false, gone: false, reason: "no MangaDex bot user id is configured" };
    }
    if (uploader === null) {
      return { ok: false, gone: false, reason: "MangaDex did not say who uploaded this chapter" };
    }
    if (uploader.toLowerCase() !== bot.toLowerCase()) {
      return { ok: false, gone: false, reason: `uploaded by ${uploader}, not by this account` };
    }
    return { ok: true, detail };
  }

  /** Re-read the reporting settings. Call once at the start of each drain. */
  async refreshReporting(): Promise<void> {
    this.sendSuccesses = await this.deps.settings.getWebhookUploadSuccesses();
  }

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
        return this.runUpload(task, chapter, raw, log);
      case "EDIT":
        return this.runEdit(chapter, raw, log);
      case "DELETE":
        return this.runDelete(chapter, log);
      case "UNAVAILABLE":
        return this.runUnavailable(chapter, raw, log);
      case "RESTORE":
        return this.runRestore(chapter, raw, log);
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
   * The end-of-drain messages the queue workers send.
   *
   * `processed` counts per kind rather than per worker thread, which is the
   * closest this architecture has: the embed is named after the worker, and
   * here one uploader drains typed queues, so the kind IS the queue.
   *
   * Nothing is sent when nothing was processed: speak only when there is
   * done something, and a per-tick "finished 0 items" would be constant noise.
   *
   * "Finished all items in queue" additionally requires that something actually
   * SUCCEEDED. A task that fails goes back to the queue with a backoff, so a
   * pass that only failed has emptied nothing; announcing it as finished, once
   * per pass, for as long as the failure persists, is how this channel filled
   * with identical messages. The failures are reported by their own per-chapter
   * embeds, which is where an operator can act on them.
   */
  async flushQueueSummary(
    counts: Map<string, { processed: number; failed: number }>,
    /** PENDING + LEASED still waiting per kind, after this pass. */
    remaining: Map<string, number>,
  ): Promise<void> {
    // Totals are accumulated across passes and only reported once the queue is
    // actually empty. A drain is not one pass: work arrives in a trickle while
    // a run is processing, so the uploader wakes, handles one task, and sleeps.
    // Reporting per pass turned that into a message a minute, each announcing
    // "finished all items in queue" over a queue that plainly was not finished.
    for (const [kind, count] of counts) {
      const total = this.queueTotals.get(kind) ?? { processed: 0, failed: 0 };
      total.processed += count.processed;
      total.failed += count.failed;
      this.queueTotals.set(kind, total);
    }

    if (!this.deps.notifier.enabled) {
      // Still clear, or the totals grow forever on a deployment with no webhook.
      for (const kind of [...this.queueTotals.keys()]) {
        if ((remaining.get(kind) ?? 0) === 0) this.queueTotals.delete(kind);
      }
      return;
    }

    const embeds: DiscordEmbedInput[] = [];
    for (const [kind, total] of [...this.queueTotals]) {
      // Not empty yet: keep counting and say nothing.
      if ((remaining.get(kind) ?? 0) > 0) continue;
      this.queueTotals.delete(kind);
      if (total.processed === 0 && total.failed === 0) continue;
      // UNAVAILABLE is summary-only: a per-chapter embed for a bulk
      // "mark these unavailable" pass is hundreds of messages nobody reads.
      if (kind === "UNAVAILABLE") {
        embeds.push(queueSummaryEmbed(kind, total.processed, total.failed));
      }
      if (total.processed > 0) embeds.push(queueFinishedEmbed(kind));
    }
    if (embeds.length > 0) await this.deps.notifier.send(embeds);
  }

  // -------------------------------------------------------------- UPLOAD

  private async runUpload(
    task: UploadTask,
    chapter: Chapter,
    raw: Record<string, unknown>,
    log: Logger,
  ): Promise<void> {
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
      // A chapter known to be unreadable is published already carded, rather
      // than published live and carded afterwards. The two-step version leaves
      // a window -- however short -- in which MangaDex shows readers a working
      // link to a page that gives them nothing, which is the exact thing the
      // card exists to prevent. `runUnavailable` cannot do this: it opens an
      // EDIT session against a chapter that must already exist.
      const carded = cardOnUpload(raw);
      const files = carded
        ? [
            {
              name: "0.png",
              data: await generateChapterCard(
                unavailableCardOptions({
                  chapter,
                  detail: null,
                  footerNote: readString(raw, "footerNote"),
                  reason: carded.reason,
                  subscriptionName: carded.subscriptionName,
                }),
              ),
            },
          ]
        : await this.loadImages(chapter.imageArtifacts);

      const { pageOrder, failed } = await this.uploadPages(session.id, files, log);
      if (failed) {
        // uploader.py still commits when pages fail: the chapter lands as an
        // external-only entry rather than being lost entirely.
        log.error({ sessionId: session.id }, "some pages failed to upload, committing without pages");
      }
      // A carded chapter whose card failed to upload would commit with no
      // pages and a live publisher link -- indistinguishable from a healthy
      // external chapter, and pointing at nothing. Fail instead and retry.
      if (carded && failed) {
        throw new TaskError(
          `couldn't upload the unavailable card for a chapter being published as unavailable`,
        );
      }

      const committed = await md.commitUploadSession(
        session.id,
        {
          volume: chapter.chapterVolume,
          chapter: chapter.chapterNumber,
          title: chapter.chapterTitle,
          translatedLanguage: chapter.chapterLanguage ?? "",
          // Repointed away from the chapter nobody can open, exactly as the
          // card flow does, so `isCarded` recognises this as already handled
          // and no later pass re-cards or deletes it.
          externalUrl: carded
            ? resolveReplacementUrl(chapter.chapterUrl, chapter)
            : chapter.chapterUrl,
        },
        failed ? [] : pageOrder,
      );
      mdChapterId = committed?.id ?? null;
      if (carded) {
        log.info(
          { mdChapterId, reason: carded.reason },
          "chapter published already marked unavailable",
        );
      }
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
      // rebuilt from it; so the name must be the page's index and nothing else.
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

    // Mirror what MangaDex now holds, not what the extension reported. The two
    // differ on exactly the fields an edit exists to change, and the edit is
    // usually queued BECAUSE the extension's value is not the wanted one: a
    // volume backfilled from the aggregate is sent in the payload while the
    // extension chapter still carries null, and mirroring the chapter wrote
    // that null back. `uploaded_chapters` then said "no volume" about a chapter
    // MangaDex had just been given one for, so the same edit was found and
    // queued again on every later sweep.
    const applied = appliedChapter(chapter, body);
    await this.appendEdit(mdChapterId, applied, oldInfo, payload);
    await this.recordUploadedChapter(applied, mdChapterId);

    metrics.uploadsTotal.inc({ outcome: "edit_ok" });
    log.info({ mdChapterId, fields: Object.keys(payload) }, "chapter edited");
    this.queue("Edit", applied, mdChapterId, true);
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

    // Costs one read before an irreversible write. `runDelete` previously
    // called deleteChapter without ever looking at the chapter, so a queued row
    // was enough to attempt a deletion on any chapter id it happened to carry.
    const owned = await this.ownership(mdChapterId);
    if (!owned.ok) {
      if (owned.gone) {
        log.info({ mdChapterId }, "chapter already gone from MangaDex, nothing to delete");
        metrics.uploadsTotal.inc({ outcome: "delete_already_gone" });
        // Still archive it. The chapter is gone either way, and leaving the
        // live rows behind is what makes the archives describe chapters that
        // no longer exist.
        await this.archiveDeleted(mdChapterId, chapter);
        this.queue("Delete", chapter, mdChapterId, true, "Chapter no longer on MangaDex.");
        return;
      }
      // Finished, not failed: ownership does not change, so a retry can only
      // produce the same 403.
      log.error(
        { mdChapterId, reason: owned.reason },
        "refusing to delete a chapter this account did not upload",
      );
      metrics.uploadsTotal.inc({ outcome: "delete_refused_not_ours" });
      this.queue("Delete", chapter, mdChapterId, false, `Refused: ${owned.reason}`);
      return;
    }

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

    await this.archiveDeleted(mdChapterId, chapter);
    metrics.uploadsTotal.inc({ outcome: "delete_ok" });
    log.info({ mdChapterId }, "chapter deleted from MangaDex and archived");
    this.queue("Delete", chapter, mdChapterId, true);
  }

  /**
   * Record a chapter as deleted and take it out of the live archives.
   *
   * Archive first, then drop the live rows: deletion is irreversible, so the
   * record of what was removed outlives it (legacy deleter.py appended to the
   * `deleted` collection for the same reason).
   *
   * BOTH live archives are cleared, which is the part that was missing. A
   * chapter can be in `uploaded` or in `unavailable`, never both, and delete
   * only ever cleared `uploaded` -- so deleting a CARDED chapter left its
   * `unavailable_chapters` row behind for good. Nothing removes those later,
   * so the archive kept describing chapters MangaDex no longer has: 13 of them
   * on RuriDragon alone, which is how a query for "carded chapters" answered 36
   * when only 23 existed.
   */
  private async archiveDeleted(mdChapterId: string, chapter: Chapter): Promise<void> {
    const columns = chapterToColumns({ ...chapter, mdChapterId });
    const { prisma } = this.deps;
    await prisma.deletedChapter.upsert({
      where: { mdChapterId },
      create: { mdChapterId, ...columns },
      update: { ...columns, deletedAt: new Date() },
    });
    await prisma.uploadedChapter.deleteMany({ where: { mdChapterId } });
    await prisma.unavailableChapter.deleteMany({ where: { mdChapterId } });
  }

  // --------------------------------------------------------- UNAVAILABLE

  /**
   * Replace a taken-down external chapter with an info card, mirroring
   * unavailable.py: fetch the chapter, render the card, open an *edit* upload
   * session for that chapter, attach the card as its only page, then repoint the
   * publisher link away from the dead URL via PUT /chapter.
   *
   * Two sidecars on the task payload, both only ever set by an operator action
   * (routes/chapters.ts); the processor never sets either:
   *
   *  - `force` re-renders the card for a chapter that has ALREADY been marked
   *    unavailable. Without it the "no externalUrl left" branch below archives
   *    and returns, which is right for the automated pass, the work is done,
 *    but makes the card unfixable once posted. A card carrying a wrong series
   *    title, or one rendered before the layout was corrected, is a page on a
   *    public catalogue, so there has to be a way to replace it.
   *  - `footerNote` overrides the explanatory paragraph on the card, for the
   *    takedowns whose reason is not "the publisher removed it".
   */
  private async runUnavailable(
    chapter: Chapter,
    raw: Record<string, unknown>,
    log: Logger,
  ): Promise<void> {
    const { md } = this.deps;
    const mdChapterId = chapter.mdChapterId;
    if (!mdChapterId) throw new TaskError("unavailable task has no mdChapterId");
    const force = raw["force"] === true;
    const footerNote = readString(raw, "footerNote");

    let owned: Awaited<ReturnType<UploadTaskWorkers["ownership"]>>;
    try {
      owned = await this.ownership(mdChapterId);
    } catch (err) {
      metrics.uploadsTotal.inc({ outcome: "unavailable_failed" });
      this.queue("Unavailable", chapter, mdChapterId, false, errorMessage(err));
      throw err;
    }

    // Carding is a write to somebody's chapter: it uploads a page over it and
    // repoints its externalUrl. A retried task reaches here without having gone
    // through the queueing gate, which is how four chapters belonging to
    // another account came to be queued for exactly this.
    if (!owned.ok && !owned.gone) {
      log.error(
        { mdChapterId, reason: owned.reason },
        "refusing to card a chapter this account did not upload",
      );
      metrics.uploadsTotal.inc({ outcome: "unavailable_refused_not_ours" });
      this.queue("Unavailable", chapter, mdChapterId, false, `Refused: ${owned.reason}`);
      return;
    }

    const detail: MdChapterDetail | null = owned.ok ? owned.detail : null;

    if (detail === null) {
      // Gone from MangaDex, so it is DELETED, not carded. Archiving it as
      // unavailable said the opposite -- that a chapter which no longer exists
      // is carrying one of our cards -- and wrote the row that says so. 848
      // rows currently sit in both archives because of this and the matching
      // gap in runDelete, and every one of them makes a later pass spend a
      // MangaDex lookup rediscovering a 404.
      log.info({ mdChapterId }, "chapter already gone from MangaDex, archiving as deleted");
      await this.archiveDeleted(mdChapterId, chapter);
      metrics.uploadsTotal.inc({ outcome: "unavailable_already_gone" });
      this.queue("Unavailable", chapter, mdChapterId, true, "Chapter no longer on MangaDex.");
      return;
    }

    const attrs = detail.attributes;
    // Two ways to already be done, and the second is the common one: the card
    // flow REPOINTS externalUrl rather than clearing it, so a chapter carded
    // last week still has one. `isCarded` (externalUrl + pages > 0) is what
    // actually recognises our own work; without it a re-queued chapter is
    // re-rendered and re-uploaded on every pass.
    if ((!attrs.externalUrl || isCarded(detail)) && !force) {
      log.info({ mdChapterId }, "chapter is already marked unavailable, archiving");
      await this.archiveUnavailable(mdChapterId, chapter, detail);
      metrics.uploadsTotal.inc({ outcome: "unavailable_already_done" });
      this.queue("Unavailable", chapter, mdChapterId, true, "Already marked unavailable.");
      return;
    }

    const groups = detail.relationships
      .filter((rel) => rel.type === "scanlation_group")
      .map((rel) => rel.id);

    try {
      const card = await generateChapterCard(
        unavailableCardOptions({
          chapter,
          detail,
          unavailableAt: readString(raw, "unavailableAt"),
          footerNote,
        }),
      );

      // MangaDex allows one open upload session per account, and this task is
      // retried: an attempt killed between opening a session and deleting it
      // leaves one behind that rejects every later begin, edit or upload alike.
      const openSession = await md.currentUploadSession();
      if (openSession) {
        log.warn({ sessionId: openSession.id }, "removing stale upload session before edit");
        await md.deleteUploadSession(openSession.id);
      }

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
        // Both readings below can lag the write that just happened — the echo
        // may predate the bump, the refetch may be served from MangaDex's
        // cache — so this is a best guess; `editChapter` corrects it from the
        // 409 rather than failing the task.
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

        // Two successful calls do not add up to a card on the chapter. A commit
        // that changes nothing returns 200 exactly like one that works, so the
        // chapter is asked what happened rather than inferred from the calls.
        // Without this a re-card sweep over thousands of chapters would report
        // every one of them regenerated and change none.
        await this.confirmCardLanded(
          mdChapterId,
          { pages: attrs.pages ?? 0, version: attrs.version },
          committed,
          log,
        );

        log.info(
          { mdChapterId, replacementUrl: replacementUrl ?? "cleared", force },
          force ? "unavailable card regenerated" : "chapter marked unavailable",
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

  /**
   * Check that the card is actually on the chapter, and throw if it is not.
   *
   * `before` is how the chapter looked going in, because what counts as success
   * depends on it:
   *
   *  - a chapter with no pages must come back with at least one. That is a card
   *    where there was none.
   *  - a chapter that already had a card must come back with a HIGHER version.
   *    The page count stays at one either way, so it says nothing about whether
   *    the image was replaced, and re-carding thousands of chapters whose
   *    commits all quietly did nothing would look identical to success.
   *
   * The version is the available signal for that second case, and it is a sound
   * one: a commit that does real work bumps it, and the no-op commit behind the
   * un-carding bug leaves it untouched -- that chapter sat at version 7 across
   * repeated attempts while MangaDex answered 200 every time.
   *
   * Page CONTENT would be the more direct thing to compare, and it is not
   * available: `GET /chapter/{id}` returns no `hash` field at all. Comparing it
   * was the first attempt here and it failed every re-card it saw, because the
   * value was absent rather than merely unchanged.
   *
   * Re-read a few times before giving up. MangaDex serves chapter reads from a
   * cache that lags its own writes, so the first read after a commit can still
   * show the old state; failing on that would turn working re-cards into
   * dead-lettered tasks.
   */
  private async confirmCardLanded(
    mdChapterId: string,
    before: { pages: number; version: number },
    committed: { attributes?: { version?: number; pages?: number } } | null,
    log: Logger,
  ): Promise<void> {
    // The commit's own echo first, because it cannot lag: it is the write
    // path's answer, where `GET /chapter/{id}` is served from a cache that can
    // still show the pre-commit chapter seconds afterwards. Trusting only the
    // read failed tasks whose commit had plainly worked -- a chapter reported
    // as `pages 0 -> 0, version 2 -> 2` was sitting at pages 1, version 3 by
    // the time anyone looked. Each of those retried and re-uploaded another
    // card.
    const echo = committed?.attributes;
    if (echo) {
      const echoedAPage = before.pages === 0 && (echo.pages ?? 0) > 0;
      const echoedAWrite = before.pages > 0 && (echo.version ?? 0) > before.version;
      if (echoedAPage || echoedAWrite) return;
    }

    // Re-cards stop here. The echo above is free; the read below is not, and
    // for a re-card it cannot take the fast path at all: the page count stays
    // at one, and MangaDex's commit echo reports a STALE version (it said 7
    // for a chapter that had reached 13). So every re-card fell through to the
    // read loop and sat out MangaDex's cache -- 15 to 20 seconds of sleeping,
    // which was two thirds of the time a re-card took and the reason a 2,425
    // chapter sweep was measured in days.
    //
    // What that bought was small. A re-card replaces an image on a chapter
    // already carded, so a silent failure leaves the OLD card in place rather
    // than a live chapter looking dead. The dangerous direction -- a card that
    // never landed on a live chapter -- is the first-card case, which keeps its
    // confirmation because the echoed page count settles it without waiting.
    if (before.pages > 0) {
      log.info({ mdChapterId }, "re-card committed; not waiting on the read to confirm it");
      return;
    }

    let pages: number | null = null;
    let version: number | null = null;

    for (let attempt = 1; attempt <= CARD_CONFIRM_ATTEMPTS; attempt += 1) {
      if (attempt > 1) {
        // Worth saying: a retry here means the read came back stale, and if
        // these become common the delay is the thing to look at.
        log.debug({ mdChapterId, attempt }, "card not visible yet, re-reading");
        await sleep(CARD_CONFIRM_DELAY_MS);
      }
      const after = await this.deps.md.chapterById(mdChapterId);
      pages = after?.attributes.pages ?? null;
      version = after?.attributes.version ?? null;

      const gainedAPage = before.pages === 0 && (pages ?? 0) > 0;
      const commitDidWork = before.pages > 0 && version !== null && version > before.version;
      if (gainedAPage || commitDidWork) return;
    }

    throw new TaskError(
      `the card did not land on chapter ${mdChapterId}: pages ${before.pages} -> ` +
        `${pages === null ? "unknown" : pages}, version ${before.version} -> ` +
        `${version === null ? "unknown" : version}`,
    );
  }

  /**
   * Take the card back off a chapter.
   *
   * Carding was a one-way door: `findExtraChapters` skips anything already
   * carded, so nothing ever revisited one, and a chapter carded by mistake
   * stayed carded. 213 live RuriDragon chapters were carded by a run that
   * compared four languages it had never fetched, and there was no way to undo
   * a single one of them.
   *
   * The undo, as MangaDex describe it: open an edit session, take the card's
   * page OUT of it with DELETE /upload/{id}/batch, then commit keeping no
   * pages. `externalUrl` is set from the stored row's chapter link, or from
   * `externalUrl` on the task when an operator supplies one -- the row keeps
   * the publisher's real chapter link (see `unavailableCardOptions`), which is
   * what makes this recoverable at all.
   *
   * BLOCKED ON A MANGADEX BUG at the time of writing, confirmed with them. Each
   * step reports success and the chapter does not change: the batch delete
   * genuinely empties the session (re-reading it afterwards shows no files),
   * and the commit then answers 200 while leaving the page count, `updatedAt`
   * and even the version exactly as they were.
   *
   * The sequence is kept as written because it is the correct one and will
   * start working when their fix lands. What changed is that it no longer
   * LIES: the page count is checked afterwards and anything but zero throws.
   * 23 chapters were previously logged as restored while every one of them kept
   * its card, which is worse than not having the feature at all.
   */
  private async runRestore(
    chapter: Chapter,
    raw: Record<string, unknown>,
    log: Logger,
  ): Promise<void> {
    const { md } = this.deps;
    const mdChapterId = chapter.mdChapterId;
    if (!mdChapterId) throw new TaskError("restore task has no mdChapterId");

    const owned = await this.ownership(mdChapterId);
    if (!owned.ok) {
      if (owned.gone) {
        log.info({ mdChapterId }, "chapter is gone from MangaDex, nothing to restore");
        this.queue("Restore", chapter, mdChapterId, true, "Chapter no longer on MangaDex.");
        return;
      }
      log.error(
        { mdChapterId, reason: owned.reason },
        "refusing to restore a chapter this account did not upload",
      );
      this.queue("Restore", chapter, mdChapterId, false, `Refused: ${owned.reason}`);
      return;
    }

    const detail = owned.detail;
    const attrs = detail.attributes;
    if (!isCarded(detail)) {
      // Already an ordinary external chapter. Archiving is the right end state:
      // a re-queued restore should not open a session to change nothing.
      log.info({ mdChapterId }, "chapter carries no card, nothing to restore");
      await this.archiveRestored(mdChapterId, chapter);
      this.queue("Restore", chapter, mdChapterId, true, "No card to remove.");
      return;
    }

    const groups = detail.relationships
      .filter((rel) => rel.type === "scanlation_group")
      .map((rel) => rel.id);

    // An operator may correct the link while restoring; otherwise the row's
    // chapter url wins, and only then the value MangaDex currently holds --
    // which on a carded chapter is the replacement, not the chapter.
    const replacement = readString(raw, "externalUrl") ?? chapter.chapterUrl ?? attrs.externalUrl;

    const openSession = await md.currentUploadSession();
    if (openSession) {
      log.warn({ sessionId: openSession.id }, "removing stale upload session before restore");
      await md.deleteUploadSession(openSession.id);
    }

    const session = await md.beginEditSession(mdChapterId, attrs.version);
    try {
      // The card is a file of this session, and it has to be taken OUT of the
      // session before the commit; a commit alone leaves it exactly where it
      // was. The ids come from the begin-edit response, which returns an
      // `upload_session_file` relationship per existing page -- undocumented,
      // but it is the only place they are available.
      if (session.fileIds.length > 0) {
        const removed = await md.deleteUploadSessionFiles(session.id, session.fileIds);
        if (!removed) {
          throw new TaskError(
            `couldn't remove the card's page from the edit session for ${mdChapterId}`,
          );
        }
        log.info(
          { mdChapterId, sessionId: session.id, files: session.fileIds.length },
          "removed the card's page from the edit session",
        );
      }

      // Then commit with no pages kept. `[]` rather than omitting the field:
      // omitting it is rejected outright as required, and null is rejected as
      // not-an-array, so this is the only form the endpoint accepts.
      const committed = await md.commitUploadSession(
        session.id,
        {
          volume: attrs.volume,
          chapter: attrs.chapter,
          title: attrs.title,
          translatedLanguage: attrs.translatedLanguage,
          externalUrl: replacement,
        },
        [],
      );

      let version = committed?.attributes?.version ?? null;
      if (version === null) {
        const refetched = await md.chapterById(mdChapterId);
        version = refetched?.attributes.version ?? attrs.version;
      }

      const edited = await md.editChapter(mdChapterId, {
        volume: attrs.volume,
        chapter: attrs.chapter,
        title: attrs.title,
        translatedLanguage: attrs.translatedLanguage,
        groups,
        externalUrl: replacement,
        version,
      });
      if (!edited) throw new TaskError(`couldn't restore externalUrl for chapter ${mdChapterId}`);

      // MangaDex accepting the commit is not the same as MangaDex having
      // dropped the pages, and the difference is invisible from here: a commit
      // that changes nothing comes back 2xx exactly like one that works. Ask
      // the chapter what happened instead of trusting the call.
      //
      // Worth the extra request because of what the two failures cost. A
      // restore that silently leaves the card on is a live chapter still
      // showing "no longer available" to readers, recorded as DONE, retried by
      // nobody -- which is precisely how 23 chapters were reported restored
      // while every one of them kept its card. A restore that fails loudly is
      // a queue entry someone can see.
      const after = await md.chapterById(mdChapterId);
      const pagesAfter = after?.attributes.pages ?? null;
      if (pagesAfter === null || pagesAfter > 0) {
        throw new TaskError(
          `commit left ${pagesAfter === null ? "unknown" : String(pagesAfter)} page(s) on ` +
            `chapter ${mdChapterId}; the card was not removed`,
        );
      }
    } catch (err) {
      await this.safeDeleteSession(session.id, log);
      this.queue("Restore", chapter, mdChapterId, false, errorMessage(err));
      throw err;
    }

    await this.archiveRestored(mdChapterId, chapter);
    log.info({ mdChapterId, externalUrl: replacement }, "card removed; chapter restored");
    this.queue("Restore", chapter, mdChapterId, true);
  }

  /**
   * Move a chapter out of the unavailable archive and back to uploaded.
   *
   * The row is what tells every later pass the chapter is carded, so leaving it
   * behind would have the next run treat a restored chapter as still
   * unavailable.
   */
  private async archiveRestored(mdChapterId: string, chapter: Chapter): Promise<void> {
    const { prisma } = this.deps;
    await prisma.unavailableChapter.deleteMany({ where: { mdChapterId } });
    await this.recordUploadedChapter(chapter, mdChapterId);
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
    // Last honest moment for the url. The chapter is not carded yet, so even a
    // payload rebuilt from MangaDex still carries the publisher's real link;
    // one commit later it carries the replacement.
    await this.rememberOrigin(chapter, mdChapterId);
    await this.deps.prisma.unavailableChapter.upsert({
      where: { mdChapterId },
      create: { mdChapterId, ...columns },
      update: { ...columns, unavailableAt: new Date() },
    });
    await this.deps.prisma.uploadedChapter.deleteMany({ where: { mdChapterId } });
  }

  // ------------------------------------------------------------- shared

  /**
   * Keep the chapter as the publisher described it, once and for good.
   *
   * Write-once by design: `update: {}` so a later pass can never overwrite it.
   * That is the entire value. Everything else about a chapter degrades as it
   * moves -- a chapter rebuilt from a MangaDex record takes its url from
   * `externalUrl`, which on a carded chapter is the REPLACEMENT link -- so
   * without this the publisher's real link is lost the first time a carded
   * chapter is archived, and there is nothing left to recover it from.
   *
   * Never throws: losing provenance is bad, failing the upload that produced it
   * is worse.
   */
  private async rememberOrigin(chapter: Chapter, mdChapterId: string): Promise<void> {
    const extension = chapter.extensionName;
    if (!extension) return;
    try {
      await this.deps.prisma.chapterOrigin.upsert({
        where: { mdChapterId },
        create: {
          mdChapterId,
          extension,
          chapterId: chapter.chapterId ?? null,
          chapterUrl: chapter.chapterUrl ?? null,
          mangaId: chapter.mangaId ?? null,
          mdMangaId: chapter.mdMangaId ?? null,
          mangaName: chapter.mangaName ?? null,
          chapterNumber: chapter.chapterNumber ?? null,
          chapterVolume: chapter.chapterVolume ?? null,
          chapterTitle: chapter.chapterTitle ?? null,
          chapterLanguage: chapter.chapterLanguage ?? null,
        },
        update: {},
      });
    } catch (err) {
      this.deps.log.warn({ err, mdChapterId }, "could not record the chapter's origin");
    }
  }

  private async recordUploadedChapter(chapter: Chapter, mdChapterId: string): Promise<void> {
    const { prisma } = this.deps;
    const columns = uploadedChapterColumns({ ...chapter, mdChapterId });
    await this.rememberOrigin(chapter, mdChapterId);

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

    // A successful upload is the expected case, and one embed per chapter turns
    // the channel into a transcript in which the failures, the only entries
    // anyone can act on, scroll past unread. Off unless an operator asks for
    // them; the run-level "Found N chapters" embed already reports the work.
    // Failures are always sent: dropping one silently has no reading in which
    // it is what the operator wanted.
    if (success && !this.sendSuccesses) return;

    // Not a per-action status line: one field carrying
    // Success/Manga/Chapter/Extension plus the language, title, expiry and the
    // four links, titled after the queue that did the work. A channel that has
    // been reading these for years should not have to relearn them. The failure
    // reason rides along as the description; see queueEmbed.
    this.pending.push(queueEmbed(action, chapter, success, detail));
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
 * nothing; port of `_resolve_replacement_url`.
 */
/**
 * Should this upload be published already carded, and why?
 *
 * Set by whoever queues the task, for a chapter already known to be unreadable
 * -- one the publisher lists but will not serve, typically because it moved
 * behind a subscription. Absent for every ordinary upload, which is all of them
 * unless an extension says otherwise.
 *
 * `reason` is validated rather than trusted: it selects the wording a reader
 * sees, and an unrecognised value silently falling through to "removed" would
 * tell them a chapter is gone when it is merely paid for.
 */
function cardOnUpload(
  raw: Record<string, unknown>,
): { reason: UnavailableReason; subscriptionName: string | null } | null {
  if (raw["uploadAsUnavailable"] !== true) return null;
  const reason = readString(raw, "reason");
  const known: UnavailableReason[] = ["removed", "subscriber-only", "region-locked"];
  return {
    reason: known.includes(reason as UnavailableReason)
      ? (reason as UnavailableReason)
      : "removed",
    subscriptionName: readString(raw, "subscriptionName"),
  };
}

/**
 * Where a carded chapter's `externalUrl` should point, best first: the
 * chapter itself, then the series page, then the publisher's homepage.
 *
 * The chapter link leads: it is the most specific answer, and a reader who
 * follows it gets the publisher's own page for exactly the chapter the card
 * describes -- which may well have come back, since publishers rotate chapters
 * in and out of free access rather than deleting them. The series page is the
 * next best thing when the chapter link was never recorded, and the domain root
 * is the last resort that at least reaches the publisher.
 *
 * This does not weaken `isCarded`, which recognises our work by
 * `externalUrl && pages > 0` -- the card supplies the page, so the url is free
 * to stay useful.
 */
function resolveReplacementUrl(liveExternalUrl: string | null, chapter: Chapter): string | null {
  const chapterUrl = (chapter.chapterUrl ?? "").trim();
  if (isHttpUrl(chapterUrl)) return chapterUrl;

  const mangaUrl = (chapter.mangaUrl ?? "").trim();
  if (isHttpUrl(mangaUrl)) return mangaUrl;

  for (const candidate of [liveExternalUrl, chapter.chapterUrl, chapter.mangaUrl]) {
    const root = domainRoot(candidate);
    if (root) return root;
  }
  return null;
}
