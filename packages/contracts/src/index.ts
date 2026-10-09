/**
 * Wire contracts shared by the web app, the API and the sync engine.
 * The server validates every request with these; the client uses the inferred types.
 */
import { z } from "zod";
import { ATTENDANCE_STATUSES, ROLES, isIsoDate } from "@schoolpulse/domain";

export const uuid = z.string().uuid();
export const isoDate = z.string().refine(isIsoDate, "Expected a real calendar date as YYYY-MM-DD");
export const attendanceStatus = z.enum(ATTENDANCE_STATUSES);
export const role = z.enum(ROLES);

// ---------- auth ----------

export const deviceId = z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);

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

export const meResponse = z.object({
  user: z.object({ id: uuid, name: z.string(), email: z.string() }),
  school: z.object({ id: uuid, name: z.string(), timezone: z.string() }),
  role,
});
export type MeResponse = z.infer<typeof meResponse>;

export const tokenResponse = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: z.string(),
  refreshToken: z.string(),
  me: meResponse,
});
export type TokenResponse = z.infer<typeof tokenResponse>;

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

export const apiError = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
export type ApiError = z.infer<typeof apiError>;
