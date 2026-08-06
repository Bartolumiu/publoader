import type { Prisma, PrismaClient } from "@prisma/client";
import { normaliseMangadexLanguage } from "../../contracts/languages.js";
import type { OverrideOptionsLike } from "../processor/dedupe.js";

/**
 * Per-extension override options.
 *
 * These used to be one JSONB dict, which hid three distinct relations with
 * three distinct constraints inside a shape that could express none of them:
 *
 *   same            -> extension_chapter_aliases   (an alias has ONE master)
 *   multi_chapters  -> extension_multi_chapters    (a set of chapter numbers)
 *   custom_language -> extension_language_maps     (one MangaDex code per key,
 *                                                   and it must be a real one)
 *
 * Everything else in the dict is extension-private (mangaplus's title regexes,
 * `num2words`, `no_chapters`, …) and stays in `extension_configs.override_options`:
 * see the model comment in schema.prisma.
 *
 * This store is the single call site for all of it: `load` returns the exact
 * `OverrideOptionsLike` shape core/processor/dedupe.ts already consumes, so the
 * processor's decision logic did not change when the storage did.
 */

/** The three normalised relations, in the legacy shape the processor expects. */
export interface NormalisedOverrideOptions {
  same: Record<string, string[]>;
  multi_chapters: Record<string, string[]>;
  custom_language: Record<string, string>;
}

/** A row a write refused, reported per-row so a bad paste is not a failed paste. */
export interface OverrideRejection {
  /** Which relation the row belongs to. */
  option: "same" | "multi_chapters" | "custom_language";
  key: string;
  value?: string;
  reason: string;
}

export interface ReplaceResult {
  aliases: number;
  multiChapters: number;
  languages: number;
  /** Keys left in the free-form blob because the platform does not model them. */
  passthroughKeys: string[];
  rejected: OverrideRejection[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The three keys this store owns; anything else is passed through untouched. */
const NORMALISED_KEYS = ["same", "multi_chapters", "custom_language"] as const;

export class ExtensionConfigStore {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * The three relations for one extension, assembled into the shape
   * `decideForManga` and `findDuplicateChapters` take.
   *
   * Rows are ordered so the result is byte-identical between calls. Order is
   * not semantically load-bearing (see the ExtensionMultiChapter model
   * comment), but a stable result makes a config diff in a log or an audit
   * entry mean something.
   */
  async load(extension: string): Promise<NormalisedOverrideOptions> {
    const [aliases, multi, languages] = await Promise.all([
      this.prisma.extensionChapterAlias.findMany({
        where: { extension },
        select: { masterChapterId: true, aliasChapterId: true },
        orderBy: [{ masterChapterId: "asc" }, { aliasChapterId: "asc" }],
      }),
      this.prisma.extensionMultiChapter.findMany({
        where: { extension },
        select: { chapterId: true, chapterNumber: true },
        orderBy: [{ chapterId: "asc" }, { chapterNumber: "asc" }],
      }),
      this.prisma.extensionLanguageMap.findMany({
        where: { extension },
        select: { sourceLanguage: true, mangadexLanguage: true },
        orderBy: { sourceLanguage: "asc" },
      }),
    ]);

    const same: Record<string, string[]> = {};
    for (const row of aliases) {
      (same[row.masterChapterId] ??= []).push(row.aliasChapterId);
    }
    const multiChapters: Record<string, string[]> = {};
    for (const row of multi) {
      (multiChapters[row.chapterId] ??= []).push(row.chapterNumber);
    }
    const customLanguage: Record<string, string> = {};
    for (const row of languages) {
      customLanguage[row.sourceLanguage] = row.mangadexLanguage;
    }

    return { same, multi_chapters: multiChapters, custom_language: customLanguage };
  }

  /**
   * The full override-options document as an extension expects to receive it:
   * the free-form blob with the three normalised relations layered on top.
   *
   * The tables win on a key collision. A stale `same` left in the blob by a
   * hand-edited row must not shadow the table that the migration and every
   * write since have maintained.
   */
  async loadForLease(extension: string): Promise<Record<string, unknown>> {
    const [config, normalised] = await Promise.all([
      this.prisma.extensionConfig.findUnique({ where: { extension } }),
      this.load(extension),
    ]);
    const passthrough = isPlainObject(config?.overrideOptions) ? config.overrideOptions : {};
    const delivered: Record<string, unknown> = { ...passthrough };
    // Empty relations are omitted rather than sent as {}: an extension that
    // checks `options.same` for presence should see the same thing it saw when
    // its bundle's JSON file simply had no such key.
    for (const key of NORMALISED_KEYS) {
      if (Object.keys(normalised[key]).length > 0) delivered[key] = normalised[key];
      else delete delivered[key];
    }
    return delivered;
  }

  /** `load`, widened to the interface the processor's decision functions take. */
  async loadForProcessor(extension: string): Promise<OverrideOptionsLike> {
    return this.load(extension);
  }

  /**
   * Replace an extension's whole override-options document.
   *
   * Accepts the legacy dict verbatim; that is what an operator has to hand,
   * what a bundle's override_options.json contains, and what the admin API has
   * always taken; splits the three modelled relations out into their tables,
   * and keeps the rest as the free-form blob.
   *
   * Rows the constraints refuse are reported, not thrown: a document with one
   * bad language code should land with that one row rejected, exactly as the
   * tracked-manga batch endpoint treats a bad line.
   */
  async replace(extension: string, document: unknown): Promise<ReplaceResult> {
    const blob = isPlainObject(document) ? document : {};
    const rejected: OverrideRejection[] = [];

    const aliases = parseAliases(blob["same"], rejected);
    const multiChapters = parseMultiChapters(blob["multi_chapters"], rejected);
    const languages = parseLanguages(blob["custom_language"], rejected);

    const passthrough: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(blob)) {
      if (!(NORMALISED_KEYS as readonly string[]).includes(key)) passthrough[key] = value;
    }

    // One transaction: a half-applied config is worse than a refused one,
    // because `same` and `multi_chapters` decide what gets deleted from
    // MangaDex and an operator cannot see the difference from the outside.
    await this.prisma.$transaction(async (tx) => {
      await tx.extensionConfig.upsert({
        where: { extension },
        create: { extension, overrideOptions: passthrough as Prisma.InputJsonObject },
        update: { overrideOptions: passthrough as Prisma.InputJsonObject },
      });
      await tx.extensionChapterAlias.deleteMany({ where: { extension } });
      await tx.extensionMultiChapter.deleteMany({ where: { extension } });
      await tx.extensionLanguageMap.deleteMany({ where: { extension } });
      if (aliases.length > 0) {
        await tx.extensionChapterAlias.createMany({
          data: aliases.map((row) => ({ extension, ...row })),
        });
      }
      if (multiChapters.length > 0) {
        await tx.extensionMultiChapter.createMany({
          data: multiChapters.map((row) => ({ extension, ...row })),
        });
      }
      if (languages.length > 0) {
        await tx.extensionLanguageMap.createMany({
          data: languages.map((row) => ({ extension, ...row })),
        });
      }
    });

    return {
      aliases: aliases.length,
      multiChapters: multiChapters.length,
      languages: languages.length,
      passthroughKeys: Object.keys(passthrough).sort(),
      rejected,
    };
  }

  /**
   * Seed an extension's config from its bundle, without overwriting anything.
   *
   * Publishing a bundle must not silently revert operator edits, so this is
   * create-only in both halves: the blob is inserted only when there is no row,
   * and the three tables are seeded only when they are empty for this
   * extension. A partially-curated extension keeps what it has.
   */
  async seedIfAbsent(extension: string, document: unknown): Promise<boolean> {
    const [config, aliasCount, multiCount, languageCount] = await Promise.all([
      this.prisma.extensionConfig.findUnique({ where: { extension } }),
      this.prisma.extensionChapterAlias.count({ where: { extension } }),
      this.prisma.extensionMultiChapter.count({ where: { extension } }),
      this.prisma.extensionLanguageMap.count({ where: { extension } }),
    ]);
    if (config !== null || aliasCount > 0 || multiCount > 0 || languageCount > 0) return false;
    await this.replace(extension, document);
    return true;
  }

  /** Everything an operator needs to see, in one payload for the admin API. */
  async describe(extension: string): Promise<{
    extension: string;
    overrideOptions: Record<string, unknown>;
    passthrough: Record<string, unknown>;
    same: Record<string, string[]>;
    multi_chapters: Record<string, string[]>;
    custom_language: Record<string, string>;
  }> {
    const [config, normalised] = await Promise.all([
      this.prisma.extensionConfig.findUnique({ where: { extension } }),
      this.load(extension),
    ]);
    const passthrough = isPlainObject(config?.overrideOptions) ? config.overrideOptions : {};
    return {
      extension,
      // The reassembled legacy document, so `ext-config get | ext-config set`
      // still round-trips and a caller written against the old field keeps
      // working.
      overrideOptions: { ...passthrough, ...stripEmpty(normalised) },
      passthrough,
      ...normalised,
    };
  }
}

function stripEmpty(normalised: NormalisedOverrideOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of NORMALISED_KEYS) {
    if (Object.keys(normalised[key]).length > 0) out[key] = normalised[key];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Legacy-document parsing. Each of these mirrors one jsonb expansion in
// prisma/migrations/20260730_normalise_extension_config/migration.sql; the two
// must agree, so keep them in step.
// ---------------------------------------------------------------------------

function parseAliases(
  value: unknown,
  rejected: OverrideRejection[],
): { masterChapterId: string; aliasChapterId: string }[] {
  if (value === undefined || value === null) return [];
  if (!isPlainObject(value)) {
    rejected.push({ option: "same", key: "", reason: "expected an object of master id -> alias ids" });
    return [];
  }
  const rows: { masterChapterId: string; aliasChapterId: string }[] = [];
  // An alias may have only one master, so the first master to claim it wins and
  // the second is reported. The JSON dict allowed the conflict and resolved it
  // by enumeration order; saying so out loud is the point of the constraint.
  const claimed = new Map<string, string>();
  for (const [master, aliasList] of Object.entries(value)) {
    if (!Array.isArray(aliasList)) {
      rejected.push({ option: "same", key: master, reason: "value is not a list of chapter ids" });
      continue;
    }
    for (const alias of aliasList) {
      if (typeof alias !== "string" && typeof alias !== "number") {
        rejected.push({ option: "same", key: master, reason: "alias id is not a string" });
        continue;
      }
      const aliasId = String(alias);
      if (aliasId === master) {
        rejected.push({
          option: "same",
          key: master,
          value: aliasId,
          reason: "a chapter cannot be an alias of itself",
        });
        continue;
      }
      const owner = claimed.get(aliasId);
      if (owner !== undefined) {
        if (owner !== master) {
          rejected.push({
            option: "same",
            key: master,
            value: aliasId,
            reason: `already an alias of ${owner}; an alias may have only one master`,
          });
        }
        continue;
      }
      claimed.set(aliasId, master);
      rows.push({ masterChapterId: master, aliasChapterId: aliasId });
    }
  }
  return rows;
}

function parseMultiChapters(
  value: unknown,
  rejected: OverrideRejection[],
): { chapterId: string; chapterNumber: string }[] {
  if (value === undefined || value === null) return [];
  if (!isPlainObject(value)) {
    rejected.push({
      option: "multi_chapters",
      key: "",
      reason: "expected an object of chapter id -> chapter numbers",
    });
    return [];
  }
  const rows: { chapterId: string; chapterNumber: string }[] = [];
  const seen = new Set<string>();
  for (const [chapterId, numbers] of Object.entries(value)) {
    if (!Array.isArray(numbers)) {
      rejected.push({
        option: "multi_chapters",
        key: chapterId,
        reason: "value is not a list of chapter numbers",
      });
      continue;
    }
    for (const number of numbers) {
      if (typeof number !== "string" && typeof number !== "number") {
        rejected.push({
          option: "multi_chapters",
          key: chapterId,
          reason: "chapter number is not a string",
        });
        continue;
      }
      const chapterNumber = String(number);
      const key = `${chapterId} ${chapterNumber}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ chapterId, chapterNumber });
    }
  }
  return rows;
}

function parseLanguages(
  value: unknown,
  rejected: OverrideRejection[],
): { sourceLanguage: string; mangadexLanguage: string }[] {
  if (value === undefined || value === null) return [];
  if (!isPlainObject(value)) {
    rejected.push({
      option: "custom_language",
      key: "",
      reason: "expected an object of source key -> MangaDex language code",
    });
    return [];
  }
  const rows: { sourceLanguage: string; mangadexLanguage: string }[] = [];
  for (const [sourceLanguage, target] of Object.entries(value)) {
    const mangadexLanguage = normaliseMangadexLanguage(target);
    if (mangadexLanguage === null) {
      // Not fatal, and not silent: an unknown code here would have widened the
      // keep-set by a language MangaDex has never heard of, which protects
      // nothing. The row is dropped and named.
      rejected.push({
        option: "custom_language",
        key: sourceLanguage,
        value: typeof target === "string" ? target : String(target),
        reason: "not a MangaDex language code",
      });
      continue;
    }
    rows.push({ sourceLanguage, mangadexLanguage });
  }
  return rows;
}
