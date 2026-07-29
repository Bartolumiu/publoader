import { Prisma, type PrismaClient, type UploadTaskKind } from "@prisma/client";
import type { Logger } from "../../logging.js";
import { ResultEnvelope } from "../../contracts/envelope.js";
import type { MangaRecord } from "../../contracts/records.js";
import { Manifest } from "../../contracts/manifest.js";
import { chapterFromRecord, type Chapter, type MdApi, type MdChapter } from "../md/types.js";
import { ResultStore } from "../store/results.js";
import { SettingsStore, type RemovalMode } from "../store/settings.js";
import { UploadTaskStore, uploadDedupeKey } from "../store/uploadTasks.js";
import {
  aggregateChapterIds,
  backfillVolumes,
  decideForManga,
  findDuplicateChapters,
  formatTitle,
  mdChapterMangaId,
  type OverrideOptionsLike,
} from "./dedupe.js";

/**
 * Turns committed result envelopes into MangaDex work.
 *
 * This is the TypeScript port of `publoader/extension_uploader.py`'s
 * ExtensionUploader.upload_chapters plus the dupe sweep from
 * `publoader/dupes_checker.py`. It runs entirely inside the core: workers
 * never learn MangaDex credentials, they only report what a publisher
 * currently offers, and every upload/edit/delete decision is made here against
 * the live MangaDex state.
 *
 * Idempotency: processing a run twice is harmless and expected. Task
 * enqueueing is ON CONFLICT DO NOTHING on (kind, dedupeKey), bookkeeping is
 * upserts, and the run is only flipped to PROCESSED at the very end. A crash
 * mid-run therefore replays cleanly on the next tick — at worst some tasks are
 * already queued and the second pass is a no-op for them.
 */

interface ClaimedRun {
  id: string;
  extension: string;
  bundleSha256: string;
  kind: "UPDATE" | "CLEAN" | "FORCE";
}

interface MergedResults {
  updatedChapters: Chapter[];
  /** null when any segment declined to publish a full listing. */
  allChapters: Chapter[] | null;
  untrackedManga: MangaRecord[];
  trackedMangadexIds: string[];
  overrideOptions: OverrideOptionsLike;
  languages: string[];
  groupId: string | null;
}

export interface RunProcessorOptions {
  /** Safety valve so one tick cannot monopolise the process. */
  maxRunsPerTick?: number;
}

export class RunProcessor {
  private readonly results: ResultStore;
  private readonly tasks: UploadTaskStore;
  private readonly settings: SettingsStore;
  /** manga id -> title; the replacement for the manga_data.json local cache. */
  private readonly mangaNames = new Map<string, string>();
  /** Per-run aggregate cache: volume backfill and the dupe sweep share it. */
  private aggregates = new Map<string, unknown>();
  private readonly maxRunsPerTick: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly md: MdApi,
    private readonly log: Logger,
    options: RunProcessorOptions = {},
  ) {
    this.results = new ResultStore(prisma);
    this.tasks = new UploadTaskStore(prisma);
    this.settings = new SettingsStore(prisma);
    this.maxRunsPerTick = options.maxRunsPerTick ?? 10;
  }

  /** Process every run currently waiting in INGESTING. Returns the count. */
  async tick(): Promise<number> {
    const attempted = new Set<string>();
    let processed = 0;

    for (let i = 0; i < this.maxRunsPerTick; i++) {
      const run = await this.claimRun(attempted);
      if (!run) break;
      attempted.add(run.id);

      try {
        await this.processRun(run);
        processed++;
      } catch (err) {
        // Deliberately left in INGESTING: the next tick retries, and every
        // effect this run may already have had is idempotent.
        this.log.error({ err, runId: run.id, extension: run.extension }, "run processing failed");
      }
    }
    return processed;
  }

  /**
   * Claim the least-recently-touched INGESTING run. FOR UPDATE SKIP LOCKED
   * plus bumping updated_at means concurrent processors pick different runs;
   * it is a soft claim rather than a lease, which is safe precisely because
   * processing is idempotent.
   */
  private async claimRun(exclude: Set<string>): Promise<ClaimedRun | null> {
    const excluded = exclude.size > 0 ? [...exclude] : ["00000000-0000-0000-0000-000000000000"];
    const rows = await this.prisma.$queryRaw<ClaimedRun[]>(Prisma.sql`
      WITH candidate AS (
        SELECT id FROM runs
        WHERE state = 'INGESTING' AND id <> ALL(${excluded}::uuid[])
        ORDER BY updated_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE runs r
      SET updated_at = now()
      FROM candidate
      WHERE r.id = candidate.id
      RETURNING r.id, r.extension, r.bundle_sha256 AS "bundleSha256", r.kind
    `);
    return rows[0] ?? null;
  }

  async processRun(run: ClaimedRun): Promise<void> {
    const log = this.log.child({ runId: run.id, extension: run.extension });
    this.aggregates = new Map();

    const { envelopes, missingJobs } = await this.loadEnvelopes(run.id, log);

    // A clean run decides what to DELETE from a "the publisher no longer has
    // this" premise. Acting on a partial view would remove chapters that a
    // missing segment would have vouched for, so refuse and stay in INGESTING.
    if (missingJobs > 0 && run.kind === "CLEAN") {
      log.error({ missingJobs }, "clean run is missing committed segments; refusing to process");
      return;
    }
    if (envelopes.length === 0) {
      log.warn("no committed envelopes for run; nothing to process");
      await this.markProcessed(run.id, log);
      return;
    }

    const merged = mergeEnvelopes(envelopes, run.extension);
    const manifest = await this.loadManifest(run.bundleSha256);
    const groupId = merged.groupId ?? manifest?.mangadex_group_id ?? null;
    if (!groupId) {
      log.error("no mangadex group id in envelopes or manifest; cannot process run");
      return;
    }
    const removalMode: RemovalMode =
      manifest?.chapter_removal_mode ?? (await this.settings.getRemovalMode());

    if (merged.untrackedManga.length > 0) {
      log.info(
        { untracked: merged.untrackedManga.length },
        "manga on the publisher that are not tracked on MangaDex",
      );
    }

    const updatedByManga = groupByMdManga(merged.updatedChapters);
    const allByManga = merged.allChapters === null ? null : groupByMdManga(merged.allChapters);
    const trackedIds = new Set(merged.trackedMangadexIds);

    await this.resolveMangaNames([...updatedByManga.keys()]);
    applyMangaNames(updatedByManga, this.mangaNames);
    if (allByManga) applyMangaNames(allByManga, this.mangaNames);

    // Accumulates every MangaDex chapter seen this run, keyed by manga — the
    // equivalent of ExtensionUploader.chapters_on_md.
    const chaptersOnMdByManga = new Map<string, MdChapter[]>();
    const totals = { upload: 0, edit: 0, skip: 0, remove: 0 };

    for (const [mangaId, updatedChapters] of updatedByManga) {
      const chaptersOnMd = await this.md.chaptersForManga(mangaId, groupId);
      for (const mdChapter of chaptersOnMd) {
        const owner = mdChapterMangaId(mdChapter) ?? mangaId;
        const bucket = chaptersOnMdByManga.get(owner);
        if (bucket) bucket.push(mdChapter);
        else chaptersOnMdByManga.set(owner, [mdChapter]);
      }

      backfillVolumes(updatedChapters, await this.aggregateFor(mangaId, groupId));

      const decision = decideForManga({
        mangadexMangaId: mangaId,
        updatedChapters,
        allMangaChapters: allByManga === null ? null : (allByManga.get(mangaId) ?? []),
        chaptersOnMd,
        // Uploads happen asynchronously off the UploadTask queue, so nothing
        // has been posted to MangaDex by the time this run is processed. The
        // Python equivalent (current_uploaded_chapters) was likewise empty
        // whenever the uploader ran out-of-process.
        postedMdUpdates: [],
        overrideOptions: merged.overrideOptions,
        languages: merged.languages,
        groupId,
        cleanDb: run.kind === "CLEAN",
      });

      for (const chapter of decision.toUpload) {
        await this.tasks.enqueue("UPLOAD", uploadDedupeKey(chapter), chapter);
      }
      for (const edit of decision.toEdit) {
        await this.tasks.enqueue("EDIT", edit.mdChapterId, {
          ...edit.chapter,
          oldInfo: edit.oldInfo,
          payload: edit.payload,
        });
      }
      await this.enqueueRemovals(decision.toRemove, mangaId, run.extension, groupId, removalMode);
      await this.recordUploaded(
        [...decision.toEdit.map((edit) => edit.chapter), ...decision.skipped],
        run.extension,
      );

      totals.upload += decision.toUpload.length;
      totals.edit += decision.toEdit.length;
      totals.skip += decision.skipped.length;
      totals.remove += decision.toRemove.length;

      if (decision.skippedDifferentId.length > 0) {
        log.debug(
          { mangaId, count: decision.skippedDifferentId.length },
          "chapters already uploaded under their master id (same override)",
        );
      }
      log.info(
        {
          mangaId,
          mangaName: this.mangaNames.get(mangaId) ?? null,
          upload: decision.toUpload.length,
          edit: decision.toEdit.length,
          skipped: decision.skipped.length,
          remove: decision.toRemove.length,
        },
        "manga processed",
      );
    }

    totals.remove += await this.removeUntrackedManga(
      chaptersOnMdByManga,
      trackedIds,
      run.extension,
      groupId,
      removalMode,
      log,
    );

    if (run.kind === "CLEAN" && allByManga !== null) {
      totals.remove += await this.removeMangaWithoutExternalChapters(
        merged.trackedMangadexIds,
        allByManga,
        run.extension,
        groupId,
        removalMode,
        log,
      );
    }

    const dupes = await this.deleteDuplicates(run, merged, updatedByManga, groupId, log);

    log.info({ ...totals, dupes }, "run processed");
    await this.markProcessed(run.id, log);
  }

  // -- envelope loading -----------------------------------------------------

  private async loadEnvelopes(
    runId: string,
    log: Logger,
  ): Promise<{ envelopes: ResultEnvelope[]; missingJobs: number }> {
    const jobs = await this.prisma.job.findMany({
      where: { runId },
      orderBy: { segmentIndex: "asc" },
    });

    const envelopes: ResultEnvelope[] = [];
    let missingJobs = 0;
    for (const job of jobs) {
      const submission = await this.results.committedForJob(job.id);
      if (!submission) {
        missingJobs++;
        log.warn({ jobId: job.id, segmentKey: job.segmentKey }, "job has no committed envelope");
        continue;
      }
      const parsed = ResultEnvelope.safeParse(submission.envelope);
      if (!parsed.success) {
        // Ingestion already validated this, so a failure here means the stored
        // row was tampered with or the schema moved under us.
        missingJobs++;
        log.error({ jobId: job.id }, "committed envelope no longer parses");
        continue;
      }
      envelopes.push(parsed.data);
    }
    return { envelopes, missingJobs };
  }

  private async loadManifest(bundleSha256: string): Promise<Manifest | null> {
    const bundle = await this.prisma.bundle.findUnique({ where: { sha256: bundleSha256 } });
    if (!bundle) return null;
    const parsed = Manifest.safeParse(bundle.manifest);
    return parsed.success ? parsed.data : null;
  }

  // -- MangaDex helpers -----------------------------------------------------

  private async aggregateFor(mangaId: string, groupId: string): Promise<unknown> {
    const cached = this.aggregates.get(mangaId);
    if (cached !== undefined) return cached;
    const aggregate = await this.md.mangaAggregate(mangaId, groupId);
    this.aggregates.set(mangaId, aggregate);
    return aggregate;
  }

  /** _get_manga_data_md: titles for manga ids we have not seen before. */
  private async resolveMangaNames(ids: string[]): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => id && !this.mangaNames.has(id));
    for (let i = 0; i < missing.length; i += 100) {
      const chunk = missing.slice(i, i + 100);
      const manga = await this.md.mangaByIds(chunk);
      for (const entry of manga) this.mangaNames.set(entry.id, formatTitle(entry));
    }
  }

  // -- writes ---------------------------------------------------------------

  /**
   * update_database: the canonical record of what this extension has on
   * MangaDex. Chapters without an md chapter id are skipped — there is nothing
   * to key them on, exactly as in Python.
   */
  private async recordUploaded(chapters: Chapter[], extension: string): Promise<void> {
    for (const chapter of chapters) {
      if (!chapter.mdChapterId) continue;

      const data = {
        extension,
        chapterId: chapter.chapterId,
        mdMangaId: chapter.mdMangaId,
        chapterLanguage: chapter.chapterLanguage,
        chapterNumber: chapter.chapterNumber,
        data: chapter as unknown as Prisma.InputJsonValue,
      };
      await this.prisma.uploadedChapter.upsert({
        where: { mdChapterId: chapter.mdChapterId },
        create: { mdChapterId: chapter.mdChapterId, ...data },
        update: data,
      });

      // uploaded_ids is insert-only: the FIRST MangaDex chapter an extension
      // chapter id mapped to is the one that stays recorded.
      if (chapter.chapterId) {
        await this.prisma.uploadedId.upsert({
          where: { extension_chapterId: { extension, chapterId: chapter.chapterId } },
          create: { extension, chapterId: chapter.chapterId, mdChapterId: chapter.mdChapterId },
          update: {},
        });
      }
    }
  }

  /**
   * enqueue_chapter_removal: route chapters that should leave MangaDex to
   * either the hard-delete queue or the "replace with an unavailable card"
   * queue, and drop them from the uploaded bookkeeping so nothing re-queues
   * them later.
   */
  private async enqueueRemovals(
    mdChapters: MdChapter[],
    mdMangaId: string,
    extension: string,
    groupId: string,
    mode: RemovalMode,
  ): Promise<void> {
    if (mdChapters.length === 0) return;
    const kind: UploadTaskKind = mode === "delete" ? "DELETE" : "UNAVAILABLE";
    const mangaName = this.mangaNames.get(mdMangaId) ?? null;

    for (const mdChapter of mdChapters) {
      await this.tasks.enqueue(
        kind,
        mdChapter.id,
        chapterFromMdChapter(mdChapter, { mdMangaId, extension, groupId, mangaName, mode }),
      );
      await this.prisma.uploadedChapter.deleteMany({ where: { mdChapterId: mdChapter.id } });
    }
  }

  private async markProcessed(runId: string, log: Logger): Promise<void> {
    const done = await this.prisma.run.updateMany({
      where: { id: runId, state: "INGESTING" },
      data: { state: "PROCESSED", completedAt: new Date() },
    });
    if (done.count !== 1) log.warn("run was no longer INGESTING when processing finished");
  }

  // -- cleanup passes -------------------------------------------------------

  /**
   * find_untracked_md_manga: chapters published under our group for a manga
   * the extension no longer tracks.
   *
   * Deviation: the Python original compared chapter dicts against a list of
   * manga ids, so the condition was never true and the pass never removed
   * anything. The intent — visible in its log message and its call to
   * enqueue_chapter_removal — is implemented here. In practice the candidate
   * set is tiny, because every manga reached in this pass came from the
   * extension's own updates.
   */
  private async removeUntrackedManga(
    chaptersOnMdByManga: Map<string, MdChapter[]>,
    trackedIds: Set<string>,
    extension: string,
    groupId: string,
    mode: RemovalMode,
    log: Logger,
  ): Promise<number> {
    const untracked = [...chaptersOnMdByManga.keys()].filter((id) => !trackedIds.has(id));
    if (untracked.length === 0) return 0;

    log.info({ untracked }, "manga on MangaDex under our group that the extension no longer tracks");
    await this.resolveMangaNames(untracked);

    let removed = 0;
    for (const mangaId of untracked) {
      const mdChapters = chaptersOnMdByManga.get(mangaId) ?? [];
      await this.enqueueRemovals(mdChapters, mangaId, extension, groupId, mode);
      removed += mdChapters.length;
    }
    return removed;
  }

  /**
   * remove_chapters_if_not_external (clean runs only): tracked manga for which
   * the publisher listed no chapters at all, but which still have chapters on
   * MangaDex under our group.
   */
  private async removeMangaWithoutExternalChapters(
    trackedIds: string[],
    allByManga: Map<string, Chapter[]>,
    extension: string,
    groupId: string,
    mode: RemovalMode,
    log: Logger,
  ): Promise<number> {
    const candidates = [...new Set(trackedIds)].filter((id) => !allByManga.has(id));
    if (candidates.length === 0) return 0;

    let removed = 0;
    const removedFrom: string[] = [];
    for (const mangaId of candidates) {
      const mdChapters = await this.md.chaptersForManga(mangaId, groupId);
      if (mdChapters.length === 0) continue;
      await this.resolveMangaNames([mangaId]);
      await this.enqueueRemovals(mdChapters, mangaId, extension, groupId, mode);
      removed += mdChapters.length;
      removedFrom.push(mangaId);
    }
    if (removedFrom.length > 0) {
      log.info({ manga: removedFrom }, "removing chapters on MangaDex but no longer on the publisher");
    }
    return removed;
  }

  /**
   * DeleteDuplicatesMD.delete_dupes. Duplicates are always hard-deleted,
   * whatever the removal mode: an "unavailable" card on a duplicate would
   * simply leave the duplicate in place.
   */
  private async deleteDuplicates(
    run: ClaimedRun,
    merged: MergedResults,
    updatedByManga: Map<string, Chapter[]>,
    groupId: string,
    log: Logger,
  ): Promise<number> {
    const mangaIds =
      run.kind === "CLEAN"
        ? merged.trackedMangadexIds
        : updatedByManga.size > 0
          ? [...updatedByManga.keys()]
          : merged.trackedMangadexIds;

    const languages = new Set(merged.languages);
    const multiChapters = merged.overrideOptions.multi_chapters ?? {};
    let deleted = 0;

    for (const mangaId of new Set(mangaIds)) {
      const chapterIds = aggregateChapterIds(await this.aggregateFor(mangaId, groupId));
      if (chapterIds.length === 0) continue;

      const chapters = await this.md.chaptersByIds([...new Set(chapterIds)]);
      // The Python aggregate request filtered by the extension's languages;
      // this client cannot, so the filter is applied to the fetched chapters.
      const inLanguage =
        languages.size > 0
          ? chapters.filter((c) => languages.has(c.attributes.translatedLanguage))
          : chapters;

      const dupes = findDuplicateChapters(inLanguage, { groupId, multiChapters });
      if (dupes.length === 0) continue;

      log.info({ mangaId, dupes: dupes.map((c) => c.id) }, "found duplicate chapters to delete");
      await this.resolveMangaNames([mangaId]);
      await this.enqueueRemovals(dupes, mangaId, run.extension, groupId, "delete");
      deleted += dupes.length;
    }
    return deleted;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Segments of one run cover disjoint sets of manga, so their chapter lists
 * concatenate. `allChapters` is the exception: it means "this is everything
 * the publisher has", and a single segment that declined to answer makes the
 * merged view incomplete — which would turn the removal passes into mass
 * deletions. Any null therefore collapses the whole thing to null.
 */
export function mergeEnvelopes(envelopes: ResultEnvelope[], extension: string): MergedResults {
  const updatedChapters: Chapter[] = [];
  const allChapters: Chapter[] = [];
  let allChaptersComplete = true;
  const untrackedManga = new Map<string, MangaRecord>();
  const trackedMangadexIds = new Set<string>();
  let overrideOptions: OverrideOptionsLike = {};
  let languages: string[] = [];
  let groupId: string | null = null;

  for (const envelope of envelopes) {
    for (const record of envelope.updatedChapters) {
      updatedChapters.push(chapterFromRecord(record, extension));
    }
    if (envelope.allChapters === null) {
      allChaptersComplete = false;
    } else {
      for (const record of envelope.allChapters) {
        allChapters.push(chapterFromRecord(record, extension));
      }
    }
    for (const manga of envelope.untrackedManga) untrackedManga.set(manga.mangaId, manga);
    for (const id of envelope.trackedMangadexIds) trackedMangadexIds.add(id);

    // Identical across segments of a run; first non-empty wins.
    if (Object.keys(envelope.overrideOptions).length > 0 && Object.keys(overrideOptions).length === 0) {
      overrideOptions = envelope.overrideOptions as OverrideOptionsLike;
    }
    if (envelope.extensionLanguages.length > 0 && languages.length === 0) {
      languages = envelope.extensionLanguages;
    }
    groupId ??= envelope.mangadexGroupId;
  }

  return {
    updatedChapters,
    allChapters: allChaptersComplete ? allChapters : null,
    untrackedManga: [...untrackedManga.values()],
    trackedMangadexIds: [...trackedMangadexIds],
    overrideOptions,
    languages,
    groupId,
  };
}

/** _sort_chapters_by_manga: chapters without a MangaDex manga id are dropped. */
function groupByMdManga(chapters: Chapter[]): Map<string, Chapter[]> {
  const sorted = new Map<string, Chapter[]>();
  for (const chapter of chapters) {
    const mdMangaId = chapter.mdMangaId;
    if (!mdMangaId || mdMangaId === "None") continue;
    const bucket = sorted.get(mdMangaId);
    if (bucket) bucket.push(chapter);
    else sorted.set(mdMangaId, [chapter]);
  }
  return sorted;
}

/** The MangaDex title wins over whatever the extension called the manga. */
function applyMangaNames(byManga: Map<string, Chapter[]>, names: Map<string, string>): void {
  for (const [mangaId, chapters] of byManga) {
    const name = names.get(mangaId);
    if (!name) continue;
    for (const chapter of chapters) chapter.mangaName = name;
  }
}

/**
 * The md-chapter -> Chapter conversion from update_expired_chapter_database /
 * mark_chapters_unavailable. `unavailableAt` rides along on the queued JSON
 * for the unavailable worker, which stamps it on the generated chapter card.
 *
 * Deviation: Python wrote a 1990-01-01 sentinel into chapter_timestamp and
 * chapter_expire to mean "already expired", because a sweep over the uploaded
 * collection re-read those fields. Removal is queue-driven here and the
 * uploaded row is deleted outright, so the sentinel would only be misleading
 * date data — both fields are null.
 */
export function chapterFromMdChapter(
  mdChapter: MdChapter,
  context: {
    mdMangaId: string;
    extension: string;
    groupId: string;
    mangaName: string | null;
    mode: RemovalMode;
  },
): Chapter & { unavailableAt?: string } {
  const attrs = mdChapter.attributes;
  const now = new Date().toISOString();

  const chapter: Chapter & { unavailableAt?: string } = {
    chapterLookup: now,
    chapterTimestamp: null,
    chapterExpire: null,
    chapterLanguage: attrs.translatedLanguage,
    chapterNumber: attrs.chapter,
    chapterTitle: attrs.title,
    chapterVolume: attrs.volume,
    chapterId: null,
    chapterUrl: attrs.externalUrl,
    mdChapterId: mdChapter.id,
    mangaId: null,
    mdMangaId: context.mdMangaId,
    mdGroupId: context.groupId,
    mangaName: context.mangaName,
    mangaUrl: null,
    extensionName: context.extension,
    imageArtifacts: [],
  };
  if (context.mode === "unavailable") chapter.unavailableAt = now;
  return chapter;
}
