-- Second Fathom account (TASK-054). Same OSA pipeline, one more workspace to poll.
-- A label distinguishes the two Fathom cards in the UI. Additive: existing rows keep their keys.
ALTER TABLE integrations ADD COLUMN label TEXT;

-- Name the existing Fathom row, then add a second slot on the same OSA account (id 1).
UPDATE integrations SET label = 'Primary account' WHERE kind = 'fathom' AND label IS NULL;
INSERT INTO integrations (account_id, kind, status, label)
  SELECT 1, 'fathom', 'disconnected', 'Second account'
  WHERE EXISTS (SELECT 1 FROM accounts WHERE id = 1);
