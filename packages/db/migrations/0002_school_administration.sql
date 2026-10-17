-- SchoolPulse 0002: school administration (Slice 2).
-- School profile, academic years and terms, a real student registry, class/stream configuration and teacher assignments.
--
-- ADDITIVE: nothing from 0001 is dropped or rewritten. New columns are nullable or have defaults, so a database that
-- already holds Slice 1 data (and the Slice 1 API running against it) keeps working unchanged. Exactly one existing
-- constraint is relaxed on purpose, and it is called out below: class names become unique per academic year instead
-- of per school, so "Grade 7A" can exist again next year.
--
-- Apply AFTER Slice 1 is stable (see docs/SLICE-2-HANDOFF.md). Run packages/db/preflight/0002_school_administration.sql
-- first; if it returns a row with severity 'blocking', this migration would fail and, because migrations run in one
-- transaction, change nothing.

-- Needed for "no two overlapping date ranges" exclusion constraints on uuid + daterange columns.
-- (Supported on Neon and on stock PostgreSQL 16; requires a role allowed to create extensions.)
create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------------------------------------------
-- School profile
-- ---------------------------------------------------------------------------------------------------------------
alter table schools
  add column code           text,
  add column contact_email  text,
  add column contact_phone  text,
  add column address        text,
  add column updated_at     timestamptz not null default now();

alter table schools
  add constraint schools_code_format   check (code is null or code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$'),
  add constraint schools_contact_email check (contact_email is null or length(contact_email) between 3 and 254),
  add constraint schools_contact_phone check (contact_phone is null or length(contact_phone) between 3 and 40),
  add constraint schools_address_len   check (address is null or length(address) between 1 and 300);
-- A school code identifies a school across the platform, so it is unique ignoring case. Legacy schools have none yet.
create unique index schools_code_key on schools (upper(code)) where code is not null;

-- ---------------------------------------------------------------------------------------------------------------
-- Academic years and terms
-- ---------------------------------------------------------------------------------------------------------------
create table academic_years (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references schools (id),
  name        text not null check (length(name) between 1 and 50),
  starts_on   date not null,
  ends_on     date not null,
  is_active   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (ends_on > starts_on),
  unique (school_id, id),
  -- Years of one school never overlap: a date belongs to at most one academic year.
  constraint academic_years_no_overlap
    exclude using gist (school_id with =, daterange(starts_on, ends_on, '[]') with &&)
);
create unique index academic_years_name_key on academic_years (school_id, lower(name));
-- At most one active year per school, enforced by the database, not just by the service.
create unique index academic_years_one_active on academic_years (school_id) where is_active;

create table terms (
  id                uuid primary key default gen_random_uuid(),
  school_id         uuid not null,
  academic_year_id  uuid not null,
  name              text not null check (length(name) between 1 and 50),
  starts_on         date not null,
  ends_on           date not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (ends_on > starts_on),
  foreign key (school_id, academic_year_id) references academic_years (school_id, id),
  unique (school_id, id),
  constraint terms_no_overlap
    exclude using gist (school_id with =, daterange(starts_on, ends_on, '[]') with &&)
);
create unique index terms_year_name_key on terms (school_id, academic_year_id, lower(name));
create index terms_year_idx on terms (school_id, academic_year_id, starts_on);
-- (Terms lying inside their year's dates is checked by the service: a CHECK cannot read another table.)

-- ---------------------------------------------------------------------------------------------------------------
-- Classes: year, stream, status
-- ---------------------------------------------------------------------------------------------------------------
alter table classes
  add column academic_year_id  uuid,
  add column stream            text,
  add column status            text not null default 'active',
  add column updated_at        timestamptz not null default now();

alter table classes
  add constraint classes_status_check  check (status in ('active', 'archived')),
  add constraint classes_stream_len    check (stream is null or length(stream) between 1 and 30),
  -- Legacy rows predate the checks below, so they are not re-validated; every new or changed row is.
  add constraint classes_grade_len     check (length(grade_level) between 1 and 20) not valid,
  -- Composite FK: a class can only reference an academic year of its own school. NULL = not assigned yet (legacy).
  add constraint classes_academic_year_fk foreign key (school_id, academic_year_id) references academic_years (school_id, id);

-- RELAXED CONSTRAINT (the only one): 0001 made class names unique per school. Names are now unique per school AND
-- academic year (case-insensitive). Classes with no year (all Slice 1 classes) stay unique per school, as before.
alter table classes drop constraint classes_school_id_name_key;
create unique index classes_school_year_name_key   on classes (school_id, academic_year_id, lower(name)) where academic_year_id is not null;
create unique index classes_school_nullyear_name_key on classes (school_id, lower(name))                  where academic_year_id is null;
-- Two classes in one year cannot both be "grade 7, stream A".
create unique index classes_school_year_grade_stream_key
  on classes (school_id, academic_year_id, grade_level, lower(stream)) where academic_year_id is not null and stream is not null;
create index classes_year_idx on classes (school_id, academic_year_id);

-- ---------------------------------------------------------------------------------------------------------------
-- Students: registry fields
-- ---------------------------------------------------------------------------------------------------------------
alter table students
  add column other_names     text,
  add column date_of_birth   date,
  add column gender          text,
  add column enrolment_date  date,
  add column status          text not null default 'enrolled',
  add column updated_at      timestamptz not null default now();

-- Backfill for students created by Slice 1: first class start date if they had one, otherwise the day they were
-- created. The status follows the Slice 1 `active` flag. `active` itself is left exactly as it was (see handoff).
update students s
   set enrolment_date = coalesce(
         (select min(e.starts_on) from enrollments e where e.school_id = s.school_id and e.student_id = s.id),
         (s.created_at at time zone 'UTC')::date),
       status = case when s.active then 'enrolled' else 'withdrawn' end;
-- The default keeps anything that still inserts students the Slice 1 way (without this column) working.
-- Slice 2 always supplies the date explicitly.
alter table students
  alter column enrolment_date set not null,
  alter column enrolment_date set default ((now() at time zone 'UTC')::date);

alter table students
  add constraint students_status_check check (status in ('enrolled', 'withdrawn', 'transferred', 'graduated')),
  add constraint students_gender_check check (gender is null or gender in ('female', 'male')),
  add constraint students_other_names_len check (other_names is null or length(other_names) between 1 and 100),
  add constraint students_dob_sane check (date_of_birth is null or date_of_birth >= date '1900-01-01'),
  -- Pre-existing columns: enforced for new and changed rows only, so legacy data can never block the migration.
  add constraint students_admission_len check (length(admission_no) between 1 and 30) not valid,
  add constraint students_names_len check (length(first_name) between 1 and 100 and length(last_name) between 1 and 100) not valid;

-- Admission numbers are unique per school ignoring case ("ma1001" and "MA1001" are the same child).
-- 0001's case-sensitive unique constraint stays; this is stricter, never looser.
create unique index students_school_admission_ci_key on students (school_id, upper(admission_no));
create index students_school_name_idx on students (school_id, lower(last_name), lower(first_name), id);
create index students_school_status_idx on students (school_id, status);

-- ---------------------------------------------------------------------------------------------------------------
-- Enrolments: a student is in at most one class on any given day
-- ---------------------------------------------------------------------------------------------------------------
alter table enrollments
  add column created_at  timestamptz not null default now(),
  add column created_by  uuid references users (id);

alter table enrollments
  add constraint enrollments_no_overlap
    exclude using gist (school_id with =, student_id with =, daterange(starts_on, ends_on, '[]') with &&);
create index enrollments_student_idx on enrollments (school_id, student_id, starts_on);

-- ---------------------------------------------------------------------------------------------------------------
-- Teacher assignments
-- ---------------------------------------------------------------------------------------------------------------
alter table class_teachers
  add column created_at  timestamptz not null default now(),
  add column created_by  uuid references users (id);
create index class_teachers_user_idx on class_teachers (school_id, user_id);

-- 0001 only checked that the class is in the school; it did not check that the user belongs to that school.
-- From now on a teacher can only be assigned to a class of a school where they hold an active teacher membership.
-- Existing rows are not re-checked; new and re-pointed rows are.
create function class_teachers_require_teacher_membership() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from memberships m
     where m.user_id = new.user_id and m.school_id = new.school_id and m.role = 'teacher' and m.active
  ) then
    raise exception 'class_teachers_teacher_membership: user % is not an active teacher at school %', new.user_id, new.school_id
      using errcode = '23514', constraint = 'class_teachers_teacher_membership';
  end if;
  return new;
end
$$;
create trigger class_teachers_teacher_membership
  before insert or update of user_id, school_id on class_teachers
  for each row execute function class_teachers_require_teacher_membership();
