import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apiError, assignTeacherRequest, changeStudentStatusRequest, classListQuery, createAcademicYearRequest, createClassRequest, createStudentRequest,
  createTermRequest, placeStudentRequest, rosterQuery, studentDetail, studentListItem, studentListQuery, updateAcademicYearRequest, updateClassRequest,
  updateSchoolRequest, updateStudentRequest, uuid, isoDate,
} from "../src/index.ts";

const U = "3f2b8c1e-9d4a-4e6b-8a7c-1d2e3f4a5b6c";
const ok = (schema: { safeParse(v: unknown): { success: boolean } }, v: unknown) => schema.safeParse(v).success;

test("Slice 1 exports are unchanged: uuid and isoDate still come from the package root", () => {
  assert.equal(uuid.safeParse(U).success, true);
  assert.equal(isoDate.safeParse("2026-02-30").success, false);
});

test("apiError accepts the Slice 1 shape and the new optional field", () => {
  assert.equal(ok(apiError, { error: { code: "x", message: "y" } }), true);
  assert.equal(ok(apiError, { error: { code: "x", message: "y", field: "admissionNo" } }), true);
});

test("school profile updates: partial, validated, and never accept a schoolId", () => {
  assert.equal(ok(updateSchoolRequest, { name: "Mavambo Academy" }), true);
  assert.equal(ok(updateSchoolRequest, {}), false, "an empty update is refused");
  assert.equal(ok(updateSchoolRequest, { name: "   " }), false);
  assert.equal(ok(updateSchoolRequest, { timezone: "Mars/Olympus" }), false);
  assert.equal(ok(updateSchoolRequest, { timezone: "Africa/Harare" }), true);
  assert.equal(ok(updateSchoolRequest, { contactEmail: "not-an-email" }), false);
  assert.equal(ok(updateSchoolRequest, { code: "x" }), false, "codes are 2-32 characters");
  assert.equal(ok(updateSchoolRequest, { code: "MAV-001" }), true);
  assert.equal(ok(updateSchoolRequest, { schoolId: U, name: "Hijack" }), false, "unknown keys are rejected, not ignored");
  const cleared = updateSchoolRequest.parse({ code: "", address: "", contactEmail: "", contactPhone: null });
  assert.deepEqual(cleared, { code: null, address: null, contactEmail: null, contactPhone: null });
});

test("academic years and terms: real dates, trimmed names, strict bodies", () => {
  assert.equal(ok(createAcademicYearRequest, { name: "2026", startsOn: "2026-01-13", endsOn: "2026-12-04" }), true);
  assert.equal(ok(createAcademicYearRequest, { name: "2026", startsOn: "2026-13-01", endsOn: "2026-12-04" }), false);
  assert.equal(ok(createAcademicYearRequest, { name: "", startsOn: "2026-01-13", endsOn: "2026-12-04" }), false);
  assert.equal(ok(createAcademicYearRequest, { name: "2026", startsOn: "2026-01-13", endsOn: "2026-12-04", schoolId: U }), false);
  assert.equal(ok(updateAcademicYearRequest, { isActive: true }), true);
  assert.equal(ok(updateAcademicYearRequest, {}), false);
  assert.equal(ok(createTermRequest, { name: "Term 1", startsOn: "2026-01-13", endsOn: "2026-04-10" }), true);
  assert.equal(ok(createTermRequest, { name: "Term 1", startsOn: "2026-01-13" }), false);
});

test("registering a student: required fields, normalisable admission number, optional placement", () => {
  const base = { admissionNo: "MA2001", firstName: "Nyasha", lastName: "Moyo" };
  assert.equal(ok(createStudentRequest, base), true);
  assert.equal(ok(createStudentRequest, { ...base, dateOfBirth: "2014-03-02", gender: "female", classId: U, classStartsOn: "2026-10-08", otherNames: "Rudo" }), true);
  assert.equal(ok(createStudentRequest, { ...base, admissionNo: "MA 2001" }), false, "no spaces inside an admission number");
  assert.equal(ok(createStudentRequest, { ...base, admissionNo: "" }), false);
  assert.equal(ok(createStudentRequest, { ...base, firstName: "1234" }), false, "a name needs a letter");
  assert.equal(ok(createStudentRequest, { ...base, gender: "unknown" }), false);
  assert.equal(ok(createStudentRequest, { ...base, dateOfBirth: "2014-02-30" }), false);
  assert.equal(ok(createStudentRequest, { ...base, classId: "not-a-uuid" }), false);
  assert.equal(ok(createStudentRequest, { ...base, schoolId: U }), false);
  assert.equal(ok(createStudentRequest, { ...base, active: false }), false, "the legacy active flag is not writable");
  assert.equal(createStudentRequest.parse({ ...base, firstName: "  Nyasha  " }).firstName, "Nyasha");
  assert.equal(createStudentRequest.parse({ ...base, otherNames: "" }).otherNames, null);
});

test("student updates cannot change class or status through the profile endpoint", () => {
  assert.equal(ok(updateStudentRequest, { firstName: "Tadiwa" }), true);
  assert.equal(ok(updateStudentRequest, {}), false);
  assert.equal(ok(updateStudentRequest, { classId: U }), false);
  assert.equal(ok(updateStudentRequest, { status: "withdrawn" }), false);
  assert.equal(ok(updateStudentRequest, { dateOfBirth: null, gender: null }), true, "optional fields can be cleared");
});

test("status and placement changes name what they change and when", () => {
  assert.equal(ok(changeStudentStatusRequest, { status: "withdrawn" }), true);
  assert.equal(ok(changeStudentStatusRequest, { status: "withdrawn", effectiveFrom: "2026-10-09" }), true);
  assert.equal(ok(changeStudentStatusRequest, { status: "expelled" }), false);
  assert.equal(ok(changeStudentStatusRequest, { status: "withdrawn", effectiveFrom: "tomorrow" }), false);
  assert.equal(ok(placeStudentRequest, { classId: U }), true);
  assert.equal(ok(placeStudentRequest, { classId: U, effectiveFrom: "2026-10-09" }), true);
  assert.equal(ok(placeStudentRequest, {}), false);
});

test("list queries: bounded page size, defaults, string flags from the URL", () => {
  assert.deepEqual(studentListQuery.parse({}), { limit: 25, offset: 0 });
  assert.equal(studentListQuery.parse({ limit: "50", offset: "100" }).limit, 50);
  assert.equal(ok(studentListQuery, { limit: "101" }), false, "page size is capped at 100");
  assert.equal(ok(studentListQuery, { limit: "0" }), false);
  assert.equal(ok(studentListQuery, { offset: "-1" }), false);
  assert.equal(studentListQuery.parse({ unplaced: "true" }).unplaced, true);
  assert.equal(ok(studentListQuery, { unplaced: "yes" }), false);
  assert.equal(ok(studentListQuery, { status: "expelled" }), false);
  assert.equal(ok(studentListQuery, { classId: "nope" }), false);
  assert.equal(studentListQuery.parse({ q: "  moyo " }).q, "moyo");
  assert.equal(ok(classListQuery, { academicYearId: U, status: "archived" }), true);
  assert.equal(ok(classListQuery, { status: "deleted" }), false);
});

test("classes: a new class needs a year; edits are partial and strict", () => {
  assert.equal(ok(createClassRequest, { name: "Grade 7A", gradeLevel: "7", stream: "A", academicYearId: U }), true);
  assert.equal(ok(createClassRequest, { name: "Grade 7A", gradeLevel: "7", academicYearId: U }), true, "stream is optional");
  assert.equal(ok(createClassRequest, { name: "Grade 7A", gradeLevel: "7" }), false, "year is required");
  assert.equal(ok(createClassRequest, { name: "", gradeLevel: "7", academicYearId: U }), false);
  assert.equal(ok(createClassRequest, { name: "Grade 7A", gradeLevel: "7", academicYearId: U, schoolId: U }), false);
  assert.equal(ok(updateClassRequest, { status: "archived" }), true);
  assert.equal(ok(updateClassRequest, { status: "deleted" }), false);
  assert.equal(ok(updateClassRequest, { stream: null }), true);
  assert.equal(ok(updateClassRequest, {}), false);
});

test("roster query and teacher assignment", () => {
  assert.equal(ok(rosterQuery, {}), true);
  assert.equal(ok(rosterQuery, { date: "2026-10-08" }), true);
  assert.equal(ok(rosterQuery, { date: "2026-10-80" }), false);
  assert.equal(ok(assignTeacherRequest, { userId: U }), true);
  assert.equal(ok(assignTeacherRequest, { userId: "chipo" }), false);
  assert.equal(ok(assignTeacherRequest, { userId: U, schoolId: U }), false);
});

test("the list item carries no date of birth or gender; the detail does", () => {
  assert.equal("dateOfBirth" in studentListItem.shape, false);
  assert.equal("gender" in studentListItem.shape, false);
  assert.equal("dateOfBirth" in studentDetail.shape, true);
});
