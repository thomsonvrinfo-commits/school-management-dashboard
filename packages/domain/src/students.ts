/**
 * The student registry's rules: how identifiers are normalised, what makes a record plausible, and how a student's
 * class placement and status change over time.
 *
 * A student's class is never a field that gets overwritten. It is a dated row (an "enrolment"): a move closes the
 * current row and opens a new one, so every register ever taken still points at the class it was taken for.
 * The planners below take the facts as plain data and say exactly what to change; they touch nothing themselves.
 */
import { addDays, daysBetween, isIsoDate } from "./dates.ts";
import { problem, type Problem } from "./problem.ts";

export const STUDENT_STATUSES = ["enrolled", "withdrawn", "transferred", "graduated"] as const;
export type StudentStatus = (typeof STUDENT_STATUSES)[number];

export const GENDERS = ["female", "male"] as const;
export type Gender = (typeof GENDERS)[number];

// ---------- identifiers and names ----------

/** Letters, digits and a few separators schools use ("2026/0123", "MA-1001"). */
export const ADMISSION_NO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/;
export const ADMISSION_NO_MAX = 30;

/** Admission numbers are compared ignoring case and surrounding spaces, so "ma1001 " and "MA1001" are one number. */
export function normaliseAdmissionNo(raw: string): string {
  return raw.trim().toUpperCase();
}

export function validateAdmissionNo(raw: string): Problem | null {
  const v = normaliseAdmissionNo(raw);
  if (v.length === 0) return problem("required", "Enter the admission number.", "admissionNo");
  if (v.length > ADMISSION_NO_MAX) return problem("too_long", `An admission number can be at most ${ADMISSION_NO_MAX} characters.`, "admissionNo");
  if (!ADMISSION_NO_PATTERN.test(v)) {
    return problem("invalid_admission_no", "Use letters, numbers, and - _ . / only (no spaces).", "admissionNo");
  }
  return null;
}

/** Trim and collapse runs of spaces. Capitalisation is left as typed ("McDonald", "Ndlovu-Moyo"). */
export function normalisePersonName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

export function validatePersonName(raw: string, field: string, label: string): Problem | null {
  const v = normalisePersonName(raw);
  if (v.length === 0) return problem("required", `Enter ${label}.`, field);
  if (v.length > 100) return problem("too_long", `${label[0]!.toUpperCase()}${label.slice(1)} can be at most 100 characters.`, field);
  if (!/\p{L}/u.test(v)) return problem("invalid_name", `${label[0]!.toUpperCase()}${label.slice(1)} must contain letters.`, field);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) return problem("invalid_name", `${label[0]!.toUpperCase()}${label.slice(1)} contains characters that are not allowed.`, field);
  return null;
}

// ---------- dates on the record ----------

export const MIN_AGE_YEARS = 2;
export const MAX_AGE_YEARS = 30;
/** Pre-registration for next term is normal; a year ahead is the limit. */
export const MAX_FUTURE_ENROLMENT_DAYS = 366;

export function validateDateOfBirth(dob: string, today: string): Problem | null {
  if (!isIsoDate(dob)) return problem("invalid_date", "Date of birth is not a real date.", "dateOfBirth");
  if (dob > today) return problem("dob_in_future", "Date of birth cannot be in the future.", "dateOfBirth");
  const days = daysBetween(dob, today);
  if (days < MIN_AGE_YEARS * 365) return problem("dob_too_recent", `A student must be at least ${MIN_AGE_YEARS} years old.`, "dateOfBirth");
  if (days > MAX_AGE_YEARS * 366) return problem("dob_too_old", `That date of birth is more than ${MAX_AGE_YEARS} years ago. Please check it.`, "dateOfBirth");
  return null;
}

export function validateEnrolmentDate(enrolmentDate: string, dateOfBirth: string | null | undefined, today: string): Problem | null {
  if (!isIsoDate(enrolmentDate)) return problem("invalid_date", "Enrolment date is not a real date.", "enrolmentDate");
  if (dateOfBirth && enrolmentDate < dateOfBirth) return problem("enrolment_before_birth", "A student cannot be enrolled before they were born.", "enrolmentDate");
  if (daysBetween(today, enrolmentDate) > MAX_FUTURE_ENROLMENT_DAYS) {
    return problem("enrolment_too_far_ahead", "Enrolment date is more than a year ahead.", "enrolmentDate");
  }
  return null;
}

// ---------- placement planning ----------

export interface EnrolmentSpan {
  id: string;
  classId: string;
  startsOn: string;
  /** Last day in the class; null = still there. */
  endsOn: string | null;
}

export interface PlacementTarget {
  id: string;
  status: "active" | "archived";
  /** The class's academic year dates, or null for a class that has not been assigned a year yet. */
  year: { startsOn: string; endsOn: string } | null;
}

/** The enrolment with the latest start: the one that is current, or the most recent one if the student is unplaced. */
export function latestEnrolment(enrolments: readonly EnrolmentSpan[]): EnrolmentSpan | null {
  let latest: EnrolmentSpan | null = null;
  for (const e of enrolments) if (!latest || e.startsOn > latest.startsOn) latest = e;
  return latest;
}

/** The enrolment covering `date`, if any. */
export function enrolmentOn(enrolments: readonly EnrolmentSpan[], date: string): EnrolmentSpan | null {
  return enrolments.find((e) => e.startsOn <= date && (e.endsOn === null || e.endsOn >= date)) ?? null;
}

export interface AttendanceGuard {
  /** The service must confirm the student has NO attendance record dated on or after this day. */
  onOrAfter: string;
}

export type PlacementPlan =
  | {
      ok: true;
      /** First day in the (new) class. */
      effectiveFrom: string;
      /** Close this enrolment on `endsOn` (the day before the move). Absent when the student was unplaced. */
      close?: { enrolmentId: string; endsOn: string };
      open: { classId: string; startsOn: string };
      guard?: AttendanceGuard;
    }
  | { ok: false; problem: Problem };

const fail = (p: Problem): { ok: false; problem: Problem } => ({ ok: false, problem: p });

export interface PlacementInput {
  today: string;
  student: { status: StudentStatus; enrolmentDate: string };
  enrolments: readonly EnrolmentSpan[];
  target: PlacementTarget;
  /** First day in the class. Defaults to tomorrow for a move, and to today (inside the class's year) for a first placement. */
  effectiveFrom?: string;
}

/**
 * Place an unplaced student in a class, or move a placed one.
 *
 * - A MOVE is never retroactive: it cannot start before today, and it must start after the day the student joined
 *   their current class. The default is tomorrow, so a register already open on a teacher's phone today still matches.
 * - A FIRST placement (the student has no open enrolment) may be dated in the past, because the head is catching up
 *   the records; the database refuses it if it would overlap an existing enrolment.
 */
export function planPlacement(input: PlacementInput): PlacementPlan {
  const { today, student, enrolments, target } = input;
  if (student.status !== "enrolled") {
    return fail(problem("student_not_enrolled", "This student is not currently enrolled. Re-enrol them before placing them in a class.", "classId"));
  }
  if (target.status !== "active") return fail(problem("class_archived", "That class is archived. Choose an active class.", "classId"));
  if (input.effectiveFrom !== undefined && !isIsoDate(input.effectiveFrom)) {
    return fail(problem("invalid_date", "The effective date is not a real date.", "effectiveFrom"));
  }

  const latest = latestEnrolment(enrolments);
  const placed = latest !== null && latest.endsOn === null;

  let from: string;
  if (placed) {
    if (latest.classId === target.id) return fail(problem("already_in_class", "The student is already in that class.", "classId"));
    from = input.effectiveFrom ?? addDays(today, 1);
    if (from < today) {
      return fail(problem("retroactive_move", "A class change cannot take effect in the past. Pick today or a later date.", "effectiveFrom"));
    }
    if (from <= latest.startsOn) {
      return fail(problem(
        "move_before_current_start",
        `The student joined their current class on ${latest.startsOn}. Pick a later date, or remove that placement first if it was a mistake.`,
        "effectiveFrom",
      ));
    }
  } else {
    // Unplaced: start today (or later if the student is not enrolled yet, or the class's year has not begun).
    let earliest = latest?.endsOn ? addDays(latest.endsOn, 1) : student.enrolmentDate;
    if (student.enrolmentDate > earliest) earliest = student.enrolmentDate;
    if (input.effectiveFrom !== undefined) {
      from = input.effectiveFrom;
      if (from < student.enrolmentDate) {
        return fail(problem("before_enrolment_date", `The student was enrolled on ${student.enrolmentDate}; they cannot be in a class before that.`, "effectiveFrom"));
      }
      if (latest?.endsOn && from <= latest.endsOn) {
        return fail(problem("overlaps_enrolment", `The student is still in their previous class until ${latest.endsOn}. Start the new placement after that.`, "effectiveFrom"));
      }
    } else {
      from = today > earliest ? today : earliest;
      if (target.year && from < target.year.startsOn) from = target.year.startsOn;
    }
  }

  if (target.year && (from < target.year.startsOn || from > target.year.endsOn)) {
    return fail(problem("outside_academic_year", `That class belongs to an academic year that runs ${target.year.startsOn} to ${target.year.endsOn}. The date must be inside it.`, "effectiveFrom"));
  }

  if (placed) {
    return {
      ok: true,
      effectiveFrom: from,
      close: { enrolmentId: latest.id, endsOn: addDays(from, -1) },
      open: { classId: target.id, startsOn: from },
      guard: { onOrAfter: from },
    };
  }
  return { ok: true, effectiveFrom: from, open: { classId: target.id, startsOn: from } };
}

export type StatusPlan =
  | { ok: true; status: StudentStatus; effectiveFrom: string; close?: { enrolmentId: string; endsOn: string }; guard?: AttendanceGuard }
  | { ok: false; problem: Problem };

export interface StatusInput {
  today: string;
  student: { status: StudentStatus };
  enrolments: readonly EnrolmentSpan[];
  next: StudentStatus;
  /** First day the student is no longer in their class. Defaults to tomorrow. Only used when leaving. */
  effectiveFrom?: string;
}

/**
 * Change a student's enrolment status. Leaving (withdrawn, transferred, graduated) ends the open class enrolment the
 * day before the effective date, never in the past. Re-enrolling restores the status only: the student is then
 * unplaced until the head puts them in a class.
 */
export function planStatusChange(input: StatusInput): StatusPlan {
  const { today, student, enrolments, next } = input;
  if (input.effectiveFrom !== undefined && !isIsoDate(input.effectiveFrom)) {
    return fail(problem("invalid_date", "The effective date is not a real date.", "effectiveFrom"));
  }
  if (next === student.status) return fail(problem("no_change", `The student is already ${next}.`, "status"));

  const leaving = student.status === "enrolled" && next !== "enrolled";
  if (!leaving) return { ok: true, status: next, effectiveFrom: today };

  const from = input.effectiveFrom ?? addDays(today, 1);
  if (from < today) return fail(problem("retroactive_change", "A status change cannot take effect in the past. Pick today or a later date.", "effectiveFrom"));

  const latest = latestEnrolment(enrolments);
  if (latest === null || latest.endsOn !== null) return { ok: true, status: next, effectiveFrom: from };
  if (from <= latest.startsOn) {
    return fail(problem(
      "change_before_current_start",
      `The student joined their current class on ${latest.startsOn}. Pick a later date, or remove that placement first if it was a mistake.`,
      "effectiveFrom",
    ));
  }
  return {
    ok: true,
    status: next,
    effectiveFrom: from,
    close: { enrolmentId: latest.id, endsOn: addDays(from, -1) },
    guard: { onOrAfter: from },
  };
}

export type RemovalPlan = { ok: true } | { ok: false; problem: Problem };

/**
 * Remove a mistaken placement. Only the most recent placement can be removed, and only if no register was ever
 * taken for the student while they were in it: attendance history is never deleted or orphaned.
 */
export function planPlacementRemoval(input: {
  enrolments: readonly EnrolmentSpan[];
  enrolmentId: string;
  /** The service looked: does the student have any attendance dated within this enrolment? */
  hasAttendanceInSpan: boolean;
}): RemovalPlan {
  const target = input.enrolments.find((e) => e.id === input.enrolmentId);
  if (!target) return fail(problem("not_found", "That placement does not exist."));
  if (latestEnrolment(input.enrolments)?.id !== target.id) {
    return fail(problem("not_latest_placement", "Only the most recent placement can be removed. Move the student instead."));
  }
  if (input.hasAttendanceInSpan) {
    return fail(problem("placement_has_attendance", "Attendance has already been recorded while the student was in this class, so the placement cannot be removed. Move the student instead."));
  }
  return { ok: true };
}
