-- Namespaced external ids, and the three relations hiding inside
-- extension_configs.override_options promoted to tables. Also carries two
-- nullable bookkeeping columns for untracked_manga (see below), which ride along
-- here rather than in a migration of their own because they are additive and
-- this migration had not shipped yet. Written to be SAFE ON A POPULATED
-- DATABASE.
--
-- `prisma migrate dev` would have dropped and recreated the unique index on
-- tracked_manga and dropped override_options outright, discarding the series map
-- and every override an operator has set. This migration adds the column with a
-- default so existing rows keep their identity, then EXPANDS the JSONB into the
-- new tables before removing the three keys it read.
--
-- Two deliberate deviations from a naive reading of "drop the column":
--
--  1. `override_options` SURVIVES, minus the three keys. The blob is not only
--     the three relations — mangaplus's real file also carries `empty`,
--     `noformat`, `custom` (title regexes), `num2words`,
--     `override_chapter_numbers` and `no_chapters`, which the EXTENSION reads in
--     the worker and core never interprets. Dropping the column would delete
--     six live config keys that have no other home.
--  2. A `custom_language` value that is not a MangaDex language code does not
--     abort the migration and is not silently discarded: it is PARKED under
--     `override_options -> 'custom_language_rejected'` and counted in a RAISE
--     NOTICE. An unknown code was never doing anything useful (it widened the
--     keep-set by a language MangaDex has never heard of), but it is the record
--     of an operator's intent and deleting it would lose the evidence of the
--     typo along with the typo.
--
-- Replayable: it may run before or after the Mongo import (see
-- docs/migration-guide.md), and against a database where these tables are empty.

-- ------------------------------------------------------ tracked_manga.namespace
--
-- DEFAULT '' rather than NULL: the namespace is part of a unique key, and NULLs
-- do not compare equal in one, so a nullable column would let the same
-- (extension, mangaId) be inserted an unbounded number of times — the exact
-- collision this change exists to prevent, inverted.
ALTER TABLE "tracked_manga" ADD COLUMN "namespace" TEXT NOT NULL DEFAULT '';

DROP INDEX "tracked_manga_extension_manga_id_key";
CREATE UNIQUE INDEX "tracked_manga_extension_namespace_manga_id_key"
  ON "tracked_manga" ("extension", "namespace", "manga_id");
CREATE INDEX "tracked_manga_extension_namespace_idx"
  ON "tracked_manga" ("extension", "namespace");

-- ------------------------------------------- untracked_manga.md_applied_at/by
--
-- Records that an operator's corrections to an untracked series were pushed to
-- its MangaDex entry. The audit log has the action, but deriving "was this
-- applied, when, by whom" from an append-only log makes a routine read depend on
-- log retention; these are current state about the row.
--
-- Both nullable with no default, so this is a pure metadata change: no backfill,
-- no rewrite of the existing rows, nothing to get wrong. NULL means never
-- applied, which is the correct reading for every row that predates the feature.
ALTER TABLE "untracked_manga"
  ADD COLUMN "md_applied_at" TIMESTAMP(3),
  ADD COLUMN "md_applied_by" TEXT;

-- --------------------------------------------------- override option relations
CREATE TABLE "extension_chapter_aliases" (
  "id" TEXT NOT NULL,
  "extension" TEXT NOT NULL,
  "master_chapter_id" TEXT NOT NULL,
  "alias_chapter_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "extension_chapter_aliases_pkey" PRIMARY KEY ("id")
);
-- The constraint the JSON dict could not express: an alias has ONE master.
CREATE UNIQUE INDEX "extension_chapter_aliases_extension_alias_chapter_id_key"
  ON "extension_chapter_aliases" ("extension", "alias_chapter_id");
CREATE INDEX "extension_chapter_aliases_extension_idx"
  ON "extension_chapter_aliases" ("extension");
CREATE INDEX "extension_chapter_aliases_extension_master_chapter_id_idx"
  ON "extension_chapter_aliases" ("extension", "master_chapter_id");

CREATE TABLE "extension_multi_chapters" (
  "id" TEXT NOT NULL,
  "extension" TEXT NOT NULL,
  "chapter_id" TEXT NOT NULL,
  "chapter_number" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "extension_multi_chapters_pkey" PRIMARY KEY ("id")
);
-- Short name on purpose: the conventional one is 64 characters and Postgres
-- truncates identifiers at 63, so schema.prisma pins it with `map:` to match.
CREATE UNIQUE INDEX "extension_multi_chapters_unique"
  ON "extension_multi_chapters" ("extension", "chapter_id", "chapter_number");
CREATE INDEX "extension_multi_chapters_extension_idx"
  ON "extension_multi_chapters" ("extension");

CREATE TABLE "extension_language_maps" (
  "id" TEXT NOT NULL,
  "extension" TEXT NOT NULL,
  "source_language" TEXT NOT NULL,
  "mangadex_language" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "extension_language_maps_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "extension_language_maps_extension_source_language_key"
  ON "extension_language_maps" ("extension", "source_language");
CREATE INDEX "extension_language_maps_extension_idx"
  ON "extension_language_maps" ("extension");

-- ------------------------------------------------------------ data expansion
--
-- Every jsonb_each / jsonb_array_elements_text below is guarded on
-- jsonb_typeof, which is load-bearing for the same reason it is in
-- 20260729214943_optimise_names: both functions RAISE on the wrong input type,
-- which would abort the whole migration over one malformed config document
-- rather than leaving that one extension without overrides.
--
-- `gen_random_uuid()` is pgcrypto/PG13+ core; the id columns are TEXT because
-- Prisma's @default(uuid()) generates them client-side.

-- same: {master: [alias, …]} -> one row per alias.
--
-- DISTINCT ON (extension, alias) enforces the new constraint during the copy:
-- a legacy document that listed one alias under two masters cannot be inserted
-- whole, and the row kept is the one findKeyFromListValue would have returned
-- (it scanned Object.entries in order, so the lexicographically-first master
-- under jsonb's sorted key order is the one that was already winning).
INSERT INTO "extension_chapter_aliases" ("id", "extension", "master_chapter_id", "alias_chapter_id")
SELECT DISTINCT ON (src."extension", src."alias_chapter_id")
       gen_random_uuid()::text, src."extension", src."master_chapter_id", src."alias_chapter_id"
FROM (
  SELECT c."extension",
         entry.key AS "master_chapter_id",
         alias.value AS "alias_chapter_id"
  FROM "extension_configs" c
  CROSS JOIN LATERAL jsonb_each(c."override_options" -> 'same') AS entry
  CROSS JOIN LATERAL jsonb_array_elements_text(entry.value) AS alias
  WHERE jsonb_typeof(c."override_options" -> 'same') = 'object'
    AND jsonb_typeof(entry.value) = 'array'
) src
-- A chapter cannot be an alias of itself; the platform ignored such an entry
-- and the constraint would happily store it.
WHERE src."alias_chapter_id" <> src."master_chapter_id"
ORDER BY src."extension", src."alias_chapter_id", src."master_chapter_id";

-- multi_chapters: {chapterId: [number, …]} -> one row per (chapter, number).
INSERT INTO "extension_multi_chapters" ("id", "extension", "chapter_id", "chapter_number")
SELECT DISTINCT gen_random_uuid()::text, src."extension", src."chapter_id", src."chapter_number"
FROM (
  SELECT c."extension",
         entry.key AS "chapter_id",
         number.value AS "chapter_number"
  FROM "extension_configs" c
  CROSS JOIN LATERAL jsonb_each(c."override_options" -> 'multi_chapters') AS entry
  CROSS JOIN LATERAL jsonb_array_elements_text(entry.value) AS number
  WHERE jsonb_typeof(c."override_options" -> 'multi_chapters') = 'object'
    AND jsonb_typeof(entry.value) = 'array'
) src;

-- custom_language: {key: mangadexLanguage}. The allowlist below must stay in
-- step with src/contracts/languages.ts — that file is the one an operator write
-- is validated against, and a code accepted here but rejected there would make
-- the migration produce a row the API could not reproduce.
INSERT INTO "extension_language_maps" ("id", "extension", "source_language", "mangadex_language")
SELECT gen_random_uuid()::text, c."extension", entry.key, lower(btrim(entry.value #>> '{}'))
FROM "extension_configs" c
CROSS JOIN LATERAL jsonb_each(c."override_options" -> 'custom_language') AS entry
WHERE jsonb_typeof(c."override_options" -> 'custom_language') = 'object'
  AND jsonb_typeof(entry.value) = 'string'
  AND lower(btrim(entry.value #>> '{}')) IN (
    'ar','az','be','bg','bn','ca','cs','da','de','el','en','eo','es','es-la','et',
    'fa','fi','fil','fr','he','hi','hr','hu','hy','id','it','ja','ja-ro','jv','ka',
    'kk','km','kn','ko','ko-ro','la','lt','mn','ms','my','ne','nl','no','pl','pt',
    'pt-br','ro','ru','sk','sl','sq','sr','sv','ta','te','th','tl','tr','uk','ur',
    'uz','vi','zh','zh-hk','zh-ro'
  );

-- Park the custom_language entries the allowlist refused, so the typo is
-- recoverable rather than deleted, and say how many there were.
DO $$
DECLARE
  parked integer := 0;
BEGIN
  WITH rejected AS (
    SELECT c."extension", jsonb_object_agg(entry.key, entry.value) AS "entries"
    FROM "extension_configs" c
    CROSS JOIN LATERAL jsonb_each(c."override_options" -> 'custom_language') AS entry
    WHERE jsonb_typeof(c."override_options" -> 'custom_language') = 'object'
      AND NOT EXISTS (
        SELECT 1 FROM "extension_language_maps" m
        WHERE m."extension" = c."extension" AND m."source_language" = entry.key
      )
    GROUP BY c."extension"
  )
  UPDATE "extension_configs" c
    SET "override_options" =
      jsonb_set(c."override_options", '{custom_language_rejected}', r."entries", true)
    FROM rejected r
    WHERE r."extension" = c."extension";
  GET DIAGNOSTICS parked = ROW_COUNT;
  IF parked > 0 THEN
    RAISE NOTICE
      'custom_language: % extension(s) had codes outside the MangaDex allowlist; parked under override_options.custom_language_rejected',
      parked;
  END IF;
END
$$;

-- The three keys are tables now. Remove only those, leaving the
-- extension-private remainder (and any parked rejects) in place — see the note
-- at the top of this file for why the column itself stays.
UPDATE "extension_configs"
  SET "override_options" = "override_options" - 'same' - 'multi_chapters' - 'custom_language'
  WHERE jsonb_typeof("override_options") = 'object';

DO $$
DECLARE
  aliases integer;
  multi integer;
  languages integer;
BEGIN
  SELECT count(*) INTO aliases FROM "extension_chapter_aliases";
  SELECT count(*) INTO multi FROM "extension_multi_chapters";
  SELECT count(*) INTO languages FROM "extension_language_maps";
  RAISE NOTICE 'override options normalised: % chapter aliases, % multi-chapter numbers, % language overrides',
    aliases, multi, languages;
END
$$;
