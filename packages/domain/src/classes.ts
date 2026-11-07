/**
 * Class (and stream) configuration rules. A class belongs to one school and, once configured, one academic year.
 * A class is NOT a timetable: it is the group of students a register is taken for.
 */
import { rangeContains } from "./academic.ts";
import { isIsoDate } from "./dates.ts";
import { problem, type Problem } from "./problem.ts";

export const CLASS_STATUSES = ["active", "archived"] as const;
export type ClassStatus = (typeof CLASS_STATUSES)[number];

/** Trim and collapse runs of spaces: "Grade  7A " and "Grade 7A" are the same class name. */
export function normaliseClassName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/** A blank stream means "no stream". */
export function normaliseStream(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().replace(/\s+/g, " ");
  return v === "" ? null : v;
}

export const normaliseGradeLevel = (raw: string): string => raw.trim().replace(/\s+/g, " ");

export function validateClassName(raw: string): Problem | null {
  const v = normaliseClassName(raw);
  if (v.length === 0) return problem("required", "Enter a class name.", "name");
  if (v.length > 100) return problem("too_long", "A class name can be at most 100 characters.", "name");
  return null;
}

/** Case-insensitive comparison key, matching the database's unique indexes. */
export const classNameKey = (raw: string): string => normaliseClassName(raw).toLowerCase();
export const streamKey = (raw: string | null | undefined): string | null => normaliseStream(raw)?.toLowerCase() ?? null;

/** A class that still has students in it today cannot be archived: move them first, so no student is left in a hidden class. */
export function validateArchive(currentStudents: number): Problem | null {
  if (currentStudents > 0) {
    return problem(
      "class_has_students",
      `${currentStudents} student${currentStudents === 1 ? " is" : "s are"} still in this class. Move them to another class first.`,
      "status",
    );
  }
  return null;
}

export interface ClassYearChangeInput {
  currentYearId: string | null;
  nextYearId: string | null;
  hasEnrolments: boolean;
  hasAttendance: boolean;
  /** Earliest and latest date any placement or register of the class touches (null/null for a class with no history). */
  activity: { firstDate: string | null; lastDate: string | null };
  nextYear: { startsOn: string; endsOn: string } | null;
}

/**
 * Which academic year a class sits in can be set once (for classes created before years existed) and is then fixed
 * as soon as the class has students or registers: moving a class between years would rewrite what those registers mean.
 * The year it is given must contain all of the class's existing placements and registers; otherwise the class would be
 * locked to a year that does not describe its own history.
 */
export function validateClassYearChange(input: ClassYearChangeInput): Problem | null {
  if (input.currentYearId === input.nextYearId) return null;
  if (input.nextYearId === null) {
    return problem("year_required", "A class that has an academic year cannot go back to having none.", "academicYearId");
  }
  if (input.currentYearId !== null && (input.hasEnrolments || input.hasAttendance)) {
    return problem("class_year_locked", "This class already has students or attendance, so it cannot be moved to a different academic year. Create a new class for that year instead.", "academicYearId");
  }
  const { firstDate, lastDate } = input.activity;
  if (input.nextYear && firstDate && lastDate && (firstDate < input.nextYear.startsOn || lastDate > input.nextYear.endsOn)) {
    return problem(
      "year_excludes_history",
      `This class already has placements or registers from ${firstDate} to ${lastDate}, but that academic year runs ${input.nextYear.startsOn} to ${input.nextYear.endsOn}. Choose a year that covers them, or widen the year first.`,
      "academicYearId",
    );
  }
  return null;
}

export interface TeacherAssignmentInput {
  today: string;
  classStatus: ClassStatus;
  classYear: { startsOn: string; endsOn: string } | null;
}

/** A teacher can only be assigned to a class that is still running: active, and in an academic year that has not ended. */
export function validateTeacherAssignment(input: TeacherAssignmentInput): Problem | null {
  if (input.classStatus !== "active") return problem("class_archived", "That class is archived. Reactivate it before assigning a teacher.", "userId");
  if (input.classYear && input.today > input.classYear.endsOn) {
    return problem("class_year_ended", `That class's academic year ended on ${input.classYear.endsOn}. Teachers cannot be assigned to it now.`, "userId");
  }
  return null;
}

/** Roster dates are plain calendar dates. */
export const isRosterDate = (d: string): boolean => isIsoDate(d);

/** True when a class's academic year contains `date` (or the class has no year, so nothing restricts it). */
export function classRunsOn(year: { startsOn: string; endsOn: string } | null, date: string): boolean {
  return year === null || rangeContains(year, date);
}
