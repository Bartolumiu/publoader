import type { PrismaClient, UntrackedManga } from "@prisma/client";
import type { Logger } from "../../logging.js";
import { Manifest } from "../../contracts/manifest.js";
import type { MdApi } from "./types.js";
import { AuditLog } from "../store/settings.js";

export interface TitleNotifier {
  send(opts: { title: string; description: string; colour?: string }): Promise<void>;
}

const MAX_CREATE_ATTEMPTS = 3;

/**
 * Automated untracked-series pipeline:
 *   1. the processor persists untracked manga reported by extensions into
 *      `untracked_manga` (state NEW);
 *   2. this service — running in the core uploader (the MD-credential holder)
 *      — creates + commits a MangaDex title for each NEW row when the
 *      extension's manifest opts in (`auto_create_titles`), or when an
 *      operator approves it via the admin API;
 *   3. the new mapping lands in `tracked_manga` (the DB-authoritative manga
 *      id map delivered to workers on lease), so the very next run uploads
 *      the series' chapters;
 *   4. Discord gets an embed linking every title just created.
 *
 * State machine per row: NEW -> CREATING -> CREATED -> TRACKED
 *                        NEW -> SKIPPED (operator)   CREATING -> FAILED (retryable)
 * Every transition is a guarded update; the CREATING claim is CAS'd so
 * replicated uploaders never double-create a title.
 */
export class TitleService {
  private readonly audit: AuditLog;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly md: MdApi,
    private readonly notifier: TitleNotifier,
    private readonly log: Logger,
  ) {
    this.audit = new AuditLog(prisma);
  }

  /** One pass: process NEW rows for extensions with auto_create_titles. */
  async tick(): Promise<void> {
    const candidates = await this.prisma.untrackedManga.findMany({
      where: { state: "NEW", attempts: { lt: MAX_CREATE_ATTEMPTS } },
      orderBy: { createdAt: "asc" },
      take: 20,
    });
    if (candidates.length === 0) return;

    const manifests = await this.manifestsByExtension();
    const created: { row: UntrackedManga; mdMangaId: string }[] = [];

    for (const row of candidates) {
      const manifest = manifests.get(row.extension);
      if (!manifest) continue;
      if (!manifest.auto_create_titles) continue; // waits for operator approval
      const result = await this.createOne(row, manifest, "auto");
      if (result) created.push({ row, mdMangaId: result });
    }

    if (created.length > 0) await this.announce(created);
  }

  /** Operator-approved creation of a specific untracked row (admin API). */
  async approve(untrackedId: string, actor: string): Promise<{ mdMangaId: string } | { error: string }> {
    const row = await this.prisma.untrackedManga.findUnique({ where: { id: untrackedId } });
    if (!row) return { error: "unknown untracked manga" };
    if (row.state === "TRACKED" && row.mdMangaId) return { mdMangaId: row.mdMangaId };
    if (row.state !== "NEW" && row.state !== "FAILED") return { error: `not approvable in state ${row.state}` };
    const manifest = (await this.manifestsByExtension()).get(row.extension);
    if (!manifest) return { error: `no bundle/manifest for ${row.extension}` };

    // FAILED rows get a fresh budget on explicit approval.
    await this.prisma.untrackedManga.updateMany({
      where: { id: row.id, state: "FAILED" },
      data: { state: "NEW", attempts: 0 },
    });
    const mdMangaId = await this.createOne({ ...row, state: "NEW" }, manifest, actor);
    if (!mdMangaId) return { error: "creation failed; see untracked list for the recorded error" };
    await this.announce([{ row, mdMangaId }]);
    return { mdMangaId };
  }

  private async createOne(
    row: UntrackedManga,
    manifest: Manifest,
    actor: string,
  ): Promise<string | null> {
    // CAS claim: only one service instance may create this title.
    const claimed = await this.prisma.untrackedManga.updateMany({
      where: { id: row.id, state: "NEW" },
      data: { state: "CREATING", attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) return null;
    const log = this.log.child({ extension: row.extension, mangaId: row.mangaId });

    try {
      // Defensive re-check: the id may have been tracked by another path
      // (bundle re-import, manual tracking) since it was reported.
      const already = await this.prisma.trackedManga.findUnique({
        where: { extension_mangaId: { extension: row.extension, mangaId: row.mangaId } },
      });
      if (already) {
        await this.prisma.untrackedManga.update({
          where: { id: row.id },
          data: { state: "TRACKED", mdMangaId: already.mdMangaId },
        });
        return null; // tracked, but nothing newly created to announce
      }

      const draft = await this.md.createMangaDraft({
        // Title keyed by the language the source reports it in; fall back to en.
        title: { [row.mangaLanguage || "en"]: row.mangaName },
        originalLanguage: manifest.title_defaults.originalLanguage,
        status: manifest.title_defaults.status,
        contentRating: manifest.title_defaults.contentRating,
        links: row.mangaUrl ? { raw: row.mangaUrl } : undefined,
      });
      const committed = await this.md.commitMangaDraft(draft.id, draft.version);
      if (!committed) throw new Error("draft commit rejected by MangaDex");

      // Track first (the map is what unblocks uploads), then finalize state.
      await this.prisma.trackedManga.upsert({
        where: { extension_mangaId: { extension: row.extension, mangaId: row.mangaId } },
        create: {
          extension: row.extension,
          mangaId: row.mangaId,
          mdMangaId: draft.id,
          source: actor === "auto" ? "auto" : `operator:${actor}`,
        },
        update: {},
      });
      await this.prisma.untrackedManga.update({
        where: { id: row.id },
        data: { state: "TRACKED", mdMangaId: draft.id, lastError: null },
      });
      await this.audit.record(
        actor === "auto" ? "title-service" : actor,
        "title.create",
        `${row.extension}:${row.mangaId}`,
        { mdMangaId: draft.id, mangaName: row.mangaName },
      );
      log.info({ mdMangaId: draft.id }, "created and tracked MangaDex title");
      return draft.id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.untrackedManga.update({
        where: { id: row.id },
        data: {
          state: row.attempts + 1 >= MAX_CREATE_ATTEMPTS ? "FAILED" : "NEW",
          lastError: message.slice(0, 2000),
        },
      });
      log.error({ err }, "title creation failed");
      return null;
    }
  }

  private async announce(created: { row: UntrackedManga; mdMangaId: string }[]): Promise<void> {
    // Batch into embeds of 20 lines to stay under Discord limits.
    for (let i = 0; i < created.length; i += 20) {
      const batch = created.slice(i, i + 20);
      const lines = batch.map(
        ({ row, mdMangaId }) =>
          `**[${row.mangaName}](https://mangadex.org/title/${mdMangaId})** ` +
          `(${row.mangaLanguage}) — [source](${row.mangaUrl}) · \`${row.extension}\``,
      );
      await this.notifier.send({
        title: `Created ${created.length} new MangaDex title${created.length === 1 ? "" : "s"}`,
        description: lines.join("\n"),
        colour: "26D454",
      });
    }
  }

  private async manifestsByExtension(): Promise<Map<string, Manifest>> {
    const bundles = await this.prisma.bundle.findMany({
      where: { yanked: false },
      orderBy: { publishedAt: "desc" },
      select: { extension: true, manifest: true },
    });
    const map = new Map<string, Manifest>();
    for (const b of bundles) {
      if (map.has(b.extension)) continue;
      const parsed = Manifest.safeParse(b.manifest);
      if (parsed.success) map.set(b.extension, parsed.data);
    }
    return map;
  }
}
