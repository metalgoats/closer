-- Login and activity evidence (TASK-133). The deployment guarantee names "platform logs" and
-- "user-activity records" as the source of truth for adoption, and nothing recorded a login until
-- now. last_seen_at is bumped at most once an hour per user on any authenticated request; logins
-- are events. Cheap, and enough to answer "has anyone on this floor opened it this week".
ALTER TABLE users ADD COLUMN last_seen_at TEXT;
