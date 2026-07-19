-- Call types, each with its OWN prompt, scorecard dimensions and output set (TASK-065).
-- Gabriel's ask: label a call, and Generate uses the prompt bound to that label — "what I don't
-- need is how is the emotional connection on this call" for a non-sales call.
--
-- This is also the fix for the long-standing TASK-021 blocker: the 10 scorecard dimensions were
-- HARDCODED in llm.js, so editing a prompt could never change what got scored. Dimensions now
-- live here, per type, so a type with dimensions_json='[]' gets no scorecard at all.
CREATE TABLE call_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  description TEXT,
  prompt_body TEXT NOT NULL,
  dimensions_json TEXT NOT NULL DEFAULT '[]',   -- [] = no scorecard for this type
  produces_messages INTEGER NOT NULL DEFAULT 1, -- generate the SMS + email drafts?
  produces_crm_note INTEGER NOT NULL DEFAULT 1, -- generate the GHL/CRM note?
  is_default INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX idx_call_types_account ON call_types(account_id, archived_at, sort_order);

-- Which type a call is, chosen before Generate. NULL = not yet labelled (falls back to default).
ALTER TABLE calls ADD COLUMN call_type_id INTEGER;

-- Possible duplicate of another call (TASK-064). Set at import; never auto-deletes.
ALTER TABLE calls ADD COLUMN duplicate_of INTEGER;

-- Seed: the Sales type inherits the CURRENT live prompt verbatim, so nothing changes for
-- existing behaviour until Ivan edits it.
INSERT INTO call_types (account_id, name, description, prompt_body, dimensions_json, produces_messages, produces_crm_note, is_default, sort_order)
SELECT 1, 'Sales call', 'Full coaching debrief, scorecard, follow-up text + email, and CRM note.',
       body,
       '["rapport","authority","trust","emotional connection","pain amplification","vision building","objection handling","certainty transfer","close attempt","follow-up positioning"]',
       1, 1, 1, 0
FROM prompt_templates WHERE active = 1 AND tone IS NULL LIMIT 1;

-- Non-sales types. Deliberately NO scorecard: a client or internal call should not be graded on
-- "pain amplification". Starting prompts are a reasonable default — edit them in the UI.
INSERT INTO call_types (account_id, name, description, prompt_body, dimensions_json, produces_messages, produces_crm_note, is_default, sort_order) VALUES
(1, 'Client call',
 'For calls with an existing client. Recap, commitments and a follow-up email — no sales scorecard.',
 'You are summarising a call between a coach and an EXISTING CLIENT (not a sales prospect). Do not evaluate selling technique.

Return: what was covered, what the client is working on, what was agreed, anything the client is waiting on, and what to revisit next time.',
 '[]', 1, 1, 0, 1),

(1, 'Internal / team',
 'For internal and team calls. Decisions, action items and owners — no client messaging.',
 'You are summarising an INTERNAL TEAM call. There is no prospect and nothing is being sold. Do not produce client-facing messages or evaluate selling technique.

Use coaching language and focus on:
- What were the commitments?
- What were the agreements?
- What sounded like an expectation rather than a commitment?
- What still needs clarification?
- Who owns each next step, and by when?',
 '[]', 0, 0, 0, 2),

(1, 'Vendor / partner',
 'For vendor, partner and supplier calls. Terms, obligations and follow-ups.',
 'You are summarising a VENDOR or PARTNER call. Focus on what each side committed to, pricing or terms discussed, obligations and deadlines, open questions, and the next step. Do not evaluate selling technique.',
 '[]', 0, 1, 0, 3);

-- Existing calls keep behaving as sales calls.
UPDATE calls SET call_type_id = (SELECT id FROM call_types WHERE is_default = 1 LIMIT 1)
 WHERE call_type_id IS NULL;
