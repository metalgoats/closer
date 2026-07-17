-- Track which Workflow instance owns a run (TASK-045). Generation moved off ctx.waitUntil
-- (capped at 30s, which silently killed every run at 0:30) onto Cloudflare Workflows.
-- Storing the instance id makes a stuck run diagnosable from outside the app.
-- Additive only: nullable, no backfill needed.

ALTER TABLE calls ADD COLUMN processing_workflow_id TEXT;
