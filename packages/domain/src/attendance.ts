/**
 * Attendance rules. Pure functions: the server and the offline app both use these,
 * so a number can never differ between the phone and the dashboard.
 */

export const ATTENDANCE_STATUSES = ["present", "late", "absent"] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export interface AttendanceCounts {
  present: number;
  late: number;
  absent: number;
}

export interface AttendanceSummary extends AttendanceCounts {
  /** present + late + absent: every register entry in the period. */
  total: number;
  /** present + late. A late pupil is in school. */
  attended: number;
  /** attended / total as a percentage, one decimal place. null when there are no records (never NaN, never 0%). */
  rate: number | null;
}

export function summarise(counts: AttendanceCounts): AttendanceSummary {
  const total = counts.present + counts.late + counts.absent;
  const attended = counts.present + counts.late;
  const rate = total === 0 ? null : Math.round((attended / total) * 1000) / 10;
  return { ...counts, total, attended, rate };
}

export function countStatuses(statuses: Iterable<AttendanceStatus>): AttendanceCounts {
  const counts: AttendanceCounts = { present: 0, late: 0, absent: 0 };
  for (const s of statuses) counts[s] += 1;
  return counts;
}

export function addCounts(a: AttendanceCounts, b: AttendanceCounts): AttendanceCounts {
  return { present: a.present + b.present, late: a.late + b.late, absent: a.absent + b.absent };
}

/** Change in percentage points (current - previous), one decimal. null if either side has no records. */
export function rateChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return Math.round((current - previous) * 10) / 10;
}

export interface StoredAttendance {
  status: AttendanceStatus;
  version: number;
  /** The device that wrote the stored value. */
  deviceId: string;
}

export interface IncomingAttendance {
  status: AttendanceStatus;
  /** The version the device saw when it made the change; 0 if it had no record. */
  baseVersion: number;
  /** The device sending this change. */
  deviceId: string;
}

export type AttendanceWriteDecision =
  | { kind: "insert" }
  | { kind: "update"; nextVersion: number }
  | { kind: "noop"; version: number }
  | { kind: "conflict"; serverStatus: AttendanceStatus; serverVersion: number };

/**
 * Decides what to do with one student's attendance entry arriving from a device.
 * - nothing stored yet: insert
 * - stored value already equals the incoming one: nothing to do (safe replay)
 * - device saw the stored version: its change is a deliberate edit, apply it
 * - the stored value was written by this same device: it is the device's own earlier save (a teacher who saved the
 *   register twice while offline), so it can never conflict with itself; apply it
 * - otherwise somebody else changed the record since the device last saw it: conflict, never overwrite silently
 */
export function decideAttendanceWrite(
  stored: StoredAttendance | null,
  incoming: IncomingAttendance,
): AttendanceWriteDecision {
  if (stored === null) return { kind: "insert" };
  if (stored.status === incoming.status) return { kind: "noop", version: stored.version };
  if (stored.version === incoming.baseVersion || stored.deviceId === incoming.deviceId) {
    return { kind: "update", nextVersion: stored.version + 1 };
  }
  return { kind: "conflict", serverStatus: stored.status, serverVersion: stored.version };
}
