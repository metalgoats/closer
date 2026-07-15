-- Closer schema v1. Additive migrations only from here on.

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  pw_hash TEXT NOT NULL,          -- PBKDF2-SHA256, hex
  pw_salt TEXT NOT NULL,          -- random 16 bytes, hex
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,         -- random 32 bytes, hex
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);

-- A sales channel: its own prompt template, Fathom, LLM choice, CRM (Apple Mail metaphor).
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  llm_provider TEXT NOT NULL DEFAULT 'anthropic',   -- 'anthropic' | 'openai'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE integrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL,             -- 'fathom' | 'anthropic' | 'openai' | 'ghl'
  status TEXT NOT NULL DEFAULT 'disconnected',      -- 'connected' | 'disconnected'
  secret_name TEXT,               -- name of the Cloudflare secret holding the key (never the key)
  config_json TEXT NOT NULL DEFAULT '{}'
);

-- Versioned templates. tone NULL = the master debrief prompt; tone set = per-tone style addendum.
CREATE TABLE prompt_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  tone TEXT,                      -- NULL | 'casual' | 'balanced' | 'formal'
  version INTEGER NOT NULL DEFAULT 1,
  body TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  client_name TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  duration_min INTEGER,
  transcript TEXT,
  source TEXT NOT NULL DEFAULT 'manual',            -- 'fathom' | 'manual'
  outcome TEXT,                   -- 'closed' | 'followup' | NULL (unprocessed)
  callback_note TEXT,
  precall_brief TEXT,
  suggested_tone TEXT,            -- 'casual' | 'balanced' | 'formal'
  tone_reason TEXT,
  selected_tone TEXT,             -- user override; defaults to suggested_tone
  processed_at TEXT,
  debrief_json TEXT,              -- scorecard/didWell/hurtSale/objections/profile/signals/lessons
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_calls_account ON calls(account_id, occurred_at DESC);

-- One row per (call, kind, tone). sms/email have 3 tone rows; debrief/ghl_note have tone NULL.
CREATE TABLE outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id INTEGER NOT NULL REFERENCES calls(id),
  kind TEXT NOT NULL,             -- 'sms' | 'email' | 'ghl_note'
  tone TEXT,                      -- NULL for ghl_note
  subject TEXT,                   -- email only
  body TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'mock',
  sent_at TEXT,
  copied_at TEXT,
  updated_at TEXT
);
CREATE INDEX idx_outputs_call ON outputs(call_id, kind, tone);

-- Every in-place edit made before copying. Feeds the Sunday analysis.
CREATE TABLE edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  output_id INTEGER NOT NULL REFERENCES outputs(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL,
  tone TEXT,
  original TEXT NOT NULL,
  edited TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  folded_into_version INTEGER     -- template version this edit informed; NULL = not yet analyzed
);
CREATE INDEX idx_edits_pending ON edits(account_id, tone, folded_into_version);

-- Weekly suggestions produced from batched edits; user approves/rejects.
CREATE TABLE suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  tone TEXT,
  week_of TEXT NOT NULL,
  analysis TEXT NOT NULL,
  proposed_body TEXT,             -- proposed new template body (NULL = analysis only)
  status TEXT NOT NULL DEFAULT 'pending',           -- 'pending' | 'accepted' | 'rejected'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
