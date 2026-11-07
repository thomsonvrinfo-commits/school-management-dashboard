-- Pre-flight check for migration 0004 (activity screen indexes). READ-ONLY: it only selects, it changes nothing.
--
--     psql "$DATABASE_URL" -f packages/db/preflight/0004_audit_viewer.sql
--
-- No row with severity = 'blocking'  ->  0004 will apply.
-- 0004 only creates two indexes. It is stopped by an index that already has one of its names, or by migration 0003
-- not having run. 'advisory' rows never block: they say how much audit history the index builds will read.
--
-- Columns: severity, problem, school_id (null for server-wide findings), detail.

select 'blocking' as severity, 'audit_index_already_exists' as problem, null::uuid as school_id,
       format('An index called %s already exists. Inspect it before applying 0004.', c.relname) as detail
  from pg_class c
 where c.relkind = 'i' and c.relname in ('audit_school_id_idx', 'audit_school_actor_idx')

union all
select 'blocking', 'earlier_migrations_missing', null::uuid,
       'Migration 0003 has not been applied: 0004 expects the staff onboarding table.'
 where to_regclass('public.staff_tokens') is null

union all
-- How much the index builds will read, per school with any history. New indexes briefly block writes to audit_log.
select 'advisory', 'audit_rows_to_index', school_id,
       format('%s audit entries to index for school %s', count(*), school_id)
  from audit_log
 group by school_id
having count(*) >= 100000;
