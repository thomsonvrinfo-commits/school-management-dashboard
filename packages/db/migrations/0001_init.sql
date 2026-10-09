-- SchoolPulse 0001: tenancy, identity, classes, attendance, idempotency, audit.
-- PostgreSQL 16. Every tenant table carries school_id, and cross-table references are
-- composite (school_id, id) so a row can never point at another school's data.

create table schools (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(name) between 1 and 200),
  timezone    text not null default 'Africa/Harare',
  created_at  timestamptz not null default now()
);

create table users (
  id             uuid primary key default gen_random_uuid(),
  email          text not null check (length(email) between 3 and 254),
  name           text not null check (length(name) between 1 and 200),
  password_hash  text not null,
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);
create unique index users_email_lower_key on users (lower(email));

-- A person's role in one school. One user can belong to several schools.
create table memberships (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users (id),
  school_id  uuid not null references schools (id),
  role       text not null check (role in ('head', 'teacher')),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, school_id),
  unique (school_id, id)
);

-- One row per signed-in device. The refresh token is stored hashed; access tokens carry the session id,
-- so revoking a row here logs that device out on its next request.
create table sessions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users (id),
  school_id      uuid not null,
  membership_id  uuid not null,
  device_id      text not null,
  refresh_hash   text not null unique,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  revoked_at     timestamptz,
  foreign key (school_id, membership_id) references memberships (school_id, id)
);
create index sessions_user_idx on sessions (user_id);

create table classes (
  id           uuid primary key default gen_random_uuid(),
  school_id    uuid not null references schools (id),
  name         text not null check (length(name) between 1 and 100),
  grade_level  text not null,
  created_at   timestamptz not null default now(),
  unique (school_id, name),
  unique (school_id, id)
);

create table students (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid not null references schools (id),
  admission_no  text not null,
  first_name    text not null,
  last_name     text not null,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (school_id, admission_no),
  unique (school_id, id)
);

create table enrollments (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null,
  student_id  uuid not null,
  class_id    uuid not null,
  starts_on   date not null,
  ends_on     date,
  check (ends_on is null or ends_on >= starts_on),
  foreign key (school_id, student_id) references students (school_id, id),
  foreign key (school_id, class_id) references classes (school_id, id)
);
create index enrollments_class_idx on enrollments (school_id, class_id, starts_on);

-- Which teachers teach which class (user-level, within the school).
create table class_teachers (
  school_id  uuid not null,
  class_id   uuid not null,
  user_id    uuid not null references users (id),
  primary key (class_id, user_id),
  foreign key (school_id, class_id) references classes (school_id, id)
);

-- What "Today" reads: weekday 1 = Monday ... 7 = Sunday.
create table timetable_slots (
  id               uuid primary key default gen_random_uuid(),
  school_id        uuid not null,
  class_id         uuid not null,
  teacher_user_id  uuid not null references users (id),
  weekday          smallint not null check (weekday between 1 and 7),
  starts_at        time not null,
  ends_at          time not null,
  subject          text not null,
  check (ends_at > starts_at),
  foreign key (school_id, class_id) references classes (school_id, id)
);
create index timetable_teacher_idx on timetable_slots (school_id, teacher_user_id, weekday);

-- One authoritative record per student per day. `version` increments on every change
-- and is what devices send back as baseVersion to detect conflicts.
create table attendance_records (
  id           uuid primary key default gen_random_uuid(),
  school_id    uuid not null,
  student_id   uuid not null,
  class_id     uuid not null,
  date         date not null,
  status       text not null check (status in ('present', 'late', 'absent')),
  version      integer not null default 1 check (version >= 1),
  recorded_by  uuid not null references users (id),
  device_id    text not null,
  op_id        uuid not null,
  created_at   timestamptz not null default clock_timestamp(),
  updated_at   timestamptz not null default clock_timestamp(),
  unique (school_id, student_id, date),
  foreign key (school_id, student_id) references students (school_id, id),
  foreign key (school_id, class_id) references classes (school_id, id)
);
create index attendance_class_date_idx on attendance_records (school_id, class_id, date);

-- Idempotency: an operation id is recorded in the same transaction that applies it.
create table processed_operations (
  school_id   uuid not null references schools (id),
  op_id       uuid not null,
  user_id     uuid not null references users (id),
  device_id   text not null,
  type        text not null,
  result      jsonb,
  created_at  timestamptz not null default now(),
  primary key (school_id, op_id)
);

-- Append-only history of what changed, by whom, and through which operation.
create table audit_log (
  id             bigint generated always as identity primary key,
  school_id      uuid not null references schools (id),
  actor_user_id  uuid not null references users (id),
  action         text not null,
  entity_type    text not null,
  entity_id      uuid,
  op_id          uuid,
  details        jsonb not null default '{}'::jsonb,
  at             timestamptz not null default clock_timestamp()
);
create index audit_school_at_idx on audit_log (school_id, at desc);
