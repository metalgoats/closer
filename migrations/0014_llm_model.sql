-- Which Claude model this account generates with (TASK-098). Nullable: NULL means "use the
-- app default", so existing accounts keep working and the default can move without a data
-- migration. Additive only — no column is dropped.
ALTER TABLE accounts ADD COLUMN llm_model TEXT;
