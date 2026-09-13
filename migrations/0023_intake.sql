-- Onboarding intake (TASK-131). What a new customer tells us before the setup call: roster,
-- CRM admin, who books calls, tags. NEVER API keys -- those are pasted into Integrations on the
-- call. Stored as the JSON the form sent, after the server dropped every field it does not know.
CREATE TABLE IF NOT EXISTS intake (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  company     TEXT,
  contact     TEXT,
  data_json   TEXT NOT NULL,
  ip_hint     TEXT
);
