-- Durable activity log (TASK-040): failures, completions, usage and token spend.
-- Exists so that (a) an unattended cron is debuggable, (b) failures record WHY rather than
-- just that they happened, (c) we can see real token cost, and (d) we can tell which outputs
-- actually get used. Additive only.

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  level TEXT NOT NULL,             -- 'info' | 'warn' | 'error'
  kind TEXT NOT NULL,              -- e.g. 'generation.succeeded', 'fathom.pull', 'output.copied'
  account_id INTEGER,
  call_id INTEGER,
  detail TEXT,                     -- human-readable; for errors this is the real message
  duration_ms INTEGER,
  -- real token usage, so cost is measurable rather than estimated
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  meta_json TEXT
);

CREATE INDEX idx_events_at ON events(at DESC);
CREATE INDEX idx_events_kind ON events(kind, at DESC);
CREATE INDEX idx_events_level ON events(level, at DESC);
CREATE INDEX idx_events_call ON events(call_id, at DESC);
