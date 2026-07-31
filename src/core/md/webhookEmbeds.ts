/**
 * The Discord embeds the Python publoader sent, rebuilt for this platform.
 *
 * These are a deliberate port rather than a redesign: the wording, the field
 * layout, the colours and the link phrasing all match `publoader/webhook.py`, so
 * a channel that has been receiving these for years does not suddenly read
 * differently. Where the new architecture cannot produce the same thing, the
 * difference is named in the relevant builder rather than papered over.
 *
 * What the Python version sent, and where each one now comes from:
 *
 *   PubloaderUpdatesWebhook     per manga, at update-check time  -> `updatesEmbeds`
 *   PubloaderQueueWebhook       per worker queue, progress+summary -> `queueEmbed`,
 *                               `queueSummaryEmbed`, `queueFinishedEmbed`
 *   PubloaderDupesWebhook       duplicate chapters found          -> `dupesEmbeds`
 *   PubloaderNotIndexedWebhook  uploaded but not indexed by MD    -> `notIndexedEmbed`
 *   PubloaderWebhook            general operational message       -> `messageEmbed`
 *   WebhookLogHandler           log records above a level         -> `logEmbed`
 *
 * The transport (splitting oversized embeds, batching ten per message, the 6000
 * character budget across a whole message) already lives in webhook.ts and was
 * already a faithful port; only the embed *shapes* were missing.
 */
import type { DiscordEmbedInput, DiscordField } from "./webhook.js";

/** `COLOUR` in webhook.py — the default for anything that does not override it. */
export const COLOUR_DEFAULT = "B86F8C";
/** `PubloaderDupesWebhook.colour`. */
export const COLOUR_DUPES = "C8AA69";
/** `PubloaderNotIndexedWebhook.colour`. */
export const COLOUR_NOT_INDEXED = "45539B";

export const MD_CHAPTER_URL = "https://mangadex.org/chapter/";
export const MD_MANGA_URL = "https://mangadex.org/manga/";

/** Python's `EXPIRE_TIME`: the sentinel printed when a chapter has no expiry. */
export const EXPIRE_TIME = "1990-01-01T00:00:00+00:00";

/** Discord caps fields at 25 per embed; Python chunked by the same number. */
const FIELDS_PER_EMBED = 25;

/** One chapter, in the shape these embeds read. Loose on purpose: the callers
 *  hold rows from three different tables and Python read a dict too. */
export interface EmbedChapter {
  mangaName?: string | null;
  chapterNumber?: string | null;
  chapterTitle?: string | null;
  chapterLanguage?: string | null;
  chapterExpire?: string | Date | null;
  chapterUrl?: string | null;
  mangaUrl?: string | null;
  mdChapterId?: string | null;
  mdMangaId?: string | null;
  extensionName?: string | null;
}

/**
 * Python's `_format_link`. Returns "" when there is no URL, so the caller can
 * concatenate unconditionally and simply get nothing.
 *
 * `name.title()` in Python title-cases every word, which is why an extension
 * called `mangaplus` appears as `Mangaplus` in the link text. Reproduced rather
 * than corrected: changing it would be a visible difference in every embed.
 */
export function formatLink(
  name: string | null | undefined,
  type: string | null | undefined,
  url: string | null | undefined,
  skip = false,
): string {
  if (skip || !url) return "";
  const label = name == null ? "" : titleCase(name);
  const kind = type == null ? "" : type.toLowerCase();
  return `${label} ${kind} link: [here](${url})\n`;
}

/** Python's `str.title()`: upper-case after any non-alphabetic character. */
function titleCase(value: string): string {
  return value.replace(/[A-Za-z]+/g, (word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase());
}

function expiryText(value: string | Date | null | undefined): string {
  if (value == null) return EXPIRE_TIME;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? EXPIRE_TIME : date.toISOString();
}

/**
 * Python's `normalise_chapter`: one embed field per chapter.
 *
 * `failedUpload` suppresses the two MangaDex links, because a chapter that
 * failed to upload has no MangaDex chapter id to link to and the manga link
 * without it is misleading on its own.
 */
export function chapterField(
  chapter: EmbedChapter,
  { failedUpload = false, inline = true, success = false }: {
    failedUpload?: boolean;
    inline?: boolean;
    success?: boolean;
  } = {},
): DiscordField {
  const name =
    `Success: ${success ? "True" : "False"}\n` +
    `Manga: ${chapter.mangaName ?? "None"}\n` +
    `Chapter: ${chapter.chapterNumber ?? "None"}\n` +
    `Extension: ${chapter.extensionName ?? "None"}`;

  const value =
    `Language: \`${chapter.chapterLanguage ?? "None"}\`\n` +
    `Chapter title: \`${chapter.chapterTitle ?? "None"}\`\n` +
    `Chapter expiry: \`${expiryText(chapter.chapterExpire)}\`\n` +
    "\n" +
    formatLink("MangaDex", "chapter", chapter.mdChapterId ? `${MD_CHAPTER_URL}${chapter.mdChapterId}` : null, failedUpload) +
    formatLink("MangaDex", "manga", chapter.mdMangaId ? `${MD_MANGA_URL}${chapter.mdMangaId}` : null, failedUpload) +
    "\n" +
    formatLink(chapter.extensionName, "chapter", chapter.chapterUrl) +
    formatLink(chapter.extensionName, "manga", chapter.mangaUrl);

  return { name, value, inline };
}

/** Python's `normalise_chapters`: fields chunked 25 to an embed. */
export function chapterFieldChunks(
  chapters: EmbedChapter[],
  options: { failedUpload?: boolean; success?: boolean } = {},
): DiscordField[][] {
  const fields = chapters.map((c) => chapterField(c, options));
  const out: DiscordField[][] = [];
  for (let i = 0; i < fields.length; i += FIELDS_PER_EMBED) {
    out.push(fields.slice(i, i + FIELDS_PER_EMBED));
  }
  return out;
}

export interface UpdatesInput {
  extensionName: string;
  mangaTitle: string;
  mdMangaId: string;
  /** Chapters that will be uploaded. */
  chapters: EmbedChapter[];
  /** Chapters that failed; their MangaDex links are suppressed. */
  failedChapters?: EmbedChapter[];
  skipped?: number;
  edited?: number;
}

/**
 * `PubloaderUpdatesWebhook`: what a run decided to do, per manga.
 *
 * This is the one that fires at UPDATE-CHECK time rather than after a successful
 * upload — "To Upload" is a plan, not a result. That distinction is the whole
 * character of the Python notifications and is why a channel full of
 * "upload succeeded" messages reads wrong.
 *
 * One embed per 25-chapter chunk, each repeating the manga header, exactly as
 * Python did: the header is what identifies the series when Discord splits a
 * long run across several messages.
 */
export function updatesEmbeds(input: UpdatesInput): DiscordEmbedInput[] {
  const description =
    `MangaDex manga link: [here](${MD_MANGA_URL}${input.mdMangaId})\n` +
    `To Upload: ${input.chapters.length}\n` +
    `Skipped: ${input.skipped ?? 0}\n` +
    `To Edit: ${input.edited ?? 0}`;

  const groups = [
    ...chapterFieldChunks(input.chapters),
    ...chapterFieldChunks(input.failedChapters ?? [], { failedUpload: true }),
  ];

  // Python skipped empty chunks but still sent the header embed when there were
  // no chapters at all, so a manga with only skips is still reported.
  if (groups.length === 0) {
    return [
      {
        title: input.mangaTitle,
        description,
        colour: COLOUR_DEFAULT,
        footer: `extensions.${input.extensionName}`,
        timestamp: new Date().toISOString(),
      },
    ];
  }

  return groups.map((fields) => ({
    title: input.mangaTitle,
    description,
    colour: COLOUR_DEFAULT,
    footer: `extensions.${input.extensionName}`,
    timestamp: new Date().toISOString(),
    fields,
  }));
}

/**
 * `PubloaderQueueWebhook.add_chapter`: per-chapter progress for a queue worker.
 *
 * Python named the embed after the worker thread ("Uploader", "Deleter",
 * "Editor"). The new pipeline has one uploader draining typed queues, so the
 * kind of work is the closest equivalent and is what is used here.
 */
export function queueEmbed(workerType: string, chapter: EmbedChapter, processed: boolean): DiscordEmbedInput {
  return {
    title: titleCase(workerType),
    colour: COLOUR_DEFAULT,
    timestamp: new Date().toISOString(),
    fields: [chapterField(chapter, { success: processed, failedUpload: !processed })],
  };
}

/** `PubloaderQueueWebhook.send_summary` for the unavailable/summary-only kinds. */
export function queueSummaryEmbed(
  workerType: string,
  processed: number,
  failed: number,
): DiscordEmbedInput {
  let description = `Marked unavailable: ${processed}`;
  if (failed > 0) description += `\nFailed: ${failed}`;
  return {
    title: `${processed} chapters marked unavailable`,
    description,
    colour: COLOUR_DEFAULT,
    timestamp: new Date().toISOString(),
    footer: titleCase(workerType),
  };
}

/** `PubloaderQueueWebhook.send_queue_finished`. */
export function queueFinishedEmbed(workerType: string): DiscordEmbedInput {
  return {
    title: `${titleCase(workerType)}: Finished all items in queue`,
    colour: COLOUR_DEFAULT,
    timestamp: new Date().toISOString(),
  };
}

/**
 * `PubloaderDupesWebhook`: duplicate chapters found on MangaDex for one manga.
 *
 * Each field names the chapter the duplicates are OF, then lists them — the
 * grouping matters, because the operator's next action is deleting all but one.
 */
export function dupesEmbeds(
  mangaTitle: string,
  mdMangaId: string,
  groups: { mainChapterId: string; chapterNumber?: string | null; language?: string | null; duplicateIds: string[] }[],
): DiscordEmbedInput[] {
  const fields: DiscordField[] = groups.map((g) => ({
    name:
      `Dupes of chapter: ${g.mainChapterId}\n` +
      `Chapter Number: ${g.chapterNumber ?? "None"}\n` +
      `Chapter Language: ${g.language ?? "None"}`,
    value: g.duplicateIds.map((id) => `[${id}](${MD_CHAPTER_URL}${id})`).join("\n") || "None",
    inline: true,
  }));

  const chunks: DiscordField[][] = [];
  for (let i = 0; i < fields.length; i += FIELDS_PER_EMBED) chunks.push(fields.slice(i, i + FIELDS_PER_EMBED));
  if (chunks.length === 0) return [];

  return chunks.map((chunk) => ({
    title: `Dupes in: ${mangaTitle}`,
    description: `MangaDex manga link: [here](${MD_MANGA_URL}${mdMangaId})`,
    colour: COLOUR_DUPES,
    timestamp: new Date().toISOString(),
    fields: chunk,
  }));
}

/**
 * `PubloaderNotIndexedWebhook`: chapters MangaDex accepted but never indexed.
 *
 * Worth keeping distinct from a failure: the upload succeeded, so retrying is
 * wrong, but the chapter is not visible to readers and somebody has to know.
 */
export function notIndexedEmbed(
  title: string,
  chapterIds: string[],
  extensionName?: string | null,
): DiscordEmbedInput {
  const description = chapterIds.map((id) => `[${id}](${MD_CHAPTER_URL}${id})`).join("\n");
  return {
    title,
    description: description ? `\n${description}` : undefined,
    colour: COLOUR_NOT_INDEXED,
    timestamp: new Date().toISOString(),
    ...(extensionName ? { footer: `extensions.${extensionName}` } : {}),
  };
}

/** `PubloaderWebhook`: the general-purpose operational message. */
export function messageEmbed(
  title: string,
  description?: string | null,
  options: { colour?: string; extensionName?: string | null } = {},
): DiscordEmbedInput {
  return {
    title,
    ...(description ? { description } : {}),
    colour: options.colour ?? COLOUR_DEFAULT,
    timestamp: new Date().toISOString(),
    ...(options.extensionName ? { footer: `extensions.${options.extensionName}` } : {}),
  };
}

/**
 * `WebhookLogHandler`: a log record, as an embed.
 *
 * Python attached this to the logger so anything at or above a level went to
 * Discord. That is reproduced, but note the platform also records every
 * application-level event as a durable row visible in the dashboard's Activity
 * feed — so this is best pointed at ERROR and above, or the channel becomes a
 * firehose that duplicates a better view.
 */
export function logEmbed(level: string, message: string, extensionName?: string | null): DiscordEmbedInput {
  return {
    title: level.toUpperCase(),
    description: message,
    colour: level.toLowerCase() === "error" ? "E74C3C" : COLOUR_DEFAULT,
    timestamp: new Date().toISOString(),
    ...(extensionName ? { footer: `extensions.${extensionName}` } : {}),
  };
}
