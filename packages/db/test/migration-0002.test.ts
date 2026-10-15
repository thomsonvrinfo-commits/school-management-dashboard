import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase, loadMigrations, pgTestsEnabled } from "../testing/pg-test-runner.ts";
import { migrate, seedDev, DEV_IDS } from "../src/index.ts";

const skip = pgTestsEnabled() ? false : "no PostgreSQL configured (set PSQL_TEST_CONN)";
const TODAY = "2026-10-08";
const all = loadMigrations();
const only0001 = all.filter((m) => m.name === "0001_init.sql");

test("0002 applies over a database that already holds Slice 1 data, and keeps every row", { skip }, async () => {
  const t = await createTestDatabase({ migrate: false });
  try {
    assert.deepEqual(await migrate(t.runner, only0001), ["0001_init.sql"]);
    await seedDev(t.runner, { today: TODAY, passwordHash: "x" });
    // legacy oddities Slice 1 allowed: a student with no enrolment, and an inactive student
    await t.runner.query(`insert into students (id, school_id, admission_no, first_name, last_name, created_at)
                          values ('00000000-0000-4000-8000-00000000a001', $1, 'LEGACY1', 'No', 'Class', '2026-03-05T10:00:00Z')`, [DEV_IDS.school]);
    await t.runner.query(`insert into students (id, school_id, admission_no, first_name, last_name, active)
                          values ('00000000-0000-4000-8000-00000000a002', $1, 'LEGACY2', 'Gone', 'Away', false)`, [DEV_IDS.school]);
    const before = {
      enrollments: (await t.runner.query<{ n: number }>("select count(*)::int n from enrollments"))[0]!.n,
      attendance: (await t.runner.query<{ n: number }>("select count(*)::int n from attendance_records"))[0]!.n,
      teachers: (await t.runner.query<{ n: number }>("select count(*)::int n from class_teachers"))[0]!.n,
      slots: (await t.runner.query<{ n: number }>("select count(*)::int n from timetable_slots"))[0]!.n,
    };

    assert.deepEqual(await migrate(t.runner, all), ["0002_school_administration.sql"]);

    // nothing Slice 1 owned was lost or rewritten
    const after = {
      enrollments: (await t.runner.query<{ n: number }>("select count(*)::int n from enrollments"))[0]!.n,
      attendance: (await t.runner.query<{ n: number }>("select count(*)::int n from attendance_records"))[0]!.n,
      teachers: (await t.runner.query<{ n: number }>("select count(*)::int n from class_teachers"))[0]!.n,
      slots: (await t.runner.query<{ n: number }>("select count(*)::int n from timetable_slots"))[0]!.n,
    };
    assert.deepEqual(after, before);
    assert.equal((await t.runner.query<{ n: number }>("select count(*)::int n from students"))[0]!.n, 34);

    // backfill: enrolment date from the first class start, else the creation day; status from the old `active` flag
    const rows = await t.runner.query<{ admission_no: string; enrolment_date: string; created_day: string; status: string; active: boolean }>(
      `select admission_no, to_char(enrolment_date, 'YYYY-MM-DD') as enrolment_date,
              to_char((created_at at time zone 'UTC')::date, 'YYYY-MM-DD') as created_day, status, active
         from students where admission_no in ('MA1001', 'LEGACY1', 'LEGACY2') order by admission_no`);
    const by = Object.fromEntries(rows.map((r) => [r.admission_no, r]));
    assert.deepEqual([by.MA1001!.enrolment_date, by.MA1001!.status], ["2026-01-12", "enrolled"], "first class start date");
    assert.deepEqual([by.LEGACY1!.enrolment_date, by.LEGACY1!.status], ["2026-03-05", "enrolled"], "no class: the day the record was created");
    assert.equal(by.LEGACY2!.enrolment_date, by.LEGACY2!.created_day);
    assert.equal(by.LEGACY2!.status, "withdrawn", "status follows the old active flag");
    // the old `active` flag itself is untouched (Slice 1 still reads it)
    assert.equal(by.LEGACY2!.active, false);
    assert.equal(by.MA1001!.active, true);

    // legacy classes stay valid: no year yet, active
    const classes = await t.runner.query<{ academic_year_id: string | null; status: string; stream: string | null }>("select academic_year_id, status, stream from classes");
    assert.equal(classes.length, 3);
    assert.ok(classes.every((c) => c.academic_year_id === null && c.status === "active" && c.stream === null));

    // Slice 1's own reads give the same answers as before
    assert.equal((await t.db.store.enrolledStudents(DEV_IDS.school, [DEV_IDS.class7A], TODAY)).length, 12);
    assert.deepEqual((await t.db.store.teacherClasses(DEV_IDS.school, DEV_IDS.teacher)).map((c) => c.name), ["Grade 6A", "Grade 7A", "Grade 7B"]);

    // Slice 1 code paths keep working against the migrated schema: inserts that know nothing about the new columns
    await t.runner.query(`insert into students (school_id, admission_no, first_name, last_name) values ($1, 'S1STYLE', 'Old', 'Way')`, [DEV_IDS.school]);
    await t.runner.query(`insert into classes (school_id, name, grade_level) values ($1, 'Grade 3A', '3')`, [DEV_IDS.school]);
    await t.runner.query(`insert into enrollments (school_id, student_id, class_id, starts_on)
                          select school_id, id, $2, date '2026-02-02' from students where admission_no = 'S1STYLE'`,
      [DEV_IDS.school, (await t.runner.query<{ id: string }>(`select id from classes where name = 'Grade 3A'`))[0]!.id]);
    const old = (await t.runner.query<{ status: string; enrolment_date: string | null }>(`select status, enrolment_date from students where admission_no = 'S1STYLE'`))[0]!;
    assert.equal(old.status, "enrolled");
    assert.ok(old.enrolment_date, "the new NOT NULL column has a default, so old-style inserts still work");

    // re-running applies nothing
    assert.deepEqual(await migrate(t.runner, all), []);
  } finally {
    await t.drop();
  }
});

test("0002 refuses to run over data it would corrupt, and then changes nothing at all", { skip }, async () => {
  const t = await createTestDatabase({ migrate: false });
  try {
    await migrate(t.runner, only0001);
    await seedDev(t.runner, { today: TODAY, passwordHash: "x" });
    // Slice 1 never prevented this: one student enrolled in two classes on overlapping dates
    const [student] = await t.runner.query<{ id: string }>(`select id from students where school_id = $1 order by id limit 1`, [DEV_IDS.school]);
    await t.runner.query(
      `insert into enrollments (school_id, student_id, class_id, starts_on) values ($1, $2, $3, '2026-02-01')`,
      [DEV_IDS.school, student!.id, DEV_IDS.class6A],
    );
    await assert.rejects(migrate(t.runner, all), /no_overlap|conflicting key value|exclusion/i);
    // the whole migration rolled back: no new tables, no new columns, and it is not recorded as applied
    const applied = await t.runner.query<{ name: string }>("select name from schema_migrations");
    assert.deepEqual(applied.map((r) => r.name), ["0001_init.sql"]);
    const tables = await t.runner.query<{ table_name: string }>(`select table_name from information_schema.tables where table_name in ('academic_years', 'terms')`);
    assert.deepEqual(tables, []);
    const cols = await t.runner.query<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'students' and column_name = 'status'`);
    assert.deepEqual(cols, []);
    const constraint = await t.runner.query<{ conname: string }>(`select conname from pg_constraint where conname = 'classes_school_id_name_key'`);
    assert.equal(constraint.length, 1, "the original class-name constraint is still there");
  } finally {
    await t.drop();
  }
});
