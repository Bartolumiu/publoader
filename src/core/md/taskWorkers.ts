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
import { UploadSessionLock } from "./sessionLock.js";

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
 * The embed title the UNAVAILABLE queue reports under, and the one action whose
 * failures are not posted to Discord; see `queue`. Named rather than repeated
 * so the suppression cannot drift away from the call sites it is about.
 */
const UNAVAILABLE_ACTION = "Unavailable";

/**
 * How long to leave a committed card alone before asking whether it landed,
 * and how many times to come back.
 *
 * This is the ONLY thing that decides a card, first or re-card, so it has to be
 * generous: nothing cheaper corroborates it, and every premature verdict fails
 * a task whose commit had worked, which then retries and uploads another card.
 *
 * It used to be eight reads five seconds apart, in line, and the two properties
 * fought each other. Generous meant slow, and slow meant HELD: thirty-five
 * seconds of sleeping per card, inside the drain, with the whole queue stopped
 * behind it. So the wait could not grow to fit what MangaDex actually does
 * without the queue paying for it twice.
 *
 * Deferring breaks that trade. The task is put back with a `not_before` and the
 * uploader goes on to the next one, so waiting costs nothing but a row, and the
 * budget can be minutes instead of seconds. Two minutes, then five, then
 * fifteen: twenty-two minutes of grace against the fifteen seconds a healthy
 * write was measured to take on 2026-09-02, and a card still page-less after
 * that is not lagging, it is missing.
 */
const CARD_VERIFY_DELAYS_SECONDS = [120, 300, 900];

/** Failure that should send the task back to the queue with its message intact. */
export class TaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskError";
  }
}

/**
 * What `execute` leaves behind: nothing, or an instruction to come back.
 *
 * A third disposition was needed alongside "done" and "failed". The unavailable
 * card is written by one call and made true by another, minutes later, and
 * neither of the two existing answers fits the gap between them: DONE would
 * claim a card that may never appear, and a failure would burn an attempt and
 * re-upload a card that is probably already on its way.
 *
 * `chapter` is the payload to carry into the next claim, which is how a
 * deferred task remembers which round it is on.
 */
export type TaskOutcome = { defer: { seconds: number; chapter: Record<string, unknown> } } | null;

/** What `commitUploadSession` hands back; kept only to quote in a failure. */
type MdCommitEcho = { id?: string; attributes?: { version?: number; pages?: number } } | null;

/**
 * The full body a `PUT /chapter` needs: what MangaDex currently holds, with
 * the edit's payload laid over it.
 *
 * MangaDex's ChapterEdit is a replace, not a patch -- every mutable attribute
 * it is given is the new truth, and every one it is NOT given is cleared. So
 * the base has to restate the fields the edit does not mean to touch, and
 * `externalUrl` is one of them. Leaving it out of the base was not cosmetic:
 * the chapters this platform publishes carry no pages, only the link out to
 * the publisher, so an edit that meant to correct a title also emptied the
 * chapter -- `pages: 0` and nowhere to go. Nothing downstream noticed, because
 * the mirror still held the url that MangaDex no longer did. 52 K MANGA
 * chapters were in that state when this was found.
 *
 * A url is laid down only when it is non-empty, on both sides. ChapterEdit
 * rejects a null `externalUrl` exactly as ChapterDraft does (see
 * `commitUploadSession`), so "this chapter has no link" is expressed by
 * omitting the key. That also means a payload asking to CLEAR the link cannot
 * be honoured; sending the null would have MangaDex reject the whole edit and
 * lose the title or number change riding along with it, so the key is dropped
 * and the link is left standing -- the survivable half of an impossible ask.
 */
/**
 * Chapter timestamps MangaDex owns and this platform never writes.
 *
 * `readableAt` sits beside `publishAt` because it is the same kind of field and
 * the same mistake: a scheduling attribute that looks editable, is accepted by
 * a PUT, and means something the uploader has no business asserting.
 */
const MANGADEX_OWNED_TIMESTAMPS = ["publishAt", "readableAt"] as const;

export function chapterEditBody(
  current: {
    attributes: {
      volume: string | null;
      chapter: string | null;
      title: string | null;
      translatedLanguage: string;
      externalUrl: string | null;
      version: number;
    };
    relationships: readonly { type: string; id: string }[];
  },
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const groups = current.relationships
    .filter((rel) => rel.type === "scanlation_group")
    .map((rel) => rel.id);

  const requested = { ...payload };
  if ("externalUrl" in requested && !requested.externalUrl) delete requested.externalUrl;
  // Scheduling is MangaDex's, not ours, and this platform must never restate
  // it. Nothing here sets these — the base below is a whitelist and no route
  // accepts them — but `payload` reaches this spread from `ChapterPayload`,
  // which is deliberately `.passthrough()` so an EDIT row can carry its
  // `payload`/`oldInfo` sidecars. That leaves a hand-built or hand-patched task
  // able to put `publishAt` in an edit body, and a PUT /chapter is a replace:
  // whatever it carries becomes the new truth.
  //
  // Why it matters rather than being hygiene: a chapter that is future-dated
  // AND external cannot hold a page. Across 624 such chapters in this group,
  // not one does, against 445 of 1,688 past-dated external ones that do. So a
  // stray `publishAt` does not merely mis-schedule a chapter, it makes every
  // later unavailable card silently fail to land on it.
  for (const key of MANGADEX_OWNED_TIMESTAMPS) delete requested[key];

  return {
    volume: current.attributes.volume,
    chapter: current.attributes.chapter,
    title: current.attributes.title,
    translatedLanguage: current.attributes.translatedLanguage,
    groups,
    ...(current.attributes.externalUrl ? { externalUrl: current.attributes.externalUrl } : {}),
    ...requested,
    version: current.attributes.version,
  };
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

  /**
   * Turnstile for the one upload session the MangaDex account is allowed.
   *
   * Held by whichever worker is currently putting images up, and by nothing
   * else. It lives on the workers rather than on the client because it is the
   * workers that bracket a session -- open, upload, commit or delete -- and the
   * uploader shares ONE instance of this class across both of its drain loops,
   * so a card and a chapter upload contend here and nowhere else.
   */
  private readonly session = new UploadSessionLock();

  constructor(private readonly deps: TaskWorkerDeps) {}

  /** Whether a session is held, and how many workers are waiting for it. */
  sessionPressure(): { busy: boolean; queued: number } {
    return { busy: this.session.busy, queued: this.session.queued };
  }

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

  /**
   * Run one claimed task.
   *
   * Throws on failure; the caller requeues. Returns a `defer` when the task did
   * its write and now needs time to pass before anyone can tell whether it
   * worked -- see TaskOutcome -- and `null` when it is finished.
   */
  async execute(task: UploadTask): Promise<TaskOutcome> {
    const log = this.deps.log.child({
      taskId: task.id,
      kind: task.kind,
      dedupeKey: task.dedupeKey,
    });
    const raw = asRecord(task.chapter) ?? {};
    const chapter = chapterFromJson(raw);

    // Only UNAVAILABLE has anything to say beyond done-or-thrown; the rest are
    // finished by the time they return, so they answer for themselves here
    // rather than each ending in a `return null` that means nothing locally.
    switch (task.kind) {
      case "UPLOAD":
        await this.runUpload(task, chapter, raw, log);
        return null;
      case "EDIT":
        await this.runEdit(chapter, raw, log);
        return null;
      case "DELETE":
        await this.runDelete(chapter, log);
        return null;
      case "UNAVAILABLE":
        return this.runUnavailable(task, chapter, raw, log);
      case "RESTORE":
        await this.runRestore(chapter, raw, log);
        return null;
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

    let mdChapterId: string | null = null;
    // Everything from here to the commit holds the account's one upload
    // session, so it takes a turn: the UNAVAILABLE queue is drained at the same
    // time as this one, and both open sessions. Waiting here is the price of
    // that, and it is the only place either queue waits for the other.
    await this.session.run(async () => {
      // MangaDex allows one open upload session per account.
      const existingSession = await md.currentUploadSession();
      if (existingSession) {
        log.debug({ sessionId: existingSession.id }, "removing stale upload session");
        await md.deleteUploadSession(existingSession.id);
      }

      const session = await md.createUploadSession(mdMangaId, [mdGroupId]);
      log.info(
        { sessionId: session.id, images: chapter.imageArtifacts.length },
        "upload session opened",
      );

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
          log.error(
            { sessionId: session.id },
            "some pages failed to upload, committing without pages",
          );
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
    });

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

    const body = chapterEditBody(current, payload);

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
   *
   * A third sidecar, `cardVerify`, is set by this method on itself. It marks a
   * task that has already written its card and is only here to find out whether
   * the card arrived; see `verifyCard`. It is the reason the method can return
   * a deferral rather than only done-or-thrown.
   */
  private async runUnavailable(
    task: UploadTask,
    chapter: Chapter,
    raw: Record<string, unknown>,
    log: Logger,
  ): Promise<TaskOutcome> {
    const { md } = this.deps;
    const mdChapterId = chapter.mdChapterId;
    if (!mdChapterId) throw new TaskError("unavailable task has no mdChapterId");
    const force = raw["force"] === true;
    const footerNote = readString(raw, "footerNote");

    // A task carrying `cardVerify` wrote its card on an earlier claim. It must
    // not write another: everything below opens a session and uploads an image,
    // and doing that to a chapter whose first card is merely late is how one
    // takedown becomes four commits.
    const pending = readVerifyState(raw);
    if (pending) return this.verifyCard(task, chapter, raw, pending, log);

    let owned: Awaited<ReturnType<UploadTaskWorkers["ownership"]>>;
    try {
      owned = await this.ownership(mdChapterId);
    } catch (err) {
      metrics.uploadsTotal.inc({ outcome: "unavailable_failed" });
      this.queue(UNAVAILABLE_ACTION, chapter, mdChapterId, false, errorMessage(err));
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
      this.queue(UNAVAILABLE_ACTION, chapter, mdChapterId, false, `Refused: ${owned.reason}`);
      return null;
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
      this.queue(UNAVAILABLE_ACTION, chapter, mdChapterId, true, "Chapter no longer on MangaDex.");
      return null;
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
      this.queue(UNAVAILABLE_ACTION, chapter, mdChapterId, true, "Already marked unavailable.");
      return null;
    }

    let committed: MdCommitEcho = null;
    try {
      // Outside the session lock on purpose. Rendering a card is CPU and a
      // couple of image reads, and it is the bulk of the work either side of
      // the commit; doing it while another queue holds the session is most of
      // what running the two queues at once actually buys.
      const card = await generateChapterCard(
        unavailableCardOptions({
          chapter,
          detail,
          unavailableAt: readString(raw, "unavailableAt"),
          footerNote,
        }),
      );

      committed = await this.session.run(async () => {
        // MangaDex allows one open upload session per account, and this task is
        // retried: an attempt killed between opening a session and deleting it
        // leaves one behind that rejects every later begin, edit or upload alike.
        //
        // Inside the lock, and it has to be: this deletes whatever session the
        // account has open, which with two queues drained at once would be the
        // session the OTHER queue is uploading into.
        const openSession = await md.currentUploadSession();
        if (openSession) {
          log.warn({ sessionId: openSession.id }, "removing stale upload session before edit");
          await md.deleteUploadSession(openSession.id);
        }

        const session = await md.beginEditSession(mdChapterId, attrs.version);
        try {
          const pageId = await this.uploadCard(session.id, card, log);
          if (!pageId) throw new TaskError(`couldn't upload the chapter card for ${mdChapterId}`);

          // The repoint goes in the COMMIT, and used to be a PUT /chapter of its
          // own immediately afterwards. That ordering is the best explanation for
          // 98 of 101 cards being committed and then not existing: MangaDex
          // attaches the page synchronously, the PUT lands a second or two later
          // on a chapter that now has one, and the page does not survive it.
          //
          // The evidence is the commit echo, which sorts the outcome almost
          // perfectly the WRONG way round. Across 113 cards in one sweep:
          //
          //   echoed `resultingPages: 1`  ->  98 lost, 3 kept
          //   echoed `resultingPages: 0`  ->   0 lost, 12 kept
          //
          // Reading that as attachment timing rather than as a broken echo makes
          // it ordinary: echo 1 means the page was attached before the PUT, so
          // the PUT had something to strip; echo 0 means it had not attached yet,
          // so the PUT hit a page-less chapter and the page appeared afterwards
          // and survived. The three that echoed 1 and survived are the same race
          // finishing the other way. It also explains the ~15s some cards took to
          // become visible: they were landing after the PUT, not lagging a read.
          //
          // Folding the url into the commit makes the card and the repoint one
          // write, with nothing running between it and the confirmation.
          // The commit body already carried a non-null `externalUrl` alongside a
          // page and MangaDex accepted it, so this is the same shape with a
          // different value, not a new thing to be allowed.
          const replacementUrl = resolveReplacementUrl(attrs.externalUrl, chapter);
          const echo = await md.commitUploadSession(
            session.id,
            {
              volume: attrs.volume,
              chapter: attrs.chapter,
              title: attrs.title,
              translatedLanguage: attrs.translatedLanguage,
              externalUrl: replacementUrl,
            },
            [pageId],
          );

          log.info(
            { mdChapterId, replacementUrl: replacementUrl ?? "cleared", force },
            force ? "unavailable card committed for regeneration" : "unavailable card committed",
          );
          return echo;
        } catch (err) {
          await this.safeDeleteSession(session.id, log);
          throw err;
        }
      });
    } catch (err) {
      metrics.uploadsTotal.inc({ outcome: "unavailable_failed" });
      this.queue(UNAVAILABLE_ACTION, chapter, mdChapterId, false, errorMessage(err));
      throw err;
    }

    // The session is released and the chapter is NOT archived yet. A successful
    // call does not add up to a card on the chapter: a commit that changes
    // nothing answers 200 exactly like one that works, and on 2026-09-03 eighty
    // consecutive commits echoed `resultingPages: 1` over chapters that are
    // still page-less hours later. Archiving on the strength of the call would
    // record every one of them as carded.
    //
    // So the task goes back in the queue to be asked again later, and the
    // uploader takes the next one meanwhile. Nothing waits.
    return {
      defer: {
        seconds: CARD_VERIFY_DELAYS_SECONDS[0] ?? 120,
        chapter: {
          ...raw,
          cardVerify: {
            round: 1,
            pagesBefore: attrs.pages ?? 0,
            versionBefore: attrs.version,
            committedPages: committed?.attributes?.pages ?? null,
          },
        },
      },
    };
  }

  /**
   * The second half of a card: has the page MangaDex accepted actually arrived?
   *
   * Reached only by a task that already committed a card, minutes ago, and it
   * does the reading `confirmCardLanded` used to do in a sleep loop -- one read
   * per claim now, with the waiting done by `not_before` instead of by the
   * uploader standing still. The verdicts are unchanged:
   *
   *  - a chapter with no pages must come back with at least one. That is a card
   *    where there was none.
   *  - a chapter that already had a card must come back with a HIGHER version.
   *    The page count stays at one either way, so it says nothing about whether
   *    the image was replaced, and re-carding thousands of chapters whose
   *    commits all quietly did nothing would look identical to success.
   *
   * Page CONTENT would be the more direct comparison and is not available:
   * `GET /chapter/{id}` returns no `hash` field at all. Comparing it was the
   * first attempt here and it failed every re-card it saw, because the value
   * was absent rather than merely unchanged.
   *
   * Running out of rounds fails the task in the ordinary way, which re-cards it
   * on the next attempt -- but the `cardVerify` marker is cleared FIRST, or the
   * retry would arrive here again and re-read a chapter nobody has written to
   * since, forever, until the attempts ran out without a second card ever being
   * tried.
   */
  private async verifyCard(
    task: UploadTask,
    chapter: Chapter,
    raw: Record<string, unknown>,
    state: VerifyState,
    log: Logger,
  ): Promise<TaskOutcome> {
    const mdChapterId = chapter.mdChapterId;
    if (!mdChapterId) throw new TaskError("unavailable task has no mdChapterId");

    const after = await this.deps.md.chapterById(mdChapterId);
    if (after === null) {
      // Deleted between the card and the check. It is DELETED, not carded, and
      // saying otherwise writes a row claiming a chapter that no longer exists
      // is carrying one of our cards.
      log.info({ mdChapterId }, "chapter went away before the card could be confirmed");
      await this.archiveDeleted(mdChapterId, chapter);
      metrics.uploadsTotal.inc({ outcome: "unavailable_already_gone" });
      this.queue(UNAVAILABLE_ACTION, chapter, mdChapterId, true, "Chapter no longer on MangaDex.");
      return null;
    }

    const pages = after.attributes.pages ?? null;
    const version = after.attributes.version ?? null;
    if (cardLanded({ pages: state.pagesBefore, version: state.versionBefore }, { pages, version })) {
      log.info(
        { mdChapterId, round: state.round, pages, version },
        "card confirmed on the chapter",
      );
      // archiveUnavailable moves the row out of uploaded_chapters as it writes.
      await this.archiveUnavailable(mdChapterId, chapter, after);
      metrics.uploadsTotal.inc({ outcome: "unavailable_ok" });
      this.queue(UNAVAILABLE_ACTION, chapter, mdChapterId, true);
      return null;
    }

    const nextDelay = CARD_VERIFY_DELAYS_SECONDS[state.round];
    if (nextDelay !== undefined) {
      log.info(
        { mdChapterId, round: state.round, pages, version, nextDelay },
        "card not on the chapter yet, looking again later",
      );
      return {
        defer: {
          seconds: nextDelay,
          chapter: { ...raw, cardVerify: { ...state, round: state.round + 1 } },
        },
      };
    }

    await this.clearVerifyState(task.id, raw);
    metrics.uploadsTotal.inc({ outcome: "unavailable_failed" });
    // Deliberately not queued for Discord; see `queue`.
    throw new TaskError(
      `the card did not land on chapter ${mdChapterId}: pages ${state.pagesBefore} -> ` +
        `${pages === null ? "unknown" : pages}, version ${state.versionBefore} -> ` +
        `${version === null ? "unknown" : version}` +
        `, commit echoed ${
          state.committedPages === null ? "nothing" : `pages ${state.committedPages}`
        }` +
        `, over ${CARD_VERIFY_DELAYS_SECONDS.reduce((a, b) => a + b, 0)}s`,
    );
  }

  /**
   * Take the verification marker off a task before failing it, so the retry
   * writes a new card instead of re-reading the old chapter.
   *
   * Written straight to the row rather than routed through the outcome: the
   * task is about to throw, and the caller's `fail` path does not carry a
   * payload. Best-effort -- a task that keeps the marker still terminates, it
   * just spends its remaining attempts looking rather than writing, so a
   * failure here must not mask the real error being raised.
   */
  private async clearVerifyState(taskId: string, raw: Record<string, unknown>): Promise<void> {
    const { cardVerify: _dropped, ...rest } = raw;
    try {
      await this.deps.prisma.uploadTask.update({
        where: { id: taskId },
        data: { chapter: rest as Prisma.InputJsonValue },
      });
    } catch {
      // Swallowed on purpose; the TaskError that follows is the useful one.
    }
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

    // Under the session lock for the same reason as the other two: this deletes
    // whatever session the account has open, which is the other queue's if the
    // other queue is mid-upload.
    await this.session.run(async () => {
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
    });

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

    // Except an unavailable card that did not land, which is the one failure
    // nobody can act on from Discord. It is bulk work -- a takedown sweep is
    // hundreds of chapters -- and when it fails it fails in runs, because the
    // cause is on MangaDex's side: 80 chapters in one night, each posting an
    // embed saying the same thing about a different uuid. That is the channel
    // filled with a message whose only correct response is to wait.
    //
    // Nothing is lost by it. The failure is logged with the page and version
    // counts, counted into `unavailable_failed`, left on the queue row as
    // `last_error`, and totalled in the end-of-drain summary embed, which is
    // where a run of them is legible as one number instead of hundreds.
    if (!success && action === UNAVAILABLE_ACTION) return;

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

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * How the chapter looked before its card was committed, plus which round of
 * looking we are on. Carried on the task payload as `cardVerify` between the
 * commit and the confirmation.
 */
export interface VerifyState {
  round: number;
  pagesBefore: number;
  versionBefore: number;
  /** What the commit claimed. Reported in the failure, never believed. */
  committedPages: number | null;
}

/**
 * Read the marker back off a task payload, if it is there.
 *
 * Validated rather than cast. The payload is JSONB written by an older build of
 * this same code, so a half-shaped marker is a real possibility, and one that
 * arrives with `round` missing would defer forever: `CARD_VERIFY_DELAYS[NaN]`
 * is undefined, which reads as "out of rounds", but `versionBefore` of NaN
 * would already have failed the comparison above it. Requiring the numbers up
 * front makes an unreadable marker fall through to writing a fresh card, which
 * is the recoverable direction.
 */
export function readVerifyState(raw: Record<string, unknown>): VerifyState | null {
  const marker = asRecord(raw["cardVerify"]);
  if (!marker) return null;
  const round = readNumber(marker, "round");
  const pagesBefore = readNumber(marker, "pagesBefore");
  const versionBefore = readNumber(marker, "versionBefore");
  if (round === null || pagesBefore === null || versionBefore === null) return null;
  return { round, pagesBefore, versionBefore, committedPages: readNumber(marker, "committedPages") };
}

/**
 * Did the card arrive? The whole verdict, in one place, over what MangaDex says
 * about the chapter now versus what it said before the commit.
 *
 * The commit's own echo is deliberately NOT an input. It was once accepted as
 * proof, on the reasoning that the write path cannot lag the way a cached read
 * can. It does not lag; it is simply not about the chapter. Two batches from one
 * sweep on 2026-09-02 say so exactly:
 *
 *  - 19:38, the echo reported `resultingPages: 1`, was believed, and returned
 *    1.9 seconds after the commit without reading anything. Those chapters are
 *    `pages: 0` on MangaDex now -- 84 of the 100 newest rows in the unavailable
 *    archive, every one archived as done.
 *  - 21:14, the echo reported `resultingPages: 0` for the SAME operation. The
 *    read found the page about fifteen seconds later. Those chapters are
 *    `pages: 1` now.
 *
 * So the echo claimed a page where none landed and claimed none where one did,
 * in the same sweep, and the read was right both times.
 */
export function cardLanded(
  before: { pages: number; version: number },
  after: { pages: number | null; version: number | null },
): boolean {
  // A chapter that had no page must now have one: that is a card where there
  // was none, and nothing else produces it.
  if (before.pages === 0) return (after.pages ?? 0) > 0;
  // A re-card leaves the page count at one either way, so the count says
  // nothing. The version is the available signal and a sound one: a commit that
  // does real work bumps it, and the no-op commit behind the un-carding bug
  // leaves it untouched -- that chapter sat at version 7 across repeated
  // attempts while MangaDex answered 200 every time.
  return after.version !== null && after.version > before.version;
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
