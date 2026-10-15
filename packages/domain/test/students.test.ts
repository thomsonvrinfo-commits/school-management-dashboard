import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enrolmentOn, latestEnrolment, normaliseAdmissionNo, normalisePersonName, planPlacement, planPlacementRemoval, planStatusChange,
  validateAdmissionNo, validateDateOfBirth, validateEnrolmentDate, validatePersonName,
  type EnrolmentSpan, type PlacementTarget,
} from "../src/index.ts";

const TODAY = "2026-10-08"; // Thursday
const YEAR = { startsOn: "2026-01-13", endsOn: "2026-12-04" };
const classA: PlacementTarget = { id: "A", status: "active", year: YEAR };
const classB: PlacementTarget = { id: "B", status: "active", year: YEAR };
const student = { status: "enrolled" as const, enrolmentDate: "2026-01-12" };
const inA: EnrolmentSpan = { id: "e1", classId: "A", startsOn: "2026-01-13", endsOn: null };

// ---------- identifiers ----------

test("admission numbers compare ignoring case and surrounding spaces", () => {
  assert.equal(normaliseAdmissionNo("  ma1001 "), "MA1001");
  assert.equal(validateAdmissionNo("ma1001"), null);
  assert.equal(validateAdmissionNo("2026/0123"), null);
  assert.equal(validateAdmissionNo("MA-10_01.2"), null);
  assert.equal(validateAdmissionNo("   ")?.code, "required");
  assert.equal(validateAdmissionNo("MA 1001")?.code, "invalid_admission_no", "inner spaces are not allowed");
  assert.equal(validateAdmissionNo("MA1001;drop table students")?.code, "invalid_admission_no");
  assert.equal(validateAdmissionNo("X".repeat(31))?.code, "too_long");
  assert.equal(validateAdmissionNo("-1001")?.code, "invalid_admission_no", "must start with a letter or digit");
});

test("names keep their capitalisation, lose stray spaces, and must contain a letter", () => {
  assert.equal(normalisePersonName("  Tadiwa   Chimbwanda "), "Tadiwa Chimbwanda");
  assert.equal(normalisePersonName("McDonald"), "McDonald");
  assert.equal(validatePersonName("Nyasha", "firstName", "a first name"), null);
  assert.equal(validatePersonName("Ndlovu-Moyo", "lastName", "a last name"), null);
  assert.equal(validatePersonName("Zoë", "firstName", "a first name"), null);
  assert.equal(validatePersonName("   ", "firstName", "a first name")?.code, "required");
  assert.equal(validatePersonName("1234", "firstName", "a first name")?.code, "invalid_name");
  assert.equal(validatePersonName("A".repeat(101), "firstName", "a first name")?.code, "too_long");
  assert.equal(validatePersonName("Ab\u0000c", "firstName", "a first name")?.code, "invalid_name");
  assert.equal(validatePersonName("   ", "firstName", "a first name")?.field, "firstName");
});

test("date of birth: real, not in the future, a plausible school age", () => {
  assert.equal(validateDateOfBirth("2014-03-02", TODAY), null);
  assert.equal(validateDateOfBirth("2014-02-30", TODAY)?.code, "invalid_date");
  assert.equal(validateDateOfBirth("2026-10-09", TODAY)?.code, "dob_in_future");
  assert.equal(validateDateOfBirth("2026-01-01", TODAY)?.code, "dob_too_recent");
  assert.equal(validateDateOfBirth("1980-01-01", TODAY)?.code, "dob_too_old");
});

test("enrolment date: real, not before birth, at most a year ahead", () => {
  assert.equal(validateEnrolmentDate("2026-01-12", "2014-03-02", TODAY), null);
  assert.equal(validateEnrolmentDate("2026-01-12", null, TODAY), null);
  assert.equal(validateEnrolmentDate("2013-01-01", "2014-03-02", TODAY)?.code, "enrolment_before_birth");
  assert.equal(validateEnrolmentDate("2027-01-04", null, TODAY), null, "pre-registering for next year is normal");
  assert.equal(validateEnrolmentDate("2028-01-04", null, TODAY)?.code, "enrolment_too_far_ahead");
  assert.equal(validateEnrolmentDate("nope", null, TODAY)?.code, "invalid_date");
});

// ---------- placement ----------

test("latestEnrolment and enrolmentOn read the dated history", () => {
  const history: EnrolmentSpan[] = [
    { id: "e0", classId: "X", startsOn: "2025-01-14", endsOn: "2025-12-05" },
    { id: "e1", classId: "A", startsOn: "2026-01-13", endsOn: "2026-10-08" },
    { id: "e2", classId: "B", startsOn: "2026-10-09", endsOn: null },
  ];
  assert.equal(latestEnrolment(history)?.id, "e2");
  assert.equal(latestEnrolment([]), null);
  assert.equal(enrolmentOn(history, "2026-10-08")?.classId, "A");
  assert.equal(enrolmentOn(history, "2026-10-09")?.classId, "B");
  assert.equal(enrolmentOn(history, "2025-06-01")?.classId, "X");
  assert.equal(enrolmentOn(history, "2025-12-20"), null, "between years the student is in no class");
});

test("first placement starts today, inside the class's year", () => {
  const plan = planPlacement({ today: TODAY, student, enrolments: [], target: classA });
  assert.deepEqual(plan, { ok: true, effectiveFrom: TODAY, open: { classId: "A", startsOn: TODAY } });
});

test("first placement for a class whose year has not begun starts on the first day of that year", () => {
  const next = { id: "N", status: "active" as const, year: { startsOn: "2027-01-12", endsOn: "2027-12-03" } };
  const plan = planPlacement({ today: TODAY, student, enrolments: [], target: next });
  assert.equal(plan.ok && plan.effectiveFrom, "2027-01-12");
});

test("first placement for a student who has not enrolled yet starts on their enrolment date", () => {
  const pre = { status: "enrolled" as const, enrolmentDate: "2026-11-01" };
  const plan = planPlacement({ today: TODAY, student: pre, enrolments: [], target: classA });
  assert.equal(plan.ok && plan.effectiveFrom, "2026-11-01");
});

test("a first placement may be backdated (catching up records) but not before the enrolment date or outside the year", () => {
  const ok = planPlacement({ today: TODAY, student, enrolments: [], target: classA, effectiveFrom: "2026-02-02" });
  assert.equal(ok.ok && ok.effectiveFrom, "2026-02-02");
  const early = planPlacement({ today: TODAY, student, enrolments: [], target: classA, effectiveFrom: "2026-01-11" });
  assert.equal(!early.ok && early.problem.code, "before_enrolment_date");
  const outside = planPlacement({ today: TODAY, student: { ...student, enrolmentDate: "2025-01-01" }, enrolments: [], target: classA, effectiveFrom: "2025-06-01" });
  assert.equal(!outside.ok && outside.problem.code, "outside_academic_year");
  const late = planPlacement({ today: TODAY, student, enrolments: [], target: classA, effectiveFrom: "2027-01-01" });
  assert.equal(!late.ok && late.problem.code, "outside_academic_year");
});

test("a class whose academic year is over cannot take a default placement", () => {
  const over = { id: "O", status: "active" as const, year: { startsOn: "2025-01-14", endsOn: "2025-12-05" } };
  const plan = planPlacement({ today: TODAY, student, enrolments: [], target: over });
  assert.equal(!plan.ok && plan.problem.code, "outside_academic_year");
});

test("a legacy class with no academic year accepts placements without a date range check", () => {
  const legacy = { id: "L", status: "active" as const, year: null };
  const plan = planPlacement({ today: TODAY, student, enrolments: [], target: legacy });
  assert.deepEqual(plan, { ok: true, effectiveFrom: TODAY, open: { classId: "L", startsOn: TODAY } });
});

test("a MOVE closes the current enrolment the day before and starts tomorrow by default", () => {
  const plan = planPlacement({ today: TODAY, student, enrolments: [inA], target: classB });
  assert.deepEqual(plan, {
    ok: true,
    effectiveFrom: "2026-10-09",
    close: { enrolmentId: "e1", endsOn: "2026-10-08" },
    open: { classId: "B", startsOn: "2026-10-09" },
    guard: { onOrAfter: "2026-10-09" },
  });
});

test("a move may take effect today, but never in the past, and never before the student joined their current class", () => {
  const today = planPlacement({ today: TODAY, student, enrolments: [inA], target: classB, effectiveFrom: TODAY });
  assert.equal(today.ok && today.close?.endsOn, "2026-10-07");
  const past = planPlacement({ today: TODAY, student, enrolments: [inA], target: classB, effectiveFrom: "2026-10-07" });
  assert.equal(!past.ok && past.problem.code, "retroactive_move");
  const joinedToday: EnrolmentSpan = { id: "e9", classId: "A", startsOn: TODAY, endsOn: null };
  const same = planPlacement({ today: TODAY, student, enrolments: [joinedToday], target: classB, effectiveFrom: TODAY });
  assert.equal(!same.ok && same.problem.code, "move_before_current_start", "use 'remove placement' to correct a placement made today");
});

test("moving to the class the student is already in, an archived class, or for a student who left, is refused", () => {
  assert.equal((planPlacement({ today: TODAY, student, enrolments: [inA], target: classA }) as { problem: { code: string } }).problem.code, "already_in_class");
  assert.equal((planPlacement({ today: TODAY, student, enrolments: [inA], target: { ...classB, status: "archived" } }) as { problem: { code: string } }).problem.code, "class_archived");
  assert.equal((planPlacement({ today: TODAY, student: { ...student, status: "withdrawn" }, enrolments: [], target: classA }) as { problem: { code: string } }).problem.code, "student_not_enrolled");
});

test("a move into a class whose year does not contain the start date is refused", () => {
  const next = { id: "N", status: "active" as const, year: { startsOn: "2027-01-12", endsOn: "2027-12-03" } };
  const early = planPlacement({ today: TODAY, student, enrolments: [inA], target: next });
  assert.equal(!early.ok && early.problem.code, "outside_academic_year");
  const ok = planPlacement({ today: TODAY, student, enrolments: [inA], target: next, effectiveFrom: "2027-01-12" });
  assert.equal(ok.ok && ok.close?.endsOn, "2027-01-11");
});

test("an unplaced student with a past enrolment cannot be placed on top of it", () => {
  const left: EnrolmentSpan = { id: "e1", classId: "A", startsOn: "2026-01-13", endsOn: "2026-10-12" };
  const bad = planPlacement({ today: TODAY, student, enrolments: [left], target: classB, effectiveFrom: "2026-10-10" });
  assert.equal(!bad.ok && bad.problem.code, "overlaps_enrolment");
  const dflt = planPlacement({ today: TODAY, student, enrolments: [left], target: classB });
  assert.equal(dflt.ok && dflt.effectiveFrom, "2026-10-13", "defaults to the day after the previous placement ends");
  assert.equal(dflt.ok && dflt.close, undefined);
});

// ---------- status ----------

test("leaving school ends the open enrolment the day before the effective date, defaulting to tomorrow", () => {
  const plan = planStatusChange({ today: TODAY, student: { status: "enrolled" }, enrolments: [inA], next: "withdrawn" });
  assert.deepEqual(plan, {
    ok: true, status: "withdrawn", effectiveFrom: "2026-10-09",
    close: { enrolmentId: "e1", endsOn: "2026-10-08" }, guard: { onOrAfter: "2026-10-09" },
  });
});

test("a status change cannot be retroactive or precede the current placement", () => {
  const past = planStatusChange({ today: TODAY, student: { status: "enrolled" }, enrolments: [inA], next: "transferred", effectiveFrom: "2026-10-01" });
  assert.equal(!past.ok && past.problem.code, "retroactive_change");
  const joinedToday: EnrolmentSpan = { id: "e9", classId: "A", startsOn: TODAY, endsOn: null };
  const same = planStatusChange({ today: TODAY, student: { status: "enrolled" }, enrolments: [joinedToday], next: "withdrawn", effectiveFrom: TODAY });
  assert.equal(!same.ok && same.problem.code, "change_before_current_start");
});

test("an unplaced student can leave with no enrolment to close; re-enrolling restores status only", () => {
  const leave = planStatusChange({ today: TODAY, student: { status: "enrolled" }, enrolments: [], next: "graduated" });
  assert.deepEqual(leave, { ok: true, status: "graduated", effectiveFrom: "2026-10-09" });
  const back = planStatusChange({ today: TODAY, student: { status: "withdrawn" }, enrolments: [], next: "enrolled" });
  assert.deepEqual(back, { ok: true, status: "enrolled", effectiveFrom: TODAY });
  const sideways = planStatusChange({ today: TODAY, student: { status: "withdrawn" }, enrolments: [], next: "transferred" });
  assert.equal(sideways.ok && sideways.close, undefined);
  const same = planStatusChange({ today: TODAY, student: { status: "withdrawn" }, enrolments: [], next: "withdrawn" });
  assert.equal(!same.ok && same.problem.code, "no_change");
  const badDate = planStatusChange({ today: TODAY, student: { status: "enrolled" }, enrolments: [], next: "withdrawn", effectiveFrom: "soon" });
  assert.equal(!badDate.ok && badDate.problem.code, "invalid_date");
});

// ---------- removing a mistaken placement ----------

test("only the latest placement can be removed, and never one with attendance", () => {
  const old: EnrolmentSpan = { id: "e0", classId: "X", startsOn: "2025-01-14", endsOn: "2025-12-05" };
  assert.deepEqual(planPlacementRemoval({ enrolments: [old, inA], enrolmentId: "e1", hasAttendanceInSpan: false }), { ok: true });
  const notLatest = planPlacementRemoval({ enrolments: [old, inA], enrolmentId: "e0", hasAttendanceInSpan: false });
  assert.equal(!notLatest.ok && notLatest.problem.code, "not_latest_placement");
  const used = planPlacementRemoval({ enrolments: [old, inA], enrolmentId: "e1", hasAttendanceInSpan: true });
  assert.equal(!used.ok && used.problem.code, "placement_has_attendance");
  const none = planPlacementRemoval({ enrolments: [old, inA], enrolmentId: "zz", hasAttendanceInSpan: false });
  assert.equal(!none.ok && none.problem.code, "not_found");
});
