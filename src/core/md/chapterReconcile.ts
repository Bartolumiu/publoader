import { Prisma, type PrismaClient } from "@prisma/client";
import type { Logger } from "../../logging.js";
import type { AuditLog } from "../store/settings.js";
import type { MdEntity, MdExtendedApi } from "./client.js";

/**
 * Rebuild the chapter archives from what MangaDex actually holds.
 *
 * `unavailable_chapters` and `deleted_chapters` are written only by the upload
 * task workers (taskWorkers.ts), at the moment those workers act. That makes
 * them a log of actions rather than a description of the catalogue, and the two
 * come apart whenever the log is incomplete: a database restored without them,
 * a migration, work done before the tables existed. MangaDex still carries the
 * evidence; nothing here was reading it back.
 *
 * WHAT "MARKED UNAVAILABLE" LOOKS LIKE ON MANGADEX. An external chapter, the
 * only kind this platform publishes, normally has no pages at all: the reader
 * follows `externalUrl` to the publisher. Marking one unavailable replaces that
 * with a card, and the card is a page. So:
 *
 *     externalUrl && pages > 0   ->  carries our card, i.e. marked unavailable
 *     externalUrl && pages === 0 ->  live
 *
 * On the live group that separates without a single ambiguous case: 112 carded
 * chapters, every one with exactly one page, against 6108 live ones with none.
 * The `externalUrl` of a carded chapter is no help on its own; the card flow
 * repoints it at the series or domain root rather than clearing it, which is
 * why the page count is the signal and the URL is not.
 *
 * Two passes, and they are not variations of one thing:
 *
 *   discover   Walk our groups' chapters on MangaDex and archive the carded
 *              ones. This CANNOT be expressed as a sweep of `uploaded_chapters`:
 *              on a database whose upload history is younger than the
 *              catalogue, the carded chapters have no row there at all.
 *              Measured on the live deployment, the overlap was zero. So the
 *              archive row is seeded from the MangaDex record itself.
 *
 *   reconcile  Sweep `uploaded_chapters` for rows MangaDex no longer has, and
 *              archive those as deleted. Deletions can only be found this way
 *              round: a chapter that is gone cannot be enumerated, so the only
 *              evidence is our own memory of having uploaded it.
 *
 * Separately reported and never archived: chapters MangaDex itself refuses to
 * serve while they still have no card. That is MangaDex hiding a chapter rather
 * than us having marked it, so it is not an archive row; it is a list of
 * chapters that arguably want an UNAVAILABLE task, which is an operator's call.
 *
 * Both passes are idempotent. An id already in an archive keeps the timestamp
 * it already has: that instant is when the change was first seen, and a later
 * sweep does not know better.
 */

/**
 * Does this MangaDex record carry one of our cards?
 *
 * Both halves matter. `pages > 0` alone would sweep in any natively hosted
 * chapter, and `externalUrl` alone describes every chapter we have ever
 * published, live ones included.
 */
export function isCarded(attributes: Record<string, unknown>): boolean {
  const external = attributes["externalUrl"];
  const pages = attributes["pages"];
  return typeof external === "string" && external !== "" && typeof pages === "number" && pages > 0;
}

export interface ReconcileOptions {
  /** Classify and report, write nothing. */
  dryRun: boolean;
  /** Restrict to these extensions; empty means every group we know of. */
  extensions?: string[];
  /** Skip the uploaded_chapters sweep (the slow half on a large table). */
  skipDeleted?: boolean;
  /** Who asked, for the audit trail. */
  actor: string;
}

export interface ReconcileGroup {
  extension: string;
  groupId: string;
  /** Chapters MangaDex holds for this group. */
  total: number;
  /** Of those, the ones carrying one of our cards. */
  carded: number;
  /** Of those, the ones we had not already archived. */
  recorded: number;
  /** Uncarded chapters MangaDex will not serve. Reported, never archived. */
  hiddenOnMangadex: number;
}

export interface ReconcileReport {
  dryRun: boolean;
  groups: ReconcileGroup[];
  /** Carded chapters found across every group. */
  unavailableFound: number;
  /** …of which newly written (the rest were already archived). */
  unavailableRecorded: number;
  /** uploaded_chapters rows examined by the second pass. */
  scanned: number;
  deletedFound: number;
  deletedRecorded: number;
  /**
   * Chapters MangaDex will not serve that carry no card of ours; MangaDex
   * hiding a chapter rather than us having marked it. Never archived: these are
   * candidates for an UNAVAILABLE task, which is an operator's decision.
   */
  hiddenOnMangadex: string[];
}

export interface ReconcileDeps {
  prisma: PrismaClient;
  md: MdExtendedApi;
  log: Logger;
  audit: AuditLog;
}

/** uploaded_chapters rows held in memory at once while sweeping. */
const ROW_BATCH = 100;

export class ChapterReconciler {
  constructor(private readonly deps: ReconcileDeps) {}

  async run(options: ReconcileOptions): Promise<ReconcileReport> {
    const report: ReconcileReport = {
      dryRun: options.dryRun,
      groups: [],
      unavailableFound: 0,
      unavailableRecorded: 0,
      scanned: 0,
      deletedFound: 0,
      deletedRecorded: 0,
      hiddenOnMangadex: [],
    };

    for (const { extension, groupId } of await this.groups(options.extensions ?? [])) {
      report.groups.push(await this.discoverGroup(extension, groupId, options, report));
    }
    if (!options.skipDeleted) await this.sweepUploaded(options, report);

    if (!options.dryRun) {
      await this.deps.audit.record(options.actor, "chapters.reconcile", "mangadex", {
        unavailable: report.unavailableRecorded,
        deleted: report.deletedRecorded,
        groups: report.groups.map((group) => group.groupId),
      });
    }
    return report;
  }

  /**
   * The (extension, group) pairs to ask about, taken from the chapter tables
   * rather than from configuration.
   *
   * An extension's group id lives in its manifest or its override options, both
   * of which describe what the *next* run will do. What has actually been
   * uploaded is the honest answer to "whose chapters are ours", it needs no
   * plumbing to stay current, and an extension that has never uploaded anything
   * has nothing to reconcile in the first place.
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
      pairs.set(`${row.extension} ${row.mdGroupId}`, {
        extension: row.extension,
        groupId: row.mdGroupId,
      });
    }
    return [...pairs.values()];
  }

  /** Archive every chapter of one group that carries one of our cards. */
  private async discoverGroup(
    extension: string,
    groupId: string,
    options: ReconcileOptions,
    report: ReconcileReport,
  ): Promise<ReconcileGroup> {
    const { all, served } = await this.deps.md.chapterAvailabilityForGroup(groupId);

    const carded: [string, MdEntity][] = [];
    let hiddenOnMangadex = 0;
    for (const [id, entity] of all) {
      if (isCarded(entity.attributes ?? {})) {
        carded.push([id, entity]);
        continue;
      }
      // Uncarded and MangaDex will not serve it: hidden by MangaDex, not by us.
      if (!served.has(id)) {
        hiddenOnMangadex += 1;
        report.hiddenOnMangadex.push(id);
      }
    }
    this.deps.log.info(
      { extension, groupId, total: all.size, carded: carded.length, hiddenOnMangadex },
      "group measured",
    );

    let recorded = 0;
    for (const [mdChapterId, entity] of carded) {
      report.unavailableFound += 1;
      if (await this.alreadyArchived(mdChapterId)) continue;
      recorded += 1;
      report.unavailableRecorded += 1;
      if (!options.dryRun) await this.archiveUnavailable(mdChapterId, extension, groupId, entity);
    }
    return { extension, groupId, total: all.size, carded: carded.length, recorded, hiddenOnMangadex };
  }

  /**
   * Walk `uploaded_chapters` and archive the rows MangaDex no longer has.
   *
   * Carded chapters are handled here too, for the rows the group pass could not
   * reach: a chapter whose group id we never recorded still has a row, and it
   * should not be missed just because it cannot be grouped.
   */
  private async sweepUploaded(options: ReconcileOptions, report: ReconcileReport): Promise<void> {
    let cursor: string | undefined;

    for (;;) {
      const rows = await this.deps.prisma.uploadedChapter.findMany({
        where: options.extensions?.length ? { extension: { in: options.extensions } } : {},
        orderBy: { id: "asc" },
        take: ROW_BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1]?.id;
      report.scanned += rows.length;

      for (const row of rows) {
        // One read per row rather than a batched collection lookup: the page
        // count decides everything here, and only the single-chapter endpoint
        // is authoritative for both halves of the question: it answers 404 for
        // a deletion, and carries `pages` for a card.
        const detail = await this.deps.md.chapterById(row.mdChapterId);
        if (detail === null) {
          report.deletedFound += 1;
          if (await this.alreadyArchived(row.mdChapterId)) continue;
          report.deletedRecorded += 1;
          if (!options.dryRun) await this.archiveDeleted(row);
          continue;
        }
        const attributes = detail.attributes as unknown as Record<string, unknown>;
        if (isCarded(attributes)) {
          report.unavailableFound += 1;
          if (await this.alreadyArchived(row.mdChapterId)) continue;
          report.unavailableRecorded += 1;
          if (!options.dryRun) {
            await this.archiveUnavailable(row.mdChapterId, row.extension, row.mdGroupId, {
              id: row.mdChapterId,
              attributes,
              relationships: detail.relationships,
            });
          }
        }
      }
    }
  }

  /**
   * True when the chapter is already in either archive.
   *
   * Both are checked, not just the one about to be written: a chapter recorded
   * as deleted must not be resurrected as merely unavailable, and a chapter
   * already marked unavailable keeps the instant it was first seen.
   */
  private async alreadyArchived(mdChapterId: string): Promise<boolean> {
    const [unavailable, deleted] = await Promise.all([
      this.deps.prisma.unavailableChapter.findUnique({
        where: { mdChapterId },
        select: { id: true },
      }),
      this.deps.prisma.deletedChapter.findUnique({ where: { mdChapterId }, select: { id: true } }),
    ]);
    return unavailable !== null || deleted !== null;
  }

  /**
   * Write the archive row for a chapter MangaDex will not serve.
   *
   * The columns come from the MangaDex record, because for a discovered chapter
   * that is the only description of it we have. `extra.mdAttributes` keeps the
   * raw attributes for the same reason taskWorkers does: it is the last
   * surviving answer to what the chapter looked like, and MangaDex stops being
   * able to answer once it drops the chapter entirely.
   */
  private async archiveUnavailable(
    mdChapterId: string,
    extension: string | null,
    groupId: string | null,
    entity: MdEntity,
  ): Promise<void> {
    const attrs = entity.attributes ?? {};
    const str = (key: string): string | null => {
      const value = attrs[key];
      return typeof value === "string" && value !== "" ? value : null;
    };
    const mdMangaId = entity.relationships?.find((rel) => rel.type === "manga")?.id ?? null;
    const uploaded = await this.deps.prisma.uploadedChapter.findUnique({ where: { mdChapterId } });
    const timestamp = str("readableAt") ?? str("publishAt");

    await this.deps.prisma.$transaction(async (tx) => {
      await tx.unavailableChapter.upsert({
        where: { mdChapterId },
        create: {
          mdChapterId,
          // Our own row wins where it exists: it carries the publisher-side
          // identifiers (chapterId, mangaId, the source URLs) that MangaDex has
          // never known about and that nothing else can reconstruct.
          extension: uploaded?.extension ?? extension,
          chapterId: uploaded?.chapterId ?? null,
          chapterUrl: uploaded?.chapterUrl ?? str("externalUrl"),
          chapterNumber: uploaded?.chapterNumber ?? str("chapter"),
          chapterTitle: uploaded?.chapterTitle ?? str("title"),
          chapterVolume: uploaded?.chapterVolume ?? str("volume"),
          chapterLanguage: uploaded?.chapterLanguage ?? str("translatedLanguage"),
          chapterTimestamp: uploaded?.chapterTimestamp ?? (timestamp ? new Date(timestamp) : null),
          chapterExpire: uploaded?.chapterExpire ?? null,
          chapterLookup: uploaded?.chapterLookup ?? null,
          mangaId: uploaded?.mangaId ?? null,
          mangaName: uploaded?.mangaName ?? null,
          mangaUrl: uploaded?.mangaUrl ?? null,
          mdMangaId: uploaded?.mdMangaId ?? mdMangaId,
          mdGroupId: uploaded?.mdGroupId ?? groupId,
          extra: { ...(asRecord(uploaded?.extra) ?? {}), mdAttributes: attrs } as Prisma.InputJsonValue,
        },
        update: {},
      });
      await tx.uploadedChapter.deleteMany({ where: { mdChapterId } });
    });
  }

  /** Archive a chapter MangaDex 404s, carrying our row across unchanged. */
  private async archiveDeleted(row: {
    mdChapterId: string;
    extension: string;
    chapterId: string | null;
    chapterUrl: string | null;
    chapterNumber: string | null;
    chapterTitle: string | null;
    chapterVolume: string | null;
    chapterLanguage: string | null;
    chapterTimestamp: Date | null;
    chapterExpire: Date | null;
    chapterLookup: Date | null;
    mangaId: string | null;
    mangaName: string | null;
    mangaUrl: string | null;
    mdMangaId: string | null;
    mdGroupId: string | null;
    extra: unknown;
  }): Promise<void> {
    await this.deps.prisma.$transaction(async (tx) => {
      await tx.deletedChapter.upsert({
        where: { mdChapterId: row.mdChapterId },
        create: {
          mdChapterId: row.mdChapterId,
          extension: row.extension,
          chapterId: row.chapterId,
          chapterUrl: row.chapterUrl,
          chapterNumber: row.chapterNumber,
          chapterTitle: row.chapterTitle,
          chapterVolume: row.chapterVolume,
          chapterLanguage: row.chapterLanguage,
          chapterTimestamp: row.chapterTimestamp,
          chapterExpire: row.chapterExpire,
          chapterLookup: row.chapterLookup,
          mangaId: row.mangaId,
          mangaName: row.mangaName,
          mangaUrl: row.mangaUrl,
          mdMangaId: row.mdMangaId,
          mdGroupId: row.mdGroupId,
          ...(asRecord(row.extra) ? { extra: asRecord(row.extra) as object } : {}),
        },
        update: {},
      });
      await tx.uploadedChapter.deleteMany({ where: { mdChapterId: row.mdChapterId } });
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
