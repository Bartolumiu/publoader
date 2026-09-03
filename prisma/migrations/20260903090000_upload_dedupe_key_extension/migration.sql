-- Put the extension into the UPLOAD dedupe key.
--
-- The key was `chapterId|chapterNumber|chapterLanguage` with no publisher in
-- it. Two extensions numbering out of one integer space therefore describe the
-- same key, and the unique (kind, dedupe_key) constraint resolves that by
-- having ON CONFLICT DO NOTHING drop the second one -- silently, with no error
-- and no log line. A chapter that simply never uploads.
--
-- Nothing collides today: comikey ids are `EPI-` prefixed and omoi's are
-- uuids. But k_manga (304221) and mangaup_global (109515) are both plain
-- six-digit integers, and the day their ranges meet is the day one publisher's
-- chapters start disappearing with nothing anywhere recording that they did.
--
-- Every one of the 41,487 UPLOAD rows carries `extensionName` in its payload,
-- checked before this was written, so the new key is derivable in place and
-- this needs no lookup outside the row.
--
-- ORDER MATTERS. upload_logs is rewritten FIRST, by joining to upload_tasks
-- while both still hold the legacy key. Rewriting the tasks first would leave
-- nothing to join on.

-- 1. upload_logs. This table holds the other half of the double-upload guard:
-- `runUpload` looks for a COMMITTED row under the task's key before uploading,
-- and a key it cannot find is a chapter uploaded twice. There is no extension
-- column here, so the publisher comes from the task that wrote the log --
-- unique per (kind, dedupe_key), so the join matches at most one row.
--
-- Logs whose task has since been purged keep the legacy key and become
-- unreachable, which is harmless: the guard fires on a RETRY, and a retry has
-- its task row by definition. A committed upload's row is DONE, and DONE is
-- excluded from REMOVABLE_STATES precisely so this half of the guard survives.
UPDATE "upload_logs" l
SET "dedupe_key" = coalesce(t."chapter" ->> 'extensionName', '') || '|' || l."dedupe_key"
FROM "upload_tasks" t
WHERE t."kind" = 'UPLOAD'
  AND t."dedupe_key" = l."dedupe_key"
  -- Legacy shape only: exactly two separators. A key already carrying its
  -- publisher has three, and an mdChapterId has none, so this is idempotent
  -- and cannot touch a row twice.
  AND length(l."dedupe_key") - length(replace(l."dedupe_key", '|', '')) = 2;

-- 2. upload_tasks. No uniqueness risk: two rows could never have shared the old
-- key, and prefixing distinct publishers to distinct keys keeps them distinct.
UPDATE "upload_tasks"
SET "dedupe_key" = coalesce("chapter" ->> 'extensionName', '') || '|' || "dedupe_key"
WHERE "kind" = 'UPLOAD'
  AND length("dedupe_key") - length(replace("dedupe_key", '|', '')) = 2;
