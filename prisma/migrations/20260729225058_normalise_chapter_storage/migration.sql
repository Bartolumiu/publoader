-- Promote the chapter JSONB document to typed columns on the four chapter
-- tables, written to be SAFE ON A POPULATED DATABASE.
--
-- `prisma migrate dev` generated `DROP COLUMN "chapter"` + `ADD COLUMN …` for
-- each table, which would have discarded every chapter snapshot the platform
-- holds (8.5k uploaded, 25k deleted, 429 unavailable at time of writing). This
-- migration adds the columns, copies the document into them, parks whatever has
-- no column in `extra`, and only then drops `chapter`.
--
-- The chapter shape is fixed and known (src/core/md/types.ts), so nothing is
-- open-ended except: page-artifact ids, the MangaDex attribute snapshot the
-- unavailable flow keeps, and keys the legacy Mongo import carried (`_id`,
-- `images`, `archivedAt`, `unavailableAt`). Those go to `extra` rather than
-- being dropped, so a migrated row can still be traced back to Mongo.
--
-- Replayable: it may run before or after the Mongo import (see
-- docs/migration-guide.md), and against a database where these tables are empty.

-- Exception-safe ISO-8601 -> timestamp(3). The JSON holds ISO strings, but this
-- is history imported from a loosely typed source, so a value that will not
-- parse must not abort the migration. `AT TIME ZONE 'UTC'` pins the result to
-- UTC independently of the session TimeZone, matching how Prisma reads the
-- timezone-less `timestamp(3)` columns it generates.
CREATE FUNCTION chapter_json_ts(value text) RETURNS timestamp(3)
  LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF value IS NULL OR value = '' THEN RETURN NULL; END IF;
  RETURN (value::timestamptz) AT TIME ZONE 'UTC';
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$$;

-- ---------------------------------------------------------- uploaded_chapters
-- md_chapter_id, extension, chapter_id, md_manga_id, chapter_language and
-- chapter_number are already columns here; the rest of the shape joins them.
ALTER TABLE "uploaded_chapters"
  ADD COLUMN "chapter_url" TEXT,
  ADD COLUMN "chapter_title" TEXT,
  ADD COLUMN "chapter_volume" TEXT,
  ADD COLUMN "chapter_timestamp" TIMESTAMP(3),
  ADD COLUMN "chapter_expire" TIMESTAMP(3),
  ADD COLUMN "chapter_lookup" TIMESTAMP(3),
  ADD COLUMN "manga_id" TEXT,
  ADD COLUMN "manga_name" TEXT,
  ADD COLUMN "manga_url" TEXT,
  ADD COLUMN "md_group_id" TEXT,
  ADD COLUMN "extra" JSONB;

UPDATE "uploaded_chapters" SET
  -- COALESCE on the pre-existing promoted columns: they were written from the
  -- same document and match it exactly, so this only backfills gaps and can
  -- never overwrite a populated column with something different.
  "extension"         = COALESCE(NULLIF("chapter" ->> 'extensionName', ''), "extension"),
  "chapter_id"        = COALESCE("chapter_id", "chapter" ->> 'chapterId'),
  "chapter_language"  = COALESCE("chapter_language", "chapter" ->> 'chapterLanguage'),
  "chapter_number"    = COALESCE("chapter_number", "chapter" ->> 'chapterNumber'),
  "md_manga_id"       = COALESCE("md_manga_id", "chapter" ->> 'mdMangaId'),
  "chapter_url"       = "chapter" ->> 'chapterUrl',
  "chapter_title"     = "chapter" ->> 'chapterTitle',
  "chapter_volume"    = "chapter" ->> 'chapterVolume',
  "chapter_timestamp" = chapter_json_ts("chapter" ->> 'chapterTimestamp'),
  "chapter_expire"    = chapter_json_ts("chapter" ->> 'chapterExpire'),
  "chapter_lookup"    = chapter_json_ts("chapter" ->> 'chapterLookup'),
  "manga_id"          = "chapter" ->> 'mangaId',
  "manga_name"        = "chapter" ->> 'mangaName',
  "manga_url"         = "chapter" ->> 'mangaUrl',
  "md_group_id"       = "chapter" ->> 'mdGroupId';

-- The residue. Promoted keys are stripped; a timestamp key is stripped only if
-- it actually converted, so an unparseable date survives verbatim in `extra`
-- instead of being silently turned into NULL. NULL when nothing is left over.
--
-- `_PydanticInitialised__` is the one key dropped outright: it is pydantic's
-- private "model was constructed" flag, not chapter data. The Mongo importer
-- already intends to drop it (see asRecord in src/cli/migrate-from-mongo.ts) and
-- missed this camelCased spelling.
UPDATE "uploaded_chapters" SET "extra" = NULLIF(
  "chapter" - (
    ARRAY['chapterId','chapterUrl','chapterNumber','chapterTitle','chapterVolume',
          'chapterLanguage','mangaId','mangaName','mangaUrl','mdChapterId',
          'mdMangaId','mdGroupId','extensionName',
          '_PydanticInitialised__','__pydantic_initialised__','__pydanticInitialised__']
    || CASE WHEN NULLIF("chapter" ->> 'chapterTimestamp', '') IS NOT NULL AND "chapter_timestamp" IS NULL
            THEN '{}'::text[] ELSE ARRAY['chapterTimestamp'] END
    || CASE WHEN NULLIF("chapter" ->> 'chapterExpire', '') IS NOT NULL AND "chapter_expire" IS NULL
            THEN '{}'::text[] ELSE ARRAY['chapterExpire'] END
    || CASE WHEN NULLIF("chapter" ->> 'chapterLookup', '') IS NOT NULL AND "chapter_lookup" IS NULL
            THEN '{}'::text[] ELSE ARRAY['chapterLookup'] END
  ), '{}'::jsonb);

ALTER TABLE "uploaded_chapters" DROP COLUMN "chapter";

-- ----------------------------------------------------------- deleted_chapters
ALTER TABLE "deleted_chapters"
  ADD COLUMN "chapter_id" TEXT,
  ADD COLUMN "chapter_url" TEXT,
  ADD COLUMN "chapter_number" TEXT,
  ADD COLUMN "chapter_title" TEXT,
  ADD COLUMN "chapter_volume" TEXT,
  ADD COLUMN "chapter_language" TEXT,
  ADD COLUMN "chapter_timestamp" TIMESTAMP(3),
  ADD COLUMN "chapter_expire" TIMESTAMP(3),
  ADD COLUMN "chapter_lookup" TIMESTAMP(3),
  ADD COLUMN "manga_id" TEXT,
  ADD COLUMN "manga_name" TEXT,
  ADD COLUMN "manga_url" TEXT,
  ADD COLUMN "md_manga_id" TEXT,
  ADD COLUMN "md_group_id" TEXT,
  ADD COLUMN "extra" JSONB;

UPDATE "deleted_chapters" SET
  "extension"         = COALESCE("extension", "chapter" ->> 'extensionName'),
  "chapter_id"        = "chapter" ->> 'chapterId',
  "chapter_url"       = "chapter" ->> 'chapterUrl',
  "chapter_number"    = "chapter" ->> 'chapterNumber',
  "chapter_title"     = "chapter" ->> 'chapterTitle',
  "chapter_volume"    = "chapter" ->> 'chapterVolume',
  "chapter_language"  = "chapter" ->> 'chapterLanguage',
  "chapter_timestamp" = chapter_json_ts("chapter" ->> 'chapterTimestamp'),
  "chapter_expire"    = chapter_json_ts("chapter" ->> 'chapterExpire'),
  "chapter_lookup"    = chapter_json_ts("chapter" ->> 'chapterLookup'),
  "manga_id"          = "chapter" ->> 'mangaId',
  "manga_name"        = "chapter" ->> 'mangaName',
  "manga_url"         = "chapter" ->> 'mangaUrl',
  "md_manga_id"       = "chapter" ->> 'mdMangaId',
  "md_group_id"       = "chapter" ->> 'mdGroupId';

UPDATE "deleted_chapters" SET "extra" = NULLIF(
  "chapter" - (
    ARRAY['chapterId','chapterUrl','chapterNumber','chapterTitle','chapterVolume',
          'chapterLanguage','mangaId','mangaName','mangaUrl','mdChapterId',
          'mdMangaId','mdGroupId','extensionName',
          '_PydanticInitialised__','__pydantic_initialised__','__pydanticInitialised__']
    || CASE WHEN NULLIF("chapter" ->> 'chapterTimestamp', '') IS NOT NULL AND "chapter_timestamp" IS NULL
            THEN '{}'::text[] ELSE ARRAY['chapterTimestamp'] END
    || CASE WHEN NULLIF("chapter" ->> 'chapterExpire', '') IS NOT NULL AND "chapter_expire" IS NULL
            THEN '{}'::text[] ELSE ARRAY['chapterExpire'] END
    || CASE WHEN NULLIF("chapter" ->> 'chapterLookup', '') IS NOT NULL AND "chapter_lookup" IS NULL
            THEN '{}'::text[] ELSE ARRAY['chapterLookup'] END
  ), '{}'::jsonb);

ALTER TABLE "deleted_chapters" DROP COLUMN "chapter";

-- ------------------------------------------------------- unavailable_chapters
ALTER TABLE "unavailable_chapters"
  ADD COLUMN "extension" TEXT,
  ADD COLUMN "chapter_id" TEXT,
  ADD COLUMN "chapter_url" TEXT,
  ADD COLUMN "chapter_number" TEXT,
  ADD COLUMN "chapter_title" TEXT,
  ADD COLUMN "chapter_volume" TEXT,
  ADD COLUMN "chapter_language" TEXT,
  ADD COLUMN "chapter_timestamp" TIMESTAMP(3),
  ADD COLUMN "chapter_expire" TIMESTAMP(3),
  ADD COLUMN "chapter_lookup" TIMESTAMP(3),
  ADD COLUMN "manga_id" TEXT,
  ADD COLUMN "manga_name" TEXT,
  ADD COLUMN "manga_url" TEXT,
  ADD COLUMN "md_manga_id" TEXT,
  ADD COLUMN "md_group_id" TEXT,
  ADD COLUMN "extra" JSONB;

UPDATE "unavailable_chapters" SET
  "extension"         = "chapter" ->> 'extensionName',
  "chapter_id"        = "chapter" ->> 'chapterId',
  "chapter_url"       = "chapter" ->> 'chapterUrl',
  "chapter_number"    = "chapter" ->> 'chapterNumber',
  "chapter_title"     = "chapter" ->> 'chapterTitle',
  "chapter_volume"    = "chapter" ->> 'chapterVolume',
  "chapter_language"  = "chapter" ->> 'chapterLanguage',
  "chapter_timestamp" = chapter_json_ts("chapter" ->> 'chapterTimestamp'),
  "chapter_expire"    = chapter_json_ts("chapter" ->> 'chapterExpire'),
  "chapter_lookup"    = chapter_json_ts("chapter" ->> 'chapterLookup'),
  "manga_id"          = "chapter" ->> 'mangaId',
  "manga_name"        = "chapter" ->> 'mangaName',
  "manga_url"         = "chapter" ->> 'mangaUrl',
  "md_manga_id"       = "chapter" ->> 'mdMangaId',
  "md_group_id"       = "chapter" ->> 'mdGroupId';

-- `mdAttributes` (the MangaDex snapshot taken at takedown), plus the legacy
-- `unavailableAt` / `archivedAt` stamps, fall through into `extra` here.
UPDATE "unavailable_chapters" SET "extra" = NULLIF(
  "chapter" - (
    ARRAY['chapterId','chapterUrl','chapterNumber','chapterTitle','chapterVolume',
          'chapterLanguage','mangaId','mangaName','mangaUrl','mdChapterId',
          'mdMangaId','mdGroupId','extensionName',
          '_PydanticInitialised__','__pydantic_initialised__','__pydanticInitialised__']
    || CASE WHEN NULLIF("chapter" ->> 'chapterTimestamp', '') IS NOT NULL AND "chapter_timestamp" IS NULL
            THEN '{}'::text[] ELSE ARRAY['chapterTimestamp'] END
    || CASE WHEN NULLIF("chapter" ->> 'chapterExpire', '') IS NOT NULL AND "chapter_expire" IS NULL
            THEN '{}'::text[] ELSE ARRAY['chapterExpire'] END
    || CASE WHEN NULLIF("chapter" ->> 'chapterLookup', '') IS NOT NULL AND "chapter_lookup" IS NULL
            THEN '{}'::text[] ELSE ARRAY['chapterLookup'] END
  ), '{}'::jsonb);

ALTER TABLE "unavailable_chapters" DROP COLUMN "chapter";

-- ------------------------------------------------------------ edited_chapters
-- `edits` is untouched: an append-only history of variable length and shape,
-- which is the one thing in these tables JSONB is actually the right type for.
ALTER TABLE "edited_chapters"
  ADD COLUMN "extension" TEXT,
  ADD COLUMN "chapter_id" TEXT,
  ADD COLUMN "chapter_url" TEXT,
  ADD COLUMN "chapter_number" TEXT,
  ADD COLUMN "chapter_title" TEXT,
  ADD COLUMN "chapter_volume" TEXT,
  ADD COLUMN "chapter_language" TEXT,
  ADD COLUMN "chapter_timestamp" TIMESTAMP(3),
  ADD COLUMN "chapter_expire" TIMESTAMP(3),
  ADD COLUMN "chapter_lookup" TIMESTAMP(3),
  ADD COLUMN "manga_id" TEXT,
  ADD COLUMN "manga_name" TEXT,
  ADD COLUMN "manga_url" TEXT,
  ADD COLUMN "md_manga_id" TEXT,
  ADD COLUMN "md_group_id" TEXT,
  ADD COLUMN "extra" JSONB;

UPDATE "edited_chapters" SET
  "extension"         = "chapter" ->> 'extensionName',
  "chapter_id"        = "chapter" ->> 'chapterId',
  "chapter_url"       = "chapter" ->> 'chapterUrl',
  "chapter_number"    = "chapter" ->> 'chapterNumber',
  "chapter_title"     = "chapter" ->> 'chapterTitle',
  "chapter_volume"    = "chapter" ->> 'chapterVolume',
  "chapter_language"  = "chapter" ->> 'chapterLanguage',
  "chapter_timestamp" = chapter_json_ts("chapter" ->> 'chapterTimestamp'),
  "chapter_expire"    = chapter_json_ts("chapter" ->> 'chapterExpire'),
  "chapter_lookup"    = chapter_json_ts("chapter" ->> 'chapterLookup'),
  "manga_id"          = "chapter" ->> 'mangaId',
  "manga_name"        = "chapter" ->> 'mangaName',
  "manga_url"         = "chapter" ->> 'mangaUrl',
  "md_manga_id"       = "chapter" ->> 'mdMangaId',
  "md_group_id"       = "chapter" ->> 'mdGroupId';

UPDATE "edited_chapters" SET "extra" = NULLIF(
  "chapter" - (
    ARRAY['chapterId','chapterUrl','chapterNumber','chapterTitle','chapterVolume',
          'chapterLanguage','mangaId','mangaName','mangaUrl','mdChapterId',
          'mdMangaId','mdGroupId','extensionName',
          '_PydanticInitialised__','__pydantic_initialised__','__pydanticInitialised__']
    || CASE WHEN NULLIF("chapter" ->> 'chapterTimestamp', '') IS NOT NULL AND "chapter_timestamp" IS NULL
            THEN '{}'::text[] ELSE ARRAY['chapterTimestamp'] END
    || CASE WHEN NULLIF("chapter" ->> 'chapterExpire', '') IS NOT NULL AND "chapter_expire" IS NULL
            THEN '{}'::text[] ELSE ARRAY['chapterExpire'] END
    || CASE WHEN NULLIF("chapter" ->> 'chapterLookup', '') IS NOT NULL AND "chapter_lookup" IS NULL
            THEN '{}'::text[] ELSE ARRAY['chapterLookup'] END
  ), '{}'::jsonb);

ALTER TABLE "edited_chapters" DROP COLUMN "chapter";

DROP FUNCTION chapter_json_ts(text);
