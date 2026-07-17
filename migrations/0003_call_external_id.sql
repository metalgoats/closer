-- Track the provider's own ID for an imported call so re-pulling can't duplicate it (TASK-035).
-- Additive only: adds a column + index, touches no existing rows.

ALTER TABLE calls ADD COLUMN external_id TEXT;

-- Partial unique index: only enforced for rows that actually came from a provider.
-- Manually pasted calls keep external_id NULL and are unaffected.
CREATE UNIQUE INDEX idx_calls_external ON calls(account_id, external_id) WHERE external_id IS NOT NULL;
