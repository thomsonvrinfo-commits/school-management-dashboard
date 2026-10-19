-- Pre-flight check for migration 0003 (staff onboarding). READ-ONLY: it only selects, it changes nothing.
--
--     psql "$DATABASE_URL" -f packages/db/preflight/0003_staff_onboarding.sql
--
-- No row with severity = 'blocking'  ->  0003 will apply.
-- 0003 only creates a new table, so the only things that can stop it are a table or index that already has one of its
-- names, or the earlier migrations not having run. 'advisory' rows never block; they point at data worth knowing about
-- before staff accounts go live.
--
-- Columns: severity, problem, school_id (null for server-wide findings), detail.

select 'blocking' as severity, 'staff_tokens_already_exists' as problem, null::uuid as school_id,
       'A relation called staff_tokens already exists. Inspect it before applying 0003.' as detail
 where to_regclass('public.staff_tokens') is not null

union all
select 'blocking', 'earlier_migrations_missing', null::uuid,
       'Migration 0002 has not been applied: 0003 expects the school administration tables.'
 where to_regclass('public.academic_years') is null

union all
-- Staff identities are email addresses, compared ignoring case. These accounts could not be invited or reset by address.
select 'advisory', 'email_not_lower_case', null::uuid,
       format('user %s has an email address with capital letters; invitations store it in lower case, and sign-in ignores case', id)
  from users
 where email <> lower(email)

union all
-- A school with no active head cannot invite anyone through the app; the operator command must be used first.
select 'advisory', 'school_without_active_head', s.id,
       format('school %s (%s) has no active head teacher, so nobody can invite staff there until the operator command issues a head invitation', s.id, s.name)
  from schools s
 where not exists (select 1 from memberships m where m.school_id = s.id and m.role = 'head' and m.active);
