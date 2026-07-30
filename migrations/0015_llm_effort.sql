-- Reasoning depth for the debrief pass (TASK-099). Nullable: NULL means the app default
-- ("medium"), so existing accounts are unchanged and the default can move without a data
-- migration. Additive only.
ALTER TABLE accounts ADD COLUMN llm_effort TEXT;
