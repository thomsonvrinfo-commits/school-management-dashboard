/**
 * Wire contracts shared by the web app, the API and the sync engine.
 * The server validates every request with these; the client uses the inferred types.
 */
import { z } from "zod";
import { ATTENDANCE_STATUSES } from "@schoolpulse/domain";
import { deviceId, isoDate, meResponse, role, tokenResponse, uuid } from "./primitives.ts";
import type { MeResponse, TokenResponse } from "./primitives.ts";

// Moved to primitives.ts (Slice 2, and again in P1) so admin.ts and staff.ts can share them without an import cycle.
// Same names, same exports.
export { deviceId, isoDate, meResponse, role, tokenResponse, uuid };
export type { MeResponse, TokenResponse };
export const attendanceStatus = z.enum(ATTENDANCE_STATUSES);

// ---------- auth ----------

export const loginRequest = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
  deviceId,
  /** Required only when the account belongs to more than one school. */
  schoolId: uuid.optional(),
});
export type LoginRequest = z.infer<typeof loginRequest>;

export const refreshRequest = z.object({
  refreshToken: z.string().min(20).max(200),
  deviceId,
});
export type RefreshRequest = z.infer<typeof refreshRequest>;

export const logoutRequest = z.object({ refreshToken: z.string().min(20).max(200) });

// ---------- sync: operations pushed from a device ----------

export const attendanceEntry = z.object({
  studentId: uuid,
  status: attendanceStatus,
  /** Version of the record this device last saw; 0 if it had none. */
  baseVersion: z.number().int().min(0),
});
export type AttendanceEntry = z.infer<typeof attendanceEntry>;

export const attendanceRecordOp = z.object({
  opId: uuid,
  type: z.literal("attendance.record"),
  /** Client clock, informational only. The server never orders by it. */
  createdAt: z.string().datetime(),
  payload: z.object({
    classId: uuid,
    date: isoDate,
    entries: z.array(attendanceEntry).min(1).max(100),
  }),
});
export type AttendanceRecordOp = z.infer<typeof attendanceRecordOp>;

/** A union so later operation types slot in without changing the push contract. */
export const syncOp = z.discriminatedUnion("type", [attendanceRecordOp]);
export type SyncOp = z.infer<typeof syncOp>;

export const pushRequest = z.object({
  deviceId,
  ops: z.array(syncOp).min(1).max(50),
});
export type PushRequest = z.infer<typeof pushRequest>;

export const entryOutcome = z.enum(["applied", "noop", "conflict"]);
export const entryResult = z.object({
  studentId: uuid,
  outcome: entryOutcome,
  /** The server's state for this student/date after processing (for a conflict: the value that won). */
  status: attendanceStatus,
  version: z.number().int().min(1),
});
export type EntryResult = z.infer<typeof entryResult>;

export const rejectionReason = z.enum(["forbidden", "invalid", "not_found", "future_date"]);
export type RejectionReason = z.infer<typeof rejectionReason>;

export const opResult = z.object({
  opId: uuid,
  outcome: z.enum(["applied", "conflict", "rejected"]),
  /** True when this operation had already been processed and the stored result is returned. */
  replayed: z.boolean(),
  reason: rejectionReason.optional(),
  entries: z.array(entryResult),
});
export type OpResult = z.infer<typeof opResult>;

export const pushResponse = z.object({ results: z.array(opResult), serverTime: z.string() });
export type PushResponse = z.infer<typeof pushResponse>;

// ---------- sync: replica a device downloads ----------

export const bootstrapResponse = z.object({
  /**
   * A fingerprint of everything below except `serverTime`. A phone sends it back as `since`; if nothing changed the server
   * answers with `bootstrapUnchanged` (a few dozen bytes) instead of the whole replica. Opaque: only ever compared for equality.
   */
  version: z.string(),
  serverTime: z.string(),
  today: isoDate,
  school: z.object({ id: uuid, name: z.string(), timezone: z.string() }),
  classes: z.array(z.object({ id: uuid, name: z.string(), gradeLevel: z.string() })),
  students: z.array(
    z.object({
      id: uuid,
      classId: uuid,
      admissionNo: z.string(),
      firstName: z.string(),
      lastName: z.string(),
    }),
  ),
  todaySlots: z.array(
    z.object({
      id: uuid,
      classId: uuid,
      className: z.string(),
      subject: z.string(),
      startsAt: z.string(),
      endsAt: z.string(),
    }),
  ),
  attendance: z.array(
    z.object({
      studentId: uuid,
      classId: uuid,
      date: isoDate,
      status: attendanceStatus,
      version: z.number().int().min(1),
    }),
  ),
});
export type BootstrapResponse = z.infer<typeof bootstrapResponse>;

/** `?since=` on the bootstrap request: the `version` of the replica this phone already holds. */
export const bootstrapQuery = z.object({ since: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, "Not a valid version").optional() });
export type BootstrapQuery = z.input<typeof bootstrapQuery>;

/** The answer when the phone's replica is still current: nothing to download. */
export const bootstrapUnchanged = z.object({ unchanged: z.literal(true), version: z.string(), serverTime: z.string(), today: isoDate });
export type BootstrapUnchanged = z.infer<typeof bootstrapUnchanged>;

// ---------- admin: attendance summary ----------

export const summaryQuery = z.object({ from: isoDate.optional(), to: isoDate.optional() });

const summaryFigures = z.object({
  present: z.number().int(),
  late: z.number().int(),
  absent: z.number().int(),
  total: z.number().int(),
  attended: z.number().int(),
  rate: z.number().nullable(),
});

export const attendanceSummaryResponse = z.object({
  period: z.object({ from: isoDate, to: isoDate }),
  previousPeriod: z.object({ from: isoDate, to: isoDate }),
  school: summaryFigures,
  previousSchool: summaryFigures,
  /** Percentage points, current minus previous. null if either period has no records. */
  changePoints: z.number().nullable(),
  classes: z.array(
    z.object({
      classId: uuid,
      name: z.string(),
      current: summaryFigures,
      previous: summaryFigures,
      changePoints: z.number().nullable(),
    }),
  ),
});
export type AttendanceSummaryResponse = z.infer<typeof attendanceSummaryResponse>;

/** `field` (Slice 2) names the input a validation or conflict error is about; older clients simply ignore it. */
export const apiError = z.object({ error: z.object({ code: z.string(), message: z.string(), field: z.string().optional() }) });
export type ApiError = z.infer<typeof apiError>;

// ---------- Slice 2: school administration ----------
export * from "./admin.ts";

// ---------- P1: staff onboarding ----------
export * from "./staff.ts";

// ---------- P1: activity screen ----------
export * from "./audit.ts";
