import { describe, expect, it, vi } from "vitest";
import type { PrismaClient, UntrackedManga } from "@prisma/client";
import { createLogger } from "../../src/logging.js";
import { AUTO_MAP_ACTOR, TitleService } from "../../src/core/md/titleService.js";
import type { MdApi, MdManga } from "../../src/core/md/types.js";

/**
 * What the auto-map leaves behind.
 *
 * The pass writes the series map — it decides where a publisher's chapters get
 * uploaded — and it used to do that in complete silence: no announcement, and,
 * despite a comment in the source claiming otherwise, no audit entry either.
 * The only trace was a `source` string on the map row, which is current state
 * rather than history: it cannot say when a series was mapped or by which pass,
 * and the next repoint overwrites it.
 *
 * Two things are tested here. That every automatic mapping is recorded against
 * a non-human actor, so "what did nobody look at" is answerable; and that the
 * announcement is COALESCED, because the pass runs about every five seconds
 * while the upload queue is idle and announcing per pass would bury the channel
 * — which is the reason it announced nothing in the first place.
 */

const log = createLogger("test-automap-trail", "silent");

const SERIES_URL = "https://comikey.com/comics/kengan-omega";

const manga = (id: string, links: Record<string, string>): MdManga => ({
  id,
  attributes: {
    title: { en: "Kengan Omega" },
    altTitles: [],
    originalLanguage: "ja",
    links,
  },
});

const row = (overrides: Partial<UntrackedManga> = {}): UntrackedManga =>
  ({
    id: "11111111-1111-4111-8111-111111111111",
    extension: "comikey",
    mangaId: "kengan-omega",
    mangaName: "Kengan Omega",
    mangaLanguage: "en",
    mangaUrl: SERIES_URL,
    state: "NEW",
    mdMangaId: null,
    attempts: 0,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as UntrackedManga;

/** A TitleService over one batch, reporting what it wrote and what it said. */
function harness(rows: UntrackedManga[], searchResults: MdManga[]) {
  const audits: { actor: string; action: string; subject: string; detail: Record<string, unknown> }[] = [];
  const sent: { title: string; description: string; colour?: string }[] = [];

  const prisma = {
    untrackedManga: {
      findMany: async () => rows,
      count: async () => 0,
      update: async () => rows[0],
      updateMany: async () => ({ count: 1 }),
    },
    trackedManga: {
      findUnique: async () => null,
      upsert: async ({ create }: { create: unknown }) => create,
    },
    auditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data as (typeof audits)[number]);
        return data;
      },
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        for (const entry of data) audits.push(entry as (typeof audits)[number]);
        return { count: data.length };
      },
    },
  } as unknown as PrismaClient;

  const md = { searchManga: async () => searchResults } as unknown as MdApi;

  const notifier = {
    send: vi.fn(async (opts: { title: string; description: string; colour?: string }) => {
      sent.push(opts);
    }),
  };

  return { titles: new TitleService(prisma, md, notifier, log), audits, sent };
}

describe("the trail an automatic mapping leaves", () => {
  it("records every mapping against a non-human actor", async () => {
    const h = harness([row()], [manga("md-1", { engtl: SERIES_URL })]);
    await h.titles.autoMapByOfficialLink({ dryRun: false });

    const mapped = h.audits.filter((a) => a.action === "untracked.automap.mapped");
    expect(mapped).toHaveLength(1);
    // Not a person's name: the point of finding one of these later is knowing
    // that nobody reviewed it.
    expect(mapped[0]!.actor).toBe(AUTO_MAP_ACTOR);
    expect(mapped[0]!.subject).toBe("comikey:kengan-omega");
  });

  it("records which evidence the match rested on", async () => {
    // The three link places are not equally strong, and re-auditing a batch of
    // automatic mappings means filtering on exactly this.
    const h = harness([row()], [manga("md-1", { raw: SERIES_URL })]);
    await h.titles.autoMapByOfficialLink({ dryRun: false });

    const [entry] = h.audits.filter((a) => a.action === "untracked.automap.mapped");
    expect(entry!.detail.via).toBe("links");
    expect(entry!.detail.source).toBe("auto:link");
    expect(entry!.detail.mdMangaId).toBe("md-1");
    // Enough to read the entry without joining anything back to it.
    expect(entry!.detail.mangaName).toBe("Kengan Omega");
    expect(entry!.detail.mangaUrl).toBe(SERIES_URL);
  });

  it("writes nothing for a preview", async () => {
    // A dry run is a question, not an event.
    const h = harness([row()], [manga("md-1", { engtl: SERIES_URL })]);
    await h.titles.autoMapByOfficialLink({ dryRun: true });

    expect(h.audits.filter((a) => a.action === "untracked.automap.mapped")).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });

  it("says nothing at all when a pass mapped nothing", async () => {
    // The common case by a wide margin, and the one that must stay silent.
    const h = harness([row()], [manga("md-1", { engtl: "https://comikey.com/comics/something-else" })]);
    await h.titles.autoMapByOfficialLink({ dryRun: false });
    expect(h.sent).toHaveLength(0);
  });
});

describe("announcing without burying the channel", () => {
  it("announces the first mapping straight away", async () => {
    // A quiet platform should not sit on its first mapping for a quarter of an
    // hour; only a busy one is throttled.
    const h = harness([row()], [manga("md-1", { engtl: SERIES_URL })]);
    await h.titles.autoMapByOfficialLink({ dryRun: false });

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.title).toContain("Auto-mapped 1 series");
    expect(h.sent[0]!.description).toContain("Kengan Omega");
    // Which evidence, in words, so the reader can judge it.
    expect(h.sent[0]!.description).toContain("official English link");
    // Amber rather than the green a created title gets: nothing was published,
    // and nobody reviewed these.
    expect(h.sent[0]!.colour).toBe("D9A12C");
    expect(h.sent[0]!.description).toContain("No titles were created");
  });

  it("holds later passes back into one digest rather than a message each", async () => {
    const h = harness([row()], [manga("md-1", { engtl: SERIES_URL })]);
    await h.titles.autoMapByOfficialLink({ dryRun: false });
    expect(h.sent).toHaveLength(1);

    // The pass runs about every five seconds while the queue is idle; three
    // more passes inside the window must not be three more messages.
    for (let i = 0; i < 3; i++) await h.titles.autoMapByOfficialLink({ dryRun: false });
    expect(h.sent).toHaveLength(1);
  });

  it("sends the held mappings once the window has passed", async () => {
    vi.useFakeTimers();
    try {
      const h = harness([row()], [manga("md-1", { engtl: SERIES_URL })]);
      await h.titles.autoMapByOfficialLink({ dryRun: false });
      expect(h.sent).toHaveLength(1);

      await h.titles.autoMapByOfficialLink({ dryRun: false });
      await h.titles.autoMapByOfficialLink({ dryRun: false });
      expect(h.sent).toHaveLength(1);

      vi.setSystemTime(new Date(Date.now() + 16 * 60 * 1000));
      await h.titles.autoMapByOfficialLink({ dryRun: false });

      expect(h.sent).toHaveLength(2);
      // Everything held since the last digest, counted as one event rather than
      // as several unrelated ones.
      expect(h.sent[1]!.title).toContain("Auto-mapped 3 series");
    } finally {
      vi.useRealTimers();
    }
  });
});
