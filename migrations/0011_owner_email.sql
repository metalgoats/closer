-- Scope each Fathom token to its owner's own recordings (TASK-063).
-- Fathom's /meetings endpoint returns TEAM/WORKSPACE recordings, not just the key owner's, so
-- an unfiltered poll ingests colleagues' calls (third-party data we have no business holding).
-- The documented fix is recorded_by[]=<email>. Until an owner email is set for a token, the
-- poller SKIPS that token — fail closed, because the failure mode is other people's private
-- transcripts landing in our database.
ALTER TABLE integrations ADD COLUMN owner_email TEXT;
