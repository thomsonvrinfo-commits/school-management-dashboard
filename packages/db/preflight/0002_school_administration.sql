-- Pre-flight check for migration 0002 (school administration). READ-ONLY: it only selects, it changes nothing.
--
-- Run it against the database BEFORE applying 0002:
--     psql "$DATABASE_URL" -f packages/db/preflight/0002_school_administration.sql
--
-- No row with severity = 'blocking'  ->  0002 will apply.
-- Each 'blocking' row names data that would make 0002 fail ("could not create unique index" or an exclusion-constraint
-- error). 0002 runs in one transaction, so a failure changes nothing, but you cannot apply it until these rows are fixed.
-- 'advisory' rows never block the migration. They list rows from before the new limits that are still readable and still
-- usable in a register, but that the API will refuse to edit until the offending value is corrected (it says so, with a 409).
--
-- Columns: severity, problem, school_id (null for server-wide findings), detail.

select 'blocking' as severity, 'overlapping_enrolments' as problem, a.school_id,
       format('student %s: placement %s (%s to %s) overlaps placement %s (%s to %s)',
              a.student_id, a.id, a.starts_on, coalesce(a.ends_on::text, 'open'), b.id, b.starts_on, coalesce(b.ends_on::text, 'open')) as detail
  from enrollments a
  join enrollments b on b.school_id = a.school_id and b.student_id = a.student_id and b.id > a.id
 where daterange(a.starts_on, a.ends_on, '[]') && daterange(b.starts_on, b.ends_on, '[]')

union all
select 'blocking', 'admission_numbers_differing_only_by_case', school_id,
       format('admission number %s is held by students %s', upper(admission_no),
              string_agg(id::text || ' (' || admission_no || ')', ', ' order by id))
  from students
 group by school_id, upper(admission_no)
having count(*) > 1

union all
select 'blocking', 'class_names_differing_only_by_case', school_id,
       format('class name %s is held by classes %s', lower(name),
              string_agg(id::text || ' (' || name || ')', ', ' order by id))
  from classes
 group by school_id, lower(name)
having count(*) > 1

union all
select 'blocking', 'btree_gist_unavailable', null::uuid,
       'The btree_gist extension is not available on this server, and 0002 needs it for the "no overlapping placements" rule.'
 where not exists (select 1 from pg_available_extensions where name = 'btree_gist')

union all
select 'blocking', 'cannot_create_extension', null::uuid,
       'btree_gist is not installed and this role cannot create it (it needs a superuser, or CREATE on the database since btree_gist is a trusted extension).'
 where exists (select 1 from pg_available_extensions where name = 'btree_gist')
   and not exists (select 1 from pg_extension where extname = 'btree_gist')
   and not (select rolsuper from pg_roles where rolname = current_user)
   and not has_database_privilege(current_database(), 'CREATE')

union all
select 'advisory', 'admission_number_outside_limits', school_id,
       format('student %s: admission number has %s characters (limit 1 to 30)', id, length(admission_no))
  from students
 where length(admission_no) not between 1 and 30

union all
select 'advisory', 'student_name_outside_limits', school_id,
       format('student %s: first name has %s and last name %s characters (limit 1 to 100)', id, length(first_name), length(last_name))
  from students
 where length(first_name) not between 1 and 100 or length(last_name) not between 1 and 100

union all
select 'advisory', 'grade_level_outside_limits', school_id,
       format('class %s: grade level has %s characters (limit 1 to 20)', id, length(grade_level))
  from classes
 where length(grade_level) not between 1 and 20

order by 1, 2, 3, 4;
