-- Persist an explicit generation state machine (TASK-036).
-- Previously the only signal was processed_at, written at the very END of a run — so a
-- generation that was cancelled (client navigated away) or that failed left the call
-- indistinguishable from one that had never started, with no error recorded.
-- Additive only.

ALTER TABLE calls ADD COLUMN processing_status TEXT;        -- 'new' | 'processing' | 'processed' | 'failed'
ALTER TABLE calls ADD COLUMN processing_started_at TEXT;
ALTER TABLE calls ADD COLUMN processing_error TEXT;

-- Backfill existing rows from the old implicit signal.
UPDATE calls SET processing_status = CASE WHEN processed_at IS NOT NULL THEN 'processed' ELSE 'new' END;
