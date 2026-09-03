import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { RemovalCheckStore, REMOVAL_CONFIRMATIONS } from "../../src/core/store/removalChecks.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * Absence as a vote rather than a verdict.
 *
 * Three of the four removal passes read their evidence off what an extension
 * listed, and "the extension did not list this chapter" is the same sentence
 * whether the publisher retired it or the extension was broken when we asked.
 * The platform could not tell those apart and acted on the first report either
 * way; carding is a one-way door onto a public catalogue.
 *
 * Every property here is one an outage would otherwise defeat, so they are
 * written against a live postgres: the vote is a single upsert precisely so two
 * segments of one run cannot both count, and that cannot be shown in a mock.
 */
describe.skipIf(!dbReady())("RemovalCheckStore", () => {
  const prisma = testPrisma();
  const store = new RemovalCheckStore(prisma);

  const candidate = (mdChapterId: string, extension = "mangaplus") => ({
    mdChapterId,
    mdMangaId: "manga-1",
    extension,
    pass: "no-longer-listed",
    mode: "unavailable",
  });

  /** A time far enough past the vote window that the next report counts. */
  const laterThanTheWindow = (from: Date, days = 2) =>
    new Date(from.getTime() + days * 24 * 60 * 60 * 1000);

  beforeEach(async () => {
    await resetDb(prisma);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("does not confirm a chapter the first time a run misses it", async () => {
    const [vote] = await store.vote([candidate("ch-1")]);

    expect(vote).toMatchObject({ misses: 1, confirmed: false });
    // The whole point: one bad response removes nothing.
    expect(REMOVAL_CONFIRMATIONS).toBeGreaterThan(1);
  });

  it("confirms only once enough separate runs agree", async () => {
    let now = new Date();
    const seen: boolean[] = [];

    for (let run = 1; run <= REMOVAL_CONFIRMATIONS; run += 1) {
      const [vote] = await store.vote([candidate("ch-1")], now);
      seen.push(vote!.confirmed);
      now = laterThanTheWindow(now);
    }

    // False until the last one, which is the tally being met and not before.
    expect(seen.slice(0, -1).every((c) => c === false)).toBe(true);
    expect(seen.at(-1)).toBe(true);
  });

  it("ignores a second report inside the same window, which is one outage seen twice", async () => {
    // A retry, a scoped recheck, another segment of the same run: three reports
    // from one broken hour must not be three votes.
    const now = new Date();
    await store.vote([candidate("ch-1")], now);

    const [again] = await store.vote([candidate("ch-1")], new Date(now.getTime() + 60_000));
    expect(again).toMatchObject({ misses: 1, confirmed: false, tooSoon: true });

    const [third] = await store.vote([candidate("ch-1")], new Date(now.getTime() + 120_000));
    expect(third).toMatchObject({ misses: 1, tooSoon: true });
  });

  it("reports a vote that counted as counted", async () => {
    // The mirror of the case above, and the one a naive `not_before > now`
    // test gets wrong: a counting vote also sets a future window, so the
    // window alone cannot say whether the report was believed.
    let now = new Date();
    await store.vote([candidate("ch-1")], now);
    now = laterThanTheWindow(now);

    const [counted] = await store.vote([candidate("ch-1")], now);
    expect(counted).toMatchObject({ misses: 2, tooSoon: false });
  });

  it("does not let repeated reports inside the window push the next vote away", async () => {
    // The window must be anchored to the vote that counted. Moved forward on
    // every report, a run every five minutes would hold a chapter below the
    // tally for ever and the removal would never happen at all.
    const now = new Date();
    const [first] = await store.vote([candidate("ch-1")], now);
    const window = first!.notBefore.getTime();

    await store.vote([candidate("ch-1")], new Date(now.getTime() + 60_000));
    const row = await prisma.chapterRemovalCheck.findUniqueOrThrow({
      where: { mdChapterId: "ch-1" },
    });
    expect(row.notBefore.getTime()).toBe(window);
  });

  it("spaces the next vote at least a day out, with a per-chapter offset", async () => {
    const now = new Date();
    const votes = await store.vote(
      Array.from({ length: 12 }, (_, i) => candidate(`ch-${i}`)),
      now,
    );

    const day = 24 * 60 * 60 * 1000;
    for (const vote of votes) {
      expect(vote.notBefore.getTime()).toBeGreaterThanOrEqual(now.getTime() + day);
    }
    // Jittered, so a whole series does not become eligible in the same second
    // and get retired wholesale by one badly-timed second run.
    expect(new Set(votes.map((v) => v.notBefore.getTime())).size).toBeGreaterThan(1);
  });

  it("forgets the tally the moment the publisher lists the chapter again", async () => {
    let now = new Date();
    await store.vote([candidate("ch-1")], now);
    now = laterThanTheWindow(now);
    const [second] = await store.vote([candidate("ch-1")], now);
    expect(second).toMatchObject({ misses: 2 });

    expect(await store.clear(["ch-1"])).toBe(1);

    // Back from one. The evidence has to be recent AND consecutive, not just
    // plentiful: a chapter that flickers must never accumulate its way out.
    now = laterThanTheWindow(now);
    const [afterReturn] = await store.vote([candidate("ch-1")], now);
    expect(afterReturn).toMatchObject({ misses: 1, confirmed: false });
  });

  it("counts each chapter separately, and clears only what came back", async () => {
    const now = new Date();
    await store.vote([candidate("ch-1"), candidate("ch-2"), candidate("ch-3")], now);

    await store.clear(["ch-2"]);

    const left = await prisma.chapterRemovalCheck.findMany({ orderBy: { mdChapterId: "asc" } });
    expect(left.map((r) => r.mdChapterId)).toEqual(["ch-1", "ch-3"]);
  });

  it("clears a whole extension, for an operator who knows it was an outage", async () => {
    const now = new Date();
    await store.vote(
      [candidate("ch-1", "mangaplus"), candidate("ch-2", "mangaplus"), candidate("ch-3", "omoi")],
      now,
    );

    expect(await store.clearExtension("mangaplus")).toBe(2);
    expect((await store.pending()).map((r) => r.mdChapterId)).toEqual(["ch-3"]);
  });

  it("records who reported it and what would have happened", async () => {
    await store.vote([{ ...candidate("ch-1"), mode: "delete", pass: "manga-untracked" }]);

    expect(await prisma.chapterRemovalCheck.findUniqueOrThrow({ where: { mdChapterId: "ch-1" } }))
      .toMatchObject({ extension: "mangaplus", mode: "delete", pass: "manga-untracked" });
  });
});
