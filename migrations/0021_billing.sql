-- Billing (TASK-122). Stripe holds the money and the card; this holds the answer to
-- "is this account paid up, and until when".
--
-- WHY ANY LOCAL STATE AT ALL, when Stripe already knows: because asking Stripe on every request
-- is a network call in the hot path that fails when Stripe has an incident. The subscription
-- state is a cache, Stripe is the source of truth, and webhooks keep the cache honest.

CREATE TABLE billing (
  account_id            INTEGER PRIMARY KEY REFERENCES accounts(id),
  stripe_customer_id    TEXT,
  stripe_subscription_id TEXT,
  -- 'active' | 'trialing' | 'past_due' | 'cancelled' | 'pending' | NULL (never subscribed).
  -- Deliberately NOT a boolean: "past_due" is a customer Stripe is still dunning and who should
  -- keep working for a few days, and collapsing that into false cuts off a paying customer whose
  -- card expired. A boolean here is an angry phone call.
  status                TEXT,
  seats                 INTEGER,
  current_period_end    TEXT,
  -- The email the checkout was opened with, so an unmatched webhook can still be traced to a
  -- human rather than being a dangling Stripe id.
  billing_email         TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT
);
CREATE INDEX idx_billing_customer ON billing(stripe_customer_id);

-- Idempotency. Stripe explicitly does NOT guarantee ordering and WILL redeliver: it retries for
-- three days on any non-2xx, and the dashboard can resend by hand. Processing a
-- checkout.session.completed twice provisions twice; processing an invoice.paid twice extends
-- the period twice. Stripe's own guidance is to track event IDs, so the id is the primary key
-- and a repeat insert is the signal to stop, not an error.
--
-- `created_at` exists so this table can be pruned; nothing reads it yet.
CREATE TABLE billing_events (
  stripe_event_id TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  account_id      INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
