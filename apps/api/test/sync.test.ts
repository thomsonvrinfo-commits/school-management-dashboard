import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pgTestsEnabled } from "@schoolpulse/db/testing";
import { DEV_IDS } from "@schoolpulse/db";
import { bootstrap, push } from "../src/services/sync.ts";
import { HttpError } from "../src/errors.ts";
import { EMAILS, EXTRA, TODAY, attendanceOp, makeFixture, only, signIn, studentsOf, type Fixture } from "./support.ts";

const skip = pgTestsEnabled() ? false : "no PostgreSQL configured (set PSQL_TEST_CONN)";
let f: Fixture;
before(async () => { if (!skip) f = await makeFixture(); });
after(async () => { if (!skip) await f.close(); });

const status = (e: unknown) => (e instanceof HttpError ? `${e.status} ${e.code}` : String(e));
const count = async (sql: string, p: string[] = []) => ((await f.t.runner.query<{ n: number }>(sql, p))[0]!.n);
const rowOf = async (studentId: string, date: string) =>
  (await f.t.runner.query<{ status: string; version: number }>(
    `select status, version from attendance_records where student_id = $1 and date = $2::date`, [studentId, date]))[0];
const DEV = "device-chipo0001";

// ---------- bootstrap: the permission-filtered replica ----------

test("bootstrap gives a teacher exactly her classes, students, today's timetable and recent attendance", { skip }, async () => {
  const s = await signIn(f.deps, EMAILS.chipo, DEV);
  const b = await bootstrap(f.deps, s.auth);
  assert.equal(b.today, TODAY);
  assert.equal(b.school.name, "Mavambo Academy");
  assert.deepEqual(b.classes.map((c) => c.name), ["Grade 6A", "Grade 7A", "Grade 7B"]);
  assert.equal(b.students.length, 32);
  assert.deepEqual(b.todaySlots.map((x) => [x.className, x.startsAt]), [["Grade 7A", "08:00"], ["Grade 7B", "10:00"], ["Grade 6A", "13:00"]]);
  assert.ok(b.attendance.length > 0);
  assert.ok(b.attendance.every((a) => a.date >= "2026-09-24" && a.date <= TODAY));
});

test("bootstrap never includes a class the teacher does not teach", { skip }, async () => {
  await f.t.runner.query(
    `insert into attendance_records (school_id, student_id, class_id, date, status, recorded_by, device_id, op_id)
     values ($1, $2, $3, '2026-10-07', 'absent', $4, 'x', $5)`, [DEV_IDS.school, EXTRA.student5A, EXTRA.class5A, EXTRA.tendai, crypto.randomUUID()]);
  const b = await bootstrap(f.deps, (await signIn(f.deps, EMAILS.chipo, DEV)).auth);
  assert.ok(!b.classes.some((c) => c.id === EXTRA.class5A));
  assert.ok(!b.students.some((s) => s.id === EXTRA.student5A));
  assert.ok(!b.attendance.some((a) => a.studentId === EXTRA.student5A));
});

test("the head cannot use the teacher replica", { skip }, async () => {
  const s = await signIn(f.deps, EMAILS.head, "device-head00001");
  assert.equal(await bootstrap(f.deps, s.auth).catch(status), "403 forbidden");
});

// ---------- push: the happy path ----------

test("a teacher's register is applied, recorded in the audit log, and versioned from 1", { skip }, async () => {
  const s = await signIn(f.deps, EMAILS.chipo, DEV);
  const kids = await studentsOf(f, DEV_IDS.class7A, "2026-09-01");
  const op = attendanceOp(DEV_IDS.class7A, "2026-09-01", kids.map((id, i) => ({ studentId: id, status: i === 0 ? "absent" : i === 1 ? "late" : "present" })));
  const r = only((await push(f.deps, s.auth, { deviceId: DEV, ops: [op] })).results);
  assert.equal(r.outcome, "applied");
  assert.equal(r.replayed, false);
  assert.ok(r.entries.every((e) => e.outcome === "applied" && e.version === 1));
  assert.equal(await count(`select count(*)::int as n from attendance_records where date = '2026-09-01' and class_id = $1`, [DEV_IDS.class7A]), 12);
  assert.deepEqual(await rowOf(kids[0]!, "2026-09-01"), { status: "absent", version: 1 });
  const audit = await f.t.runner.query<{ details: { changes: unknown[] }; actor_user_id: string }>(
    `select details, actor_user_id from audit_log where op_id = $1`, [op.opId]);
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.actor_user_id, DEV_IDS.teacher);
  assert.equal(audit[0]!.details.changes.length, 12);
});

test("editing your own earlier entry (right baseVersion) updates it to version 2", { skip }, async () => {
  const s = await signIn(f.deps, EMAILS.chipo, DEV);
  const [kid] = await studentsOf(f, DEV_IDS.class7A, "2026-09-01");
  const r = only((await push(f.deps, s.auth, { deviceId: DEV, ops: [attendanceOp(DEV_IDS.class7A, "2026-09-01", [{ studentId: kid!, status: "late", baseVersion: 1 }])] })).results);
  assert.equal(r.outcome, "applied");
  assert.deepEqual(r.entries.map((e) => [e.outcome, e.status, e.version]), [["applied", "late", 2]]);
  assert.deepEqual(await rowOf(kid!, "2026-09-01"), { status: "late", version: 2 });
});

// ---------- idempotency ----------

test("replaying an operation returns the stored result and changes nothing", { skip }, async () => {
  const s = await signIn(f.deps, EMAILS.chipo, DEV);
  const kids = (await studentsOf(f, DEV_IDS.class7B, "2026-09-02")).slice(0, 3);
  const op = attendanceOp(DEV_IDS.class7B, "2026-09-02", kids.map((id) => ({ studentId: id, status: "present" })));
  const first = only((await push(f.deps, s.auth, { deviceId: DEV, ops: [op] })).results);
  const auditBefore = await count(`select count(*)::int as n from audit_log`);
  const again = only((await push(f.deps, s.auth, { deviceId: DEV, ops: [op] })).results);
  assert.equal(again.replayed, true);
  assert.deepEqual({ ...again, replayed: false }, first);
  assert.equal(await count(`select count(*)::int as n from audit_log`), auditBefore);
  assert.equal(await count(`select count(*)::int as n from attendance_records where date = '2026-09-02' and class_id = $1`, [DEV_IDS.class7B]), 3);
});

test("the same operation sent twice at the same moment is applied once", { skip }, async () => {
  const s = await signIn(f.deps, EMAILS.chipo, DEV);
  const kids = (await studentsOf(f, DEV_IDS.class6A, "2026-09-03")).slice(0, 4);
  const op = attendanceOp(DEV_IDS.class6A, "2026-09-03", kids.map((id) => ({ studentId: id, status: "absent" })));
  const [a, b] = await Promise.all([
    push(f.deps, s.auth, { deviceId: DEV, ops: [op] }),
    push(f.deps, s.auth, { deviceId: DEV, ops: [op] }),
  ]);
  const flags = [only(a.results).replayed, only(b.results).replayed].sort();
  assert.deepEqual(flags, [false, true]);
  assert.equal(await count(`select count(*)::int as n from attendance_records where date = '2026-09-03' and class_id = $1`, [DEV_IDS.class6A]), 4);
  assert.equal(await count(`select count(*)::int as n from audit_log where op_id = $1`, [op.opId]), 1);
  assert.equal(await rowOf(kids[0]!, "2026-09-03").then((r) => r?.version), 1);
});

test("someone else's operation id is refused without revealing anything", { skip }, async () => {
  const chipo = await signIn(f.deps, EMAILS.chipo, DEV);
  const tendai = await signIn(f.deps, EMAILS.tendai, "device-tendai001");
  const [kid] = await studentsOf(f, DEV_IDS.class7A, "2026-09-04");
  const op = attendanceOp(DEV_IDS.class7A, "2026-09-04", [{ studentId: kid!, status: "present" }]);
  await push(f.deps, chipo.auth, { deviceId: DEV, ops: [op] });
  const r = only((await push(f.deps, tendai.auth, { deviceId: "device-tendai001", ops: [op] })).results);
  assert.deepEqual([r.outcome, r.reason, r.entries.length], ["rejected", "forbidden", 0]);
});

// ---------- conflicts ----------

test("a teacher who saves the same register twice while offline does not conflict with herself", { skip }, async () => {
  const chipo = await signIn(f.deps, EMAILS.chipo, DEV);
  const [kid] = await studentsOf(f, DEV_IDS.class7A, "2026-08-31");
  // Both operations were made before either synced, so both carry baseVersion 0.
  const first = attendanceOp(DEV_IDS.class7A, "2026-08-31", [{ studentId: kid!, status: "absent" }]);
  const second = attendanceOp(DEV_IDS.class7A, "2026-08-31", [{ studentId: kid!, status: "present" }]);
  const res = (await push(f.deps, chipo.auth, { deviceId: DEV, ops: [first, second] })).results;
  assert.deepEqual(res.map((r) => r.outcome), ["applied", "applied"]);
  assert.deepEqual(await rowOf(kid!, "2026-08-31"), { status: "present", version: 2 });
});


test("two devices, same student and day: the later one is told about a conflict and nothing is overwritten", { skip }, async () => {
  const chipo = await signIn(f.deps, EMAILS.chipo, DEV);
  const tendai = await signIn(f.deps, EMAILS.tendai, "device-tendai001");
  const [kid] = await studentsOf(f, DEV_IDS.class7A, "2026-09-07");
  await push(f.deps, chipo.auth, { deviceId: DEV, ops: [attendanceOp(DEV_IDS.class7A, "2026-09-07", [{ studentId: kid!, status: "absent" }])] });
  // Mr. Tendai was offline: he never saw Chipo's record (baseVersion 0) and says "present".
  const r = only((await push(f.deps, tendai.auth, { deviceId: "device-tendai001", ops: [attendanceOp(DEV_IDS.class7A, "2026-09-07", [{ studentId: kid!, status: "present" }])] })).results);
  assert.equal(r.outcome, "conflict");
  assert.deepEqual(r.entries.map((e) => [e.outcome, e.status, e.version]), [["conflict", "absent", 1]]);
  assert.deepEqual(await rowOf(kid!, "2026-09-07"), { status: "absent", version: 1 });

  // He reviews it and chooses "use mine": a fresh op based on the version he now knows about.
  const redo = only((await push(f.deps, tendai.auth, { deviceId: "device-tendai001", ops: [attendanceOp(DEV_IDS.class7A, "2026-09-07", [{ studentId: kid!, status: "present", baseVersion: 1 }])] })).results);
  assert.deepEqual(redo.entries.map((e) => [e.outcome, e.status, e.version]), [["applied", "present", 2]]);
  assert.deepEqual(await rowOf(kid!, "2026-09-07"), { status: "present", version: 2 });
});

test("a partly conflicting register applies the clean entries and reports only the conflicting one", { skip }, async () => {
  const chipo = await signIn(f.deps, EMAILS.chipo, DEV);
  const tendai = await signIn(f.deps, EMAILS.tendai, "device-tendai001");
  const [a, b, c] = await studentsOf(f, DEV_IDS.class7A, "2026-09-08");
  await push(f.deps, chipo.auth, { deviceId: DEV, ops: [attendanceOp(DEV_IDS.class7A, "2026-09-08", [{ studentId: b!, status: "late" }])] });
  const r = only((await push(f.deps, tendai.auth, { deviceId: "device-tendai001", ops: [attendanceOp(DEV_IDS.class7A, "2026-09-08", [
    { studentId: a!, status: "present" }, { studentId: b!, status: "absent" }, { studentId: c!, status: "present" }]) ] })).results);
  assert.equal(r.outcome, "conflict");
  const byId = new Map(r.entries.map((e) => [e.studentId, e.outcome]));
  assert.deepEqual([byId.get(a!), byId.get(b!), byId.get(c!)], ["applied", "conflict", "applied"]);
  assert.deepEqual(await rowOf(b!, "2026-09-08"), { status: "late", version: 1 });
  assert.deepEqual(await rowOf(a!, "2026-09-08"), { status: "present", version: 1 });
});

test("sending the value the server already has is a harmless no-op, whatever the baseVersion", { skip }, async () => {
  const chipo = await signIn(f.deps, EMAILS.chipo, DEV);
  const [kid] = await studentsOf(f, DEV_IDS.class7A, "2026-09-09");
  await push(f.deps, chipo.auth, { deviceId: DEV, ops: [attendanceOp(DEV_IDS.class7A, "2026-09-09", [{ studentId: kid!, status: "absent" }])] });
  const r = only((await push(f.deps, chipo.auth, { deviceId: DEV, ops: [attendanceOp(DEV_IDS.class7A, "2026-09-09", [{ studentId: kid!, status: "absent", baseVersion: 0 }])] })).results);
  assert.deepEqual(r.entries.map((e) => [e.outcome, e.version]), [["noop", 1]]);
  assert.equal(r.outcome, "applied");
});

test("two teachers racing to record the same new student/day: exactly one wins, the other gets a conflict", { skip }, async () => {
  const chipo = await signIn(f.deps, EMAILS.chipo, DEV);
  const tendai = await signIn(f.deps, EMAILS.tendai, "device-tendai001");
  const [kid] = await studentsOf(f, DEV_IDS.class7A, "2026-09-10");
  const [x, y] = await Promise.all([
    push(f.deps, chipo.auth, { deviceId: DEV, ops: [attendanceOp(DEV_IDS.class7A, "2026-09-10", [{ studentId: kid!, status: "absent" }])] }),
    push(f.deps, tendai.auth, { deviceId: "device-tendai001", ops: [attendanceOp(DEV_IDS.class7A, "2026-09-10", [{ studentId: kid!, status: "present" }])] }),
  ]);
  assert.deepEqual([only(x.results).outcome, only(y.results).outcome].sort(), ["applied", "conflict"]);
  assert.equal(await count(`select count(*)::int as n from attendance_records where student_id = $1 and date = '2026-09-10'`, [kid!]), 1);
  assert.equal((await rowOf(kid!, "2026-09-10"))?.version, 1);
});

// ---------- permissions and tenancy ----------

test("a teacher cannot record attendance for a class she does not teach", { skip }, async () => {
  const chipo = await signIn(f.deps, EMAILS.chipo, DEV);
  const r = only((await push(f.deps, chipo.auth, { deviceId: DEV, ops: [attendanceOp(EXTRA.class5A, "2026-09-11", [{ studentId: EXTRA.student5A, status: "present" }])] })).results);
  assert.deepEqual([r.outcome, r.reason], ["rejected", "forbidden"]);
  assert.equal(await rowOf(EXTRA.student5A, "2026-09-11"), undefined);
});

test("a student who is not in the class cannot be marked through it", { skip }, async () => {
  const chipo = await signIn(f.deps, EMAILS.chipo, DEV);
  const [from6A] = await studentsOf(f, DEV_IDS.class6A, "2026-09-14");
  const r = only((await push(f.deps, chipo.auth, { deviceId: DEV, ops: [attendanceOp(DEV_IDS.class7A, "2026-09-14", [{ studentId: from6A!, status: "present" }])] })).results);
  assert.deepEqual([r.outcome, r.reason], ["rejected", "invalid"]);
});

test("the same student twice in one register, a future date, and an unknown class are all rejected", { skip }, async () => {
  const chipo = await signIn(f.deps, EMAILS.chipo, DEV);
  const [kid] = await studentsOf(f, DEV_IDS.class7A, "2026-09-15");
  const dup = only((await push(f.deps, chipo.auth, { deviceId: DEV, ops: [attendanceOp(DEV_IDS.class7A, "2026-09-15", [{ studentId: kid!, status: "present" }, { studentId: kid!, status: "absent" }])] })).results);
  assert.deepEqual([dup.outcome, dup.reason], ["rejected", "invalid"]);
  const future = only((await push(f.deps, chipo.auth, { deviceId: DEV, ops: [attendanceOp(DEV_IDS.class7A, "2026-10-09", [{ studentId: kid!, status: "present" }])] })).results);
  assert.deepEqual([future.outcome, future.reason], ["rejected", "future_date"]);
  const ghost = only((await push(f.deps, chipo.auth, { deviceId: DEV, ops: [attendanceOp(crypto.randomUUID(), "2026-09-15", [{ studentId: kid!, status: "present" }])] })).results);
  assert.deepEqual([ghost.outcome, ghost.reason], ["rejected", "not_found"]);
});

test("a teacher at another school cannot touch this school's class; it looks like it does not exist", { skip }, async () => {
  const other = await signIn(f.deps, EMAILS.other, "device-other0001");
  const [kid] = await studentsOf(f, DEV_IDS.class7A, "2026-09-16");
  const r = only((await push(f.deps, other.auth, { deviceId: "device-other0001", ops: [attendanceOp(DEV_IDS.class7A, "2026-09-16", [{ studentId: kid!, status: "absent" }])] })).results);
  assert.deepEqual([r.outcome, r.reason], ["rejected", "not_found"]);
  assert.equal(await rowOf(kid!, "2026-09-16"), undefined);
  const b = await bootstrap(f.deps, other.auth);
  assert.deepEqual(b.classes.map((c) => c.name), ["Form 1A"]);
  assert.equal(b.students.length, 0);
});

test("the head cannot push attendance, and a device cannot push as another device", { skip }, async () => {
  const head = await signIn(f.deps, EMAILS.head, "device-head00001");
  const [kid] = await studentsOf(f, DEV_IDS.class7A, "2026-09-17");
  const op = attendanceOp(DEV_IDS.class7A, "2026-09-17", [{ studentId: kid!, status: "present" }]);
  assert.equal(await push(f.deps, head.auth, { deviceId: "device-head00001", ops: [op] }).catch(status), "403 forbidden");
  const chipo = await signIn(f.deps, EMAILS.chipo, DEV);
  assert.equal(await push(f.deps, chipo.auth, { deviceId: "device-someoneelse", ops: [op] }).catch(status), "403 device_mismatch");
  assert.equal(await rowOf(kid!, "2026-09-17"), undefined);
});

test("a batch is processed per operation: one rejected op does not stop the next", { skip }, async () => {
  const chipo = await signIn(f.deps, EMAILS.chipo, DEV);
  const [kid] = await studentsOf(f, DEV_IDS.class7A, "2026-08-28");
  const bad = attendanceOp(EXTRA.class5A, "2026-08-28", [{ studentId: EXTRA.student5A, status: "present" }]);
  const good = attendanceOp(DEV_IDS.class7A, "2026-08-28", [{ studentId: kid!, status: "present" }]);
  const res = (await push(f.deps, chipo.auth, { deviceId: DEV, ops: [bad, good] })).results;
  assert.deepEqual(res.map((r) => r.outcome), ["rejected", "applied"]);
  assert.deepEqual(res[1]!.entries.map((e) => e.outcome), ["applied"]); // really inserted, not a no-op
  assert.deepEqual(await rowOf(kid!, "2026-08-28"), { status: "present", version: 1 });
});
