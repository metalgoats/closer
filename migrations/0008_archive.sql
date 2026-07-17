-- Archive (TASK-050). NOT a storage measure: one real call is ~148 KB and D1's paid ceiling is
-- 10 GB, so at 30 calls/week the database takes ~42 years to fill. This exists purely so the
-- working inbox stays readable — Gabriel's original complaint was "it's just so much".
-- Never "save space" by dropping transcripts: it buys 88% of a resource we have decades of and
-- permanently destroys the ability to regenerate.
-- Additive only: nullable, existing rows stay active (NULL = not archived).

ALTER TABLE calls ADD COLUMN archived_at TEXT;
CREATE INDEX idx_calls_archived ON calls(archived_at);
