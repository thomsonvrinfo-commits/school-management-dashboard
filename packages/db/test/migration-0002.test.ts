import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

// ---------- the pre-flight script an operator runs before applying 0002 ----------

const preflightSql = readFileSync(fileURLToPath(new URL("../preflight/0002_school_administration.sql", import.meta.url)), "utf8")
  .split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n").trim().replace(/;\s*$/, "");
type Finding = { severity: string; problem: string; school_id: string | null; detail: string };
const preflight = (t: { runner: { query<T>(sql: string): Promise<T[]> } }) => t.runner.query<Finding>(preflightSql);
const SEED_STUDENT = "00000000-0000-4000-8000-00000000b001";

test("pre-flight: a clean Slice 1 database has no blocking findings, and 0002 then applies", { skip }, async () => {
  const t = await createTestDatabase({ migrate: false });
  try {
    await migrate(t.runner, only0001);
    await seedDev(t.runner, { today: TODAY, passwordHash: "x" });
    assert.deepEqual(await preflight(t), []);
    assert.deepEqual(await migrate(t.runner, all), ["0002_school_administration.sql"]);
  } finally {
    await t.drop();
  }
});

test("pre-flight finds each kind of legacy data that stops 0002, names the rows, and the migration really does fail on them", { skip }, async () => {
  const t = await createTestDatabase({ migrate: false });
  try {
    await migrate(t.runner, only0001);
    await seedDev(t.runner, { today: TODAY, passwordHash: "x" });
    const q = (sql: string, p: (string | number | null)[] = []) => t.runner.query(sql, p);
    // 0001 compared admission numbers and class names case-sensitively, so all of these were allowed
    await q(`insert into students (id, school_id, admission_no, first_name, last_name) values ($1, $2, 'ma1001', 'Dup', 'Case')`, [SEED_STUDENT, DEV_IDS.school]);
    await q(`insert into classes (school_id, name, grade_level) values ($1, 'grade 7a', '7')`, [DEV_IDS.school]);
    const [student] = await q(`select id from students where school_id = $1 and admission_no = 'MA1002'`, [DEV_IDS.school]) as { id: string }[];
    await q(`insert into enrollments (school_id, student_id, class_id, starts_on, ends_on) values ($1, $2, $3, '2026-02-01', '2026-03-01')`, [DEV_IDS.school, student!.id, DEV_IDS.class6A]);
    // ...and two rows from before the new length limits (advisory only)
    await q(`insert into students (school_id, admission_no, first_name, last_name) values ($1, 'LONG1', repeat('N', 150), 'Name')`, [DEV_IDS.school]);
    await q(`insert into classes (school_id, name, grade_level) values ($1, 'Odd Grade', repeat('G', 30))`, [DEV_IDS.school]);

    const found = await preflight(t);
    const blocking = found.filter((r) => r.severity === "blocking");
    assert.deepEqual(blocking.map((r) => r.problem).sort(), ["admission_numbers_differing_only_by_case", "class_names_differing_only_by_case", "overlapping_enrolments"]);
    assert.ok(blocking.every((r) => r.school_id === DEV_IDS.school), "each finding says which school it is in");
    const detail = (problem: string) => found.find((r) => r.problem === problem)!.detail;
    assert.match(detail("admission_numbers_differing_only_by_case"), /MA1001.*\(ma1001\)/);
    assert.match(detail("class_names_differing_only_by_case"), /grade 7a/);
    assert.match(detail("overlapping_enrolments"), new RegExp(student!.id));
    assert.deepEqual(found.filter((r) => r.severity === "advisory").map((r) => r.problem).sort(), ["grade_level_outside_limits", "student_name_outside_limits"]);

    // the findings are not false alarms: the migration fails, and rolls back completely
    await assert.rejects(migrate(t.runner, all), /unique|no_overlap|exclusion|duplicate/i);
    assert.deepEqual((await q("select name from schema_migrations") as { name: string }[]).map((r) => r.name), ["0001_init.sql"]);

    // fix the data the way the script's output says, one finding at a time; 0002 then applies
    await q(`update students set admission_no = 'MA1001-DUP' where id = $1`, [SEED_STUDENT]);
    assert.ok(!(await preflight(t)).some((r) => r.problem === "admission_numbers_differing_only_by_case"));
    await q(`update classes set name = 'Grade 7A (second)' where name = 'grade 7a'`);
    await q(`delete from enrollments where student_id = $1 and class_id = $2 and starts_on = '2026-02-01'`, [student!.id, DEV_IDS.class6A]);
    assert.deepEqual((await preflight(t)).filter((r) => r.severity === "blocking"), []);
    assert.deepEqual(await migrate(t.runner, all), ["0002_school_administration.sql"]);
  } finally {
    await t.drop();
  }
});

test("pre-flight: placements that merely touch or are back to back are not flagged (only real overlaps are)", { skip }, async () => {
  const t = await createTestDatabase({ migrate: false });
  try {
    await migrate(t.runner, only0001);
    await seedDev(t.runner, { today: TODAY, passwordHash: "x" });
    const [student] = await t.runner.query<{ id: string }>(`select id from students where school_id = $1 and admission_no = 'MA1002'`, [DEV_IDS.school]);
    // MA1002 is open in 7A since 12 Jan. Close it and add a following one: adjacent days, no overlap.
    await t.runner.query(`update enrollments set ends_on = '2026-05-31' where student_id = $1`, [student!.id]);
    await t.runner.query(`insert into enrollments (school_id, student_id, class_id, starts_on) values ($1, $2, $3, '2026-06-01')`, [DEV_IDS.school, student!.id, DEV_IDS.class7B]);
    assert.deepEqual(await preflight(t), []);
    assert.deepEqual(await migrate(t.runner, all), ["0002_school_administration.sql"], "and the migration agrees");
  } finally {
    await t.drop();
  }
});
