import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classNameKey, classRunsOn, normaliseClassName, normaliseStream, streamKey, validateArchive, validateClassName, validateClassYearChange,
  validateTeacherAssignment,
} from "../src/index.ts";

test("class names and streams are normalised the same way the database compares them", () => {
  assert.equal(normaliseClassName("  Grade   7A "), "Grade 7A");
  assert.equal(classNameKey("Grade 7A"), classNameKey("  grade  7a"));
  assert.equal(normaliseStream("   "), null);
  assert.equal(normaliseStream(undefined), null);
  assert.equal(normaliseStream(" Blue  Group "), "Blue Group");
  assert.equal(streamKey("A"), streamKey(" a "));
  assert.equal(streamKey(null), null);
  assert.equal(validateClassName("   ")?.code, "required");
  assert.equal(validateClassName("x".repeat(101))?.code, "too_long");
  assert.equal(validateClassName("Grade 7A"), null);
});

test("a class with students in it today cannot be archived", () => {
  assert.equal(validateArchive(0), null);
  assert.equal(validateArchive(1)?.code, "class_has_students");
  assert.match(validateArchive(1)!.message, /1 student is still/);
  assert.match(validateArchive(12)!.message, /12 students are still/);
});

test("a class's academic year can be set once, then locks once it has students or registers", () => {
  const base = { currentYearId: null, nextYearId: "y26", hasEnrolments: false, hasAttendance: false, activity: { firstDate: null, lastDate: null }, nextYear: { startsOn: "2026-01-05", endsOn: "2026-12-04" } };
  assert.equal(validateClassYearChange(base), null);
  // legacy class (no year yet) that already has students: allowed, this is how old classes get a year
  assert.equal(validateClassYearChange({ ...base, hasEnrolments: true, hasAttendance: true, activity: { firstDate: "2026-01-12", lastDate: "2026-10-07" } }), null);
  // ...but the year must contain ALL of the class's history: nothing before it starts or after it ends
  const late = validateClassYearChange({ ...base, hasEnrolments: true, activity: { firstDate: "2027-02-01", lastDate: "2027-02-01" } });
  assert.equal(late?.code, "year_excludes_history");
  assert.match(late!.message, /2027-02-01 to 2027-02-01.*2026-01-05 to 2026-12-04/);
  assert.equal(validateClassYearChange({ ...base, hasEnrolments: true, activity: { firstDate: "2026-01-04", lastDate: "2026-03-01" } })?.code, "year_excludes_history", "starts a day before the year");
  assert.equal(validateClassYearChange({ ...base, hasEnrolments: true, activity: { firstDate: "2026-02-01", lastDate: "2026-12-05" } })?.code, "year_excludes_history", "runs a day past the year");
  assert.equal(validateClassYearChange({ ...base, hasEnrolments: true, activity: { firstDate: "2026-01-05", lastDate: "2026-12-04" } }), null, "exactly the year is fine");
  // a class that already has a year and students is locked to it
  assert.equal(validateClassYearChange({ ...base, currentYearId: "y25", hasEnrolments: true })?.code, "class_year_locked");
  assert.equal(validateClassYearChange({ ...base, currentYearId: "y25", hasAttendance: true })?.code, "class_year_locked");
  // an empty class may switch year
  assert.equal(validateClassYearChange({ ...base, currentYearId: "y25" }), null);
  // no change is always fine, even when locked
  assert.equal(validateClassYearChange({ ...base, currentYearId: "y26", hasEnrolments: true }), null);
  // cannot un-assign a year
  assert.equal(validateClassYearChange({ ...base, currentYearId: "y26", nextYearId: null })?.code, "year_required");
});

test("teachers can only be assigned to classes that are still running", () => {
  const year = { startsOn: "2026-01-13", endsOn: "2026-12-04" };
  assert.equal(validateTeacherAssignment({ today: "2026-10-08", classStatus: "active", classYear: year }), null);
  assert.equal(validateTeacherAssignment({ today: "2026-10-08", classStatus: "active", classYear: null }), null, "legacy classes have no year to be incompatible with");
  assert.equal(validateTeacherAssignment({ today: "2026-12-04", classStatus: "active", classYear: year }), null, "the last day counts");
  assert.equal(validateTeacherAssignment({ today: "2026-12-05", classStatus: "active", classYear: year })?.code, "class_year_ended");
  assert.equal(validateTeacherAssignment({ today: "2026-10-08", classStatus: "archived", classYear: year })?.code, "class_archived");
});

test("classRunsOn: a class without a year is not restricted", () => {
  const year = { startsOn: "2026-01-13", endsOn: "2026-12-04" };
  assert.equal(classRunsOn(null, "1999-01-01"), true);
  assert.equal(classRunsOn(year, "2026-10-08"), true);
  assert.equal(classRunsOn(year, "2027-01-01"), false);
});
