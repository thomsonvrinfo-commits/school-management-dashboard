-- SchoolPulse 0004: the activity screen (P1).
-- The head's "who changed what" screen reads audit_log newest-first, one page at a time, optionally for one person.
-- Both need an index; nothing else changes.
--
-- ADDITIVE: two indexes and no table, column or data change, so the API built for 0003 keeps working untouched.
-- Building an index briefly blocks WRITES to audit_log (reads are fine). The table is small at the start; the
-- pre-flight prints its size so the operator can judge. To undo:
--     drop index audit_school_id_idx; drop index audit_school_actor_idx;
--
-- Run packages/db/preflight/0004_audit_viewer.sql first; it is read-only.

-- Newest first within one school, paged by id ("show me what happened before entry N").
create index audit_school_id_idx on audit_log (school_id, id desc);
-- The same, for one person's actions.
create index audit_school_actor_idx on audit_log (school_id, actor_user_id, id desc);
