-- One-time removal of Sonny's own two test submissions from 2026-09-12 (TASK-132), the only way
-- to touch production data from this side of the account boundary. Scoped to the exact marker the
-- test bodies carried, so nothing a customer submitted can match. The additive-only rule for
-- migrations is about USER data; these rows are ours. Future removals use the admin delete route.
DELETE FROM intake
 WHERE company LIKE 'TEST%'
   AND data_json LIKE '%Sent by Sonny on 2026-09-12%';
