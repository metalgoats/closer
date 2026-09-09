-- Who ran this call (TASK-117). The keystone for the manager tier discussed on the 2026-09-09
-- Nathan call: a rep's private view, the admin's per-person drill-down, aggregate-by-role, the
-- weekly ranking and the per-lead record are ALL one missing column plus a scoped query.
--
-- `calls` has carried `account_id` since v1 and no owner at all. Nothing in the API was ever
-- scoped to a user; the roles added in 0019 gate the Spend and Integrations PAGES and nothing
-- else. So today every authenticated session sees every call, and there is no data from which a
-- per-person number could be computed even if there were a screen for it.
--
-- WHY EMAIL AND NOT user_id. The person who recorded a call is identified by Fathom, and Fathom
-- knows them by email. They will usually NOT have a login here yet -- on Nathan's floor the reps
-- get imported long before anyone provisions six accounts. Storing the email means attribution is
-- captured from day one and a `users` row can be joined to it later, whenever it appears. A
-- user_id FK would force us to either invent user rows at import time or drop the attribution on
-- the floor. `rep_user_id` can be added later as a resolved cache; the email is the durable fact.
ALTER TABLE calls ADD COLUMN rep_email TEXT;

-- Backfill is EXACT, not a guess, and it is worth stating why.
-- The poller has been scoped by `recorded_by[]=<owner_email>` since 0011 (TASK-063) and SKIPS any
-- token with no owner email -- it fails closed rather than hoovering the whole workspace. So every
-- Fathom-sourced call in this database was, by construction, recorded by the owner of the
-- integration named in `source_integration_id`. There is no ambiguity to resolve.
UPDATE calls
   SET rep_email = (SELECT i.owner_email FROM integrations i WHERE i.id = calls.source_integration_id)
 WHERE rep_email IS NULL
   AND source = 'fathom'
   AND source_integration_id IS NOT NULL;

-- Manually pasted calls are deliberately left NULL. Nothing in the record says who pasted them,
-- and attributing them to the integration owner would be a fabrication -- exactly the mistake
-- `events.model` made when it stored the provider and every row looked populated and was wrong.
-- New manual pastes are attributed to the session user from here on.

CREATE INDEX idx_calls_rep ON calls(account_id, rep_email, occurred_at);
