/**
 * Slice 2 against Slice 1: what the school administration screens configure is exactly what the offline attendance
 * register reads, pushes to and reports on. These tests drive the REAL Slice 1 services (bootstrap, push, summary).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootstrapResponse, pushResponse } from "@schoolpulse/contracts";
import { pgTestsEnabled } from "@schoolpulse/db/testing";
import { attendanceSummary } from "../src/services/admin.ts";
import { bootstrap, push } from "../src/services/sync.ts";
import { DEV_IDS, EXTRA, call, createYear2026, expectOk, makeAdminFixture, type AdminFixture, type Signed } from "./admin-support.ts";
import { attendanceOp, only } from "./support.ts";

const skip = pgTestsEnabled() ? false : "no PostgreSQL configured (set PSQL_TEST_CONN)";
const TODAY = "2026-10-08";
const NEXT_DAY = "2026-10-09";
let f: AdminFixture;
let y2026: string;
let grade = 0;

const DEVICES = { chipo: "device-chipo-001", tendai: "device-tendai-01", otherTeacher: "device-oteach-001" };
const makeClass = async (name: string, academicYearId = y2026, who: Signed = f.head) =>
  expectOk(await call(f, who, "POST /v1/classes", { body: { name, gradeLevel: `I${++grade}`, stream: null, academicYearId } }), 201).body.id as string;
const register = async (admissionNo: string, classId: string | null, who: Signed = f.head) =>
  expectOk(await call(f, who, "POST /v1/students", {
    body: { admissionNo, firstName: "Kid", lastName: admissionNo, enrolmentDate: "2026-01-12", ...(classId ? { classId, classStartsOn: "2026-02-02" } : {}) },
  }), 201).body;
const assign = async (classId: string, userId: string, who: Signed = f.head) =>
  expectOk(await call(f, who, "POST /v1/classes/:id/teachers", { params: { id: classId }, body: { userId } }));
const pushAs = (who: Signed, device: string, classId: string, entries: { studentId: string; status: "present" | "late" | "absent"; baseVersion?: number }[], date: string, opId?: string) =>
  push(f.deps, who.auth, { deviceId: device, ops: [attendanceOp(classId, date, entries, opId)] });
const replica = async (who: Signed) => bootstrapResponse.parse(await bootstrap(f.deps, who.auth));
const atTime = async <T>(iso: string, fn: () => Promise<T>): Promise<T> => {
  const real = f.clock.now;
  f.clock.now = new Date(iso);
  try {
    return await fn();
  } finally {
    f.clock.now = real;
  }
};
const DAY2 = "2026-10-09T06:05:00.000Z"; // 08:05 on 2026-10-09 in Harare

before(async () => {
  if (skip) return;
  f = await makeAdminFixture();
  y2026 = await createYear2026(f);
});
after(async () => {
  if (!skip) await f.close();
});

test("a school set up entirely through Slice 2 can take registers: year, class, students, teacher, push, overview", { skip }, async () => {
  // The second school starts with only a head and one teacher account. Everything else is configured through the API.
  const year = expectOk(await call(f, f.otherHead, "POST /v1/academic-years", { body: { name: "2026", startsOn: "2026-01-05", endsOn: "2026-12-11", isActive: true } }), 201).body.id as string;
  const cls = await makeClass("Form 2B", year, f.otherHead);
  const kids = [await register("OS-1", cls, f.otherHead), await register("OS-2", cls, f.otherHead), await register("OS-3", cls, f.otherHead)];
  await assign(cls, EXTRA.otherTeacher, f.otherHead);

  const rep = await replica(f.otherTeacher);
  assert.deepEqual(rep.classes.map((c) => c.name).sort(), ["Form 1A", "Form 2B"]);
  assert.deepEqual(rep.students.filter((s) => s.classId === cls).map((s) => s.admissionNo).sort(), ["OS-1", "OS-2", "OS-3"]);

  const res = pushResponse.parse(await pushAs(f.otherTeacher, DEVICES.otherTeacher, cls, [
    { studentId: kids[0].id, status: "present" }, { studentId: kids[1].id, status: "late" }, { studentId: kids[2].id, status: "absent" },
  ], TODAY));
  assert.equal(only(res.results).outcome, "applied");

  const s = await attendanceSummary(f.deps, f.otherHead.auth, { from: TODAY, to: TODAY });
  const row = s.classes.find((c) => c.name === "Form 2B")!;
  assert.deepEqual([row.current.present, row.current.late, row.current.absent, row.current.total], [1, 1, 1, 3]);
  // and nothing of it is visible to the first school
  const mavambo = await attendanceSummary(f.deps, f.head.auth, { from: TODAY, to: TODAY });
  assert.ok(!mavambo.classes.some((c) => c.name === "Form 2B"));
  assert.ok(!(await replica(f.chipo)).students.some((x) => x.admissionNo.startsWith("OS-")));
});

test("the bootstrap payload keeps exactly the shape Slice 1 clients expect", { skip }, async () => {
  const raw = await bootstrap(f.deps, f.chipo.auth);
  assert.deepEqual(Object.keys(raw).sort(), ["attendance", "classes", "school", "serverTime", "students", "todaySlots", "today"].sort());
  for (const c of raw.classes) assert.deepEqual(Object.keys(c).sort(), ["gradeLevel", "id", "name"], "no new fields leak into the replica's classes");
  for (const s of raw.students) assert.deepEqual(Object.keys(s).sort(), ["admissionNo", "classId", "firstName", "id", "lastName"], "no date of birth, gender or status on the phone");
});

test("Slice 1's own data is untouched: Ms. Chipo still has her three classes and 32 students", { skip }, async () => {
  const rep = await replica(f.chipo);
  assert.deepEqual(rep.classes.map((c) => c.name).filter((n) => ["Grade 6A", "Grade 7A", "Grade 7B"].includes(n)).sort(), ["Grade 6A", "Grade 7A", "Grade 7B"]);
  assert.equal(rep.students.filter((s) => [DEV_IDS.class7A, DEV_IDS.class7B, DEV_IDS.class6A].includes(s.classId)).length, 32);
  assert.deepEqual(rep.todaySlots.map((x) => x.className), ["Grade 7A", "Grade 7B", "Grade 6A"]);
});

test("stable ids: renaming a class or editing a student changes no id, and a register queued before still applies", { skip }, async () => {
  const cls = await makeClass("Stable 1A");
  const kid = await register("ST-A", cls);
  await assign(cls, DEV_IDS.teacher);
  const before = (await replica(f.chipo)).classes.find((c) => c.id === cls)!;
  assert.equal(before.name, "Stable 1A");

  // the head renames the class and corrects the child's name while Ms. Chipo is offline with a register taken
  expectOk(await call(f, f.head, "PATCH /v1/classes/:id", { params: { id: cls }, body: { name: "Stable One-A" } }));
  expectOk(await call(f, f.head, "PATCH /v1/students/:id", { params: { id: kid.id }, body: { firstName: "Kudzai", admissionNo: "ST-A2" } }));

  const after = await replica(f.chipo);
  assert.deepEqual([after.classes.find((c) => c.id === cls)!.name, after.students.find((s) => s.id === kid.id)!.admissionNo], ["Stable One-A", "ST-A2"], "same ids, new labels");
  const r = only((await pushAs(f.chipo, DEVICES.chipo, cls, [{ studentId: kid.id, status: "present" }], TODAY)).results);
  assert.equal(r.outcome, "applied", "the queued op names the class and student by the ids it always had");
});

test("a class change: registers before the effective date are accepted, after it the student belongs to the new class", { skip }, async () => {
  const oldCls = await makeClass("Move Old");
  const newCls = await makeClass("Move New");
  await assign(oldCls, DEV_IDS.teacher);
  await assign(newCls, EXTRA.tendai);
  const stay = await register("MV-S", oldCls);
  const mover = await register("MV-M", oldCls);

  // history: today's register for the old class includes the mover
  const first = only((await pushAs(f.chipo, DEVICES.chipo, oldCls, [{ studentId: stay.id, status: "present" }, { studentId: mover.id, status: "late" }], TODAY)).results);
  assert.equal(first.outcome, "applied");

  // the head moves the student from tomorrow
  const moved = expectOk(await call(f, f.head, "POST /v1/students/:id/placements", { params: { id: mover.id }, body: { classId: newCls, effectiveFrom: NEXT_DAY } }), 201).body;
  assert.equal(moved.currentClass.name, "Move Old", "still in the old class today");
  assert.equal(moved.upcomingClass.name, "Move New");

  // today the register does not change at all
  assert.ok((await replica(f.chipo)).students.some((s) => s.id === mover.id && s.classId === oldCls));
  assert.ok(!(await replica(f.tendai)).students.some((s) => s.id === mover.id));

  await atTime(DAY2, async () => {
    // the next morning each teacher's replica follows the move
    const chipo = await replica(f.chipo);
    const tendai = await replica(f.tendai);
    assert.equal(chipo.today, NEXT_DAY);
    assert.deepEqual(chipo.students.filter((s) => s.classId === oldCls).map((s) => s.id), [stay.id]);
    assert.deepEqual(tendai.students.filter((s) => s.classId === newCls).map((s) => s.id), [mover.id]);

    // a register queued BEFORE the move (for the day it was taken) is still valid: the student was in that class that day
    const queued = only((await pushAs(f.chipo, DEVICES.chipo, oldCls, [{ studentId: mover.id, status: "absent", baseVersion: 1 }], TODAY)).results);
    assert.equal(queued.outcome, "applied");

    // today's registers: the old class takes the stayer, the new class takes the mover
    assert.equal(only((await pushAs(f.chipo, DEVICES.chipo, oldCls, [{ studentId: stay.id, status: "present" }], NEXT_DAY)).results).outcome, "applied");
    assert.equal(only((await pushAs(f.tendai, DEVICES.tendai, newCls, [{ studentId: mover.id, status: "present" }], NEXT_DAY)).results).outcome, "applied");

    // The mover does not belong to the old class today. Slice 1 rejects the WHOLE operation when any entry's student is
    // not enrolled that day (documented residual risk: a stale phone that still lists the mover loses that register).
    const stale = only((await pushAs(f.chipo, DEVICES.chipo, oldCls, [{ studentId: stay.id, status: "present" }, { studentId: mover.id, status: "present" }], NEXT_DAY)).results);
    assert.deepEqual([stale.outcome, stale.reason], ["rejected", "invalid"]);
  });

  // history stayed where it happened
  const rows = await f.t.runner.query<{ class_id: string; date: string }>(
    `select class_id, to_char(date, 'YYYY-MM-DD') as date from attendance_records where student_id = $1 order by date`, [mover.id]);
  assert.deepEqual(rows.map((r) => [r.class_id, r.date]), [[oldCls, TODAY], [newCls, NEXT_DAY]]);
  const old = (await f.t.runner.query<{ status: string; version: number }>(`select status, version from attendance_records where student_id = $1 and class_id = $2`, [mover.id, oldCls]))[0]!;
  assert.deepEqual([old.status, old.version], ["absent", 2], "the earlier register was corrected in place, not duplicated");

  // the head's overview attributes each day to the class it was taken for
  const s = await atTime(DAY2, () => attendanceSummary(f.deps, f.head.auth, { from: TODAY, to: NEXT_DAY }));
  const oldRow = s.classes.find((c) => c.name === "Move Old")!;
  const newRow = s.classes.find((c) => c.name === "Move New")!;
  assert.equal(oldRow.current.total, 3, "stayer on both days + the mover on the first");
  assert.equal(newRow.current.total, 1);
});

test("a student who leaves school: earlier registers stay, later ones can no longer include them", { skip }, async () => {
  const cls = await makeClass("Leaver 1A");
  await assign(cls, DEV_IDS.teacher);
  const stay = await register("LV-S", cls);
  const leaver = await register("LV-L", cls);
  expectOk(await call(f, f.head, "POST /v1/students/:id/status", { params: { id: leaver.id }, body: { status: "withdrawn", effectiveFrom: NEXT_DAY } }));
  assert.equal(only((await pushAs(f.chipo, DEVICES.chipo, cls, [{ studentId: stay.id, status: "present" }, { studentId: leaver.id, status: "present" }], TODAY)).results).outcome, "applied");
  await atTime(DAY2, async () => {
    assert.ok(!(await replica(f.chipo)).students.some((s) => s.id === leaver.id), "no longer on the register");
    assert.equal(only((await pushAs(f.chipo, DEVICES.chipo, cls, [{ studentId: stay.id, status: "present" }], NEXT_DAY)).results).outcome, "applied");
    assert.equal(only((await pushAs(f.chipo, DEVICES.chipo, cls, [{ studentId: leaver.id, status: "present" }], NEXT_DAY)).results).reason, "invalid");
  });
  assert.equal((await f.t.runner.query<{ n: number }>(`select count(*)::int as n from attendance_records where student_id = $1`, [leaver.id]))[0]!.n, 1, "history kept");
});

test("changing a class's teacher never rewrites who took earlier registers", { skip }, async () => {
  const cls = await makeClass("Handover 1A");
  const kid = await register("HO-1", cls);
  await assign(cls, DEV_IDS.teacher);
  assert.equal(only((await pushAs(f.chipo, DEVICES.chipo, cls, [{ studentId: kid.id, status: "present" }], TODAY)).results).outcome, "applied");
  await assign(cls, EXTRA.tendai);
  expectOk(await call(f, f.head, "DELETE /v1/classes/:id/teachers/:userId", { params: { id: cls, userId: DEV_IDS.teacher } }));
  // Mr. Tendai can now take (and correct) the register; Ms. Chipo cannot
  const fix = only((await pushAs(f.tendai, DEVICES.tendai, cls, [{ studentId: kid.id, status: "late", baseVersion: 1 }], TODAY)).results);
  assert.equal(fix.outcome, "applied");
  assert.equal(only((await pushAs(f.chipo, DEVICES.chipo, cls, [{ studentId: kid.id, status: "absent", baseVersion: 2 }], TODAY)).results).reason, "forbidden");
  const audit = await f.t.runner.query<{ actor_user_id: string }>(
    `select actor_user_id from audit_log where action = 'attendance.recorded' and entity_id = $1 order by at, id`, [cls]);
  assert.deepEqual(audit.map((a) => a.actor_user_id), [DEV_IDS.teacher, EXTRA.tendai], "each change is attributed to whoever made it");
});

test("a retried operation is answered from its stored result even after the teacher's access changed", { skip }, async () => {
  const cls = await makeClass("Retry 1A");
  const kid = await register("RT-1", cls);
  await assign(cls, DEV_IDS.teacher);
  const opId = crypto.randomUUID();
  const first = only((await pushAs(f.chipo, DEVICES.chipo, cls, [{ studentId: kid.id, status: "present" }], TODAY, opId)).results);
  expectOk(await call(f, f.head, "DELETE /v1/classes/:id/teachers/:userId", { params: { id: cls, userId: DEV_IDS.teacher } }));
  const again = only((await pushAs(f.chipo, DEVICES.chipo, cls, [{ studentId: kid.id, status: "present" }], TODAY, opId)).results);
  assert.deepEqual([again.outcome, again.replayed, again.entries], [first.outcome, true, first.entries], "idempotent replay does not depend on today's permissions");
  assert.equal((await f.t.runner.query<{ n: number }>(`select count(*)::int as n from attendance_records where student_id = $1`, [kid.id]))[0]!.n, 1);
});

test("a class in an academic year that has not started yet can be set up and staffed ahead of time", { skip }, async () => {
  const next = expectOk(await call(f, f.head, "POST /v1/academic-years", { body: { name: "2027", startsOn: "2027-01-04", endsOn: "2027-12-10", isActive: false } }), 201).body.id as string;
  const cls = await makeClass("Next Year 1A", next);
  await assign(cls, DEV_IDS.teacher);
  const rep = await replica(f.chipo);
  assert.ok(rep.classes.some((c) => c.id === cls), "the class is on her list (it has no students to register yet)");
  assert.equal(rep.students.filter((s) => s.classId === cls).length, 0);
});

test("Slice 1 responses keep parsing with the Slice 1 contracts while Slice 2 data changes under them", { skip }, async () => {
  const cls = await makeClass("Contract 1A");
  const kid = await register("CT-1", cls);
  await assign(cls, DEV_IDS.teacher);
  bootstrapResponse.parse(await bootstrap(f.deps, f.chipo.auth));
  pushResponse.parse(await pushAs(f.chipo, DEVICES.chipo, cls, [{ studentId: kid.id, status: "present" }], TODAY));
});

// ---------- a register being saved while the head changes the student's placement ----------
// These run two real database sessions against each other. Whoever reaches the student's placement second must WAIT for the
// first to finish and then decide on what it left, never on a read that is already out of date.

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const untilSomeoneWaitsOnALock = async () => {
  for (let i = 0; i < 100; i++) {
    const [row] = await f.t.runner.query<{ n: number }>(`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
    if (row!.n > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail("expected a database session to be waiting on a lock, but none is");
};
const insertRegister = (tx: { insertAttendance: (w: never) => Promise<unknown> }, studentId: string, classId: string, date: string) =>
  tx.insertAttendance({ schoolId: DEV_IDS.school, studentId, classId, date, status: "present", recordedBy: DEV_IDS.teacher, deviceId: "dev-test-0001", opId: crypto.randomUUID() } as never);

test("race: a register being saved wins over a move that was decided before it committed (the move is refused, nothing is orphaned)", { skip }, async () => {
  const oldCls = await makeClass("Race Old");
  const newCls = await makeClass("Race New");
  const kid = await register("RC-A", oldCls);
  const held = deferred();
  const gate = deferred();
  // a push that has checked the student is in Race Old on the 9th (just past midnight, while the head's clock still says the 8th)
  const saving = f.deps.db.transaction(async (tx) => {
    const enrolled = await tx.enrolledStudents(DEV_IDS.school, [oldCls], NEXT_DAY, { lock: true });
    assert.ok(enrolled.some((s) => s.id === kid.id));
    held.resolve();
    await gate.promise;
    await insertRegister(tx, kid.id, oldCls, NEXT_DAY);
  });
  await held.promise;
  const moving = call(f, f.head, "POST /v1/students/:id/placements", { params: { id: kid.id }, body: { classId: newCls, effectiveFrom: NEXT_DAY } });
  await untilSomeoneWaitsOnALock();
  gate.resolve();
  await saving;
  const res = await moving;
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.error.code, "attendance_after_effective_date");

  const placements = await f.t.runner.query<{ class_id: string; ends_on: string | null }>(`select class_id, to_char(ends_on, 'YYYY-MM-DD') as ends_on from enrollments where student_id = $1`, [kid.id]);
  assert.deepEqual(placements.map((p) => [p.class_id, p.ends_on]), [[oldCls, null]], "the placement was not touched");
  assert.equal((await f.t.runner.query<{ n: number }>(`select count(*)::int as n from attendance_records where student_id = $1 and class_id = $2`, [kid.id, oldCls]))[0]!.n, 1);
});

test("race: removing a placement waits for a register being saved for it, then refuses", { skip }, async () => {
  const cls = await makeClass("Race Remove");
  const kid = await register("RC-R", cls);
  const placementId = (await f.t.runner.query<{ id: string }>(`select id from enrollments where student_id = $1`, [kid.id]))[0]!.id;
  const held = deferred();
  const gate = deferred();
  const saving = f.deps.db.transaction(async (tx) => {
    assert.ok((await tx.enrolledStudents(DEV_IDS.school, [cls], TODAY, { lock: true })).some((s) => s.id === kid.id));
    held.resolve();
    await gate.promise;
    await insertRegister(tx, kid.id, cls, TODAY);
  });
  await held.promise;
  const removing = call(f, f.head, "DELETE /v1/students/:id/placements/:placementId", { params: { id: kid.id, placementId } });
  await untilSomeoneWaitsOnALock();
  gate.resolve();
  await saving;
  const res = await removing;
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.error.code, "placement_has_attendance");
  assert.equal((await f.t.runner.query<{ n: number }>(`select count(*)::int as n from enrollments where student_id = $1`, [kid.id]))[0]!.n, 1);
});

test("race: the real push waits for a placement change in progress and decides on its result", { skip }, async () => {
  const cls = await makeClass("Race Push");
  const newCls = await makeClass("Race Push 2");
  await assign(cls, DEV_IDS.teacher);
  const stays = await register("RC-S", cls);
  const leaves = await register("RC-L", cls);

  // (1) the head's change ends the student's placement before today: the push must not use its earlier read of "enrolled"
  {
    const held = deferred();
    const gate = deferred();
    const changing = f.deps.admin.transaction(async (tx) => {
      const [open] = (await tx.listEnrolments(DEV_IDS.school, leaves.id, { lock: true })).filter((e) => e.endsOn === null);
      await tx.closeEnrolment(DEV_IDS.school, open!.id, "2026-10-07"); // the service refuses this date; a direct data fix could do it
      held.resolve();
      await gate.promise;
    });
    await held.promise;
    const pushing = pushAs(f.chipo, DEVICES.chipo, cls, [{ studentId: stays.id, status: "present" }, { studentId: leaves.id, status: "present" }], TODAY);
    await untilSomeoneWaitsOnALock();
    gate.resolve();
    await changing;
    const r = only((await pushing).results);
    assert.deepEqual([r.outcome, r.reason], ["rejected", "invalid"], "the student is no longer enrolled, so the operation is refused, not applied on a stale read");
    assert.equal((await f.t.runner.query<{ n: number }>(`select count(*)::int as n from attendance_records where class_id = $1`, [cls]))[0]!.n, 0);
  }

  // (2) a change that does not touch today (a move from tomorrow): the push waits for it to commit, then is applied as usual
  {
    const held = deferred();
    const gate = deferred();
    const changing = f.deps.admin.transaction(async (tx) => {
      const [open] = (await tx.listEnrolments(DEV_IDS.school, stays.id, { lock: true })).filter((e) => e.endsOn === null);
      await tx.closeEnrolment(DEV_IDS.school, open!.id, TODAY);
      await tx.insertEnrolment({ id: crypto.randomUUID(), schoolId: DEV_IDS.school, studentId: stays.id, classId: newCls, startsOn: NEXT_DAY, createdBy: DEV_IDS.head });
      held.resolve();
      await gate.promise;
    });
    await held.promise;
    const pushing = pushAs(f.chipo, DEVICES.chipo, cls, [{ studentId: stays.id, status: "present" }], TODAY);
    await untilSomeoneWaitsOnALock();
    gate.resolve();
    await changing;
    assert.equal(only((await pushing).results).outcome, "applied", "today's register is still valid: the move starts tomorrow");
    const [row] = await f.t.runner.query<{ class_id: string }>(`select class_id from attendance_records where student_id = $1`, [stays.id]);
    assert.equal(row!.class_id, cls);
  }
});
