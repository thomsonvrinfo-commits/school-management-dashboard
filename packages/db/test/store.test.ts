import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase, pgTestsEnabled, type TestDatabase } from "../testing/pg-test-runner.ts";
import { seedDev, DEV_IDS, DEV_ACCOUNTS } from "../src/index.ts";

const skip = pgTestsEnabled() ? false : "no PostgreSQL configured (set PSQL_TEST_CONN)";
const TODAY = "2026-10-08"; // a Thursday
let t: TestDatabase;

before(async () => {
  if (skip) return;
  t = await createTestDatabase();
  await seedDev(t.runner, { today: TODAY, passwordHash: "test-hash" });
});
after(async () => {
  if (!skip) await t.drop();
});

test("migrations create the schema and are recorded", { skip }, async () => {
  const rows = await t.runner.query<{ name: string }>("select name from schema_migrations");
  assert.deepEqual(rows.map((r) => r.name), ["0001_init.sql"]);
});

test("re-running migrate applies nothing", { skip }, async () => {
  const { migrate } = await import("../src/index.ts");
  const { loadMigrations } = await import("../testing/pg-test-runner.ts");
  assert.deepEqual(await migrate(t.runner, loadMigrations()), []);
});

test("seed: 32 students, 14 school days of history, today left empty", { skip }, async () => {
  const [c] = await t.runner.query<{ n: number; days: number; today: number }>(
    `select count(*)::int as n, count(distinct date)::int as days,
            (count(*) filter (where date = $1::date))::int as today from attendance_records`, [TODAY]);
  assert.equal(c!.n, 32 * 14);
  assert.equal(c!.days, 14);
  assert.equal(c!.today, 0);
});

test("findUserByEmail is case-insensitive", { skip }, async () => {
  const u = await t.db.store.findUserByEmail("CHIPO@Mavambo.example");
  assert.equal(u?.id, DEV_IDS.teacher);
  assert.equal(u?.name, DEV_ACCOUNTS.teacher.name);
  assert.equal(await t.db.store.findUserByEmail("nobody@example.com"), null);
});

test("teacher sees her classes and Thursday's timetable in order", { skip }, async () => {
  const classes = await t.db.store.teacherClasses(DEV_IDS.school, DEV_IDS.teacher);
  assert.deepEqual(classes.map((c) => c.name), ["Grade 6A", "Grade 7A", "Grade 7B"]);
  const slots = await t.db.store.timetableForTeacher(DEV_IDS.school, DEV_IDS.teacher, 4);
  assert.deepEqual(slots.map((s) => [s.className, s.startsAt, s.endsAt]), [
    ["Grade 7A", "08:00", "08:40"], ["Grade 7B", "10:00", "10:40"], ["Grade 6A", "13:00", "13:40"],
  ]);
  assert.deepEqual(await t.db.store.timetableForTeacher(DEV_IDS.school, DEV_IDS.teacher, 6), []);
});

test("enrolledStudents respects the date and the class list", { skip }, async () => {
  const s7a = await t.db.store.enrolledStudents(DEV_IDS.school, [DEV_IDS.class7A], TODAY);
  assert.equal(s7a.length, 12);
  assert.deepEqual(await t.db.store.enrolledStudents(DEV_IDS.school, [DEV_IDS.class7A], "2025-01-01"), []);
  assert.deepEqual(await t.db.store.enrolledStudents(DEV_IDS.school, [], TODAY), []);
});

test("attendance writes: insert, then a second insert for the same student/day returns null", { skip }, async () => {
  const [s] = await t.db.store.enrolledStudents(DEV_IDS.school, [DEV_IDS.class7A], TODAY);
  const w = { schoolId: DEV_IDS.school, studentId: s!.id, classId: DEV_IDS.class7A, date: TODAY, status: "absent" as const,
    recordedBy: DEV_IDS.teacher, deviceId: "dev-test-1", opId: "00000000-0000-4000-8000-0000000aaaa1" };
  assert.deepEqual(await t.db.store.insertAttendance(w), { version: 1 });
  assert.equal(await t.db.store.insertAttendance({ ...w, status: "present" }), null);
  await t.db.transaction(async (tx) => {
    const [row] = await tx.lockAttendance(DEV_IDS.school, [s!.id], TODAY);
    assert.equal(row!.status, "absent");
    await tx.updateAttendance({ ...w, status: "late" }, row!.version + 1);
  });
  const [after] = await t.db.store.lockAttendance(DEV_IDS.school, [s!.id], TODAY);
  assert.deepEqual([after!.status, after!.version], ["late", 2]);
});

test("cross-school references are impossible at the database level", { skip }, async () => {
  const otherSchool = "00000000-0000-4000-8000-0000000000ff";
  await t.runner.query(`insert into schools (id, name) values ($1, 'Other School')`, [otherSchool]);
  await assert.rejects(
    t.runner.query(
      `insert into attendance_records (school_id, student_id, class_id, date, status, recorded_by, device_id, op_id)
       values ($1, $2, $3, '2026-10-01', 'present', $4, 'd', $5)`,
      [otherSchool, "00000000-0000-4000-8000-000000001001", DEV_IDS.class7A, DEV_IDS.teacher, "00000000-0000-4000-8000-0000000bbbb1"]),
    /foreign key|violates/i,
  );
});

test("status outside present/late/absent is rejected by the database", { skip }, async () => {
  await assert.rejects(
    t.runner.query(
      `insert into attendance_records (school_id, student_id, class_id, date, status, recorded_by, device_id, op_id)
       values ($1, $2, $3, '2026-10-02', 'excused', $4, 'd', $5)`,
      [DEV_IDS.school, "00000000-0000-4000-8000-000000001001", DEV_IDS.class7A, DEV_IDS.teacher, "00000000-0000-4000-8000-0000000bbbb2"]),
    /check constraint|violates/i,
  );
});

test("claimOperation: first wins, second is told it already exists (idempotency key)", { skip }, async () => {
  const op = "00000000-0000-4000-8000-0000000cccc1";
  assert.equal(await t.db.store.claimOperation(DEV_IDS.school, op, DEV_IDS.teacher, "dev-test-1", "attendance.record"), true);
  assert.equal(await t.db.store.claimOperation(DEV_IDS.school, op, DEV_IDS.teacher, "dev-test-1", "attendance.record"), false);
  await t.db.store.saveOperationResult(DEV_IDS.school, op, { hello: "world" });
  assert.deepEqual((await t.db.store.getOperation(DEV_IDS.school, op))?.result, { hello: "world" });
});

test("a rolled-back transaction leaves nothing behind", { skip }, async () => {
  const op = "00000000-0000-4000-8000-0000000cccc2";
  await assert.rejects(t.db.transaction(async (tx) => {
    await tx.claimOperation(DEV_IDS.school, op, DEV_IDS.teacher, "d", "attendance.record");
    throw new Error("boom");
  }), /boom/);
  assert.equal(await t.db.store.getOperation(DEV_IDS.school, op), null);
});

test("attendanceCountsByClass includes every class and counts statuses", { skip }, async () => {
  const rows = await t.db.store.attendanceCountsByClass(DEV_IDS.school, "2026-09-01", "2026-10-07");
  assert.equal(rows.length, 3);
  for (const r of rows) assert.ok(r.present + r.late + r.absent > 0);
  const none = await t.db.store.attendanceCountsByClass(DEV_IDS.school, "2020-01-01", "2020-01-02");
  assert.deepEqual(none.map((r) => r.present + r.late + r.absent), [0, 0, 0]);
});

test("uuidArray rejects anything that is not a UUID", () => {
  return import("../src/index.ts").then(({ uuidArray }) => {
    assert.throws(() => uuidArray(["1,2"]), TypeError);
    assert.equal(uuidArray([DEV_IDS.school]), `{${DEV_IDS.school}}`);
  });
});
