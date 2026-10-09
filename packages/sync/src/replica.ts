/**
 * The device's local copy of attendance, and how it changes. Pure functions: the web app calls these and then
 * persists the returned rows in IndexedDB, so the rules can be tested without a browser.
 */
import type { AttendanceEntry } from "@schoolpulse/contracts";
import type { AttendanceStatus } from "@schoolpulse/domain";
import type { AppliedEntry } from "./index.ts";

export interface LocalAttendance {
  studentId: string;
  classId: string;
  date: string;
  status: AttendanceStatus;
  /** The last SERVER version this device knows about (0 if the server has never confirmed this row). */
  version: number;
  /** True while the teacher's change has not been confirmed by the server. */
  dirty: boolean;
}

export interface ServerAttendance {
  studentId: string;
  classId: string;
  date: string;
  status: AttendanceStatus;
  version: number;
}

/**
 * The teacher saved a register. Returns the rows to write locally and the entries for the operation to queue.
 * Students whose mark did not change are left alone, so saving twice does not queue noise.
 */
export function planRegisterSave(input: {
  classId: string;
  date: string;
  marks: Readonly<Record<string, AttendanceStatus>>;
  existing: ReadonlyMap<string, LocalAttendance>;
}): { rows: LocalAttendance[]; entries: AttendanceEntry[] } {
  const rows: LocalAttendance[] = [];
  const entries: AttendanceEntry[] = [];
  for (const [studentId, status] of Object.entries(input.marks)) {
    const ex = input.existing.get(studentId);
    if (ex && ex.status === status) continue;
    const baseVersion = ex?.version ?? 0;
    rows.push({ studentId, classId: input.classId, date: input.date, status, version: baseVersion, dirty: true });
    entries.push({ studentId, status, baseVersion });
  }
  return { rows, entries };
}

/** The server confirmed (or already had) this entry. */
export function applyConfirmed(local: LocalAttendance | undefined, e: AppliedEntry): LocalAttendance {
  if (!local) {
    return { studentId: e.studentId, classId: e.classId, date: e.date, status: e.status, version: e.version, dirty: false };
  }
  // A newer local edit is still waiting to sync: keep it, but remember the version the server is now at.
  if (local.dirty && local.status !== e.status) return { ...local, version: e.version };
  return { ...local, status: e.status, version: e.version, dirty: false };
}

/** Merge a downloaded row into the local copy. Unsynced local work always wins until it has been pushed. */
export function mergeServerRow(local: LocalAttendance | undefined, server: ServerAttendance): LocalAttendance {
  if (local?.dirty) return local;
  return { ...server, dirty: false };
}

/** "Use mine": keep my value, but base it on the server's current version. */
export function rebase(local: LocalAttendance, serverVersion: number): LocalAttendance {
  return { ...local, version: serverVersion, dirty: true };
}

export const rowKey = (studentId: string, date: string) => `${studentId}|${date}`;

export interface RegisterCounts {
  present: number;
  late: number;
  absent: number;
  unmarked: number;
}

export function registerCounts(studentIds: readonly string[], marks: Readonly<Record<string, AttendanceStatus | undefined>>): RegisterCounts {
  const counts: RegisterCounts = { present: 0, late: 0, absent: 0, unmarked: 0 };
  for (const id of studentIds) {
    const m = marks[id];
    if (m) counts[m] += 1;
    else counts.unmarked += 1;
  }
  return counts;
}
