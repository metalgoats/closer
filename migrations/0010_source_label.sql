-- Attribute each Fathom call to the token that imported it (TASK-054 follow-up), so the inbox
-- can display the token's custom label instead of the account name — Gabriel runs both the
-- hypnosis business and OSA through Fathom on one account.
-- Live association: the inbox joins to the integration and shows its CURRENT label, so renaming
-- a token updates every call it imported.
ALTER TABLE calls ADD COLUMN source_integration_id INTEGER;

-- Backfill: every existing Fathom call was imported by the primary token (id 1 — the only
-- Fathom key ever configured). Manual calls stay NULL and fall back to the account name.
UPDATE calls SET source_integration_id = 1 WHERE source = 'fathom' AND source_integration_id IS NULL;
