-- Per-series recheck cooldown: "stop looking at this one for a while".
--
-- Some series can never produce another upload. Comikey's catalogue is the
-- clearest case: its free set is a permanently-free PREFIX -- in a 31-series
-- sample, 30 had their free set as exactly the first N episodes and nothing
-- else -- so a series whose first chapter is free and whose every later chapter
-- is paid has a frozen answer. A clean run still pays one `/episodes` call per
-- language to re-derive it, and clean runs are the expensive ones (778 comikey
-- series, unskippable by design, because `allChapters` must be complete or the
-- processor reads the gap as a withdrawal). Suppressing the frozen series is
-- what makes clean runs cheap enough to run OFTEN on the series that need them.
--
-- A cooldown rather than a boolean pause, because "never check again" is a
-- promise about the publisher's future that nobody can keep. If Comikey ever
-- widens a free prefix from one chapter to five, a permanent pause guarantees
-- we never find out; a cooldown costs one call per series per interval and
-- closes that hole. `cooldown_days` makes it self-renewing, so a paused series
-- is re-examined on a schedule instead of drifting until someone remembers it.
--
-- All nullable: NULL `recheck_after` is "not paused", which is what every
-- existing row is, so nothing needs backfilling.

-- When this series becomes eligible for runs again. NULL means never paused.
-- A row is SUPPRESSED while `recheck_after > now()`, and DUE once it is not:
-- the comparison is against the clock rather than a separate flag so a cooldown
-- expires on its own, with no sweep to run and nothing to go stale.
ALTER TABLE "tracked_manga" ADD COLUMN "recheck_after" TIMESTAMP(3);

-- The renewal interval. After a clean run covers a due series, `recheck_after`
-- rolls forward by this many days.
--
-- NULL means a one-shot pause: the series comes back and STAYS back. Both are
-- wanted -- "hold this until I have fixed the mapping" is one-shot, "this free
-- prefix is frozen, look every quarter" is renewing -- and they differ only in
-- whether this column is set.
ALTER TABLE "tracked_manga" ADD COLUMN "cooldown_days" INTEGER;

-- Provenance for the pause. Not audit history -- audit_events has that -- but
-- the answer to "why is this series paused", which is the question an operator
-- actually has six months later, and which should not require reading a log.
ALTER TABLE "tracked_manga" ADD COLUMN "paused_at" TIMESTAMP(3);
ALTER TABLE "tracked_manga" ADD COLUMN "paused_by" TEXT;
ALTER TABLE "tracked_manga" ADD COLUMN "pause_reason" TEXT;

-- The suppression predicate runs on the hot path: every lease builds the manga
-- id map, and every processed run rebuilds the authoritative tracked set.
-- Partial, because the overwhelming majority of rows have NULL here and
-- indexing them would be indexing the whole table to find the few percent that
-- are paused.
CREATE INDEX "tracked_manga_extension_recheck_after_idx"
  ON "tracked_manga" ("extension", "recheck_after")
  WHERE "recheck_after" IS NOT NULL;
