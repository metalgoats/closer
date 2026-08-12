-- Two real logins (TASK-112). Named on the 2026-08-11 call as "separate logins and permission
-- levels", and the reason they shared one credential was never laziness — it was the only thing
-- the schema permitted:
--
--   * `users` had no role column at all.
--   * The ONLY route that creates a user is POST /api/setup, which refuses once one user exists.
--     No signup, no invite, no admin user-management, and no password-change route anywhere.
--   * `requireUser` was called once, purely as a gate. Nothing in the API was scoped to a user,
--     so every authenticated session saw every call, every integration and the Spend page.
--
-- This is NOT multi-tenancy (TASK-027 stays parked, and belongs to the pivot question). It is
-- two named people on one account with one of them unable to read the billing page.
--
-- 'member' is the default so that any user created by a route that forgets to set a role is the
-- LESS privileged one. Defaulting to 'admin' would make a future forgotten field a privilege
-- escalation instead of an inconvenience.
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member';

-- The first-run user is the one who ran /api/setup and owns the deployment, so they become the
-- admin. MIN(id) rather than "all existing users" on purpose: on this database that is exactly
-- one row, and a blanket promotion would be wrong the moment it is not.
UPDATE users SET role = 'admin' WHERE id = (SELECT MIN(id) FROM users);
