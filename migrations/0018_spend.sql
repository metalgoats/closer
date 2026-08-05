-- Spend tracking (TASK-110). Two changes, both additive.
--
-- 1. `usage_daily` — Anthropic's own billing export, imported. This is the AUTHORITATIVE
--    source. It exists because reconciling our event log against the real export on
--    2026-08-06 showed the log is only trustworthy from 2026-07-30 onward:
--
--      2026-07-17 .. 07-29   we logged 24–55% of what Anthropic actually billed
--      2026-07-30 .. 08-04   exact to the token, every day
--
--    The gap is not rounding. It is runs that died before writing a usage row — the outage
--    era of TASK-041/043/045 — plus retried attempts whose first try billed and then vanished.
--    A spend page built only on `events` would therefore have understated July by roughly
--    half and shown a confident number while doing it.
--
-- 2. `events.model` — so live spend can be split by model GOING FORWARD.
--    `meta_json.model` already existed and looked like it did this job. It does not: it holds
--    the literal string "anthropic" (the PROVIDER, from llm.js), so all 27 historical
--    generations are indistinguishable from each other. On 2026-07-30 Closer billed against
--    Opus 5 AND Sonnet 5 on the same day and nothing in our data can say which run was which.
--    Nullable, because that history cannot be reconstructed and pretending otherwise would be
--    a fabrication.

CREATE TABLE usage_daily (
  usage_date     TEXT NOT NULL,        -- YYYY-MM-DD, UTC, as Anthropic reports it
  model          TEXT NOT NULL,
  api_key        TEXT NOT NULL DEFAULT '',
  workspace      TEXT NOT NULL DEFAULT '',
  usage_type     TEXT NOT NULL DEFAULT '',
  context_window TEXT NOT NULL DEFAULT '',
  -- The five billable token buckets, named for the export's own columns so there is no lossy
  -- translation between what Anthropic bills and what we display. Cache write is split by TTL
  -- because the two bill at different multipliers (1.25x vs 2x) — collapsing them loses money.
  input_no_cache   INTEGER NOT NULL DEFAULT 0,
  cache_write_5m   INTEGER NOT NULL DEFAULT 0,
  cache_write_1h   INTEGER NOT NULL DEFAULT 0,
  cache_read       INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  web_search_count INTEGER NOT NULL DEFAULT 0,
  imported_at    TEXT NOT NULL DEFAULT (datetime('now')),
  -- The full grain of the export. Re-importing an overlapping month must REPLACE rather than
  -- duplicate: Anthropic's exports overlap by design, and today's row keeps growing all day,
  -- so the same (date, model) will legitimately be imported many times with different numbers.
  PRIMARY KEY (usage_date, model, api_key, workspace, usage_type, context_window)
);

CREATE INDEX idx_usage_daily_date ON usage_daily(usage_date);

ALTER TABLE events ADD COLUMN model TEXT;
