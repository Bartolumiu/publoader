import { z } from "zod";

/**
 * The language codes MangaDex accepts as a chapter's `translatedLanguage`.
 *
 * This exists because `custom_language` is the one override option that names a
 * MangaDex-side value, and a typo in it is silently destructive: the platform
 * unions `Object.values(custom_language)` into the set of languages allowed to
 * stay on a title (see findExtraChapters in core/processor/dedupe.ts), so
 * "pt_br" instead of "pt-br" does not fail loudly — it just stops protecting
 * every Brazilian-Portuguese chapter from the removal pass. The allowlist turns
 * that into a rejected write.
 *
 * Composition: ISO 639-1 two-letter codes, plus the regional and romanised
 * variants MangaDex adds (`es-la`, `pt-br`, `zh-hk`, and the `-ro` forms), plus
 * `tl`/`fil` which MangaDex accepts interchangeably for Filipino. Every code in
 * the manifests of both extension repos validates against it, as does the only
 * `custom_language` value in production data (`es-la`, mangaplus).
 *
 * It deliberately does NOT contain the extension-side sentinel `"NULL"` that
 * mangaplus's resolveLanguage returns for "this chapter has no language I can
 * map" — that value must never reach MangaDex, and the extension drops those
 * chapters itself.
 */
export const MANGADEX_LANGUAGES = [
  "ar",
  "az",
  "be",
  "bg",
  "bn",
  "ca",
  "cs",
  "da",
  "de",
  "el",
  "en",
  "eo",
  "es",
  "es-la",
  "et",
  "fa",
  "fi",
  "fil",
  "fr",
  "he",
  "hi",
  "hr",
  "hu",
  "hy",
  "id",
  "it",
  "ja",
  "ja-ro",
  "jv",
  "ka",
  "kk",
  "km",
  "kn",
  "ko",
  "ko-ro",
  "la",
  "lt",
  "mn",
  "ms",
  "my",
  "ne",
  "nl",
  "no",
  "pl",
  "pt",
  "pt-br",
  "ro",
  "ru",
  "sk",
  "sl",
  "sq",
  "sr",
  "sv",
  "ta",
  "te",
  "th",
  "tl",
  "tr",
  "uk",
  "ur",
  "uz",
  "vi",
  "zh",
  "zh-hk",
  "zh-ro",
] as const;

export type MangadexLanguage = (typeof MANGADEX_LANGUAGES)[number];

/**
 * Case-insensitive on the way in, canonical (lower-case) on the way out.
 * MangaDex itself is case-sensitive, and an operator typing "PT-BR" into the
 * dashboard means `pt-br`, not a rejection.
 */
export const MangadexLanguageCode = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(MANGADEX_LANGUAGES));

const ALLOWED = new Set<string>(MANGADEX_LANGUAGES);

/** The canonical form of `code`, or null when MangaDex would not accept it. */
export function normaliseMangadexLanguage(code: unknown): MangadexLanguage | null {
  if (typeof code !== "string") return null;
  const candidate = code.trim().toLowerCase();
  return ALLOWED.has(candidate) ? (candidate as MangadexLanguage) : null;
}
