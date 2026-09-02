import { describe, expect, it } from "vitest";
import { chapterEditBody } from "../../src/core/md/taskWorkers.js";

const current = (overrides: Partial<Record<string, unknown>> = {}) => ({
  attributes: {
    volume: "20",
    chapter: "175",
    title: "The Pup at My Side",
    translatedLanguage: "en",
    externalUrl: "https://kmanga.kodansha.com/title/10007/episode/358273",
    version: 3,
    ...overrides,
  } as {
    volume: string | null;
    chapter: string | null;
    title: string | null;
    translatedLanguage: string;
    externalUrl: string | null;
    version: number;
  },
  relationships: [
    { type: "scanlation_group", id: "7c5fb223-aa64-4eb8-955f-762d5bfd5ab7" },
    { type: "manga", id: "0f6003ca-e7f3-43ce-bfd2-0694146994be" },
  ],
});

describe("chapterEditBody", () => {
  it("carries the existing externalUrl through an edit that does not mention it", () => {
    // The regression this exists for. PUT /chapter replaces what it is given,
    // so omitting the url from a title-only edit emptied the chapter: our
    // chapters have no pages, the link IS the chapter.
    const body = chapterEditBody(current(), { title: "Corrected Title" });
    expect(body.externalUrl).toBe("https://kmanga.kodansha.com/title/10007/episode/358273");
    expect(body.title).toBe("Corrected Title");
  });

  it("restates every field the payload does not touch", () => {
    const body = chapterEditBody(current(), { chapter: "175.1" });
    expect(body).toEqual({
      volume: "20",
      chapter: "175.1",
      title: "The Pup at My Side",
      translatedLanguage: "en",
      groups: ["7c5fb223-aa64-4eb8-955f-762d5bfd5ab7"],
      externalUrl: "https://kmanga.kodansha.com/title/10007/episode/358273",
      version: 3,
    });
  });

  it("lets the payload repoint the url", () => {
    // Carding repoints externalUrl rather than clearing it, and the repair
    // path resends the mirror's url; both must win over the current value.
    const body = chapterEditBody(current(), { externalUrl: "https://kmanga.kodansha.com/title/10007" });
    expect(body.externalUrl).toBe("https://kmanga.kodansha.com/title/10007");
  });

  it("omits the key entirely when the chapter has no url", () => {
    // MangaDex rejects a null externalUrl, so "no link" is an absent key.
    const body = chapterEditBody(current({ externalUrl: null }), { title: "x" });
    expect("externalUrl" in body).toBe(false);
  });

  it("refuses to clear a url, keeping the rest of the edit", () => {
    // Sending the null would have MangaDex reject the whole edit and lose the
    // title change with it.
    const body = chapterEditBody(current(), { title: "x", externalUrl: null });
    expect(body.externalUrl).toBe("https://kmanga.kodansha.com/title/10007/episode/358273");
    expect(body.title).toBe("x");
  });

  it("keeps only the scanlation groups", () => {
    const body = chapterEditBody(current(), { title: "x" });
    expect(body.groups).toEqual(["7c5fb223-aa64-4eb8-955f-762d5bfd5ab7"]);
  });

  it("never sends publishAt, even when a payload carries one", () => {
    // `ChapterPayload` is deliberately `.passthrough()` so an EDIT row can hold
    // its `payload`/`oldInfo` sidecars, which leaves a hand-built or
    // hand-patched task able to smuggle a scheduling field into the body. A PUT
    // /chapter is a replace, so anything that arrives here becomes the truth.
    const body = chapterEditBody(current(), {
      title: "x",
      publishAt: "2037-12-31T15:00:00+00:00",
    });
    expect("publishAt" in body).toBe(false);
    // The rest of the edit still goes through: this drops a field, not the task.
    expect(body.title).toBe("x");
  });

  it("never sends readableAt either", () => {
    // Same class of field and the same mistake; grouped so neither can be
    // re-added by someone who only remembers the publishAt incident.
    const body = chapterEditBody(current(), {
      title: "x",
      readableAt: "2023-04-03T01:00:26+00:00",
    });
    expect("readableAt" in body).toBe(false);
    expect(body.title).toBe("x");
  });

  it("leaves an edit that never mentioned them untouched", () => {
    // The strip must not perturb the ordinary path.
    const body = chapterEditBody(current(), { title: "x" });
    expect(body).toEqual({
      volume: "20",
      chapter: "175",
      title: "x",
      translatedLanguage: "en",
      groups: ["7c5fb223-aa64-4eb8-955f-762d5bfd5ab7"],
      externalUrl: "https://kmanga.kodansha.com/title/10007/episode/358273",
      version: 3,
    });
  });
});
