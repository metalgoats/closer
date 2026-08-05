-- TASK-105. Per-call chat, so Gabriel can revise an output in place instead of leaving for
-- ChatGPT. This is the feature that decides whether Closer REPLACES his old workflow or stays
-- a third step inside it: on 2026-08-04 he was running Closer, then his old ChatGPT process,
-- then a comparison pass.
CREATE TABLE IF NOT EXISTS chat_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id    INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,              -- 'user' | 'assistant'
  body       TEXT NOT NULL,
  -- Which output this turn rewrote, if any. Lets the UI say "updated the email" rather than
  -- leaving Gabriel to notice a pane changed underneath him.
  updated_kind TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Every read is "this call's history, oldest first". Without this it is a full scan per turn.
CREATE INDEX IF NOT EXISTS idx_chat_call ON chat_messages(call_id, id);
