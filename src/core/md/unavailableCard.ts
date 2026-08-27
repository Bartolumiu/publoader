import type { MdChapterDetail } from "./client.js";
import type { ChapterCardOptions, UnavailableReason } from "./card.js";
import type { Chapter } from "./types.js";

/**
 * What goes on the "this chapter is no longer available" card.
 *
 * Extracted from taskWorkers.ts so that the uploader and the dashboard's
 * preview endpoint derive the card from the same inputs by the same rules. A
 * preview that differs from what is posted is worse than no preview: an
 * operator would approve one image and publish another, and the difference
 * would only ever be noticed by a reader.
 *
 * MangaDex is preferred over the stored row wherever both have an answer,
 * because the row is a mirror that may be days old while the card is about to
 * become the chapter's only page.
 *
 * The chapter URL is the one exception, and it inverts for a reason. Marking a
 * chapter unavailable REPOINTS its externalUrl away from the chapter -- to the
 * series page, or the publisher's homepage -- so on anything already carded the
 * live value is that replacement, not the chapter. Preferring MangaDex there
 * would print the series page under "SOURCE" and lose the original chapter link
 * for good, and every re-card would do it again. The stored row still holds
 * where the chapter actually was, so it wins.
 */
export function unavailableCardOptions(input: {
  chapter: Chapter;
  /** The live chapter, when MangaDex could be read; null falls back to the row. */
  detail: MdChapterDetail | null;
  /** When availability ended; the card's "available from → to" window. */
  unavailableAt?: string | null;
  /** Replaces the standard explanatory paragraph. */
  footerNote?: string | null;
  /**
   * Why the chapter is unreadable, which selects the card's wording. Defaults
   * to `removed`, so every caller that predates this is unaffected.
   */
  reason?: UnavailableReason | null;
  /** Subscription a `subscriber-only` chapter needs, e.g. "MANGA Plus MAX". */
  subscriptionName?: string | null;
}): ChapterCardOptions {
  const { chapter, detail } = input;
  const attrs = detail?.attributes ?? null;
  return {
    mangaName: resolveMangaName(detail, chapter),
    chapterNumber: attrs?.chapter ?? chapter.chapterNumber,
    chapterTitle: attrs?.title ?? chapter.chapterTitle,
    extensionName: chapter.extensionName ?? "Unknown",
    chapterLanguage: attrs?.translatedLanguage || chapter.chapterLanguage,
    // The row first: see the note above. MangaDex's value is only used when the
    // row never recorded a chapter url, and even then it may already be a
    // replacement rather than the chapter.
    chapterUrl: chapter.chapterUrl ?? attrs?.externalUrl ?? null,
    availableFrom: chapter.chapterTimestamp,
    availableTo: input.unavailableAt ?? chapter.chapterExpire,
    footerNote: input.footerNote ?? null,
    reason: input.reason ?? "removed",
    subscriptionName: input.subscriptionName ?? null,
  };
}

/**
 * Series title for the card. Prefer the manga relationship MangaDex returned
 * (via includes[]=manga) over whatever the queue row carried: the queued name
 * is often absent, which renders a card as "Untitled".
 */
export function resolveMangaName(detail: MdChapterDetail | null, chapter: Chapter): string {
  const manga = detail?.relationships.find((rel) => rel.type === "manga");
  const attrs = manga?.attributes;
  if (attrs) {
    const title = asRecord(attrs.title) ?? {};
    const altTitles = Array.isArray(attrs.altTitles) ? attrs.altTitles : [];
    const alt: Record<string, unknown> = {};
    for (const entry of altTitles) {
      const record = asRecord(entry);
      if (!record) continue;
      for (const [lang, value] of Object.entries(record)) {
        if (!(lang in alt)) alt[lang] = value;
      }
    }
    const pick = (lang: string): string | null => {
      const value = title[lang] ?? alt[lang];
      return typeof value === "string" && value !== "" ? value : null;
    };
    const originalLanguage = typeof attrs.originalLanguage === "string" ? attrs.originalLanguage : null;
    const resolved =
      pick("en") ??
      (originalLanguage ? (pick(`${originalLanguage}-ro`) ?? pick(originalLanguage)) : null) ??
      firstString(title) ??
      firstString(alt);
    if (resolved) return resolved;
  }
  return chapter.mangaName ?? "Untitled";
}

function firstString(source: Record<string, unknown>): string | null {
  for (const value of Object.values(source)) {
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
