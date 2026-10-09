/** What the API needs from persistence. Implemented once, against PostgreSQL. */
import type { AttendanceStatus, Role } from "@schoolpulse/domain";

export interface UserRow { id: string; email: string; name: string; passwordHash: string; active: boolean }
export interface MembershipRow { id: string; schoolId: string; schoolName: string; role: Role }
export interface SessionRow {
  id: string; userId: string; schoolId: string; membershipId: string; deviceId: string; expiresAt: string; revoked: boolean;
}
/** Everything the API needs to know about who is calling, read fresh from the database on every request. */
export interface ActiveContext {
  sessionId: string; deviceId: string;
  user: { id: string; name: string; email: string };
  school: { id: string; name: string; timezone: string };
  role: Role;
}
export interface ClassRow { id: string; name: string; gradeLevel: string }
export interface StudentRow { id: string; classId: string; admissionNo: string; firstName: string; lastName: string }
export interface SlotRow { id: string; classId: string; className: string; subject: string; startsAt: string; endsAt: string }
export interface AttendanceRow {
  id: string; studentId: string; classId: string; date: string; status: AttendanceStatus; version: number;
  /** The device that wrote the current value. */
  deviceId: string;
}
export interface ClassCounts { classId: string; name: string; present: number; late: number; absent: number }

export interface NewSession {
  id: string; userId: string; schoolId: string; membershipId: string; deviceId: string; refreshHash: string; expiresAt: string;
}
export interface AttendanceWrite {
  schoolId: string; studentId: string; classId: string; date: string; status: AttendanceStatus;
  recordedBy: string; deviceId: string; opId: string;
}
export interface AuditEntry {
  schoolId: string; actorUserId: string; action: string; entityType: string; entityId: string | null;
  opId: string | null; details: unknown;
}

export interface Store {
  // identity
  findUserByEmail(email: string): Promise<UserRow | null>;
  listMemberships(userId: string): Promise<MembershipRow[]>;
  createSession(s: NewSession): Promise<void>;
  findSessionByRefreshHash(hash: string): Promise<SessionRow | null>;
  rotateSession(id: string, newHash: string, expiresAt: string): Promise<void>;
  revokeSession(id: string): Promise<void>;
  getActiveContext(sessionId: string, now: string): Promise<ActiveContext | null>;

  // teaching
  teacherClasses(schoolId: string, userId: string): Promise<ClassRow[]>;
  teachesClass(schoolId: string, userId: string, classId: string): Promise<boolean>;
  classExists(schoolId: string, classId: string): Promise<boolean>;
  enrolledStudents(schoolId: string, classIds: readonly string[], onDate: string): Promise<StudentRow[]>;
  timetableForTeacher(schoolId: string, userId: string, weekday: number): Promise<SlotRow[]>;
  attendanceInRange(schoolId: string, classIds: readonly string[], from: string, to: string): Promise<AttendanceRow[]>;

  // attendance writes (call inside a transaction)
  lockAttendance(schoolId: string, studentIds: readonly string[], date: string): Promise<AttendanceRow[]>;
  insertAttendance(w: AttendanceWrite): Promise<{ version: number } | null>;
  updateAttendance(w: AttendanceWrite, nextVersion: number): Promise<void>;

  // idempotency (call inside a transaction)
  claimOperation(schoolId: string, opId: string, userId: string, deviceId: string, type: string): Promise<boolean>;
  getOperation(schoolId: string, opId: string): Promise<{ userId: string; result: unknown } | null>;
  saveOperationResult(schoolId: string, opId: string, result: unknown): Promise<void>;
  appendAudit(e: AuditEntry): Promise<void>;

  // admin
  attendanceCountsByClass(schoolId: string, from: string, to: string): Promise<ClassCounts[]>;
}

/** Runs `fn` in a single database transaction with a Store bound to it. */
export interface Db {
  store: Store;
  transaction<T>(fn: (store: Store) => Promise<T>): Promise<T>;
}
