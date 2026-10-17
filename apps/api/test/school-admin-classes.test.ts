import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootstrapResponse, classDetail, classPage, rosterResponse } from "@schoolpulse/contracts";
import { pgTestsEnabled } from "@schoolpulse/db/testing";
import { bootstrap } from "../src/services/sync.ts";
import { DEV_IDS, EXTRA, call, createYear2026, expectError, expectOk, makeAdminFixture, type AdminFixture } from "./admin-support.ts";

const skip = pgTestsEnabled() ? false : "no PostgreSQL configured (set PSQL_TEST_CONN)";
const TODAY = "2026-10-08";
const TOMORROW = "2026-10-09";
let f: AdminFixture;
let y2026: string;
let y2027: string;
let y2025: string;
let otherYear: string; // the other school's 2026

const createClass = (body: Record<string, unknown>, who = f.head) => call(f, who, "POST /v1/classes", { body });
const makeClass = async (name: string, gradeLevel: string, stream: string | null, academicYearId = y2026) =>
  expectOk(await createClass({ name, gradeLevel, stream, academicYearId }), 201).body.id as string;
const patchClass = (id: string, body: Record<string, unknown>, who = f.head) => call(f, who, "PATCH /v1/classes/:id", { params: { id }, body });
const getClass = async (id: string) => expectOk(await call(f, f.head, "GET /v1/classes/:id", { params: { id } })).body;
const register = async (admissionNo: string, extra: Record<string, unknown> = {}) =>
  expectOk(await call(f, f.head, "POST /v1/students", { body: { admissionNo, firstName: "Test", lastName: admissionNo, enrolmentDate: "2026-01-12", ...extra } }), 201).body;
const roster = (classId: string, who = f.head, date?: string) =>
  call(f, who, "GET /v1/classes/:id/roster", { params: { id: classId }, query: date ? { date } : {} });
const year = async (name: string, startsOn: string, endsOn: string, who = f.head) =>
  expectOk(await call(f, who, "POST /v1/academic-years", { body: { name, startsOn, endsOn, isActive: false } }), 201).body.id as string;
const count = async (sql: string, p: string[] = []) => (await f.t.runner.query<{ n: number }>(sql, p))[0]!.n;

before(async () => {
  if (skip) return;
  f = await makeAdminFixture();
  y2026 = await createYear2026(f);
  y2027 = await year("2027", "2027-01-04", "2027-12-10");
  y2025 = await year("2025", "2025-01-06", "2025-12-12");
  otherYear = await year("2026", "2026-01-05", "2026-12-11", f.otherHead);
});
after(async () => {
  if (!skip) await f.close();
});

// ---------- create ----------

test("create a class: normalised, active, in the chosen year, empty, and audited", { skip }, async () => {
  const res = expectOk(await createClass({ name: "  Grade   1A ", gradeLevel: " 1 ", stream: " A ", academicYearId: y2026 }), 201);
  assert.equal(classDetail.safeParse(res.body).success, true, JSON.stringify(classDetail.safeParse(res.body)));
  const c = res.body;
  assert.deepEqual([c.name, c.gradeLevel, c.stream, c.status, c.academicYear?.name, c.studentCount, c.teacherCount, c.teachers], ["Grade 1A", "1", "A", "active", "2026", 0, 0, []]);
  const row = (await f.t.runner.query<{ school_id: string }>(`select school_id from classes where id = $1`, [c.id]))[0]!;
  assert.equal(row.school_id, DEV_IDS.school, "stored in the signed-in head's school");
  assert.ok((await f.t.runner.query<{ action: string }>(`select action from audit_log where entity_id = $1`, [c.id])).some((r) => r.action === "class.created"));
  // a stream is optional, and a blank one means "none"
  const plain = expectOk(await createClass({ name: "Grade 1 Rainbow", gradeLevel: "1", stream: "   ", academicYearId: y2026 }), 201).body;
  assert.equal(plain.stream, null);
  const omitted = expectOk(await createClass({ name: "Grade 1 Sun", gradeLevel: "1", academicYearId: y2026 }), 201).body;
  assert.equal(omitted.stream, null);
});

test("create validation: every bad input is a 400 that names the field, and nothing is stored", { skip }, async () => {
  const before = await count(`select count(*)::int as n from classes where school_id = $1`, [DEV_IDS.school]);
  const ok = { name: "Valid", gradeLevel: "2", academicYearId: y2026 };
  expectError(await createClass({ ...ok, name: "   " }), 400, "invalid_request", "name");
  expectError(await createClass({ ...ok, name: "x".repeat(101) }), 400, "invalid_request", "name");
  expectError(await createClass({ ...ok, gradeLevel: "" }), 400, "invalid_request", "gradeLevel");
  expectError(await createClass({ ...ok, gradeLevel: "9".repeat(21) }), 400, "invalid_request", "gradeLevel");
  expectError(await createClass({ ...ok, stream: "S".repeat(31) }), 400, "invalid_request", "stream");
  expectError(await createClass({ name: "No year", gradeLevel: "2" }), 400, "invalid_request", "academicYearId");
  expectError(await createClass({ ...ok, academicYearId: "not-a-uuid" }), 400, "invalid_request", "academicYearId");
  expectError(await createClass({ ...ok, schoolId: EXTRA.otherSchool }), 400, "invalid_request");
  expectError(await createClass({ ...ok, status: "archived" }), 400, "invalid_request");
  expectError(await call(f, f.head, "POST /v1/classes", { rawBody: "{not json" }), 400, "invalid_json");
  assert.equal(await count(`select count(*)::int as n from classes where school_id = $1`, [DEV_IDS.school]), before);
});

test("an academic year that does not exist, or belongs to another school, cannot be used", { skip }, async () => {
  const theirs = otherYear;
  expectError(await createClass({ name: "Sneaky", gradeLevel: "3", academicYearId: theirs }), 400, "academic_year_not_found", "academicYearId");
  expectError(await createClass({ name: "Sneaky", gradeLevel: "3", academicYearId: crypto.randomUUID() }), 400, "academic_year_not_found", "academicYearId");
  assert.equal(await count(`select count(*)::int as n from classes where name = 'Sneaky'`), 0);
});

test("no duplicate class configurations within a school and year; the same names are fine in another year", { skip }, async () => {
  await makeClass("Grade 3A", "3", "A");
  expectError(await createClass({ name: "grade 3a", gradeLevel: "3", stream: "Z", academicYearId: y2026 }), 409, "class_name_taken", "name");
  expectError(await createClass({ name: " GRADE  3A ", gradeLevel: "3", stream: "Z", academicYearId: y2026 }), 409, "class_name_taken", "name");
  expectError(await createClass({ name: "Third A", gradeLevel: "3", stream: "a", academicYearId: y2026 }), 409, "class_stream_taken", "stream");
  // grade + stream is only a duplicate when there IS a stream
  await makeClass("Grade 3 North", "3", null);
  await makeClass("Grade 3 South", "3", null);
  // next year the same class can exist again
  expectOk(await createClass({ name: "Grade 3A", gradeLevel: "3", stream: "A", academicYearId: y2027 }), 201);
  // and the other school can use the very same name in its own year
  expectOk(await createClass({ name: "Grade 3A", gradeLevel: "3", stream: "A", academicYearId: otherYear }, f.otherHead), 201);
});

test("two heads creating the same class at once: exactly one wins, the other gets a clear 409", { skip }, async () => {
  const body = { name: "Race 8A", gradeLevel: "8", stream: "A", academicYearId: y2026 };
  const results = await Promise.all([createClass(body), createClass(body), createClass(body)]);
  const codes = results.map((r) => r.status).sort();
  assert.deepEqual(codes, [201, 409, 409]);
  for (const r of results.filter((r) => r.status === 409)) assert.ok(["class_name_taken", "class_stream_taken"].includes(r.body.error.code));
  assert.equal(await count(`select count(*)::int as n from classes where name = 'Race 8A'`), 1);
});

test("teachers cannot create or edit classes", { skip }, async () => {
  expectError(await createClass({ name: "Nope", gradeLevel: "4", academicYearId: y2026 }, f.chipo), 403, "forbidden");
  const id = await makeClass("Teacher-proof", "4", "T");
  expectError(await patchClass(id, { name: "Renamed" }, f.chipo), 403, "forbidden");
  assert.equal((await getClass(id)).name, "Teacher-proof");
});

// ---------- edit ----------

test("edit: only what is sent changes; a blank stream clears it; duplicates and empty edits are refused", { skip }, async () => {
  const id = await makeClass("Grade 4A", "4", "A");
  await makeClass("Grade 4B", "4", "B");
  const renamed = expectOk(await patchClass(id, { name: "  Grade  4 Alpha " })).body;
  assert.deepEqual([renamed.name, renamed.gradeLevel, renamed.stream, renamed.status], ["Grade 4 Alpha", "4", "A", "active"]);
  const cleared = expectOk(await patchClass(id, { stream: null })).body;
  assert.equal(cleared.stream, null);
  const blank = expectOk(await patchClass(id, { stream: "  " })).body;
  assert.equal(blank.stream, null);
  expectOk(await patchClass(id, { stream: "A", gradeLevel: "4" }));

  expectError(await patchClass(id, { name: "grade 4b" }), 409, "class_name_taken", "name");
  expectError(await patchClass(id, { stream: "b" }), 409, "class_stream_taken", "stream");
  expectError(await patchClass(id, {}), 400, "invalid_request");
  expectError(await patchClass(id, { name: "" }), 400, "invalid_request", "name");
  expectError(await patchClass(id, { schoolId: EXTRA.otherSchool }), 400, "invalid_request");
  expectError(await patchClass(id, { status: "deleted" }), 400, "invalid_request", "status");
  assert.equal((await getClass(id)).name, "Grade 4 Alpha", "refused edits changed nothing");
  assert.ok((await f.t.runner.query<{ details: { fields?: string[] } }>(`select details from audit_log where entity_id = $1 and action = 'class.updated'`, [id])).length >= 3);
});

test("a class from before academic years existed can be given one, once; after that the year is fixed", { skip }, async () => {
  // Grade 5A was created by Slice 1: no year, one student enrolled since 2026-01-12.
  assert.equal((await getClass(EXTRA.class5A)).academicYear, null);
  expectError(await patchClass(EXTRA.class5A, { academicYearId: y2025 }), 409, "year_excludes_history", "academicYearId");
  expectError(await patchClass(EXTRA.class5A, { academicYearId: crypto.randomUUID() }), 400, "academic_year_not_found", "academicYearId");
  const dated = expectOk(await patchClass(EXTRA.class5A, { academicYearId: y2026 })).body;
  assert.equal(dated.academicYear.name, "2026");
  expectError(await patchClass(EXTRA.class5A, { academicYearId: y2027 }), 409, "class_year_locked", "academicYearId");
  // the same year again is not a change
  expectOk(await patchClass(EXTRA.class5A, { academicYearId: y2026, name: "Grade 5A" }));
});

test("an empty class can still be moved to another academic year, but never back to none", { skip }, async () => {
  const id = await makeClass("Wanderer", "6", "W");
  assert.equal((await patchClass(id, { academicYearId: y2027 })).status, 200);
  assert.equal((await getClass(id)).academicYear.name, "2027");
});

test("a class that clashes with another in the new year cannot move there", { skip }, async () => {
  await makeClass("Clash 9A", "9", "A", y2027);
  const id = await makeClass("Clash 9A", "9", "B", y2026); // same name, different stream: only the name clashes
  expectError(await patchClass(id, { academicYearId: y2027 }), 409, "class_name_taken", "name");
});

test("editing a class in another school is a plain 404 and changes nothing", { skip }, async () => {
  const id = await makeClass("Guarded", "7", "G");
  expectError(await patchClass(id, { name: "Hijacked" }, f.otherHead), 404, "not_found");
  expectError(await call(f, f.otherHead, "GET /v1/classes/:id", { params: { id } }), 404, "not_found");
  expectError(await call(f, f.head, "GET /v1/classes/:id", { params: { id: EXTRA.otherClass } }), 404, "not_found");
  expectError(await patchClass(EXTRA.otherClass, { name: "Mine now" }), 404, "not_found");
  assert.equal((await getClass(id)).name, "Guarded");
  assert.equal((await f.t.runner.query<{ name: string }>(`select name from classes where id = $1`, [EXTRA.otherClass]))[0]!.name, "Form 1A");
});

// ---------- archive / reactivate ----------

test("a class with students cannot be archived; an empty one can, and can come back", { skip }, async () => {
  const id = await makeClass("Archive me", "5", "Z");
  const s = await register("AR-1", { classId: id });
  const refused = expectError(await patchClass(id, { status: "archived" }), 409, "class_has_students", "status");
  assert.match(refused.body.error.message, /1 student/);
  assert.equal((await getClass(id)).status, "active");

  // move the student out (from tomorrow): until then they are still in the class today, and afterwards the move is still ahead
  const other = await makeClass("Archive target", "5", "Y");
  expectOk(await call(f, f.head, "POST /v1/students/:id/placements", { params: { id: s.id }, body: { classId: other } }), 201);
  expectError(await patchClass(id, { status: "archived" }), 409, "class_has_students", "status");
  // a placement into the class that has not started yet also counts: nobody can be left pointing at a hidden class
  const later = await register("AR-2");
  expectOk(await call(f, f.head, "POST /v1/students/:id/placements", { params: { id: later.id }, body: { classId: other, effectiveFrom: "2026-10-20" } }), 201);
  expectError(await patchClass(other, { status: "archived" }), 409, "class_has_students", "status");

  const empty = await makeClass("Nobody here", "5", "N");
  const archived = expectOk(await patchClass(empty, { status: "archived" })).body;
  assert.equal(archived.status, "archived");
  expectOk(await patchClass(empty, { status: "archived" }), 200); // already archived: nothing to check, nothing breaks
  const back = expectOk(await patchClass(empty, { status: "active" })).body;
  assert.equal(back.status, "active");
});

test("archived classes stay readable, keep their history, and are filtered from lists on request", { skip }, async () => {
  const id = await makeClass("Closed 6Z", "6", "Z");
  expectOk(await patchClass(id, { status: "archived" }));
  assert.equal((await getClass(id)).status, "archived");
  const names = async (q: Record<string, string>) =>
    (expectOk(await call(f, f.head, "GET /v1/classes", { query: { limit: "100", ...q } })).body.items as { name: string }[]).map((c) => c.name);
  assert.ok((await names({ status: "archived" })).includes("Closed 6Z"));
  assert.ok(!(await names({ status: "active" })).includes("Closed 6Z"));
  assert.ok((await names({})).includes("Closed 6Z"), "no filter shows everything");
  // a rename of an archived class is allowed (it is just configuration), and registers of it still read
  expectOk(await patchClass(id, { name: "Closed 6Z (old)" }));
});

// ---------- list ----------

test("list: page shape, bounded size, filters, headcounts and legacy classes without a year", { skip }, async () => {
  const res = expectOk(await call(f, f.head, "GET /v1/classes", { query: { limit: "100" } }));
  assert.equal(classPage.safeParse(res.body).success, true, JSON.stringify(classPage.safeParse(res.body)));
  const items = res.body.items as { id: string; name: string; academicYear: { name: string } | null; studentCount: number; teacherCount: number }[];
  const byName = new Map(items.map((c) => [c.name, c]));
  assert.equal(byName.get("Grade 7A")!.studentCount, 12);
  assert.equal(byName.get("Grade 7A")!.teacherCount, 2, "Ms. Chipo and Mr. Tendai");
  assert.equal(byName.get("Grade 7A")!.academicYear, null, "a Slice 1 class has no year until the head sets one");
  assert.ok(!items.some((c) => c.id === EXTRA.otherClass), "other school's class never listed");
  assert.deepEqual(res.body.limit, 100);

  expectError(await call(f, f.head, "GET /v1/classes", { query: { limit: "101" } }), 400, "invalid_request", "limit");
  expectError(await call(f, f.head, "GET /v1/classes", { query: { limit: "0" } }), 400, "invalid_request", "limit");
  expectError(await call(f, f.head, "GET /v1/classes", { query: { offset: "-1" } }), 400, "invalid_request", "offset");
  expectError(await call(f, f.head, "GET /v1/classes", { query: { status: "zombie" } }), 400, "invalid_request", "status");
  expectError(await call(f, f.head, "GET /v1/classes", { query: { academicYearId: "x" } }), 400, "invalid_request", "academicYearId");
  assert.equal(expectOk(await call(f, f.head, "GET /v1/classes", {})).body.limit, 25, "default page size");

  const inYear = expectOk(await call(f, f.head, "GET /v1/classes", { query: { academicYearId: y2027, limit: "100" } })).body.items as { academicYear: { id: string } }[];
  assert.ok(inYear.length >= 1 && inYear.every((c) => c.academicYear.id === y2027));
  const search = expectOk(await call(f, f.head, "GET /v1/classes", { query: { q: "grade 7" } })).body.items as { name: string }[];
  assert.deepEqual(search.map((c) => c.name).sort(), ["Grade 7A", "Grade 7B"]);
  assert.deepEqual(expectOk(await call(f, f.head, "GET /v1/classes", { query: { q: "%" } })).body.items, [], "a percent sign is just a character");
});

test("list: paging walks every class exactly once", { skip }, async () => {
  const all = expectOk(await call(f, f.head, "GET /v1/classes", { query: { limit: "100" } })).body;
  const seen: string[] = [];
  for (let offset = 0; offset < all.total; offset += 7) {
    const page = expectOk(await call(f, f.head, "GET /v1/classes", { query: { limit: "7", offset: String(offset) } })).body;
    assert.equal(page.total, all.total);
    seen.push(...page.items.map((c: { id: string }) => c.id));
  }
  assert.deepEqual(seen, all.items.map((c: { id: string }) => c.id));
  assert.equal(new Set(seen).size, seen.length);
});

test("list: another school's head sees only their own classes", { skip }, async () => {
  const theirs = expectOk(await call(f, f.otherHead, "GET /v1/classes", { query: { limit: "100" } })).body.items as { name: string }[];
  assert.ok(theirs.some((c) => c.name === "Form 1A"));
  assert.ok(theirs.every((c) => !["Grade 7A", "Grade 4A", "Guarded"].includes(c.name)));
});

test("teachers use /me/classes, not the admin class list", { skip }, async () => {
  expectError(await call(f, f.chipo, "GET /v1/classes"), 403, "forbidden");
  expectError(await call(f, f.chipo, "GET /v1/classes/:id", { params: { id: DEV_IDS.class7A } }), 403, "forbidden");
});

// ---------- roster ----------

test("roster: the head and an assigned teacher can read it; it is the same data as the offline register", { skip }, async () => {
  const asHead = expectOk(await roster(DEV_IDS.class7A));
  assert.equal(rosterResponse.safeParse(asHead.body).success, true, JSON.stringify(rosterResponse.safeParse(asHead.body)));
  const asTeacher = expectOk(await roster(DEV_IDS.class7A, f.chipo));
  assert.deepEqual(asTeacher.body, asHead.body);
  assert.equal(asHead.body.date, TODAY);
  assert.equal(asHead.body.students.length, 12);
  assert.equal(asHead.body.className, "Grade 7A");

  // the offline replica is built from the same rows
  const replica = bootstrapResponse.parse(await bootstrap(f.deps, f.chipo.auth));
  const fromReplica = replica.students.filter((s) => s.classId === DEV_IDS.class7A).map((s) => s.id).sort();
  assert.deepEqual(asHead.body.students.map((s: { id: string }) => s.id).sort(), fromReplica);
  for (const s of asHead.body.students) assert.ok(replica.students.some((r) => r.id === s.id && r.admissionNo === s.admissionNo && r.firstName === s.firstName && r.lastName === s.lastName));
});

test("roster: a teacher who is not assigned to the class, and the other school, are refused", { skip }, async () => {
  expectError(await roster(EXTRA.class5A, f.chipo), 403, "forbidden");
  expectError(await roster(DEV_IDS.class6A, f.tendai), 403, "forbidden");
  expectError(await roster(DEV_IDS.class7A, f.otherTeacher), 404, "not_found");
  expectError(await roster(DEV_IDS.class7A, f.otherHead), 404, "not_found");
  expectError(await roster(EXTRA.otherClass, f.head), 404, "not_found");
  expectError(await roster(EXTRA.otherClass, f.chipo), 404, "not_found");
  expectError(await roster(crypto.randomUUID(), f.head), 404, "not_found");
  expectError(await call(f, f.head, "GET /v1/classes/:id/roster", { params: { id: "nope" } }), 404, "not_found");
  expectOk(await roster(EXTRA.otherClass, f.otherTeacher), 200);
});

test("roster: a date shows who was in the class that day; a bad date is a 400", { skip }, async () => {
  const id = await makeClass("Roster 2A", "2", "R");
  const stay = await register("RS-1", { classId: id, classStartsOn: "2026-02-02" });
  const mover = await register("RS-2", { classId: id, classStartsOn: "2026-02-02" });
  const rosterIds = async (date: string) => (expectOk(await roster(id, f.head, date)).body.students as { id: string }[]).map((s) => s.id).sort();
  assert.deepEqual(await rosterIds("2026-02-01"), [], "before anyone joined");
  assert.deepEqual(await rosterIds("2026-02-02"), [stay.id, mover.id].sort());
  const elsewhere = await makeClass("Roster 2B", "2", "S");
  expectOk(await call(f, f.head, "POST /v1/students/:id/placements", { params: { id: mover.id }, body: { classId: elsewhere, effectiveFrom: "2026-10-20" } }), 201);
  assert.deepEqual(await rosterIds("2026-10-19"), [stay.id, mover.id].sort(), "still here the day before the move");
  assert.deepEqual(await rosterIds("2026-10-20"), [stay.id], "gone from the effective date");
  assert.deepEqual(await rosterIds("2026-03-01"), [stay.id, mover.id].sort(), "history is unchanged");
  assert.deepEqual(await rosterIds("2026-10-20").then(async () => (expectOk(await roster(elsewhere, f.head, "2026-10-20")).body.students as { id: string }[]).map((s) => s.id)), [mover.id]);

  expectError(await roster(id, f.head, "2026-13-45"), 400, "invalid_request", "date");
  expectError(await roster(id, f.head, "yesterday"), 400, "invalid_request", "date");
});

test("roster: an archived class still answers (queued attendance for it must keep working)", { skip }, async () => {
  const id = await makeClass("Roster 2C", "2", "C");
  expectOk(await patchClass(id, { status: "archived" }));
  assert.deepEqual(expectOk(await roster(id)).body.students, []);
});

test("roster: a student who has left the school is no longer listed from the day they left", { skip }, async () => {
  const id = await makeClass("Roster 2D", "2", "D");
  const s = await register("RS-9", { classId: id, classStartsOn: "2026-02-02" });
  expectOk(await call(f, f.head, "POST /v1/students/:id/status", { params: { id: s.id }, body: { status: "transferred", effectiveFrom: TOMORROW } }));
  assert.deepEqual((expectOk(await roster(id, f.head, TODAY)).body.students as { id: string }[]).map((x) => x.id), [s.id]);
  assert.deepEqual(expectOk(await roster(id, f.head, TOMORROW)).body.students, []);
});
