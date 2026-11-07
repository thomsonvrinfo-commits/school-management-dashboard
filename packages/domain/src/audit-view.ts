/**
 * What an audit entry means in plain words, for the head's activity screen.
 *
 * The audit log stores a small `details` object with each entry. It was written to hold identifiers, counts and the
 * NAMES of fields that changed, but it is not guaranteed to stay that way, and some entries carry things a school would
 * rather not repeat on a screen (an admission number, a teacher's id, the per-pupil changes of a register). So nothing
 * here echoes `details` as it is: each action has a describer that reads only the keys it knows, checks each is the
 * right shape, and says nothing about the rest. An action nobody described is shown as "Made a change", with no detail.
 * Pure: no database, no clock.
 */

export type AuditCategory = "students" | "classes" | "school" | "staff" | "attendance" | "other";

/** The categories a person can filter by. "other" is whatever is left, and is only ever seen under "everything". */
export const AUDIT_FILTER_CATEGORIES = [
  { value: "students", label: "Students" },
  { value: "classes", label: "Classes" },
  { value: "attendance", label: "Attendance" },
  { value: "staff", label: "Staff" },
  { value: "school", label: "School settings" },
] as const satisfies readonly { value: Exclude<AuditCategory, "other">; label: string }[];

const CATEGORY_OF_PREFIX: Readonly<Record<string, Exclude<AuditCategory, "other">>> = {
  student: "students",
  class: "classes",
  attendance: "attendance",
  staff: "staff",
  school: "school",
  academic_year: "school",
  term: "school",
};

const prefixOf = (action: string): string => action.split(".")[0] ?? "";

export const categoryOf = (action: string): AuditCategory => CATEGORY_OF_PREFIX[prefixOf(action)] ?? "other";

/** The action prefixes behind a category, for filtering in the database ("students" -> ["student"]). */
export function prefixesOf(category: Exclude<AuditCategory, "other">): string[] {
  return Object.entries(CATEGORY_OF_PREFIX).filter(([, c]) => c === category).map(([p]) => p);
}

export interface AuditDescription {
  category: AuditCategory;
  /** What was done, without saying who did it (the screen shows the person beside it). */
  summary: string;
  /** One short line of context, or null. Never an identifier, a person's name or a child's details. */
  detail: string | null;
}

// ---------- reading details defensively ----------

type Details = Readonly<Record<string, unknown>>;

const asObject = (d: unknown): Details => (d !== null && typeof d === "object" && !Array.isArray(d) ? (d as Details) : {});
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
/** A short piece of text the school itself typed as a NAME of something (a class, a year). */
const label = (v: unknown, max = 60): string | null => (typeof v === "string" && v.trim() !== "" ? clip(v.trim().replace(/\s+/g, " "), max) : null);
const isoDay = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1_000_000 ? v : null);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null => (typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null);
const STUDENT_STATUSES = ["enrolled", "withdrawn", "transferred", "graduated"] as const;
const CLASS_STATUSES = ["active", "archived"] as const;

/** "firstName" -> "first name". Only plain field names pass; anything else is dropped. */
function fieldList(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  const names = v.filter((x): x is string => typeof x === "string" && /^[A-Za-z]{1,40}$/.test(x)).slice(0, 12)
    .map((x) => x.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase());
  return names.length > 0 ? names.join(", ") : null;
}

const changed = (d: Details): string | null => {
  const f = fieldList(d.fields);
  return f ? `Changed: ${f}` : null;
};
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const join = (...parts: (string | null)[]): string | null => {
  const kept = parts.filter((p): p is string => p !== null);
  return kept.length > 0 ? kept.join(". ") : null;
};

interface Describer {
  summary: string;
  detail?: (d: Details) => string | null;
}

const DESCRIBERS: Readonly<Record<string, Describer>> = {
  "student.registered": { summary: "Registered a student", detail: (d) => (typeof d.classId === "string" ? "Put in a class at the same time" : null) },
  "student.updated": { summary: "Edited a student's details", detail: changed },
  "student.status_changed": {
    summary: "Changed a student's status",
    detail: (d) => {
      const from = oneOf(d.from, STUDENT_STATUSES);
      const to = oneOf(d.to, STUDENT_STATUSES);
      const on = isoDay(d.effectiveFrom);
      return join(from && to ? `From ${from} to ${to}` : to ? `To ${to}` : null, on ? `Effective ${on}` : null);
    },
  },
  "student.placed": {
    summary: "Put a student in a class",
    detail: (d) => join(d.fromClassId === null ? "First class placement" : typeof d.fromClassId === "string" ? "Moved from another class" : null, isoDay(d.effectiveFrom) ? `From ${isoDay(d.effectiveFrom)}` : null),
  },
  "student.placement_removed": {
    summary: "Removed a class placement",
    detail: (d) => join(isoDay(d.startsOn) ? `It started ${isoDay(d.startsOn)}` : null, typeof d.restoredPlacementId === "string" ? "The earlier placement was reopened" : null),
  },

  "class.created": { summary: "Created a class", detail: (d) => label(d.name) },
  "class.updated": {
    summary: "Edited a class",
    detail: (d) => join(changed(d), oneOf(d.status, CLASS_STATUSES) ? `Status: ${oneOf(d.status, CLASS_STATUSES)}` : null),
  },
  "class.teacher_assigned": { summary: "Assigned a teacher to a class" },
  "class.teacher_removed": { summary: "Removed a teacher from a class" },

  "school.updated": { summary: "Edited the school profile", detail: changed },
  "academic_year.created": { summary: "Created an academic year", detail: (d) => join(label(d.name), d.active === true ? "Made current" : null) },
  "academic_year.updated": { summary: "Edited an academic year", detail: changed },
  "academic_year.deleted": { summary: "Deleted an academic year", detail: (d) => label(d.name) },
  "term.created": { summary: "Added a term", detail: (d) => label(d.name) },
  "term.updated": { summary: "Edited a term", detail: changed },
  "term.deleted": { summary: "Deleted a term", detail: (d) => label(d.name) },

  // The per-pupil changes inside a register are deliberately not shown here: only the day and how many marks changed.
  "attendance.recorded": {
    summary: "Recorded attendance",
    detail: (d) => {
      const n = Array.isArray(d.changes) ? d.changes.length : null;
      return join(isoDay(d.date) ? `Register for ${isoDay(d.date)}` : null, n !== null ? `${plural(n, "mark", "marks")} changed` : null);
    },
  },

  "staff.invited": { summary: "Invited a teacher", detail: (d) => (count(d.replacedLinks) ? "An earlier link for them was withdrawn" : null) },
  "staff.invitation_revoked": { summary: "Withdrew an invitation" },
  "staff.joined": { summary: "Joined the school", detail: (d) => (d.newAccount === true ? "Created a new account" : d.newAccount === false ? "Used an existing account" : null) },
  "staff.deactivated": {
    summary: "Switched a teacher's access off",
    detail: (d) => (count(d.sessionsEnded) !== null ? `Signed out of ${plural(count(d.sessionsEnded)!, "device", "devices")}` : null),
  },
  "staff.reactivated": { summary: "Switched a teacher's access on" },
  "staff.reset_link_issued": { summary: "Made a password reset link", detail: (d) => (count(d.replacedLinks) ? "An earlier link was withdrawn" : null) },
  "staff.password_reset": {
    summary: "Chose a new password with a reset link",
    detail: (d) => (count(d.sessionsEnded) !== null ? `Signed out of ${plural(count(d.sessionsEnded)!, "device", "devices")}` : null),
  },
};

/** Every action the activity screen knows how to describe. A test checks that each action the API writes is in here. */
export const AUDIT_ACTIONS: readonly string[] = Object.keys(DESCRIBERS);

export function describeAudit(action: string, details: unknown): AuditDescription {
  const describer = DESCRIBERS[action];
  if (!describer) return { category: categoryOf(action), summary: "Made a change", detail: null };
  const detail = describer.detail ? describer.detail(asObject(details)) : null;
  return { category: categoryOf(action), summary: describer.summary, detail };
}
