import { describe, expect, it } from "vitest";
import {
  COLOUR_DEFAULT,
  COLOUR_DUPES,
  COLOUR_NOT_INDEXED,
  EXPIRE_TIME,
  chapterField,
  chapterFieldChunks,
  dupesEmbeds,
  formatLink,
  foundChaptersEmbed,
  logEmbed,
  messageEmbed,
  noUpdatesEmbed,
  notIndexedEmbed,
  queueEmbed,
  queueFinishedEmbed,
  queueSummaryEmbed,
  runErrorEmbed,
  runStartedEmbed,
  untrackedMangaEmbeds,
  updatesEmbeds,
} from "../../src/core/md/webhookEmbeds.js";

/**
 * These pin the embeds to the shapes `publoader/webhook.py` produced.
 *
 * The point of the port is that a Discord channel which has been receiving these
 * for years does not suddenly read differently, so the assertions are about
 * exact wording and layout rather than "an embed was produced". Several of them
 * pin behaviour that looks like a bug and is faithful — those say so, because
 * the next person to read them will otherwise'fix' it.
 */

const chapter = {
  mangaName: "Sakamoto Days",
  chapterNumber: "12",
  chapterTitle: "The Bar",
  chapterLanguage: "en",
  chapterUrl: "https://mangaplus.shueisha.co.jp/viewer/1029798",
  mangaUrl: "https://mangaplus.shueisha.co.jp/titles/100034",
  mdChapterId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  mdMangaId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
  extensionName: "mangaplus",
  chapterExpire: null,
};

describe("formatLink", () => {
  it("renders the Python phrasing exactly", () => {
    expect(formatLink("MangaDex", "chapter", "https://mangadex.org/chapter/x")).toBe(
      "Mangadex chapter link: [here](https://mangadex.org/chapter/x)\n",
    );
  });

  it("title-cases the name, which is why an extension reads as Mangaplus", () => {
    // Python called `name.title()`. Faithful, not a typo: correcting the casing
    // would change every embed this platform has ever sent.
    expect(formatLink("mangaplus", "manga", "https://example.com/x")).toContain("Mangaplus manga link");
  });

  it("returns nothing when there is no url, so callers can concatenate blindly", () => {
    expect(formatLink("MangaDex", "chapter", null)).toBe("");
    expect(formatLink("MangaDex", "chapter", undefined)).toBe("");
  });

  it("returns nothing when told to skip", () => {
    // The skip is how a failed upload suppresses its MangaDex links: there is no
    // chapter id to link to, and the manga link alone implies it landed.
    expect(formatLink("MangaDex", "chapter", "https://mangadex.org/chapter/x", true)).toBe("");
  });
});

describe("chapterField", () => {
  it("lays the name out as Success / Manga / Chapter / Extension", () => {
    const field = chapterField(chapter, { success: true });
    expect(field.name).toBe(
      "Success: True\nManga: Sakamoto Days\nChapter: 12\nExtension: mangaplus",
    );
  });

  it("writes Python's True/False rather than JavaScript's true/false", () => {
    expect(chapterField(chapter, { success: false }).name).toContain("Success: False");
  });

  it("prints the 1990 sentinel when a chapter has no expiry", () => {
    // Python's EXPIRE_TIME. A missing expiry is normal, and printing an empty
    // string there made the field look truncated.
    expect(chapterField(chapter).value).toContain(`Chapter expiry: \`${EXPIRE_TIME}\``);
  });

  it("carries language, title and all four links", () => {
    const value = chapterField(chapter).value;
    expect(value).toContain("Language: `en`");
    expect(value).toContain("Chapter title: `The Bar`");
    expect(value).toContain("Mangadex chapter link:");
    expect(value).toContain("Mangadex manga link:");
    expect(value).toContain("Mangaplus chapter link:");
    expect(value).toContain("Mangaplus manga link:");
  });

  it("suppresses only the MangaDex links on a failed upload", () => {
    // The source links still matter — they are how an operator checks what the
    // publisher actually published.
    const value = chapterField(chapter, { failedUpload: true }).value;
    expect(value).not.toContain("Mangadex chapter link:");
    expect(value).not.toContain("Mangadex manga link:");
    expect(value).toContain("Mangaplus chapter link:");
  });

  it("says None for absent fields, as Python's dict.get did", () => {
    const field = chapterField({});
    expect(field.name).toContain("Manga: None");
    expect(field.value).toContain("Language: `None`");
  });
});

describe("chapterFieldChunks", () => {
  it("splits at 25, which is Discord's per-embed field cap", () => {
    const many = Array.from({ length: 60 }, () => chapter);
    const chunks = chapterFieldChunks(many);
    expect(chunks.map((c) => c.length)).toEqual([25, 25, 10]);
  });

  it("produces nothing for no chapters", () => {
    expect(chapterFieldChunks([])).toEqual([]);
  });
});

describe("updatesEmbeds", () => {
  const base = {
    extensionName: "mangaplus",
    mangaTitle: "Sakamoto Days",
    mdMangaId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
    chapters: [chapter, chapter],
    skipped: 3,
    edited: 1,
  };

  it("reports the PLAN, not a result", () => {
    // The distinguishing feature of the Python notifications, and the reason a
    // channel full of "upload succeeded" reads wrong: this fires when the run
    // decides, so the counts are intentions.
    const [embed] = updatesEmbeds(base);
    expect(embed!.description).toContain("To Upload: 2");
    expect(embed!.description).toContain("Skipped: 3");
    expect(embed!.description).toContain("To Edit: 1");
  });

  it("titles on the manga and links it", () => {
    const [embed] = updatesEmbeds(base);
    expect(embed!.title).toBe("Sakamoto Days");
    expect(embed!.description).toContain(
      "MangaDex manga link: [here](https://mangadex.org/manga/bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb)",
    );
  });

  it("footers with extensions.<name>", () => {
    expect(updatesEmbeds(base)[0]!.footer).toBe("extensions.mangaplus");
  });

  it("repeats the manga header on every chunk", () => {
    // Discord splits long runs across messages; without the header on each, a
    // reader cannot tell which series the second message belongs to.
    const embeds = updatesEmbeds({ ...base, chapters: Array.from({ length: 30 }, () => chapter) });
    expect(embeds).toHaveLength(2);
    expect(embeds.every((e) => e.title === "Sakamoto Days")).toBe(true);
    expect(embeds.every((e) => e.description?.includes("To Upload: 30"))).toBe(true);
  });

  it("still reports a manga whose only news is skips", () => {
    // Otherwise "nothing to upload" and "the extension returned nothing" look
    // identical from the channel.
    const embeds = updatesEmbeds({ ...base, chapters: [], skipped: 7, edited: 0 });
    expect(embeds).toHaveLength(1);
    expect(embeds[0]!.description).toContain("Skipped: 7");
  });

  it("suppresses MangaDex links for failed chapters only", () => {
    const embeds = updatesEmbeds({ ...base, chapters: [], failedChapters: [chapter] });
    const value = embeds[0]!.fields![0]!.value;
    expect(value).not.toContain("Mangadex chapter link:");
    expect(value).toContain("Mangaplus chapter link:");
  });

  it("uses the publoader colour", () => {
    expect(updatesEmbeds(base)[0]!.colour).toBe(COLOUR_DEFAULT);
  });
});

describe("queue embeds", () => {
  it("titles on the queue that did the work", () => {
    expect(queueEmbed("UPLOAD", chapter, true).title).toBe("Upload");
  });

  it("marks a failure as unsuccessful and drops its MangaDex links", () => {
    const embed = queueEmbed("UPLOAD", chapter, false);
    expect(embed.fields![0]!.name).toContain("Success: False");
    expect(embed.fields![0]!.value).not.toContain("Mangadex chapter link:");
  });

  it("summarises the unavailable pass rather than listing every chapter", () => {
    const embed = queueSummaryEmbed("UNAVAILABLE", 42, 0);
    expect(embed.title).toBe("42 chapters marked unavailable");
    expect(embed.description).toBe("Marked unavailable: 42");
  });

  it("mentions failures in the summary only when there were some", () => {
    expect(queueSummaryEmbed("UNAVAILABLE", 40, 2).description).toContain("Failed: 2");
    expect(queueSummaryEmbed("UNAVAILABLE", 40, 0).description).not.toContain("Failed");
  });

  it("announces a finished queue", () => {
    expect(queueFinishedEmbed("DELETE").title).toBe("Delete: Finished all items in queue");
  });
});

describe("the remaining Python webhooks", () => {
  it("dupes are grouped by the chapter they duplicate", () => {
    // The grouping is the point: the operator's next action is deleting all but
    // one, and that decision is per-chapter.
    const [embed] = dupesEmbeds("Sakamoto Days", "bbbb", [
      { mainChapterId: "c1", chapterNumber: "12", language: "en", duplicateIds: ["d1", "d2"] },
    ]);
    expect(embed!.title).toBe("Dupes in: Sakamoto Days");
    expect(embed!.colour).toBe(COLOUR_DUPES);
    expect(embed!.fields![0]!.name).toContain("Dupes of chapter: c1");
    expect(embed!.fields![0]!.value).toContain("https://mangadex.org/chapter/d1");
  });

  it("dupes produce nothing when there are none", () => {
    expect(dupesEmbeds("x", "y", [])).toEqual([]);
  });

  it("not-indexed keeps its own colour, because it is not a failure", () => {
    // The upload succeeded; retrying would be wrong. It is still invisible to
    // readers, so it cannot be silent either.
    const embed = notIndexedEmbed("3 chapters not indexed", ["a", "b"], "mangaplus");
    expect(embed.colour).toBe(COLOUR_NOT_INDEXED);
    expect(embed.description).toContain("https://mangadex.org/chapter/a");
    expect(embed.footer).toBe("extensions.mangaplus");
  });

  it("a general message carries the default colour unless told otherwise", () => {
    expect(messageEmbed("Extension loaded").colour).toBe(COLOUR_DEFAULT);
    expect(messageEmbed("Boom", "detail", { colour: "FF0000" }).colour).toBe("FF0000");
  });

  it("a log record is titled by level and reddened for errors", () => {
    expect(logEmbed("error", "it broke").title).toBe("ERROR");
    expect(logEmbed("error", "it broke").colour).toBe("E74C3C");
    expect(logEmbed("warn", "hmm").colour).toBe(COLOUR_DEFAULT);
  });

  // ------------------------------------------------- run-level messages
  //
  // These are the embeds that tell a channel a run happened at all. Without
  // them the only traffic is per-chapter upload results, so a run that found
  // nothing, or died before uploading, is indistinguishable from no run.

  it("announces the run before anything has been found", () => {
    const embed = runStartedEmbed("mangaplus");
    expect(embed.title).toBe("Reading data from mangaplus");
    expect(embed.footer).toBe("extensions.mangaplus");
  });

  it("reports the size of the work ahead, and says so when there is none", () => {
    expect(foundChaptersEmbed("mangaplus", 12).title).toBe(
      "Found 12 chapters for extensions.mangaplus",
    );
    // Python's own inconsistency, kept: this title has no `extensions.` prefix.
    expect(noUpdatesEmbed("mangaplus").title).toBe("No new updates found for mangaplus");
  });

  it("puts the exception in a red embed, fenced", () => {
    const embed = runErrorEmbed("mangaplus", new Error("upstream returned 503"));
    expect(embed.title).toBe("Error in extensions.mangaplus");
    expect(embed.colour).toBe("FF0000");
    expect(embed.description).toContain("```");
    expect(embed.description).toContain("upstream returned 503");
  });

  it("survives a thrown non-Error", () => {
    // `throw "string"` is legal and does happen; the reporter must not itself
    // throw while reporting.
    expect(runErrorEmbed("x", "plain string").description).toContain("plain string");
    expect(runErrorEmbed("x", undefined).description).toContain("undefined");
  });

  it("lists untracked series 30 to a message, counting the total in every title", () => {
    const manga = Array.from({ length: 47 }, (_, i) => ({
      mangaName: `Series ${i}`,
      mangaLanguage: "en",
      mangaId: String(i),
      mangaUrl: `https://example.com/${i}`,
    }));
    const embeds = untrackedMangaEmbeds("mangaplus", manga);
    expect(embeds).toHaveLength(2);
    // The TOTAL, not the page size — "47" is the number the operator acts on.
    expect(embeds[0]!.title).toBe("47 Untracked Manga");
    expect(embeds[1]!.title).toBe("47 Untracked Manga (2)");
    expect(embeds[0]!.description!.split("\n")).toHaveLength(30);
    expect(embeds[1]!.description!.split("\n")).toHaveLength(17);
    expect(embeds[0]!.description).toContain("**Series 0** (en): [0](https://example.com/0)");
  });

  it("says nothing when there are no untracked series", () => {
    expect(untrackedMangaEmbeds("mangaplus", [])).toEqual([]);
  });

  it("tolerates untracked entries with missing fields", () => {
    const [embed] = untrackedMangaEmbeds("mangaplus", [{ mangaName: null }]);
    expect(embed!.description).toContain("**unknown**");
  });

  // ------------------------------------------------- queue embed detail

  it("attaches the failure reason to a failed queue embed, and nothing to a success", () => {
    // A failure the operator cannot diagnose is a notification that only tells
    // them to go and look somewhere else.
    const failed = queueEmbed("Upload", { chapterNumber: "1" }, false, "MangaDex returned 429");
    expect(failed.description).toBe("MangaDex returned 429");
    const ok = queueEmbed("Upload", { chapterNumber: "1" }, true, "Already on MangaDex.");
    expect(ok.description).toBeUndefined();
    // ...and a failure with no detail must not invent one.
    expect(queueEmbed("Upload", { chapterNumber: "1" }, false).description).toBeUndefined();
  });
});
