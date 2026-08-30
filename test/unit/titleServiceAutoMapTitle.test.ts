import { describe, expect, it, vi } from "vitest";
import type { PrismaClient, UntrackedManga } from "@prisma/client";
import { createLogger } from "../../src/logging.js";
import {
  TITLE_MATCH_SOURCE,
  TitleService,
  exactNameMatch,
  isMatchableName,
  isVariantEdition,
  linkContradicts,
} from "../../src/core/md/titleService.js";
import type { MdApi, MdManga } from "../../src/core/md/types.js";

/**
 * Mapping on a name is weaker evidence than mapping on a url, and the cost of
 * being wrong is the same either way: a publisher's chapters uploaded onto
 * somebody else's series on a public catalogue. So these tests are almost
 * entirely about what the pass REFUSES —
 *
 *   - a name that merely contains the reported one, which is how a series gets
 *     mapped onto its own spin-off;
 *   - two entries answering to one name, which is real and is a person's
 *     decision, not a coin toss;
 *   - an entry MangaDex already says is a different page on this very
 *     publisher's site;
 *   - a oneshot or a re-coloured edition sharing the serialised title's name;
 *
 * — and about the bookkeeping that keeps a queue of thousands drainable: a
 * checked row is not searched again, and a previewed match is.
 */

const log = createLogger("test-automap-title", "silent");

const manga = (
  id: string,
  titles: string[],
  opts: { alt?: string[]; links?: Record<string, string> } = {},
): MdManga => ({
  id,
  attributes: {
    title: { en: titles[0] ?? "" },
    altTitles: [...titles.slice(1), ...(opts.alt ?? [])].map((t) => ({ ja: t })),
    originalLanguage: "ja",
    links: opts.links ?? null,
  },
});

const row = (overrides: Partial<UntrackedManga> = {}): UntrackedManga =>
  ({
    id: "11111111-1111-4111-8111-111111111111",
    extension: "comikey",
    mangaId: "ext-1",
    mangaName: "Granny Girl Hinata-chan",
    mangaLanguage: "en",
    mangaUrl: "https://comikey.com/comics/granny-girl-hinata-chan/12/",
    state: "NEW",
    mdMangaId: null,
    attempts: 0,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as UntrackedManga;

/**
 * A TitleService over an in-memory queue of one batch, reporting what the pass
 * wrote: the tracked-map rows it created, and the row updates it made.
 */
function harness(rows: UntrackedManga[], searchResults: MdManga[]) {
  const tracked: { mangaId: string; mdMangaId: string; source: string }[] = [];
  const updates: { id: string; data: Partial<UntrackedManga> }[] = [];
  const searched: string[] = [];
  let existingMapping: { mdMangaId: string } | null = null;

  const prisma = {
    untrackedManga: {
      findMany: async () => rows,
      count: async () => 0,
      update: async ({ where, data }: { where: { id: string }; data: Partial<UntrackedManga> }) => {
        updates.push({ id: where.id, data });
        return rows[0];
      },
      updateMany: async ({ where, data }: { where: { id: string }; data: Partial<UntrackedManga> }) => {
        updates.push({ id: where.id, data });
        return { count: 1 };
      },
    },
    trackedManga: {
      findUnique: async () => existingMapping,
      upsert: async ({ create }: { create: { mangaId: string; mdMangaId: string; source: string } }) => {
        tracked.push(create);
        return create;
      },
    },
    auditEvent: { create: async (args: { data: unknown }) => args.data },
  } as unknown as PrismaClient;

  const md = {
    searchManga: async (title: string) => {
      searched.push(title);
      return searchResults;
    },
  } as unknown as MdApi;

  return {
    titles: new TitleService(prisma, md, { send: vi.fn(async () => undefined) }, log),
    tracked,
    updates,
    searched,
    mapExistsAs: (mdMangaId: string) => {
      existingMapping = { mdMangaId };
    },
  };
}

describe("name matching", () => {
  it("matches a name MangaDex spells differently but writes the same", () => {
    // Punctuation and case are how two records of one series differ; they are
    // not how two series differ.
    const candidate = manga("a", ["Saint☆Young Men"]);
    expect(exactNameMatch(candidate, "Saint Young Men")).toBe(true);
    expect(exactNameMatch(candidate, "SAINT YOUNG MEN")).toBe(true);
  });

  it("matches on an alt title, which is where the English name usually lives", () => {
    const candidate = manga("a", ["Kamiki Kyoudai Okotowari"], { alt: ["Beware the Kamiki Brothers!"] });
    expect(exactNameMatch(candidate, "Beware the Kamiki Brothers!")).toBe(true);
  });

  it("refuses a name that merely contains the reported one", () => {
    // The spin-off case, and the reason this is not `titleMatches`: mapping
    // "Saki" onto "Saki: Achiga-hen" sends a series' chapters to its own
    // side-story.
    expect(exactNameMatch(manga("a", ["Saki: Achiga-hen"]), "Saki")).toBe(false);
    expect(exactNameMatch(manga("a", ["Saki"]), "Saki: Achiga-hen")).toBe(false);
  });

  it("refuses names too short to be evidence", () => {
    expect(isMatchableName("Ao")).toBe(false);
    expect(isMatchableName("GTO")).toBe(false);
    expect(isMatchableName("!!!")).toBe(false);
    expect(isMatchableName("Saki")).toBe(true);
  });
});

describe("disconfirming evidence", () => {
  it("drops an entry whose link points at a different series on the same site", () => {
    // MangaDex has already answered "which page is this", and it is not this
    // one. Measured on the live queue this is how K MANGA rows go wrong.
    const candidate = manga("a", ["Wind Breaker"], {
      links: { engtl: "https://kmanga.kodansha.com/title/99999" },
    });
    expect(linkContradicts(candidate, "https://kmanga.kodansha.com/title/10304")).toBe(true);
  });

  it("keeps an entry whose link is the same page written differently", () => {
    const candidate = manga("a", ["Wind Breaker"], {
      links: { engtl: "http://www.kmanga.kodansha.com/title/10304/" },
    });
    expect(linkContradicts(candidate, "https://kmanga.kodansha.com/title/10304")).toBe(false);
  });

  it("keeps an entry that links elsewhere, or nowhere", () => {
    // Absence says nothing: most entries carry no link for the publisher at
    // all, and a link to another site is not a claim about this one.
    expect(linkContradicts(manga("a", ["X"], { links: { raw: "https://example.jp/1" } }), "https://comikey.com/comics/x/1/")).toBe(false);
    expect(linkContradicts(manga("a", ["X"]), "https://comikey.com/comics/x/1/")).toBe(false);
  });

  it("recognises the variant editions that share a serialised title's name", () => {
    expect(isVariantEdition(manga("a", ["Amagami-san Chi no Enmusubi (Oneshot)"]))).toBe(true);
    expect(isVariantEdition(manga("a", ["That Time I Got Reincarnated as a Slime (Fan Colored)"]))).toBe(true);
    expect(isVariantEdition(manga("a", ["Colorless"]))).toBe(false);
  });
});

describe("TitleService.autoMapByTitle", () => {
  it("maps the one entry holding the name, and records how it was decided", async () => {
    const h = harness([row()], [manga("aaaaaaaa-0000-4000-8000-000000000001", ["Granny Girl Hinata-chan"])]);

    const report = await h.titles.autoMapByTitle({ dryRun: false });

    expect(report.mapped).toHaveLength(1);
    expect(report.mapped[0]?.mdMangaId).toBe("aaaaaaaa-0000-4000-8000-000000000001");
    // The provenance is the point: an operator chasing a wrong mapping needs to
    // know a name decided it, not a link and not a person.
    expect(h.tracked).toEqual([
      {
        extension: "comikey",
        namespace: expect.any(String),
        mangaId: "ext-1",
        mdMangaId: "aaaaaaaa-0000-4000-8000-000000000001",
        source: TITLE_MATCH_SOURCE,
      },
    ]);
  });

  it("leaves two entries answering to one name for a person", async () => {
    // The live case: a Japanese and a Korean series both called Wind Breaker.
    const h = harness(
      [row({ mangaName: "Wind Breaker", mangaUrl: "https://kmanga.kodansha.com/title/10304" })],
      [manga("aaaaaaaa-0000-4000-8000-000000000001", ["Wind Breaker"]), manga("bbbbbbbb-0000-4000-8000-000000000002", ["Wind Breaker"])],
    );

    const report = await h.titles.autoMapByTitle({ dryRun: false });

    expect(report.mapped).toHaveLength(0);
    expect(report.ambiguous).toBe(1);
    expect(h.tracked).toHaveLength(0);
  });

  it("maps the serialised entry when the other name-holder is its own oneshot", async () => {
    const h = harness(
      [row({ mangaName: "Tying the Knot with an Amagami Sister" })],
      [
        manga("aaaaaaaa-0000-4000-8000-000000000001", ["Amagami-san Chi no Enmusubi (Oneshot)"], {
          alt: ["Tying the Knot with an Amagami Sister"],
        }),
        manga("bbbbbbbb-0000-4000-8000-000000000002", ["Amagami-san Chi no Enmusubi"], {
          alt: ["Tying the Knot with an Amagami Sister"],
        }),
      ],
    );

    const report = await h.titles.autoMapByTitle({ dryRun: false });

    expect(report.mapped).toHaveLength(1);
    expect(report.mapped[0]?.mdMangaId).toBe("bbbbbbbb-0000-4000-8000-000000000002");
  });

  it("refuses an entry MangaDex says is a different page on the same publisher", async () => {
    const h = harness(
      [row({ mangaName: "Wind Breaker", mangaUrl: "https://kmanga.kodansha.com/title/10304" })],
      [
        manga("aaaaaaaa-0000-4000-8000-000000000001", ["Wind Breaker"], {
          links: { engtl: "https://kmanga.kodansha.com/title/99999" },
        }),
      ],
    );

    const report = await h.titles.autoMapByTitle({ dryRun: false });

    expect(report.mapped).toHaveLength(0);
    expect(report.unmatched).toBe(1);
  });

  it("does not search on a name too short to be evidence", async () => {
    const h = harness([row({ mangaName: "Ao" })], [manga("aaaaaaaa-0000-4000-8000-000000000001", ["Ao"])]);

    const report = await h.titles.autoMapByTitle({ dryRun: false });

    expect(h.searched).toEqual([]);
    expect(report.mapped).toHaveLength(0);
    expect(report.unmatched).toBe(1);
  });

  it("marks a row it could not map, so the next pass moves past it", async () => {
    const h = harness([row()], []);

    await h.titles.autoMapByTitle({ dryRun: false });

    // Without this a queue thousands deep re-searches the same misses forever
    // and never reaches the rows behind them.
    expect(h.updates.some((u) => u.data.titleCheckedAt instanceof Date)).toBe(true);
  });

  it("writes nothing on a preview, and leaves the match to be found again", async () => {
    const h = harness([row()], [manga("aaaaaaaa-0000-4000-8000-000000000001", ["Granny Girl Hinata-chan"])]);

    const report = await h.titles.autoMapByTitle({ dryRun: true });

    expect(report.mapped).toHaveLength(1);
    expect(h.tracked).toHaveLength(0);
    // A match nobody has acted on must still be there when they press the
    // button that acts on it, so a previewed hit is deliberately not marked.
    expect(h.updates).toHaveLength(0);
  });

  it("previews by default, because the caller that forgets should write nothing", async () => {
    const h = harness([row()], [manga("aaaaaaaa-0000-4000-8000-000000000001", ["Granny Girl Hinata-chan"])]);

    await h.titles.autoMapByTitle();

    expect(h.tracked).toHaveLength(0);
  });

  it("leaves a series already mapped to another title alone", async () => {
    const h = harness([row()], [manga("aaaaaaaa-0000-4000-8000-000000000001", ["Granny Girl Hinata-chan"])]);
    h.mapExistsAs("cccccccc-0000-4000-8000-000000000003");

    const report = await h.titles.autoMapByTitle({ dryRun: false });

    // Repointing is an edit of existing curation, never something a batch pass
    // does on its own.
    expect(h.tracked).toHaveLength(0);
    expect(report.mapped).toHaveLength(0);
    expect(report.unmatched).toBe(1);
  });
});
