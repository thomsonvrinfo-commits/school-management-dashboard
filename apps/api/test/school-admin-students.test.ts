import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { studentDetail, studentPage } from "@schoolpulse/contracts";
import { pgTestsEnabled } from "@schoolpulse/db/testing";
import { DEV_IDS, EXTRA, call, createYear2026, expectError, expectOk, makeAdminFixture, type AdminFixture, type Res } from "./admin-support.ts";

const skip = pgTestsEnabled() ? false : "no PostgreSQL configured (set PSQL_TEST_CONN)";
const TODAY = "2026-10-08";
const TOMORROW = "2026-10-09";
let f: AdminFixture;
let yearId: string;
let classA: string; // Grade 4A
let classB: string; // Grade 4B

const makeClass = async (name: string, gradeLevel: string, stream: string | null, year = yearId) =>
  expectOk(await call(f, f.head, "POST /v1/classes", { body: { name, gradeLevel, stream, academicYearId: year } }), 201).body.id as string;
const register = (body: Record<string, unknown>, who = f.head) => call(f, who, "POST /v1/students", { body });
const detail = async (id: string) => expectOk(await call(f, f.head, "GET /v1/students/:id", { params: { id } })).body;
const place = (id: string, body: Record<string, unknown>) => call(f, f.head, "POST /v1/students/:id/placements", { params: { id }, body });
const rosterIds = async (classId: string, date: string) =>
  (expectOk(await call(f, f.head, "GET /v1/classes/:id/roster", { params: { id: classId }, query: { date } })).body.students as { id: string }[]).map((s) => s.id);
const record = (studentId: string, classId: string, date: string, status = "present") =>
  f.t.runner.query(
    `insert into attendance_records (school_id, student_id, class_id, date, status, recorded_by, device_id, op_id)
     values ($1, $2, $3, $4::date, $5, $6, 'dev-test-0001', gen_random_uuid())`,
    [DEV_IDS.school, studentId, classId, date, status, DEV_IDS.teacher],
  );

before(async () => {
  if (skip) return;
  f = await makeAdminFixture();
  yearId = await createYear2026(f);
  classA = await makeClass("Grade 4A", "4", "A");
  classB = await makeClass("Grade 4B", "4", "B");
});
after(async () => {
  if (!skip) await f.close();
});

// ---------- registering ----------

test("register a student with the minimum details: normalised, enrolled, in no class yet", { skip }, async () => {
  const res = expectOk(await register({ admissionNo: "  ma5001 ", firstName: "  Tadiwa  ", lastName: "Chimbwanda" }), 201);
  assert.equal(studentDetail.safeParse(res.body).success, true, JSON.stringify(studentDetail.safeParse(res.body)));
  const s = res.body;
  assert.deepEqual([s.admissionNo, s.firstName, s.status, s.enrolmentDate, s.currentClass, s.upcomingClass, s.placements, s.dateOfBirth, s.gender], ["MA5001", "Tadiwa", "enrolled", TODAY, null, null, [], null, null]);
  const row = (await f.t.runner.query<{ active: boolean; school_id: string }>(`select active, school_id from students where id = $1`, [s.id]))[0]!;
  assert.deepEqual([row.active, row.school_id], [true, DEV_IDS.school], "stored in the signed-in head's school; legacy active flag stays true");
  assert.ok((await f.t.runner.query<{ action: string }>(`select action from audit_log where entity_id = $1`, [s.id])).some((r) => r.action === "student.registered"));
});

test("register with full details and a class in one step", { skip }, async () => {
  const res = expectOk(await register({
    admissionNo: "MA5002", firstName: "Nyasha", lastName: "Moyo", otherNames: "Rudo", dateOfBirth: "2016-03-02", gender: "female",
    enrolmentDate: "2026-01-12", classId: classA,
  }), 201);
  const s = res.body;
  assert.deepEqual([s.otherNames, s.dateOfBirth, s.gender, s.enrolmentDate, s.currentClass?.name], ["Rudo", "2016-03-02", "female", "2026-01-12", "Grade 4A"]);
  assert.deepEqual(s.placements.map((p: { className: string; startsOn: string; endsOn: string | null; academicYear: { name: string } }) => [p.className, p.startsOn, p.endsOn, p.academicYear.name]), [["Grade 4A", TODAY, null, "2026"]]);
  assert.ok((await rosterIds(classA, TODAY)).includes(s.id), "the student is in the class roster");
});

test("a past enrolment date still lets the student be placed today (the class start defaults to today, not the enrolment date)", { skip }, async () => {
  const s = expectOk(await register({ admissionNo: "MA5003", firstName: "Old", lastName: "Hand", enrolmentDate: "2024-02-01", classId: classB }), 201).body;
  assert.equal(s.placements[0].startsOn, TODAY);
  const early = expectOk(await register({ admissionNo: "MA5004", firstName: "Back", lastName: "Dated", enrolmentDate: "2026-01-12", classId: classB, classStartsOn: "2026-02-02" }), 201).body;
  assert.equal(early.placements[0].startsOn, "2026-02-02", "a head catching up records may date the first placement in the past");
});

test("admission numbers are unique within a school (any capitalisation) but the same number may exist in another school", { skip }, async () => {
  expectError(await register({ admissionNo: "MA5001", firstName: "Dup", lastName: "One" }), 409, "admission_no_taken", "admissionNo");
  expectError(await register({ admissionNo: "ma5001", firstName: "Dup", lastName: "Two" }), 409, "admission_no_taken", "admissionNo");
  expectError(await register({ admissionNo: "MA1001", firstName: "Dup", lastName: "Seeded" }), 409, "admission_no_taken", "admissionNo"); // Slice 1 sample student
  expectOk(await register({ admissionNo: "MA1001", firstName: "Same", lastName: "Number" }, f.otherHead), 201);
  const mine = expectOk(await call(f, f.head, "GET /v1/students", { query: { q: "MA1001" } })).body;
  assert.equal(mine.items.every((s: { firstName: string }) => s.firstName !== "Same"), true, "the other school's student is not in our list");
  assert.equal((await f.t.runner.query<{ n: number }>(`select count(*)::int n from students where admission_no = 'MA5001'`))[0]!.n, 1, "no duplicate row was created");
});

test("two registrations racing for the same admission number: exactly one wins, the other gets a clear 409", { skip }, async () => {
  const results = await Promise.all([1, 2, 3].map((n) => register({ admissionNo: "RACE-1", firstName: `Racer${n}`, lastName: "Runner" })));
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 409, 409]);
  for (const r of results.filter((x) => x.status === 409)) assert.equal(r.body.error.code, "admission_no_taken");
});

test("registration validation: every bad input is a 400 that names the field, and nothing is stored", { skip }, async () => {
  const base = { admissionNo: "MA6000", firstName: "Valid", lastName: "Student" };
  const before = (await f.t.runner.query<{ n: number }>(`select count(*)::int n from students`))[0]!.n;
  expectError(await register({ ...base, admissionNo: "" }), 400, "invalid_request", "admissionNo");
  expectError(await register({ ...base, admissionNo: "MA 6000" }), 400, "invalid_request", "admissionNo");
  expectError(await register({ ...base, firstName: "   " }), 400, "invalid_request", "firstName");
  expectError(await register({ ...base, lastName: "1234" }), 400, "invalid_request", "lastName");
  expectError(await register({ ...base, gender: "robot" }), 400, "invalid_request", "gender");
  expectError(await register({ ...base, dateOfBirth: "2016-02-30" }), 400, "invalid_request", "dateOfBirth");
  expectError(await register({ ...base, dateOfBirth: "2026-10-09" }), 400, "dob_in_future", "dateOfBirth");
  expectError(await register({ ...base, dateOfBirth: "1960-01-01" }), 400, "dob_too_old", "dateOfBirth");
  expectError(await register({ ...base, dateOfBirth: "2016-03-02", enrolmentDate: "2015-01-01" }), 400, "enrolment_before_birth", "enrolmentDate");
  expectError(await register({ ...base, enrolmentDate: "2030-01-01" }), 400, "enrolment_too_far_ahead", "enrolmentDate");
  expectError(await register({ ...base, classId: crypto.randomUUID() }), 400, "class_not_found", "classId");
  expectError(await register({ ...base, classStartsOn: TODAY }), 400, "invalid_request", "classStartsOn");
  expectError(await register({ ...base, classId: classA, classStartsOn: "2027-06-01" }), 400, "outside_academic_year", "effectiveFrom");
  expectError(await register({ ...base, schoolId: EXTRA.otherSchool }), 400, "invalid_request");
  expectError(await register({ ...base, active: false }), 400, "invalid_request");
  expectError(await register({ ...base, status: "graduated" }), 400, "invalid_request");
  expectError(await call(f, f.head, "POST /v1/students", { rawBody: "nope" }), 400, "invalid_json");
  assert.equal((await f.t.runner.query<{ n: number }>(`select count(*)::int n from students`))[0]!.n, before);
});

test("a class from another school cannot be used when registering", { skip }, async () => {
  expectError(await register({ admissionNo: "MA6001", firstName: "Sneaky", lastName: "Placement", classId: EXTRA.otherClass }), 400, "class_not_found", "classId");
  assert.equal((await f.t.runner.query<{ n: number }>(`select count(*)::int n from students where admission_no = 'MA6001'`))[0]!.n, 0, "the student was not half-registered");
});

test("an archived class cannot take new students", { skip }, async () => {
  const empty = await makeClass("Grade 1X", "1", "X");
  expectOk(await call(f, f.head, "PATCH /v1/classes/:id", { params: { id: empty }, body: { status: "archived" } }));
  expectError(await register({ admissionNo: "MA6002", firstName: "Late", lastName: "Comer", classId: empty }), 409, "class_archived", "classId");
});

test("teachers cannot use the student registry", { skip }, async () => {
  expectError(await register({ admissionNo: "MA6003", firstName: "Teacher", lastName: "Made" }, f.chipo), 403, "forbidden");
  expectError(await call(f, f.chipo, "GET /v1/students"), 403, "forbidden");
  const any = (await call(f, f.head, "GET /v1/students", { query: { limit: "1" } })).body.items[0];
  expectError(await call(f, f.chipo, "GET /v1/students/:id", { params: { id: any.id } }), 403, "forbidden");
  expectError(await call(f, f.chipo, "PATCH /v1/students/:id", { params: { id: any.id }, body: { firstName: "X" } }), 403, "forbidden");
  expectError(await call(f, f.chipo, "POST /v1/students/:id/status", { params: { id: any.id }, body: { status: "withdrawn" } }), 403, "forbidden");
  expectError(await call(f, f.chipo, "POST /v1/students/:id/placements", { params: { id: any.id }, body: { classId: classA } }), 403, "forbidden");
});

// ---------- searching and filtering ----------

test("list: the page shape, bounded size, defaults, and no sensitive fields", { skip }, async () => {
  const res = expectOk(await call(f, f.head, "GET /v1/students")).body;
  assert.equal(studentPage.safeParse(res).success, true);
  assert.deepEqual([res.limit, res.offset], [25, 0]);
  assert.ok(res.total >= 32 + 5, "the seeded students plus the ones registered here");
  assert.equal(res.items.length, 25);
  for (const s of res.items) {
    assert.equal("dateOfBirth" in s || "gender" in s || "otherNames" in s, false, "the list never carries personal details beyond name and admission number");
  }
  const names = res.items.map((s: { lastName: string; firstName: string }) => `${s.lastName.toLowerCase()}|${s.firstName.toLowerCase()}`);
  assert.deepEqual(names, [...names].sort(), "sorted by last name then first name");
  expectError(await call(f, f.head, "GET /v1/students", { query: { limit: "101" } }), 400, "invalid_request", "limit");
  expectError(await call(f, f.head, "GET /v1/students", { query: { limit: "0" } }), 400, "invalid_request", "limit");
  expectError(await call(f, f.head, "GET /v1/students", { query: { offset: "-5" } }), 400, "invalid_request", "offset");
  expectError(await call(f, f.head, "GET /v1/students", { query: { status: "expelled" } }), 400, "invalid_request", "status");
  expectError(await call(f, f.head, "GET /v1/students", { query: { classId: "nope" } }), 400, "invalid_request", "classId");
  expectError(await call(f, f.head, "GET /v1/students", { query: { unplaced: "maybe" } }), 400, "invalid_request", "unplaced");
});

test("list: paging walks every student exactly once", { skip }, async () => {
  const all = expectOk(await call(f, f.head, "GET /v1/students", { query: { limit: "100" } })).body;
  const seen: string[] = [];
  for (let offset = 0; offset < all.total; offset += 9) {
    const page = expectOk(await call(f, f.head, "GET /v1/students", { query: { limit: "9", offset: String(offset) } })).body;
    assert.equal(page.total, all.total);
    seen.push(...page.items.map((s: { id: string }) => s.id));
  }
  assert.deepEqual(seen, all.items.map((s: { id: string }) => s.id));
  assert.equal(new Set(seen).size, seen.length);
  assert.deepEqual((await call(f, f.head, "GET /v1/students", { query: { offset: "100000" } })).body.items, []);
});

test("search matches names and admission numbers, every word must match, case does not matter", { skip }, async () => {
  const find = async (q: string) => (expectOk(await call(f, f.head, "GET /v1/students", { query: { q } })).body.items as { admissionNo: string }[]).map((s) => s.admissionNo);
  assert.deepEqual(await find("ma5001"), ["MA5001"]);
  assert.deepEqual(await find("CHIMBWANDA tadiwa"), ["MA5001"]);
  assert.deepEqual(await find("nyasha moyo"), ["MA5002"]);
  assert.ok((await find("nyasha")).includes("MA5002"));
  assert.ok((await find("rudo")).includes("MA5002"), "other names are searched too");
  assert.deepEqual(await find("rudo moyo"), ["MA5002"], "every word must match, across first, last and other names");
  assert.deepEqual(await find("tadiwa nobody"), []);
  assert.deepEqual(await find("%"), [], "a percent sign is just a character");
  assert.deepEqual(await find("'; drop table students; --"), []);
  assert.ok((await find("MA10")).length >= 12, "prefix of the seeded admission numbers");
  assert.equal(expectOk(await call(f, f.head, "GET /v1/students", { query: { q: "   " } })).body.total >= 37, true, "a blank search is no search");
});

test("filter by current class, status and 'no class yet'", { skip }, async () => {
  const inClass = async (classId: string) => (expectOk(await call(f, f.head, "GET /v1/students", { query: { classId } })).body.items as { admissionNo: string; currentClass: { id: string } }[]);
  assert.deepEqual((await inClass(classA)).map((s) => s.admissionNo), ["MA5002"]);
  assert.deepEqual((await inClass(classB)).map((s) => s.admissionNo).sort(), ["MA5003", "MA5004"]);
  assert.equal((await inClass(DEV_IDS.class7A)).length, 12);
  assert.ok((await inClass(DEV_IDS.class7A)).every((s) => s.currentClass.id === DEV_IDS.class7A));
  assert.equal((await inClass(EXTRA.otherClass)).length, 0, "another school's class id matches nothing");
  const unplaced = (expectOk(await call(f, f.head, "GET /v1/students", { query: { unplaced: "true" } })).body.items as { admissionNo: string }[]).map((s) => s.admissionNo);
  assert.ok(unplaced.includes("MA5001") && !unplaced.includes("MA5002"));
  assert.equal(expectOk(await call(f, f.head, "GET /v1/students", { query: { status: "withdrawn" } })).body.total, 0);
});

// ---------- viewing and editing ----------

test("another school's head cannot see, edit, move or withdraw our students; their list holds only their own", { skip }, async () => {
  const [s] = (await call(f, f.head, "GET /v1/students", { query: { q: "MA5001" } })).body.items;
  const o = f.otherHead;
  expectError(await call(f, o, "GET /v1/students/:id", { params: { id: s.id } }), 404, "not_found");
  expectError(await call(f, o, "PATCH /v1/students/:id", { params: { id: s.id }, body: { firstName: "Hijack" } }), 404, "not_found");
  expectError(await call(f, o, "POST /v1/students/:id/status", { params: { id: s.id }, body: { status: "withdrawn" } }), 404, "not_found");
  expectError(await call(f, o, "POST /v1/students/:id/placements", { params: { id: s.id }, body: { classId: EXTRA.otherClass } }), 404, "not_found");
  expectError(await call(f, o, "DELETE /v1/students/:id/placements/:placementId", { params: { id: s.id, placementId: crypto.randomUUID() } }), 404, "not_found");
  expectError(await call(f, f.head, "GET /v1/students/:id", { params: { id: "not-a-uuid" } }), 404, "not_found");
  expectError(await call(f, f.head, "GET /v1/students/:id", { params: { id: crypto.randomUUID() } }), 404, "not_found");
  assert.equal((await detail(s.id)).firstName, "Tadiwa");
  const theirs = expectOk(await call(f, o, "GET /v1/students")).body;
  assert.equal(theirs.total, 1);
  assert.equal(theirs.items[0].firstName, "Same");
});

test("edit: only what is sent changes; duplicate admission numbers and bad dates are refused", { skip }, async () => {
  const [s] = (await call(f, f.head, "GET /v1/students", { query: { q: "MA5001" } })).body.items;
  const patch = (body: Record<string, unknown>) => call(f, f.head, "PATCH /v1/students/:id", { params: { id: s.id }, body });
  const edited = expectOk(await patch({ otherNames: "Chipo", gender: "female", dateOfBirth: "2015-05-05", lastName: "  Chimbwanda-Moyo " })).body;
  assert.deepEqual([edited.firstName, edited.lastName, edited.otherNames, edited.gender, edited.dateOfBirth], ["Tadiwa", "Chimbwanda-Moyo", "Chipo", "female", "2015-05-05"]);
  assert.equal(expectOk(await patch({ gender: null, otherNames: "" })).body.gender, null);
  assert.equal((await detail(s.id)).otherNames, null, "empty clears an optional field");
  assert.equal(expectOk(await patch({ admissionNo: "ma5001" })).body.admissionNo, "MA5001", "re-saving the same number (any case) is not a duplicate of itself");
  expectError(await patch({ admissionNo: "ma5002" }), 409, "admission_no_taken", "admissionNo");
  expectError(await patch({}), 400, "invalid_request");
  expectError(await patch({ status: "withdrawn" }), 400, "invalid_request");
  expectError(await patch({ classId: classA }), 400, "invalid_request");
  expectError(await patch({ active: false }), 400, "invalid_request");
  expectError(await patch({ dateOfBirth: "2027-01-01" }), 400, "dob_in_future", "dateOfBirth");
  expectError(await patch({ dateOfBirth: "2026-10-08" }), 400, "dob_too_recent", "dateOfBirth");
  expectError(await patch({ enrolmentDate: "2010-01-01" }), 400, "enrolment_before_birth", "enrolmentDate");
  expectError(await patch({ firstName: "123" }), 400, "invalid_request", "firstName");
  assert.equal((await detail(s.id)).admissionNo, "MA5001");
});

test("the enrolment date cannot be moved after the student's first placement", { skip }, async () => {
  const [s] = (await call(f, f.head, "GET /v1/students", { query: { q: "MA5002" } })).body.items; // placed in 4A today
  expectError(await call(f, f.head, "PATCH /v1/students/:id", { params: { id: s.id }, body: { enrolmentDate: "2026-10-09" } }), 409, "enrolment_date_after_placement", "enrolmentDate");
  expectOk(await call(f, f.head, "PATCH /v1/students/:id", { params: { id: s.id }, body: { enrolmentDate: "2026-02-01" } }));
});

// ---------- placement, moves and history ----------

test("a class change adds a dated placement: the old class ends the day before, the new one starts tomorrow, history stays", { skip }, async () => {
  const s = expectOk(await register({ admissionNo: "MV-1", firstName: "Move", lastName: "Able", classId: classA }), 201).body;
  await record(s.id, classA, "2026-10-06");
  await record(s.id, classA, "2026-10-07");
  const moved = expectOk(await place(s.id, { classId: classB }), 201).body;
  assert.equal(studentDetail.safeParse(moved).success, true);
  assert.deepEqual(moved.placements.map((p: { className: string; startsOn: string; endsOn: string | null }) => [p.className, p.startsOn, p.endsOn]), [["Grade 4A", TODAY, TODAY], ["Grade 4B", TOMORROW, null]]);
  assert.deepEqual([moved.currentClass.name, moved.upcomingClass.name, moved.upcomingClass.startsOn], ["Grade 4A", "Grade 4B", TOMORROW]);
  // rosters follow the dates
  assert.ok((await rosterIds(classA, TODAY)).includes(s.id));
  assert.ok(!(await rosterIds(classB, TODAY)).includes(s.id));
  assert.ok(!(await rosterIds(classA, TOMORROW)).includes(s.id));
  assert.ok((await rosterIds(classB, TOMORROW)).includes(s.id));
  // the registers taken while the student was in 4A still belong to 4A, untouched
  assert.deepEqual(moved.attendance.map((a: { className: string; days: number }) => [a.className, a.days]), [["Grade 4A", 2]]);
  const rows = await f.t.runner.query<{ class_id: string }>(`select class_id from attendance_records where student_id = $1`, [s.id]);
  assert.ok(rows.every((r) => r.class_id === classA));
  // the list agrees, today and tomorrow
  const listed = (expectOk(await call(f, f.head, "GET /v1/students", { query: { q: "MV-1" } })).body.items as { currentClass: { name: string }; upcomingClass: { name: string } }[])[0]!;
  assert.deepEqual([listed.currentClass.name, listed.upcomingClass.name], ["Grade 4A", "Grade 4B"]);
  assert.ok((await f.t.runner.query<{ details: { fromClassId: string } }>(`select details from audit_log where entity_id = $1 and action = 'student.placed'`, [s.id])).some((r) => r.details.fromClassId === classA));
});

test("moves are never retroactive, never into the class they are already in, and refused where registers would be orphaned", { skip }, async () => {
  const s = expectOk(await register({ admissionNo: "MV-2", firstName: "Steady", lastName: "Eddie", classId: classA, enrolmentDate: "2026-01-12", classStartsOn: "2026-09-01" }), 201).body;
  expectError(await place(s.id, { classId: classA }), 409, "already_in_class", "classId");
  expectError(await place(s.id, { classId: classB, effectiveFrom: "2026-10-07" }), 400, "retroactive_move", "effectiveFrom");
  expectError(await place(s.id, { classId: classB, effectiveFrom: "2027-02-01" }), 400, "outside_academic_year", "effectiveFrom");
  expectError(await place(s.id, { classId: classB, effectiveFrom: "soon" }), 400, "invalid_request", "effectiveFrom");
  expectError(await place(s.id, { classId: crypto.randomUUID() }), 400, "class_not_found", "classId");
  expectError(await place(s.id, { classId: EXTRA.otherClass }), 400, "class_not_found", "classId");
  // a class change never takes effect today: registers saved on a phone today must still match the class they were taken for
  expectError(await place(s.id, { classId: classB, effectiveFrom: TODAY }), 400, "move_starts_today", "effectiveFrom");
  // defence in depth: if a register exists on or after the effective date (impossible through sync, which refuses future
  // dates, but possible after a timezone edit or a direct data fix) the move is refused rather than orphaning it
  await record(s.id, classA, "2026-10-12", "absent");
  expectError(await place(s.id, { classId: classB, effectiveFrom: "2026-10-12" }), 409, "attendance_after_effective_date", "effectiveFrom");
  expectError(await place(s.id, { classId: classB, effectiveFrom: TOMORROW }), 409, "attendance_after_effective_date", "effectiveFrom");
  expectOk(await place(s.id, { classId: classB, effectiveFrom: "2026-10-13" }), 201);
  assert.equal((await detail(s.id)).placements.length, 2, "only the valid move happened");
});

test("a student who has left cannot be placed; re-enrolling brings them back unplaced", { skip }, async () => {
  const s = expectOk(await register({ admissionNo: "LV-1", firstName: "Leaver", lastName: "Lee", classId: classA }), 201).body;
  const left = expectOk(await call(f, f.head, "POST /v1/students/:id/status", { params: { id: s.id }, body: { status: "withdrawn" } })).body;
  assert.equal(left.status, "withdrawn");
  assert.deepEqual([left.currentClass.name, left.placements[0].endsOn], ["Grade 4A", TODAY], "they stay on today's register and leave from tomorrow");
  assert.ok((await rosterIds(classA, TODAY)).includes(s.id));
  assert.ok(!(await rosterIds(classA, TOMORROW)).includes(s.id));
  expectError(await place(s.id, { classId: classB }), 409, "student_not_enrolled", "classId");
  expectError(await call(f, f.head, "POST /v1/students/:id/status", { params: { id: s.id }, body: { status: "withdrawn" } }), 409, "no_change", "status");
  const back = expectOk(await call(f, f.head, "POST /v1/students/:id/status", { params: { id: s.id }, body: { status: "enrolled" } })).body;
  assert.equal(back.status, "enrolled");
  const placed = expectOk(await place(s.id, { classId: classB }), 201).body;
  assert.deepEqual(placed.placements.map((p: { className: string; startsOn: string; endsOn: string | null }) => [p.className, p.startsOn, p.endsOn]), [["Grade 4A", TODAY, TODAY], ["Grade 4B", TOMORROW, null]], "re-placed from the day after the previous placement ended");
  assert.equal((await f.t.runner.query<{ active: boolean }>(`select active from students where id = $1`, [s.id]))[0]!.active, true, "the legacy active flag is never flipped, so history stays readable");
});

test("status changes: date rules and the attendance guard", { skip }, async () => {
  const s = expectOk(await register({ admissionNo: "ST-1", firstName: "Status", lastName: "Check", classId: classB, enrolmentDate: "2026-01-12", classStartsOn: "2026-09-01" }), 201).body;
  const change = (body: Record<string, unknown>) => call(f, f.head, "POST /v1/students/:id/status", { params: { id: s.id }, body });
  expectError(await change({ status: "transferred", effectiveFrom: "2026-10-01" }), 400, "retroactive_change", "effectiveFrom");
  expectError(await change({ status: "bogus" }), 400, "invalid_request", "status");
  expectError(await change({ status: "transferred", effectiveFrom: "tomorrow" }), 400, "invalid_request", "effectiveFrom");
  expectError(await change({ status: "transferred", effectiveFrom: TODAY }), 400, "change_starts_today", "effectiveFrom");
  expectError(await change({ status: "transferred", effectiveFrom: "2099-01-01" }), 400, "effective_date_too_far", "effectiveFrom");
  assert.equal((await detail(s.id)).status, "enrolled", "a refused change changed nothing");
  await record(s.id, classB, "2026-10-12"); // see the move test: the register guard is a second line of defence
  expectError(await change({ status: "transferred", effectiveFrom: "2026-10-12" }), 409, "attendance_after_effective_date", "effectiveFrom");
  const ok = expectOk(await change({ status: "transferred", effectiveFrom: "2026-10-13" })).body;
  assert.deepEqual([ok.status, ok.placements[0].endsOn], ["transferred", "2026-10-12"]);
  // sideways between leaving states is a status change only
  assert.equal(expectOk(await change({ status: "graduated" })).body.status, "graduated");
  assert.equal((await detail(s.id)).placements[0].endsOn, "2026-10-12");
});

test("a placement made by mistake can be removed, unless registers exist for it", { skip }, async () => {
  const s = expectOk(await register({ admissionNo: "RM-1", firstName: "Oops", lastName: "Wrong", classId: classA }), 201).body;
  const remove = (placementId: string) => call(f, f.head, "DELETE /v1/students/:id/placements/:placementId", { params: { id: s.id, placementId } });
  const first = s.placements[0].id;
  expectError(await remove(crypto.randomUUID()), 404, "not_found");
  expectError(await remove("nope"), 404, "not_found");
  await record(s.id, classA, TODAY);
  expectError(await remove(first), 409, "placement_has_attendance");
  await f.t.runner.query(`delete from attendance_records where student_id = $1`, [s.id]);
  const cleared = expectOk(await remove(first)).body;
  assert.deepEqual([cleared.placements, cleared.currentClass], [[], null]);
  expectOk(await place(s.id, { classId: classB }), 201);
  // only the latest placement is removable
  const m = expectOk(await register({ admissionNo: "RM-2", firstName: "Two", lastName: "Steps", classId: classA }), 201).body;
  const moved = expectOk(await place(m.id, { classId: classB }), 201).body;
  expectError(await call(f, f.head, "DELETE /v1/students/:id/placements/:placementId", { params: { id: m.id, placementId: moved.placements[0].id } }), 409, "not_latest_placement");
  const undone = expectOk(await call(f, f.head, "DELETE /v1/students/:id/placements/:placementId", { params: { id: m.id, placementId: moved.placements[1].id } })).body;
  assert.deepEqual(undone.placements.map((p: { className: string; endsOn: string | null }) => [p.className, p.endsOn]), [["Grade 4A", null]], "removing a mistaken move puts the student back where they were");
  assert.equal(undone.currentClass.name, "Grade 4A");
  assert.ok((await rosterIds(classA, TOMORROW)).includes(m.id), "still on 4A's register from tomorrow, not left on no roster");
  assert.ok(!(await rosterIds(classB, TOMORROW)).includes(m.id));
  assert.ok((await f.t.runner.query<{ details: { restoredPlacementId?: string } }>(`select details from audit_log where entity_id = $1 and action = 'student.placement_removed'`, [m.id])).some((r) => r.details.restoredPlacementId === moved.placements[0].id), "the audit trail says what was restored");
});

test("removing a mistaken move does not reopen a class that has been archived since, nor after a gap", { skip }, async () => {
  const archived = await makeClass("Grade 4Z", "4", "Z");
  const a = expectOk(await register({ admissionNo: "RM-3", firstName: "Gone", lastName: "Class", classId: archived }), 201).body;
  const moved = expectOk(await place(a.id, { classId: classB }), 201).body;
  await f.t.runner.query(`update classes set status = 'archived' where id = $1`, [archived]); // a head can only do this once nobody is left in it
  const res = expectOk(await call(f, f.head, "DELETE /v1/students/:id/placements/:placementId", { params: { id: a.id, placementId: moved.placements[1].id } })).body;
  assert.deepEqual(res.placements.map((p: { className: string; endsOn: string | null }) => [p.className, p.endsOn]), [["Grade 4Z", TODAY]], "left unplaced for the head to decide");
  assert.equal(res.currentClass.name, "Grade 4Z", "still on today's register until the old placement ends");

  // a student who left, was re-enrolled and placed again after a gap is not pushed back into the class they left
  const g = expectOk(await register({ admissionNo: "RM-4", firstName: "Gap", lastName: "Year", classId: classA, enrolmentDate: "2026-01-12", classStartsOn: "2026-02-02" }), 201).body;
  await f.t.runner.query(`update enrollments set ends_on = '2026-09-30' where student_id = $1`, [g.id]);
  const again = expectOk(await place(g.id, { classId: classB }), 201).body;
  const lastId = again.placements[1].id;
  const afterGap = expectOk(await call(f, f.head, "DELETE /v1/students/:id/placements/:placementId", { params: { id: g.id, placementId: lastId } })).body;
  assert.deepEqual(afterGap.placements.map((p: { endsOn: string | null }) => p.endsOn), ["2026-09-30"]);
});

test("a date typed wrongly cannot strand a student: leaving or moving is capped at a year ahead, and refused changes change nothing", { skip }, async () => {
  const s = expectOk(await register({ admissionNo: "TY-1", firstName: "Typo", lastName: "Case", classId: classA }), 201).body;
  const status = (body: Record<string, unknown>) => call(f, f.head, "POST /v1/students/:id/status", { params: { id: s.id }, body });
  expectError(await status({ status: "withdrawn", effectiveFrom: "2099-01-01" }), 400, "effective_date_too_far", "effectiveFrom");
  // a legacy class (created before years existed) has no year to bound a move, so the cap is what protects it
  expectError(await place(s.id, { classId: EXTRA.class5A, effectiveFrom: "2999-01-01" }), 400, "effective_date_too_far", "effectiveFrom");
  const after = await detail(s.id);
  assert.deepEqual([after.status, after.placements.length, after.placements[0].endsOn], ["enrolled", 1, null], "nothing was closed");
  // the last day inside the cap works, and the student can then be placed again from there
  const moved = expectOk(await place(s.id, { classId: EXTRA.class5A, effectiveFrom: "2027-10-09" }), 201).body;
  assert.deepEqual(moved.placements.map((p: { endsOn: string | null }) => p.endsOn), ["2027-10-08", null]);
});

test("two admins placing the same student at once cannot leave them in two classes", { skip }, async () => {
  const s = expectOk(await register({ admissionNo: "RC-1", firstName: "Race", lastName: "Condition" }), 201).body;
  const results = await Promise.all([place(s.id, { classId: classA }), place(s.id, { classId: classB })]);
  for (const r of results) assert.ok([201, 409].includes(r.status), JSON.stringify(r.body));
  const rows = await f.t.runner.query<{ class_id: string; starts_on: string; ends_on: string | null }>(
    `select class_id, to_char(starts_on,'YYYY-MM-DD') starts_on, to_char(ends_on,'YYYY-MM-DD') ends_on from enrollments where student_id = $1 order by starts_on`, [s.id]);
  assert.ok(rows.length >= 1 && rows.length <= 2);
  assert.equal(rows.filter((r) => r.ends_on === null).length, 1, "exactly one open placement");
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1]!.ends_on! < rows[i]!.starts_on, "placements never overlap");
});

test("a response that is an error never leaks details of the other school", { skip }, async () => {
  const r: Res = await call(f, f.otherHead, "GET /v1/students/:id", { params: { id: (await call(f, f.head, "GET /v1/students", { query: { q: "MA5001" } })).body.items[0].id } });
  assert.equal(JSON.stringify(r.body).includes("Tadiwa"), false);
});
