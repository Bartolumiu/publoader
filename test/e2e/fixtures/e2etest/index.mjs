/**
 * Deterministic e2e fixture extension (extension API v2).
 *
 * Exercises the real extension contract end-to-end without touching any
 * external site: two chapters for the one tracked manga, plus one untracked
 * manga so the automated title pipeline has something to persist. Also doubles
 * as the failover fixture — if the platform-delivered manga id map contains
 * the marker external id "slow", the run outlives several lease renewals so a
 * `docker kill` of the executing worker is observable as a lease expiry.
 *
 * Plain ESM on purpose: no build step, so `bundle publish` zips this directory
 * as-is and the fixture stays readable as the thing that actually runs.
 */

const MANGA_ID = "m1";
const SLOW_MARKER = "slow";
const SLOW_MS = 90_000;

/** An ExtensionFactory: takes the context, returns something with collect(). */
const factory = (ctx) => ({
  async collect({ postedChapterIds, cleanRun }) {
    if (ctx.mangaIdMap.has(SLOW_MARKER)) {
      ctx.log("slow mode: stalling so the driver can kill this worker", { ms: SLOW_MS });
      await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
    }

    const posted = new Set(postedChapterIds);
    const now = new Date();
    const expire = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const updatedChapters = [];
    for (const number of ["1", "2"]) {
      const chapterId = `c${number}`;
      if (posted.has(chapterId)) continue;
      updatedChapters.push({
        chapterTimestamp: now.toISOString(),
        chapterExpire: expire.toISOString(),
        chapterLanguage: "en",
        chapterNumber: number,
        chapterTitle: `E2E Chapter ${number}`,
        chapterVolume: null,
        chapterId,
        chapterUrl: `https://e2e.example.com/chapter/${chapterId}`,
        mangaId: MANGA_ID,
        // Left unresolved on purpose: the runner fills it from the platform's
        // tracked map, which is what makes this fixture prove the DB overlay.
        mdMangaId: null,
        mangaName: "E2E Test Manga",
        mangaUrl: `https://e2e.example.com/manga/${MANGA_ID}`,
      });
    }
    ctx.log("collected", { updated: updatedChapters.length, cleanRun });

    return {
      updatedChapters,
      // v1 returned an empty list here unconditionally; the v2 contract wants
      // a catalogue only when one was actually gathered.
      allChapters: cleanRun ? [] : null,
      untrackedManga: [
        {
          mangaId: "m2",
          mangaName: "Untracked E2E Manga",
          mangaLanguage: "en",
          mangaUrl: "https://e2e.example.com/manga/m2",
        },
      ],
    };
  },
});

export default factory;
