-- Store integration API keys in D1 so they can be pasted in the Integrations UI
-- instead of requiring `wrangler secret put` from a terminal (TASK-032).
-- Additive only: adds columns, touches no existing data.
--
-- secret_value holds the key in plaintext. It is WRITE-ONLY over the API: the
-- server never returns it to the browser, only a masked preview. Cloudflare
-- secrets (env vars) still work as a fallback when secret_value is NULL.

ALTER TABLE integrations ADD COLUMN secret_value TEXT;
ALTER TABLE integrations ADD COLUMN updated_at TEXT;
