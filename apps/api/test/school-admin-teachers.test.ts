import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootstrapResponse, classDetail, myClassesResponse, teachersResponse } from "@schoolpulse/contracts";
import { pgTestsEnabled } from "@schoolpulse/db/testing";
import { attendanceSummary } from "../src/services/admin.ts";
import { bootstrap, push } from "../src/services/sync.ts";
import { DEV_IDS, EXTRA, call, createYear2026, expectError, expectOk, makeAdminFixture, type AdminFixture } from "./admin-support.ts";
import { attendanceOp, only } from "./support.ts";

const skip = pgTestsEnabled() ? false : "no PostgreSQL configured (set PSQL_TEST_CONN)";
const TODAY = "2026-10-08";
let f: AdminFixture;
let y2026: string;
const CHIPO_DEVICE = "device-chipo-001";
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LEFT_TEACHER = uid(5001); // an ex-teacher: membership switched off
const NEW_TEACHER = uid(5002); // a teacher with no classes yet

let grade = 0; // a fresh grade per class, so a repeated stream letter never collides with an earlier test's class
const makeClass = async (name: string, stream: string | null = null, academicYearId = y2026) =>
  expectOk(await call(f, f.head, "POST /v1/classes", { body: { name, gradeLevel: `T${++grade}`, stream, academicYearId } }), 201).body.id as string;
const assign = (classId: string, userId: string, who = f.head) => call(f, who, "POST /v1/classes/:id/teachers", { params: { id: classId }, body: { userId } });
const unassign = (classId: string, userId: string, who = f.head) => call(f, who, "DELETE /v1/classes/:id/teachers/:userId", { params: { id: classId, userId } });
const register = async (admissionNo: string, classId: string) =>
  expectOk(await call(f, f.head, "POST /v1/students", { body: { admissionNo, firstName: "Kid", lastName: admissionNo, enrolmentDate: "2026-01-12", classId, classStartsOn: "2026-02-02" } }), 201).body;
const mine = async (who = f.chipo) => expectOk(await call(f, who, "GET /v1/me/classes")).body;
const teacherIds = async (classId: string) => ((await call(f, f.head, "GET /v1/classes/:id", { params: { id: classId } })).body.teachers as { id: string }[]).map((t) => t.id).sort();
const count = async (sql: string, p: string[] = []) => (await f.t.runner.query<{ n: number }>(sql, p))[0]!.n;
const pushFor = (classId: string, entries: { studentId: string; status: "present" | "late" | "absent" }[], date = TODAY) =>
  push(f.deps, f.chipo.auth, { deviceId: CHIPO_DEVICE, ops: [attendanceOp(classId, date, entries)] });

before(async () => {
  if (skip) return;
  f = await makeAdminFixture();
  y2026 = await createYear2026(f);
  const q = (sql: string, p: string[]) => f.t.runner.query(sql, p);
  await q(`insert into users (id, email, name, password_hash) values ($1, 'left@mavambo.example', 'Mr. Left', 'x')`, [LEFT_TEACHER]);
  await q(`insert into memberships (id, user_id, school_id, role, active) values ($1, $2, $3, 'teacher', false)`, [uid(5011), LEFT_TEACHER, DEV_IDS.school]);
  await q(`insert into users (id, email, name, password_hash) values ($1, 'new@mavambo.example', 'Mrs. New', 'x')`, [NEW_TEACHER]);
  await q(`insert into memberships (id, user_id, school_id, role) values ($1, $2, $3, 'teacher')`, [uid(5012), NEW_TEACHER, DEV_IDS.school]);
});
after(async () => {
  if (!skip) await f.close();
});

// ---------- who can be assigned ----------

test("the teacher list holds this school's active teachers with their class counts, and nobody else", { skip }, async () => {
  const res = expectOk(await call(f, f.head, "GET /v1/teachers"));
  assert.equal(teachersResponse.safeParse(res.body).success, true, JSON.stringify(teachersResponse.safeParse(res.body)));
  const byName = new Map((res.body.items as { id: string; name: string; email: string; classCount: number }[]).map((t) => [t.name, t]));
  assert.deepEqual([...byName.keys()].sort(), ["Mr. Tendai", "Mrs. New", "Ms. Chipo"].sort());
  assert.equal(byName.get("Ms. Chipo")!.classCount, 3);
  assert.equal(byName.get("Mr. Tendai")!.classCount, 1);
  assert.equal(byName.get("Mrs. New")!.classCount, 0);
  assert.ok(!byName.has("Mr. Left"), "a deactivated teacher is not offered");
  for (const t of byName.values()) assert.deepEqual(Object.keys(t).sort(), ["classCount", "email", "id", "name"]);

  const theirs = expectOk(await call(f, f.otherHead, "GET /v1/teachers")).body.items as { name: string }[];
  assert.deepEqual(theirs.map((t) => t.name), ["Other Teacher"]);
  expectError(await call(f, f.chipo, "GET /v1/teachers"), 403, "forbidden");
});

// ---------- assign / remove ----------

test("assign a teacher: the class shows them, the count follows, repeating it changes nothing", { skip }, async () => {
  const id = await makeClass("Assign 4A", "A");
  const res = expectOk(await assign(id, DEV_IDS.teacher));
  assert.equal(classDetail.safeParse(res.body).success, true, JSON.stringify(classDetail.safeParse(res.body)));
  assert.deepEqual(res.body.teachers.map((t: { id: string; name: string }) => [t.id, t.name]), [[DEV_IDS.teacher, "Ms. Chipo"]]);
  assert.equal(res.body.teacherCount, 1);
  expectOk(await assign(id, EXTRA.tendai));
  assert.equal(expectOk(await assign(id, EXTRA.tendai)).body.teachers.length, 2, "assigning twice does not duplicate");
  assert.equal(await count(`select count(*)::int as n from class_teachers where class_id = $1`, [id]), 2);
  const audits = await f.t.runner.query<{ details: { userId: string } }>(`select details from audit_log where entity_id = $1 and action = 'class.teacher_assigned'`, [id]);
  assert.equal(audits.length, 2, "the repeat is not audited as a second assignment");
  const row = (await f.t.runner.query<{ created_by: string }>(`select created_by from class_teachers where class_id = $1 and user_id = $2`, [id, DEV_IDS.teacher]))[0]!;
  assert.equal(row.created_by, DEV_IDS.head, "who assigned is recorded");
});

test("remove a teacher: gone from the class; removing again is a clear 404", { skip }, async () => {
  const id = await makeClass("Assign 4B", "B");
  await assign(id, DEV_IDS.teacher);
  await assign(id, EXTRA.tendai);
  const res = expectOk(await unassign(id, DEV_IDS.teacher));
  assert.deepEqual(res.body.teachers.map((t: { id: string }) => t.id), [EXTRA.tendai]);
  expectError(await unassign(id, DEV_IDS.teacher), 404, "assignment_not_found");
  expectError(await unassign(id, NEW_TEACHER), 404, "assignment_not_found");
  expectError(await unassign(id, "nope"), 404, "not_found");
  expectError(await unassign(crypto.randomUUID(), EXTRA.tendai), 404, "not_found");
  assert.deepEqual(await teacherIds(id), [EXTRA.tendai]);
});

test("changing the teacher of a class is an assignment plus a removal; both are audited", { skip }, async () => {
  const id = await makeClass("Assign 4C", "C");
  await assign(id, EXTRA.tendai);
  await assign(id, NEW_TEACHER);
  await unassign(id, EXTRA.tendai);
  assert.deepEqual(await teacherIds(id), [NEW_TEACHER]);
  const actions = (await f.t.runner.query<{ action: string }>(`select action from audit_log where entity_id = $1 order by at, id`, [id])).map((r) => r.action);
  assert.ok(actions.filter((a) => a === "class.teacher_assigned").length === 2 && actions.includes("class.teacher_removed"));
});

test("only teachers of this school can be assigned: another school's teacher, a head, a former teacher or a stranger are all the same 400", { skip }, async () => {
  const id = await makeClass("Assign 4D", "D");
  const refusal = async (userId: string) => expectError(await assign(id, userId), 400, "teacher_not_found", "userId");
  await refusal(EXTRA.otherTeacher);
  await refusal(DEV_IDS.head);
  await refusal(LEFT_TEACHER);
  await refusal(crypto.randomUUID());
  expectError(await assign(id, "not-a-uuid"), 400, "invalid_request", "userId");
  expectError(await call(f, f.head, "POST /v1/classes/:id/teachers", { params: { id }, body: {} }), 400, "invalid_request", "userId");
  expectError(await call(f, f.head, "POST /v1/classes/:id/teachers", { params: { id }, body: { userId: DEV_IDS.teacher, schoolId: EXTRA.otherSchool } }), 400, "invalid_request");
  assert.deepEqual(await teacherIds(id), []);
  // and the database refuses it too, should anything ever bypass the service
  await assert.rejects(
    f.t.runner.query(`insert into class_teachers (school_id, class_id, user_id) values ($1, $2, $3)`, [DEV_IDS.school, id, EXTRA.otherTeacher]),
    /class_teachers_teacher_membership/,
  );
});

test("a class from another school cannot be assigned to, even by its own head, and nothing is revealed", { skip }, async () => {
  expectError(await assign(EXTRA.otherClass, DEV_IDS.teacher), 404, "not_found");
  expectError(await assign(EXTRA.otherClass, EXTRA.otherTeacher), 404, "not_found");
  expectError(await unassign(EXTRA.otherClass, EXTRA.otherTeacher), 404, "not_found");
  const id = await makeClass("Assign 4E", "E");
  expectError(await assign(id, DEV_IDS.teacher, f.otherHead), 404, "not_found");
  expectError(await assign(id, EXTRA.otherTeacher, f.otherHead), 404, "not_found");
  assert.deepEqual(await teacherIds(id), []);
  assert.equal(await count(`select count(*)::int as n from class_teachers where school_id = $1 and class_id = $2`, [EXTRA.otherSchool, EXTRA.otherClass]), 1, "the other school's assignment is untouched");
});

test("an archived class, or one whose academic year has ended, cannot get a new teacher", { skip }, async () => {
  const id = await makeClass("Assign 4F", "F");
  await assign(id, DEV_IDS.teacher);
  expectOk(await call(f, f.head, "PATCH /v1/classes/:id", { params: { id }, body: { status: "archived" } }));
  expectError(await assign(id, EXTRA.tendai), 409, "class_archived", "userId");
  expectOk(await unassign(id, DEV_IDS.teacher), 200); // removing is always allowed
  expectOk(await call(f, f.head, "PATCH /v1/classes/:id", { params: { id }, body: { status: "active" } }));
  expectOk(await assign(id, EXTRA.tendai));

  const old = expectOk(await call(f, f.head, "POST /v1/academic-years", { body: { name: "2025", startsOn: "2025-01-06", endsOn: "2025-12-12", isActive: false } }), 201).body.id as string;
  const past = await makeClass("Assign 3A (2025)", "A", old);
  expectError(await assign(past, DEV_IDS.teacher), 409, "class_year_ended", "userId");
  assert.deepEqual(await teacherIds(past), []);
});

test("teachers cannot assign or remove anyone, not even themselves", { skip }, async () => {
  const id = await makeClass("Assign 4G", "G");
  expectError(await assign(id, DEV_IDS.teacher, f.chipo), 403, "forbidden");
  expectError(await assign(id, EXTRA.tendai, f.chipo), 403, "forbidden");
  await assign(id, EXTRA.tendai);
  expectError(await unassign(id, EXTRA.tendai, f.chipo), 403, "forbidden");
  expectError(await unassign(id, EXTRA.tendai, f.tendai), 403, "forbidden");
  assert.deepEqual(await teacherIds(id), [EXTRA.tendai]);
});

test("two admins assigning the same teacher at once leave exactly one assignment", { skip }, async () => {
  const id = await makeClass("Assign 4H", "H");
  const results = await Promise.all([assign(id, NEW_TEACHER), assign(id, NEW_TEACHER), assign(id, NEW_TEACHER)]);
  for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await count(`select count(*)::int as n from class_teachers where class_id = $1`, [id]), 1);
});

// ---------- what Slice 1 sees ----------

test("/me/classes is exactly the set of classes the offline bootstrap sends", { skip }, async () => {
  const res = expectOk(await call(f, f.chipo, "GET /v1/me/classes"));
  assert.equal(myClassesResponse.safeParse(res.body).success, true, JSON.stringify(myClassesResponse.safeParse(res.body)));
  assert.equal(res.body.today, TODAY);
  const replica = bootstrapResponse.parse(await bootstrap(f.deps, f.chipo.auth));
  assert.deepEqual(res.body.classes.map((c: { id: string }) => c.id).sort(), replica.classes.map((c) => c.id).sort());
  for (const c of res.body.classes as { id: string; studentCount: number }[]) {
    assert.equal(c.studentCount, replica.students.filter((s) => s.classId === c.id).length, "headcount matches the replica");
  }
  expectError(await call(f, f.head, "GET /v1/me/classes"), 403, "forbidden");
  const none = expectOk(await call(f, f.otherTeacher, "GET /v1/me/classes")).body.classes as { id: string }[];
  assert.deepEqual(none.map((c) => c.id), [EXTRA.otherClass], "only the teacher's own school and classes");
});

test("an assignment reaches the teacher straight away: /me/classes, bootstrap, roster and registers; a removal takes it away", { skip }, async () => {
  const id = await makeClass("Assign 5A", "A");
  const kid = await register("TA-1", id);
  assert.ok(!(await mine()).classes.some((c: { id: string }) => c.id === id));
  expectError(await call(f, f.chipo, "GET /v1/classes/:id/roster", { params: { id } }), 403, "forbidden");
  assert.equal(only((await pushFor(id, [{ studentId: kid.id, status: "present" }])).results).reason, "forbidden");

  await assign(id, DEV_IDS.teacher);
  const now = (await mine()).classes.find((c: { id: string }) => c.id === id);
  assert.deepEqual([now.name, now.studentCount, now.academicYear.name], ["Assign 5A", 1, "2026"]);
  const replica = bootstrapResponse.parse(await bootstrap(f.deps, f.chipo.auth));
  assert.ok(replica.classes.some((c) => c.id === id));
  assert.deepEqual(replica.students.filter((s) => s.classId === id).map((s) => s.id), [kid.id]);
  assert.equal((await call(f, f.chipo, "GET /v1/classes/:id/roster", { params: { id } })).status, 200);
  const r = only((await pushFor(id, [{ studentId: kid.id, status: "present" }])).results);
  assert.equal(r.outcome, "applied");

  await unassign(id, DEV_IDS.teacher);
  assert.ok(!(await mine()).classes.some((c: { id: string }) => c.id === id));
  assert.ok(!bootstrapResponse.parse(await bootstrap(f.deps, f.chipo.auth)).classes.some((c) => c.id === id));
  expectError(await call(f, f.chipo, "GET /v1/classes/:id/roster", { params: { id } }), 403, "forbidden");
  const again = only((await pushFor(id, [{ studentId: kid.id, status: "late" }])).results);
  assert.deepEqual([again.outcome, again.reason], ["rejected", "forbidden"], "a removed teacher cannot record any more");
  // what they recorded while assigned is still there, still theirs
  const rec = (await f.t.runner.query<{ status: string; recorded_by: string }>(`select status, recorded_by from attendance_records where student_id = $1`, [kid.id]))[0]!;
  assert.deepEqual([rec.status, rec.recorded_by], ["present", DEV_IDS.teacher]);
});

test("archiving a class takes it off the teacher's replica, yet a register queued before still syncs", { skip }, async () => {
  const id = await makeClass("Assign 5B", "B");
  const kid = await register("TA-2", id);
  await assign(id, DEV_IDS.teacher);
  assert.ok((await mine()).classes.some((c: { id: string }) => c.id === id));
  // The head moves the only student out from tomorrow (2026-10-09); only once that has happened can the class be archived.
  const elsewhere = await makeClass("Assign 5B-new", "N");
  expectOk(await call(f, f.head, "POST /v1/students/:id/placements", { params: { id: kid.id }, body: { classId: elsewhere, effectiveFrom: "2026-10-09" } }), 201);
  expectError(await call(f, f.head, "PATCH /v1/classes/:id", { params: { id }, body: { status: "archived" } }), 409, "class_has_students");

  const realNow = f.clock.now;
  f.clock.now = new Date("2026-10-10T06:05:00.000Z"); // two days later, 08:05 in Harare
  try {
    expectOk(await call(f, f.head, "PATCH /v1/classes/:id", { params: { id }, body: { status: "archived" } }));
    assert.ok(!(await mine()).classes.some((c: { id: string }) => c.id === id), "hidden from /me/classes");
    assert.ok(!bootstrapResponse.parse(await bootstrap(f.deps, f.chipo.auth)).classes.some((c) => c.id === id), "hidden from the replica");
    // Ms. Chipo took Thursday's register offline, before the class was archived, and syncs it now.
    const queued = only((await pushFor(id, [{ studentId: kid.id, status: "present" }], TODAY)).results);
    assert.deepEqual([queued.outcome, queued.reason], ["applied", undefined], "archiving a class does not strand registers already taken");
    // and the head can still read that class's history
    assert.equal(expectOk(await call(f, f.head, "GET /v1/classes/:id/roster", { params: { id }, query: { date: TODAY } })).body.students.length, 1);
  } finally {
    f.clock.now = realNow;
  }
});

test("the head's attendance overview picks up a new class and the register taken for it", { skip }, async () => {
  const id = await makeClass("Overview 6A", "A");
  const kids = [await register("OV-1", id), await register("OV-2", id), await register("OV-3", id)];
  await assign(id, DEV_IDS.teacher);
  const r = only((await pushFor(id, [
    { studentId: kids[0]!.id, status: "present" }, { studentId: kids[1]!.id, status: "absent" }, { studentId: kids[2]!.id, status: "late" },
  ], "2026-10-07")).results);
  assert.equal(r.outcome, "applied");
  const s = await attendanceSummary(f.deps, f.head.auth, { from: "2026-10-07", to: "2026-10-07" });
  const row = s.classes.find((c) => c.name === "Overview 6A")!;
  assert.deepEqual([row.current.present, row.current.late, row.current.absent, row.current.total], [1, 1, 1, 3]);
});
