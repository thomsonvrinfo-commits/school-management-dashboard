import { test } from "node:test";
import assert from "node:assert/strict";
import type { AcademicYearDto, ClassDetail, SchoolProfile, StudentDetail } from "@schoolpulse/contracts";
import {
  describePlacement, emptyClassForm, emptyStudentForm, emptyTermForm, emptyYearForm, latestPlacement, pageWindow, placeFailure, profileToForm,
  queryString, studentToForm, toCreateClass, toCreateStudent, toFailure, toPlacement, toStatusChange, toUpdateClass, toUpdateProfile, toUpdateStudent,
  toUpdateYear, validateCreateClass, validateCreateStudent, validateCreateTerm, validateCreateYear, validatePlacement, validateStatusChange,
  validateUpdateClass, validateUpdateProfile, validateUpdateStudent, yearToForm, classToForm,
} from "../src/lib/admin-forms.ts";

const UUID_A = "3f1c3a64-9f1e-4c55-8a37-0d7d2a3d2b11";
const UUID_B = "7a2b9c40-1d2e-4f3a-9b4c-5d6e7f8a9b0c";

const student: StudentDetail = {
  id: UUID_A, admissionNo: "MA5002", firstName: "Nyasha", lastName: "Moyo", status: "enrolled", currentClass: { id: UUID_B, name: "Grade 4A" }, upcomingClass: null,
  otherNames: "Rudo", dateOfBirth: "2016-03-02", gender: "female", enrolmentDate: "2026-01-12", attendance: [],
  placements: [
    { id: UUID_A, classId: UUID_B, className: "Grade 3A", academicYear: { id: UUID_A, name: "2025" }, startsOn: "2025-01-13", endsOn: "2025-12-12" },
    { id: UUID_B, classId: UUID_B, className: "Grade 4A", academicYear: { id: UUID_B, name: "2026" }, startsOn: "2026-01-12", endsOn: null },
  ],
};

test("queryString keeps only the filters that are set and encodes them", () => {
  assert.equal(queryString({}), "");
  assert.equal(queryString({ q: "", status: undefined, offset: 0 }), "?offset=0");
  assert.equal(queryString({ q: "tadiwa & co", limit: 25, unplaced: true }), "?q=tadiwa+%26+co&limit=25&unplaced=true");
});

test("failures: no answer is described honestly, a refusal keeps its message and field", () => {
  const net = toFailure(Object.assign(new Error("x"), { name: "NetworkFailure" }));
  assert.equal(net.unreachable, true);
  assert.match(net.message, /cannot tell whether that was saved/);
  const api = toFailure(Object.assign(new Error("That admission number is already used."), { name: "ApiFailure", code: "admission_no_taken", field: "admissionNo" }));
  assert.deepEqual(api, { message: "That admission number is already used.", code: "admission_no_taken", field: "admissionNo" });
  assert.equal(toFailure(new Error("boom")).message, "Something went wrong. Nothing was changed.");
  assert.equal(toFailure(null).message, "Something went wrong. Nothing was changed.");
});

test("a refusal shows next to its field when the form has it, otherwise at the top", () => {
  const f = { message: "Already used.", field: "admissionNo" };
  assert.deepEqual(placeFailure(f, ["admissionNo", "firstName"]).errors, { admissionNo: "Already used." });
  assert.ok(placeFailure(f, ["admissionNo"]).banner);
  assert.deepEqual(placeFailure(f, ["firstName"]), { errors: {}, banner: "Already used." });
  assert.deepEqual(placeFailure({ message: "Nope." }, ["firstName"]), { errors: {}, banner: "Nope." });
});

test("registering a student: blank required fields are named in plain words; a good form passes the server's own schema", () => {
  const blank = validateCreateStudent(emptyStudentForm());
  assert.equal(blank.ok, false);
  if (!blank.ok) {
    assert.equal(blank.errors.admissionNo, "Enter the admission number.");
    assert.equal(blank.errors.firstName, "Enter the first name.");
    assert.equal(blank.errors.lastName, "Enter the last name.");
    assert.equal(Object.keys(blank.errors).length, 3);
  }
  const v = { ...emptyStudentForm(), admissionNo: " ma7001 ", firstName: " Tadiwa ", lastName: "Chimbwanda" };
  assert.deepEqual(toCreateStudent(v), { admissionNo: "ma7001", firstName: "Tadiwa", lastName: "Chimbwanda" });
  assert.deepEqual(validateCreateStudent(v), { ok: true });
});

test("registering a student: bad optional values are reported against their own field", () => {
  const base = { ...emptyStudentForm(), admissionNo: "MA1", firstName: "A", lastName: "B" };
  const bad = (patch: object) => {
    const r = validateCreateStudent({ ...base, ...patch });
    return r.ok ? {} : r.errors;
  };
  assert.match(bad({ admissionNo: "MA 7001" }).admissionNo ?? "", /no spaces/);
  assert.match(bad({ dateOfBirth: "2016-13-45" }).dateOfBirth ?? "", /Enter a real date for the date of birth/);
  assert.match(bad({ enrolmentDate: "yesterday" }).enrolmentDate ?? "", /Enter a real date for the enrolment date/);
  assert.match(bad({ firstName: "1234" }).firstName ?? "", /must contain letters/);
  assert.match(bad({ otherNames: "x".repeat(101) }).otherNames ?? "", /too long/);
  assert.equal(bad({ classId: "not-a-class" }).classId, "Choose the class.");
  assert.deepEqual(bad({ dateOfBirth: "2016-03-02", gender: "female", enrolmentDate: "2026-01-12", classId: UUID_A, classStartsOn: "2026-02-02" }), {});
});

test("registering: a start date without a class is not sent", () => {
  const v = { ...emptyStudentForm(), admissionNo: "MA1", firstName: "A", lastName: "B", classStartsOn: "2026-02-02" };
  assert.deepEqual(toCreateStudent(v), { admissionNo: "MA1", firstName: "A", lastName: "B" });
  assert.deepEqual(toCreateStudent({ ...v, classId: UUID_A }), { admissionNo: "MA1", firstName: "A", lastName: "B", classId: UUID_A, classStartsOn: "2026-02-02" });
});

test("editing a student sends only what changed, and clearing an optional field sends null", () => {
  const same = studentToForm(student);
  assert.deepEqual(toUpdateStudent(student, same), {}, "an untouched form changes nothing");
  assert.deepEqual(toUpdateStudent(student, { ...same, firstName: " Nyasha-Rose " }), { firstName: "Nyasha-Rose" });
  assert.deepEqual(toUpdateStudent(student, { ...same, otherNames: "", dateOfBirth: "", gender: "" }), { otherNames: null, dateOfBirth: null, gender: null });
  const req = toUpdateStudent(student, { ...same, admissionNo: "MA5003", gender: "male" });
  assert.deepEqual(req, { admissionNo: "MA5003", gender: "male" });
  assert.deepEqual(validateUpdateStudent(req), { ok: true });
  const bad = validateUpdateStudent({ dateOfBirth: "31/12/2016" });
  assert.equal(bad.ok, false);
});

test("moving a student and changing status: dates are optional, the class and status are not", () => {
  assert.deepEqual(toPlacement({ classId: UUID_A, effectiveFrom: "" }), { classId: UUID_A });
  assert.deepEqual(validatePlacement({ classId: UUID_A, effectiveFrom: "2026-10-20" }), { ok: true });
  const none = validatePlacement({ classId: "", effectiveFrom: "" });
  assert.equal(none.ok === false && none.errors.classId, "Choose the class.");
  const noStatus = validateStatusChange({ status: "", effectiveFrom: "" });
  assert.equal(noStatus.ok === false && noStatus.errors.status, "Choose the status.");
  assert.deepEqual(toStatusChange({ status: "withdrawn", effectiveFrom: "2026-10-20" }), { status: "withdrawn", effectiveFrom: "2026-10-20" });
  assert.deepEqual(validateStatusChange({ status: "transferred", effectiveFrom: "" }), { ok: true });
});

test("placement history reads in words and the latest one is the only one that can be removed", () => {
  assert.equal(describePlacement(student.placements[0]!), "Grade 3A, 2025: 13 Jan 2025 to 12 Dec 2025");
  assert.equal(describePlacement(student.placements[1]!), "Grade 4A, 2026: from 12 Jan 2026, still there");
  assert.equal(latestPlacement(student.placements)?.id, UUID_B);
  assert.equal(latestPlacement([]), null);
});

const klass: ClassDetail = { id: UUID_A, name: "Grade 4A", gradeLevel: "4", stream: "A", status: "active", academicYear: { id: UUID_B, name: "2026" }, studentCount: 0, teacherCount: 0, teachers: [] };

test("creating a class: the academic year is required; blank stream means none", () => {
  const missingYear = validateCreateClass({ ...emptyClassForm(), name: "Grade 1A", gradeLevel: "1" });
  assert.equal(missingYear.ok === false && missingYear.errors.academicYearId, "Choose the academic year.");
  const v = { ...emptyClassForm(UUID_B), name: " Grade 1A ", gradeLevel: "1" };
  assert.deepEqual(toCreateClass(v), { name: "Grade 1A", gradeLevel: "1", academicYearId: UUID_B });
  assert.deepEqual(validateCreateClass(v), { ok: true });
  const blank = validateCreateClass(emptyClassForm(UUID_B));
  assert.equal(blank.ok === false && blank.errors.name, "Enter the name.");
  assert.equal(blank.ok === false && blank.errors.gradeLevel, "Enter the grade.");
});

test("editing a class sends only changes; archive and reactivate are status changes", () => {
  const f = classToForm(klass);
  assert.deepEqual(toUpdateClass(klass, f), {});
  assert.deepEqual(toUpdateClass(klass, { ...f, stream: "" }), { stream: null });
  assert.deepEqual(toUpdateClass(klass, { ...f, name: "Grade 4 Alpha", status: "archived" }), { name: "Grade 4 Alpha", status: "archived" });
  const legacy: ClassDetail = { ...klass, academicYear: null };
  assert.deepEqual(toUpdateClass(legacy, { ...classToForm(legacy), academicYearId: UUID_B }), { academicYearId: UUID_B }, "a class from before years can be given one");
  assert.deepEqual(toUpdateClass(legacy, classToForm(legacy)), {}, "a blank year on a legacy class is not a change");
  assert.deepEqual(validateUpdateClass({ status: "archived" }), { ok: true });
});

const profile: SchoolProfile = { id: UUID_A, name: "Mavambo Academy", code: null, timezone: "Africa/Harare", contactEmail: null, contactPhone: null, address: null, activeAcademicYear: null };

test("school profile: only changes are sent, cleared fields go as empty text, bad values are caught", () => {
  const f = profileToForm(profile);
  assert.deepEqual(toUpdateProfile(profile, f), {});
  const req = toUpdateProfile(profile, { ...f, code: " mav-01 ", contactEmail: "office@mavambo.example" });
  assert.deepEqual(req, { code: "mav-01", contactEmail: "office@mavambo.example" });
  assert.deepEqual(validateUpdateProfile(req), { ok: true });
  const withEmail: SchoolProfile = { ...profile, contactEmail: "office@mavambo.example" };
  assert.deepEqual(toUpdateProfile(withEmail, { ...profileToForm(withEmail), contactEmail: "" }), { contactEmail: "" });
  const bad = validateUpdateProfile({ timezone: "Mars/Olympus", contactEmail: "nope", code: "a b" });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.match(bad.errors.timezone ?? "", /time zone/i);
    assert.match(bad.errors.contactEmail ?? "", /valid email/);
    assert.match(bad.errors.code ?? "", /letters, numbers/);
  }
});

const year: AcademicYearDto = { id: UUID_A, name: "2026", startsOn: "2026-01-05", endsOn: "2026-12-11", isActive: true, classCount: 3, terms: [] };

test("academic years and terms: required fields named; dates must be real; updates send changes only", () => {
  const blank = validateCreateYear(emptyYearForm());
  assert.equal(blank.ok === false && blank.errors.name, "Enter the name.");
  assert.equal(blank.ok === false && blank.errors.startsOn, "Enter the start date.");
  assert.equal(blank.ok === false && blank.errors.endsOn, "Enter the end date.");
  assert.deepEqual(validateCreateYear({ name: "2027", startsOn: "2027-01-04", endsOn: "2027-12-10", isActive: false }), { ok: true });
  const badDate = validateCreateYear({ name: "2027", startsOn: "2027-02-30", endsOn: "2027-12-10", isActive: false });
  assert.equal(badDate.ok === false && /real date/.test(badDate.errors.startsOn ?? ""), true);
  assert.deepEqual(toUpdateYear(year, yearToForm(year)), {});
  assert.deepEqual(toUpdateYear(year, { ...yearToForm(year), isActive: false, endsOn: "2026-12-04" }), { endsOn: "2026-12-04", isActive: false });
  assert.deepEqual(validateCreateTerm({ name: "Term 1", startsOn: "2026-01-12", endsOn: "2026-04-10" }), { ok: true });
  assert.equal(validateCreateTerm(emptyTermForm()).ok, false);
});

test("paging text: 'Showing 26 to 50 of 132' and which buttons are live", () => {
  assert.deepEqual(pageWindow({ total: 132, limit: 25, offset: 25 }), { from: 26, to: 50, hasPrev: true, hasNext: true, prevOffset: 0, nextOffset: 50 });
  assert.deepEqual(pageWindow({ total: 132, limit: 25, offset: 125 }), { from: 126, to: 132, hasPrev: true, hasNext: false, prevOffset: 100, nextOffset: 150 });
  assert.deepEqual(pageWindow({ total: 0, limit: 25, offset: 0 }), { from: 0, to: 0, hasPrev: false, hasNext: false, prevOffset: 0, nextOffset: 25 });
});
