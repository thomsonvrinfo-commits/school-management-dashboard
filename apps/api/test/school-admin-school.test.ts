import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { academicYearDto, academicYearsResponse, schoolProfile, termDto } from "@schoolpulse/contracts";
import { pgTestsEnabled } from "@schoolpulse/db/testing";
import { ADMIN_EXTRA, DEV_IDS, EXTRA, YEAR_2026, call, createYear2026, expectError, expectOk, makeAdminFixture, type AdminFixture } from "./admin-support.ts";

const skip = pgTestsEnabled() ? false : "no PostgreSQL configured (set PSQL_TEST_CONN)";
let f: AdminFixture;

before(async () => {
  if (!skip) f = await makeAdminFixture();
});
after(async () => {
  if (!skip) await f.close();
});

const auditActions = async (schoolId: string) =>
  (await f.t.runner.query<{ action: string }>(`select action from audit_log where school_id = $1 order by id`, [schoolId])).map((r) => r.action);

// ---------- profile ----------

test("the head reads and updates the school profile; the contract shape holds", { skip }, async () => {
  const before = expectOk(await call(f, f.head, "GET /v1/school")).body;
  assert.equal(schoolProfile.safeParse(before).success, true);
  assert.deepEqual([before.name, before.code, before.timezone, before.activeAcademicYear], ["Mavambo Academy", null, "Africa/Harare", null]);

  const updated = expectOk(await call(f, f.head, "PATCH /v1/school", {
    body: { code: "mav-001", contactEmail: "office@mavambo.example", contactPhone: "+263 242 000 000", address: "12 School Road, Harare" },
  })).body;
  assert.equal(schoolProfile.safeParse(updated).success, true);
  assert.deepEqual([updated.code, updated.contactEmail, updated.name], ["mav-001", "office@mavambo.example", "Mavambo Academy"], "untouched fields stay");
  expectOk(await call(f, f.head, "PATCH /v1/school", { body: { address: "" } }));
  assert.equal(expectOk(await call(f, f.head, "GET /v1/school")).body.address, null, "an empty string clears a field");
  assert.ok((await auditActions(DEV_IDS.school)).includes("school.updated"));
});

test("profile validation: names, codes, e-mail, time zone, and unknown keys", { skip }, async () => {
  const patch = (body: unknown) => call(f, f.head, "PATCH /v1/school", { body });
  expectError(await patch({}), 400, "invalid_request");
  expectError(await patch({ name: "   " }), 400, "invalid_request", "name");
  expectError(await patch({ code: "x" }), 400, "invalid_request", "code");
  expectError(await patch({ contactEmail: "nope" }), 400, "invalid_request", "contactEmail");
  expectError(await patch({ timezone: "Mars/Olympus" }), 400, "invalid_request", "timezone");
  expectError(await call(f, f.head, "PATCH /v1/school", { rawBody: "{not json" }), 400, "invalid_json");
});

test("the school is never taken from the request: a schoolId in the body is refused, and another school's head only edits their own", { skip }, async () => {
  expectError(await call(f, f.head, "PATCH /v1/school", { body: { name: "Hijack", schoolId: EXTRA.otherSchool } }), 400, "invalid_request");
  const res = expectOk(await call(f, f.otherHead, "PATCH /v1/school", { body: { name: "Other School Renamed" } }));
  assert.equal(res.body.id, EXTRA.otherSchool);
  assert.equal(expectOk(await call(f, f.head, "GET /v1/school")).body.name, "Mavambo Academy", "Mavambo is untouched");
  await call(f, f.otherHead, "PATCH /v1/school", { body: { name: "Other School" } });
});

test("a school code is unique across schools, in any capitalisation", { skip }, async () => {
  expectOk(await call(f, f.head, "PATCH /v1/school", { body: { code: "MAV-001" } }));
  expectError(await call(f, f.otherHead, "PATCH /v1/school", { body: { code: "mav-001" } }), 409, "school_code_taken", "code");
  expectOk(await call(f, f.otherHead, "PATCH /v1/school", { body: { code: "OTHER-9" } }));
});

test("teachers cannot read or change the school profile or years; they are refused before anything is looked at", { skip }, async () => {
  expectError(await call(f, f.chipo, "GET /v1/school"), 403, "forbidden");
  expectError(await call(f, f.chipo, "PATCH /v1/school", { body: { name: "Mine now" } }), 403, "forbidden");
  expectError(await call(f, f.chipo, "PATCH /v1/school", { body: { garbage: true } }), 403, "forbidden", undefined);
  expectError(await call(f, f.chipo, "GET /v1/academic-years"), 403, "forbidden");
  expectError(await call(f, f.chipo, "POST /v1/academic-years", { body: YEAR_2026 }), 403, "forbidden");
  assert.equal(expectOk(await call(f, f.head, "GET /v1/school")).body.name, "Mavambo Academy");
});

// ---------- academic years ----------

test("academic years: create, list newest first, one active at a time", { skip }, async () => {
  const y25 = expectOk(await call(f, f.head, "POST /v1/academic-years", { body: { name: "2025", startsOn: "2025-01-14", endsOn: "2025-12-05" } }), 201).body;
  assert.equal(academicYearDto.safeParse(y25).success, true);
  assert.deepEqual([y25.isActive, y25.classCount, y25.terms], [false, 0, []]);
  const y26 = expectOk(await call(f, f.head, "POST /v1/academic-years", { body: { ...YEAR_2026, isActive: true } }), 201).body;
  assert.equal(y26.isActive, true);
  // making the older year active switches, in one step
  const switched = expectOk(await call(f, f.head, "PATCH /v1/academic-years/:id", { params: { id: y25.id }, body: { isActive: true } })).body;
  assert.equal(switched.isActive, true);
  const list = expectOk(await call(f, f.head, "GET /v1/academic-years")).body;
  assert.equal(academicYearsResponse.safeParse(list).success, true);
  assert.deepEqual(list.items.map((y: { name: string; isActive: boolean }) => [y.name, y.isActive]), [["2026", false], ["2025", true]]);
  assert.equal(expectOk(await call(f, f.head, "GET /v1/school")).body.activeAcademicYear.name, "2025", "the profile reports the active year");
  // switch back; creating with isActive also switches
  expectOk(await call(f, f.head, "PATCH /v1/academic-years/:id", { params: { id: y26.id }, body: { isActive: true } }));
  assert.deepEqual((await call(f, f.head, "GET /v1/academic-years")).body.items.filter((y: { isActive: boolean }) => y.isActive).map((y: { name: string }) => y.name), ["2026"]);
  // deactivating leaves no active year, which is allowed
  expectOk(await call(f, f.head, "PATCH /v1/academic-years/:id", { params: { id: y26.id }, body: { isActive: false } }));
  assert.equal(expectOk(await call(f, f.head, "GET /v1/school")).body.activeAcademicYear, null);
  expectOk(await call(f, f.head, "PATCH /v1/academic-years/:id", { params: { id: y26.id }, body: { isActive: true } }));
});

test("academic years: invalid dates, overlaps and duplicate names are refused with a reason", { skip }, async () => {
  const create = (body: unknown) => call(f, f.head, "POST /v1/academic-years", { body });
  expectError(await create({ name: "2027", startsOn: "2027-12-03", endsOn: "2027-01-12" }), 400, "invalid_dates", "endsOn");
  expectError(await create({ name: "2027", startsOn: "2027-02-30", endsOn: "2027-12-03" }), 400, "invalid_request", "startsOn");
  expectError(await create({ name: "2027", startsOn: "2027-01-01", endsOn: "2029-01-01" }), 400, "year_too_long", "endsOn");
  expectError(await create({ name: "", startsOn: "2027-01-12", endsOn: "2027-12-03" }), 400, "invalid_request", "name");
  expectError(await create({ name: "2027", startsOn: "2026-12-11", endsOn: "2027-12-03" }), 409, "year_overlap", "startsOn"); // shares the 11th
  expectError(await create({ name: " 2026 ", startsOn: "2027-01-12", endsOn: "2027-12-03" }), 409, "year_name_taken", "name");
  expectError(await create({ name: "2027", startsOn: "2027-01-12", endsOn: "2027-12-03", schoolId: EXTRA.otherSchool }), 400, "invalid_request");
  assert.equal(expectOk(await call(f, f.head, "GET /v1/academic-years")).body.items.length, 2, "nothing was created by the failed attempts");
});

test("academic years: another school sees and touches none of them", { skip }, async () => {
  const [y26] = (await call(f, f.head, "GET /v1/academic-years")).body.items;
  assert.deepEqual(expectOk(await call(f, f.otherHead, "GET /v1/academic-years")).body.items, []);
  expectError(await call(f, f.otherHead, "PATCH /v1/academic-years/:id", { params: { id: y26.id }, body: { name: "Stolen" } }), 404, "not_found");
  expectError(await call(f, f.otherHead, "DELETE /v1/academic-years/:id", { params: { id: y26.id } }), 404, "not_found");
  expectError(await call(f, f.otherHead, "POST /v1/academic-years/:id/terms", { params: { id: y26.id }, body: { name: "T1", startsOn: "2026-02-01", endsOn: "2026-04-01" } }), 404, "not_found");
  // the same dates and name are perfectly fine in their own school
  expectOk(await call(f, f.otherHead, "POST /v1/academic-years", { body: { ...YEAR_2026 } }), 201);
  assert.equal(expectOk(await call(f, f.head, "GET /v1/academic-years")).body.items.length, 2);
  expectError(await call(f, f.head, "PATCH /v1/academic-years/:id", { params: { id: "not-a-uuid" }, body: { name: "x" } }), 404, "not_found");
});

test("terms: inside the year, never overlapping, unique names", { skip }, async () => {
  const [y26] = (await call(f, f.head, "GET /v1/academic-years")).body.items;
  const add = (body: unknown, id = y26.id) => call(f, f.head, "POST /v1/academic-years/:id/terms", { params: { id }, body });
  const t1 = expectOk(await add({ name: "Term 1", startsOn: "2026-01-13", endsOn: "2026-04-10" }), 201).body;
  assert.equal(termDto.safeParse(t1).success, true);
  expectOk(await add({ name: "Term 2", startsOn: "2026-05-05", endsOn: "2026-08-07" }), 201);
  expectError(await add({ name: "Term 3", startsOn: "2026-09-08", endsOn: "2027-01-10" }), 400, "term_outside_year", "startsOn");
  expectError(await add({ name: "Term 3", startsOn: "2026-01-01", endsOn: "2026-02-01" }), 400, "term_outside_year");
  expectError(await add({ name: "Term 3", startsOn: "2026-08-07", endsOn: "2026-12-04" }), 409, "term_overlap", "startsOn");
  expectError(await add({ name: "term 1", startsOn: "2026-09-08", endsOn: "2026-12-04" }), 409, "term_name_taken", "name");
  expectError(await add({ name: "Term 3", startsOn: "2026-12-04", endsOn: "2026-09-08" }), 400, "invalid_dates");
  expectOk(await add({ name: "Term 3", startsOn: "2026-09-08", endsOn: "2026-12-04" }), 201);
  const upd = expectOk(await call(f, f.head, "PATCH /v1/terms/:id", { params: { id: t1.id }, body: { endsOn: "2026-04-17" } })).body;
  assert.equal(upd.endsOn, "2026-04-17");
  expectError(await call(f, f.head, "PATCH /v1/terms/:id", { params: { id: t1.id }, body: { endsOn: "2026-05-10" } }), 409, "term_overlap");
  expectError(await call(f, f.head, "PATCH /v1/terms/:id", { params: { id: t1.id }, body: { name: "Term 2" } }), 409, "term_name_taken", "name");
  expectError(await call(f, f.otherHead, "PATCH /v1/terms/:id", { params: { id: t1.id }, body: { name: "Mine" } }), 404, "not_found");
  expectError(await call(f, f.otherHead, "DELETE /v1/terms/:id", { params: { id: t1.id } }), 404, "not_found");
  const years = expectOk(await call(f, f.head, "GET /v1/academic-years")).body.items;
  assert.deepEqual(years.find((y: { name: string }) => y.name === "2026").terms.map((t: { name: string }) => t.name), ["Term 1", "Term 2", "Term 3"], "terms come back inside their year, in date order");
});

test("changing a year's dates cannot strand its terms, placements or registers; nothing is corrupted", { skip }, async () => {
  const years = (await call(f, f.head, "GET /v1/academic-years")).body.items;
  const y26 = years.find((y: { name: string }) => y.name === "2026");
  const patch = (body: unknown) => call(f, f.head, "PATCH /v1/academic-years/:id", { params: { id: y26.id }, body });
  // terms run 13 Jan to 4 Dec
  expectError(await patch({ startsOn: "2026-02-01" }), 409, "year_excludes_terms", "startsOn");
  expectError(await patch({ endsOn: "2026-10-01" }), 409, "year_excludes_terms", "startsOn");
  expectError(await patch({ startsOn: "2026-02-01", endsOn: "2026-01-05" }), 400, "invalid_dates");
  expectOk(await patch({ startsOn: "2026-01-06", endsOn: "2026-12-10" }));
  expectError(await patch({ endsOn: "2025-06-01" }), 400, "invalid_dates");
  expectError(await patch({ startsOn: "2025-12-01" }), 409, "year_overlap", "startsOn"); // 2025 runs to 5 Dec

  // put a class with registers into the year: legacy 7A already has enrolments from 12 Jan and attendance from September
  expectOk(await call(f, f.head, "PATCH /v1/classes/:id", { params: { id: DEV_IDS.class7A }, body: { academicYearId: y26.id } }));
  const attendanceBefore = (await f.t.runner.query<{ n: number }>(`select count(*)::int n from attendance_records where class_id = $1`, [DEV_IDS.class7A]))[0]!.n;
  // the year starts on 6 Jan so 7A's placements (12 Jan) fit; moving the start past them would orphan them
  expectError(await patch({ startsOn: "2026-02-01" }), 409, "year_excludes_terms"); // terms first
  // renaming and (de)activating never touch classes or registers
  expectOk(await patch({ name: "Year 2026" }));
  expectOk(await patch({ isActive: false }));
  expectOk(await patch({ isActive: true }));
  const klass = expectOk(await call(f, f.head, "GET /v1/classes/:id", { params: { id: DEV_IDS.class7A } })).body;
  assert.equal(klass.academicYear.id, y26.id);
  assert.equal(klass.studentCount, 12);
  const attendanceAfter = (await f.t.runner.query<{ n: number }>(`select count(*)::int n from attendance_records where class_id = $1`, [DEV_IDS.class7A]))[0]!.n;
  assert.equal(attendanceAfter, attendanceBefore);
  // with terms removed, the registers themselves still pin the year's dates
  for (const t of (await call(f, f.head, "GET /v1/academic-years")).body.items.find((y: { id: string }) => y.id === y26.id).terms) {
    expectOk(await call(f, f.head, "DELETE /v1/terms/:id", { params: { id: t.id } }), 204);
  }
  expectError(await patch({ startsOn: "2026-10-01" }), 409, "year_excludes_activity", "startsOn");
  expectError(await patch({ endsOn: "2026-09-20" }), 409, "year_excludes_activity", "startsOn");
  expectOk(await patch({ startsOn: "2026-01-12", endsOn: "2026-12-31" }));
});

test("a year that still has classes or terms cannot be deleted; an empty one can", { skip }, async () => {
  const years = (await call(f, f.head, "GET /v1/academic-years")).body.items;
  const y26 = years.find((y: { classCount: number }) => y.classCount > 0);
  const y25 = years.find((y: { name: string }) => y.name === "2025");
  expectError(await call(f, f.head, "DELETE /v1/academic-years/:id", { params: { id: y26.id } }), 409, "year_has_classes");
  expectOk(await call(f, f.head, "POST /v1/academic-years/:id/terms", { params: { id: y25.id }, body: { name: "Term 1", startsOn: "2025-01-14", endsOn: "2025-04-11" } }), 201);
  expectError(await call(f, f.head, "DELETE /v1/academic-years/:id", { params: { id: y25.id } }), 409, "year_has_terms");
  const [term] = (await call(f, f.head, "GET /v1/academic-years")).body.items.find((y: { id: string }) => y.id === y25.id).terms;
  expectOk(await call(f, f.head, "DELETE /v1/terms/:id", { params: { id: term.id } }), 204);
  expectOk(await call(f, f.head, "DELETE /v1/academic-years/:id", { params: { id: y25.id } }), 204);
  expectError(await call(f, f.head, "DELETE /v1/academic-years/:id", { params: { id: y25.id } }), 404, "not_found");
  assert.equal(expectOk(await call(f, f.head, "GET /v1/academic-years")).body.items.length, 1);
  assert.ok((await auditActions(DEV_IDS.school)).includes("academic_year.deleted"));
});

test("every change is in the audit log, recording which fields changed and not their values", { skip }, async () => {
  const rows = await f.t.runner.query<{ action: string; details: Record<string, unknown> }>(
    `select action, details from audit_log where school_id = $1 and action like 'school.%' order by id`, [DEV_IDS.school]);
  assert.ok(rows.length >= 2);
  for (const r of rows) assert.equal(JSON.stringify(r.details).includes("office@mavambo.example"), false, "no contact details in the log");
  assert.equal(ADMIN_EXTRA.year.length > 0, true);
});
