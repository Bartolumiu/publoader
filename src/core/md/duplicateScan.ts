import type { PrismaClient } from "@prisma/client";
import type { Logger } from "../../logging.js";
import type { AuditLog } from "../store/settings.js";
import { ExtensionConfigStore } from "../store/extensionConfig.js";
import { UploadTaskStore } from "../store/uploadTasks.js";
import type { MdExtendedApi } from "./client.js";
import { ReconcilePlan, type ReconcileStep } from "./reconcilePlan.js";
import { findDuplicateChapters, formatTitle, mdChapterMangaId } from "../processor/dedupe.js";
import { chapterFromMdChapter } from "./chapterRows.js";
import { isCarded, type MdChapter } from "./types.js";

/**
 * Find the chapters MangaDex holds twice, per series, without running an
 * extension.
 *
 * WHY THIS EXISTS. Duplicates were only ever detected as a side effect of a
 * run: `deleteDuplicates` in the processor looks at the series a run touched,
 * with the override options that run carried. That is the right place to catch
 * the duplicate a run just created, and the wrong place to answer "does this
 * series have duplicates?" — the answer needs the extension to be runnable, its
 * source to be reachable, and the series to be one the run happened to visit.
 * A series whose publisher is gone, or one that simply was not in this run's
 * scope, is unanswerable that way, and those are exactly the series that
 * accumulate duplicates.
 *
 * Nothing here needs the publisher. A duplicate is a property of what MangaDex
 * holds: two chapters of the same series, same language, pointing at the same
 * publisher link (or, for page chapters, carrying the same volume and number).
 * So the scan reads MangaDex and nothing else, which makes it runnable at any
 * time, against any series, with no extension bundle involved.
 *
 * The decision itself is NOT reimplemented here. `findDuplicateChapters` is the
 * same function the processor uses, so a scan and a run can never disagree
 * about what a duplicate is, and the card exclusion that function carries (a
 * chapter marked unavailable has every other card's externalUrl, so on the
 * duplicate key they all collapse into one bucket) protects this path for free.
 *
 * WHAT IT DOES WITH THEM. Nothing, unless asked. The default is a report: which
 * series, which chapters, which one would survive. `apply` queues a DELETE
 * task per doomed chapter, which is the same route every other operator
 * deletion takes — core-uploader is the only process that writes to MangaDex,
 * so this queues rather than deletes, and the queue is where an operator can
 * still cancel it.
 *
 * Duplicates are always hard-deleted, never carded, whatever the extension's
 * removal mode. A card on a duplicate leaves the duplicate in place and adds a
 * page to it; the point of removing it is that it should not be there at all.
 */

export interface DuplicateScanOptions {
  /** Restrict to these extensions; empty means every group we have uploaded to. */
  extensions: string[];
  /**
   * Restrict to these MangaDex title ids.
   *
   * Also changes how the chapters are FETCHED: a scoped scan asks per series,
   * an unscoped one walks the whole group once. See `chaptersFor`.
   */
  mangaIds: string[];
  /** Queue a DELETE for every duplicate found. False reports and writes nothing. */
  apply: boolean;
  /** Who asked, for the audit trail. */
  actor: string;
}

/** What became of one duplicate this scan decided to remove. */
export type DuplicateOutcome =
  | "found"
  | "queued"
  | "requeued"
  | "already_queued"
  | "leased"
  | "failed";

export interface DuplicateChapterRow {
  mdChapterId: string;
  chapterNumber: string | null;
  chapterVolume: string | null;
  chapterTitle: string | null;
  chapterLanguage: string;
  /** The publisher link, which for an external chapter is its identity. */
  chapterUrl: string | null;
  createdAt: string;
}

export interface DuplicateRemoval extends DuplicateChapterRow {
  outcome: DuplicateOutcome;
  taskId?: string;
  /** Why it was not queued, when it was not. */
  reason?: string;
}

/** One bucket of chapters that are the same chapter. */
export interface DuplicateSet {
  /**
   * What made them the same: the identical publisher link, or — for chapters
   * with no link, i.e. ones whose pages are hosted on MangaDex — the same
   * volume and chapter number.
   */
  matchedOn: "url" | "number";
  language: string;
  /** The oldest, which is the one that stays. */
  keep: DuplicateChapterRow;
  remove: DuplicateRemoval[];
}

export interface DuplicateSeries {
  extension: string;
  groupId: string;
  mdMangaId: string;
  mangaName: string | null;
  /** How many of this series' chapters the group has on MangaDex. */
  chaptersOnMd: number;
  duplicates: DuplicateSet[];
  /** Chapters this series would lose; the sum of `remove` across its sets. */
  removeCount: number;
}

export interface DuplicateGroupSummary {
  extension: string;
  groupId: string;
  chaptersOnMd: number;
  seriesScanned: number;
  seriesWithDuplicates: number;
  duplicatesFound: number;
  queued: number;
}

export interface DuplicateScanReport {
  apply: boolean;
  groups: DuplicateGroupSummary[];
  /**
   * The affected series, worst first. Only series WITH duplicates appear: a
   * clean series has nothing to show and there are hundreds of them.
   */
  series: DuplicateSeries[];
  seriesScanned: number;
  seriesWithDuplicates: number;
  duplicatesFound: number;
  /** Duplicates a DELETE was queued for. Always 0 on a report-only scan. */
  queued: number;
  /**
   * Duplicates `apply` did not queue. Almost always because the chapter already
   * has a delete waiting or in flight, which is not a failure — the deletion is
   * already coming; the per-chapter `outcome` says which case it was.
   */
  blocked: number;
  /** Series with duplicates that `series` does not list, for size. */
  truncatedSeries: number;
}

export interface DuplicateScanProgress {
  steps: ReconcileStep[];
}

export interface DuplicateScanDeps {
  prisma: PrismaClient;
  md: MdExtendedApi;
  log: Logger;
  audit: AuditLog;
  /** Called as the scan advances, with the whole step list. Never awaited. */
  onProgress?: (progress: DuplicateScanProgress) => void;
}

/**
 * Series detailed in the report.
 *
 * The report is stored as one JSON blob in a settings row and rendered as a
 * table, so it has to stay a readable size. The COUNTS are never capped — a
 * scan that found duplicates in 900 series says 900 — and `apply` does its work
 * during the scan rather than from this list, so nothing an operator can act on
 * is lost by trimming the display.
 */
const SERIES_LIMIT = 200;

/** Title ids per `mangaByIds` request. */
const TITLE_BATCH = 100;

export class DuplicateScanner {
  private readonly plan = new ReconcilePlan((steps) => {
    try {
      this.deps.onProgress?.({ steps });
    } catch (error) {
      this.deps.log.warn({ error }, "duplicate scan progress sink threw");
    }
  });

  private readonly tasks: UploadTaskStore;
  private readonly config: ExtensionConfigStore;

  constructor(private readonly deps: DuplicateScanDeps) {
    this.tasks = new UploadTaskStore(deps.prisma);
    this.config = new ExtensionConfigStore(deps.prisma);
  }

  /** The steps as they stand, for a caller that needs them after a failure. */
  steps(): ReconcileStep[] {
    return this.plan.snapshot();
  }

  async run(options: DuplicateScanOptions): Promise<DuplicateScanReport> {
    try {
      return await this.scan(options);
    } catch (error) {
      this.plan.fail(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async scan(options: DuplicateScanOptions): Promise<DuplicateScanReport> {
    const report: DuplicateScanReport = {
      apply: options.apply,
      groups: [],
      series: [],
      seriesScanned: 0,
      seriesWithDuplicates: 0,
      duplicatesFound: 0,
      queued: 0,
      blocked: 0,
      truncatedSeries: 0,
    };

    this.plan.start(this.plan.add("groups", "Find which groups we have uploaded to"));
    const groups = await this.groups(options.extensions);
    this.plan.finish("groups", groups.length);

    for (const { extension, groupId } of groups) {
      this.plan.add(`read:${groupId}`, `Read ${extension}'s chapters on MangaDex`);
      this.plan.add(`scan:${groupId}`, `Compare ${extension}'s chapters series by series`);
      if (options.apply) {
        this.plan.add(`delete:${groupId}`, `Queue ${extension}'s duplicates for deletion`);
      }
    }

    const affected: DuplicateSeries[] = [];
    for (const { extension, groupId } of groups) {
      report.groups.push(await this.scanGroup(extension, groupId, options, report, affected));
    }

    // Worst first: an operator looking at this wants the series that is wrong
    // in twelve places before the one that is wrong once.
    affected.sort((a, b) => b.removeCount - a.removeCount);
    report.series = affected.slice(0, SERIES_LIMIT);
    report.truncatedSeries = affected.length - report.series.length;

    if (options.apply && report.queued > 0) {
      await this.deps.audit.record(
        options.actor,
        "chapters.duplicates.delete",
        options.extensions.join(",") || "all extensions",
        {
          extensions: options.extensions,
          mangaIds: options.mangaIds,
          queued: report.queued,
          blocked: report.blocked,
          duplicatesFound: report.duplicatesFound,
        },
      );
    }

    this.deps.log.info(
      {
        apply: options.apply,
        series: report.seriesScanned,
        withDuplicates: report.seriesWithDuplicates,
        duplicates: report.duplicatesFound,
        queued: report.queued,
      },
      "duplicate scan finished",
    );
    return report;
  }

  /**
   * The (extension, group) pairs to ask about, read from what has actually been
   * uploaded rather than from configuration — the same rule, and for the same
   * reason, as ChapterReconciler.groups: a manifest describes what the next run
   * will do, while the chapter tables describe whose chapters are already out
   * there, which is the set that can contain duplicates.
   */
  private async groups(extensions: string[]): Promise<{ extension: string; groupId: string }[]> {
    const rows = await this.deps.prisma.uploadedChapter.findMany({
      where: {
        mdGroupId: { not: null },
        ...(extensions.length > 0 ? { extension: { in: extensions } } : {}),
      },
      distinct: ["extension", "mdGroupId"],
      select: { extension: true, mdGroupId: true },
    });
    const pairs = new Map<string, { extension: string; groupId: string }>();
    for (const row of rows) {
      if (!row.mdGroupId) continue;
      pairs.set(`${row.extension} ${row.mdGroupId}`, { extension: row.extension, groupId: row.mdGroupId });
    }
    return [...pairs.values()];
  }

  private async scanGroup(
    extension: string,
    groupId: string,
    options: DuplicateScanOptions,
    report: DuplicateScanReport,
    affected: DuplicateSeries[],
  ): Promise<DuplicateGroupSummary> {
    const summary: DuplicateGroupSummary = {
      extension,
      groupId,
      chaptersOnMd: 0,
      seriesScanned: 0,
      seriesWithDuplicates: 0,
      duplicatesFound: 0,
      queued: 0,
    };

    const read = `read:${groupId}`;
    this.plan.start(read);
    const bySeries = await this.chaptersFor(groupId, options.mangaIds, (collected, total) =>
      this.plan.advance(read, collected, total),
    );
    for (const chapters of bySeries.values()) summary.chaptersOnMd += chapters.length;
    this.plan.finish(read, summary.chaptersOnMd, `${bySeries.size} series`);

    // The override options belong to the extension, not to a run, so they are
    // read here rather than taken from a result envelope. `multi_chapters` is
    // the one that matters: one source chapter that legitimately backs several
    // MangaDex chapter numbers is not a duplicate, and without this a merged
    // release loses every number but one on the first --apply.
    const multiChapters = (await this.config.loadForProcessor(extension)).multi_chapters ?? {};

    const scan = `scan:${groupId}`;
    this.plan.start(scan, bySeries.size);
    const found: { series: DuplicateSeries; chapters: MdChapter[] }[] = [];
    let scanned = 0;
    for (const [mdMangaId, chapters] of bySeries) {
      scanned += 1;
      this.plan.advance(scan, scanned);

      const dupes = findDuplicateChapters(chapters, { groupId, multiChapters });
      if (dupes.length === 0) continue;

      const series: DuplicateSeries = {
        extension,
        groupId,
        mdMangaId,
        mangaName: null,
        chaptersOnMd: chapters.length,
        duplicates: buildSets(chapters, dupes, groupId),
        removeCount: dupes.length,
      };
      found.push({ series, chapters: dupes });
      summary.seriesWithDuplicates += 1;
      summary.duplicatesFound += dupes.length;
    }
    summary.seriesScanned = bySeries.size;
    report.seriesScanned += bySeries.size;
    report.seriesWithDuplicates += summary.seriesWithDuplicates;
    report.duplicatesFound += summary.duplicatesFound;
    this.plan.finish(scan, bySeries.size, `${summary.duplicatesFound} duplicate chapter(s)`);

    const names = await this.mangaNames(found.map((entry) => entry.series.mdMangaId));
    for (const entry of found) entry.series.mangaName = names.get(entry.series.mdMangaId) ?? null;

    if (options.apply) {
      const step = `delete:${groupId}`;
      this.plan.start(step, summary.duplicatesFound);
      let done = 0;
      for (const entry of found) {
        for (const set of entry.series.duplicates) {
          for (const removal of set.remove) {
            const chapter = entry.chapters.find((c) => c.id === removal.mdChapterId);
            if (!chapter) continue;
            const result = await this.queueDelete(chapter, {
              extension,
              groupId,
              mdMangaId: entry.series.mdMangaId,
              mangaName: entry.series.mangaName,
            });
            removal.outcome = result.outcome;
            if (result.taskId) removal.taskId = result.taskId;
            if (result.reason) removal.reason = result.reason;
            if (result.outcome === "queued" || result.outcome === "requeued") {
              report.queued += 1;
              summary.queued += 1;
            } else {
              report.blocked += 1;
            }
            this.plan.advance(step, (done += 1));
          }
        }
      }
      this.plan.finish(step, summary.queued, `${summary.queued} queued`);
    }

    affected.push(...found.map((entry) => entry.series));
    return summary;
  }

  /**
   * The group's chapters, bucketed by series.
   *
   * Two fetch shapes, and the choice is about cost rather than correctness.
   * Unscoped, one walk of the whole group is ~60 paginated requests for 6000
   * chapters, against one request per series — hundreds — for the same
   * chapters. Scoped to a handful of titles that reverses completely, so a
   * scoped scan asks per series and pays for exactly what it looked at.
   *
   * A chapter with no manga relationship is dropped: it cannot be compared
   * against a series, and the duplicate key is only meaningful within one.
   */
  private async chaptersFor(
    groupId: string,
    mangaIds: string[],
    onProgress: (collected: number, total: number | null) => void,
  ): Promise<Map<string, MdChapter[]>> {
    const bySeries = new Map<string, MdChapter[]>();

    if (mangaIds.length > 0) {
      let collected = 0;
      for (const mangaId of [...new Set(mangaIds)]) {
        const chapters = await this.deps.md.chaptersForManga(mangaId, groupId);
        collected += chapters.length;
        onProgress(collected, null);
        // Reversed, because `chaptersForManga` asks MangaDex for newest-first
        // and the group walk asks for oldest-first. That difference is not
        // cosmetic: `findDuplicateChapters` keeps the OLDEST of a bucket, and
        // where MangaDex omitted `createdAt` it falls back to input order — so
        // left as it came, a scoped scan would keep the newest copy and delete
        // the original, which is the opposite of what an unscoped one does to
        // the same chapters.
        chapters.reverse();
        // Recorded even when empty, so a scoped scan reports "this series was
        // looked at and has nothing" rather than silently omitting it.
        bySeries.set(mangaId, chapters);
      }
      return bySeries;
    }

    for (const chapter of await this.deps.md.chaptersForGroup(groupId, onProgress)) {
      const mdMangaId = mdChapterMangaId(chapter);
      if (!mdMangaId) continue;
      const bucket = bySeries.get(mdMangaId);
      if (bucket) bucket.push(chapter);
      else bySeries.set(mdMangaId, [chapter]);
    }
    return bySeries;
  }

  /**
   * Series titles for the report, taken from our own rows first.
   *
   * Only the affected series are ever asked about, and our chapter tables
   * already carry the name for most of them, so the MangaDex request is usually
   * for a handful of adopted series or none at all.
   */
  private async mangaNames(mdMangaIds: string[]): Promise<Map<string, string>> {
    const wanted = [...new Set(mdMangaIds)];
    const names = new Map<string, string>();
    if (wanted.length === 0) return names;

    const rows = await this.deps.prisma.uploadedChapter.findMany({
      where: { mdMangaId: { in: wanted }, mangaName: { not: null } },
      distinct: ["mdMangaId"],
      select: { mdMangaId: true, mangaName: true },
    });
    for (const row of rows) {
      if (row.mdMangaId && row.mangaName) names.set(row.mdMangaId, row.mangaName);
    }

    const missing = wanted.filter((id) => !names.has(id));
    for (let i = 0; i < missing.length; i += TITLE_BATCH) {
      const batch = missing.slice(i, i + TITLE_BATCH);
      try {
        for (const manga of await this.deps.md.mangaByIds(batch)) {
          names.set(manga.id, formatTitle(manga));
        }
      } catch (error) {
        // A title we cannot name is shown by its id. Losing the scan over a
        // cosmetic lookup would be the worse trade.
        this.deps.log.warn({ error }, "could not read series titles for the duplicate report");
        break;
      }
    }
    return names;
  }

  /**
   * Queue one duplicate for deletion.
   *
   * `requeueForChapter` rather than `enqueue`, because this is an operator
   * action: a settled task for the same chapter must not make the second
   * request silently do nothing. A PENDING or LEASED task is left alone and
   * reported — the deletion is already on its way, and re-arming a row an
   * uploader is mid-flight against is how a chapter gets deleted twice.
   */
  private async queueDelete(
    mdChapter: MdChapter,
    context: { extension: string; groupId: string; mdMangaId: string; mangaName: string | null },
  ): Promise<{ outcome: DuplicateOutcome; taskId?: string; reason?: string }> {
    const chapter = chapterFromMdChapter(mdChapter, { ...context, mode: "delete" });
    try {
      const queued = await this.tasks.requeueForChapter("DELETE", mdChapter.id, chapter);
      if (queued) {
        return { outcome: queued.superseded ? "requeued" : "queued", taskId: queued.task.id };
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.deps.log.warn({ error, mdChapterId: mdChapter.id }, "could not queue a duplicate deletion");
      return { outcome: "failed", reason };
    }

    // Only to NAME what is holding the slot; the decision not to write was
    // already made above. A failure here therefore downgrades the message
    // rather than the outcome: the chapter is still spoken for either way, and
    // losing an unscoped scan to a read that exists to phrase a sentence would
    // be the worse trade.
    let existing;
    try {
      existing = (await this.tasks.forDedupeKey(mdChapter.id)).find((task) => task.kind === "DELETE");
    } catch (error) {
      this.deps.log.warn({ error, mdChapterId: mdChapter.id }, "could not read the queue row holding this chapter");
      return {
        outcome: "already_queued",
        reason: "something is already queued for this chapter; the queue could not be read to say what",
      };
    }

    return existing?.state === "LEASED"
      ? {
          outcome: "leased",
          taskId: existing.id,
          reason: "an uploader is deleting this chapter right now",
        }
      : {
          outcome: "already_queued",
          taskId: existing?.id,
          reason: "a delete for this chapter is already queued and has not run yet",
        };
  }
}

/**
 * Turn "these chapters are the surplus" back into "these are the buckets they
 * came from".
 *
 * `findDuplicateChapters` returns the chapters to remove and nothing else,
 * which is all a run needs. An operator deciding whether to go through with it
 * needs the other half: which chapter survives, and what made the two of them
 * the same chapter in the first place. Re-derived here rather than returned
 * from the decision function, so the shared decision keeps exactly one job.
 */
export function buildSets(
  chapters: MdChapter[],
  toRemove: MdChapter[],
  groupId?: string,
): DuplicateSet[] {
  const doomed = new Set(toRemove.map((chapter) => chapter.id));
  const buckets = new Map<string, { matchedOn: "url" | "number"; language: string; members: MdChapter[] }>();

  // The same two exclusions the decision applies, because this has to describe
  // the buckets it actually compared. A chapter carrying our unavailable card
  // has its externalUrl repointed at the series page — the same URL for every
  // card of that series — so left in, it joins whatever bucket shares that URL
  // and can end up named as the survivor of a decision it took no part in.
  const compared = chapters.filter(
    (chapter) =>
      !isCarded(chapter) &&
      (groupId === undefined ||
        chapter.relationships.some((rel) => rel.type === "scanlation_group" && rel.id === groupId)),
  );

  for (const chapter of compared) {
    const attrs = chapter.attributes;
    const matchedOn = attrs.externalUrl ? "url" : "number";
    const key = attrs.externalUrl
      ? `${attrs.translatedLanguage} url ${attrs.externalUrl}`
      : `${attrs.translatedLanguage} number ${attrs.volume ?? ""} ${attrs.chapter ?? ""}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.members.push(chapter);
    else buckets.set(key, { matchedOn, language: attrs.translatedLanguage, members: [chapter] });
  }

  const sets: DuplicateSet[] = [];
  for (const bucket of buckets.values()) {
    const remove = bucket.members.filter((chapter) => doomed.has(chapter.id));
    if (remove.length === 0) continue;
    // Whatever the decision spared, oldest first — which is the one the
    // decision keeps, and the reason this sorts rather than trusting input
    // order: a scoped fetch and a group walk hand their chapters over in
    // opposite orders. `multi_chapters` can spare more than one, so the
    // headline is the oldest survivor rather than the only one.
    const kept = bucket.members
      .filter((chapter) => !doomed.has(chapter.id))
      .sort((a, b) => (a.attributes.createdAt < b.attributes.createdAt ? -1 : 1));
    const keep = kept[0] ?? remove[0];
    if (!keep) continue;
    sets.push({
      matchedOn: bucket.matchedOn,
      language: bucket.language,
      keep: rowOf(keep),
      remove: remove.map((chapter) => ({ ...rowOf(chapter), outcome: "found" as DuplicateOutcome })),
    });
  }
  return sets;
}

function rowOf(chapter: MdChapter): DuplicateChapterRow {
  const attrs = chapter.attributes;
  return {
    mdChapterId: chapter.id,
    chapterNumber: attrs.chapter,
    chapterVolume: attrs.volume,
    chapterTitle: attrs.title,
    chapterLanguage: attrs.translatedLanguage,
    chapterUrl: attrs.externalUrl,
    createdAt: attrs.createdAt,
  };
}
