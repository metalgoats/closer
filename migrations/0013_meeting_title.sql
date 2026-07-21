-- Show the Fathom MEETING TITLE, not an attendee's name (TASK-082).
--
-- deriveClientName() preferred the first external calendar invitee over the meeting title, so a
-- call Gabriel knew as "OSA Sales Training" appeared in the inbox as "Nathan Macias" — an
-- attendee. Ivan looked for two calls Gabriel said he'd had, didn't recognise either row, and
-- reasonably concluded they were missing. They were sitting right at the top of the list.
--
-- Additive only. Nothing is dropped or rewritten by this migration; the backfill that populates
-- these columns is a separate, explicit call and only touches rows it can prove were never
-- renamed by hand.
ALTER TABLE calls ADD COLUMN attendee_name TEXT;   -- the external invitee, kept for context
ALTER TABLE calls ADD COLUMN renamed_at TEXT;      -- set when a human edits the title, so the
                                                   -- backfill can never clobber a manual rename
