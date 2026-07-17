-- Live generation progress (TASK-044). Ivan twice sat in front of an unbounded spinner with
-- no way to tell a working run from a dead one. Streaming (TASK-043) makes real progress
-- available for the first time, so persist it where the front end already polls.
--
-- Additive only: both columns are nullable with no default backfill needed. Rows written
-- before this migration simply have NULL, which the UI renders as "no progress yet".

ALTER TABLE calls ADD COLUMN processing_progress INTEGER;
ALTER TABLE calls ADD COLUMN processing_step TEXT;
