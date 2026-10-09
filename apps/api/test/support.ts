import assert from "node:assert/strict";
import { createTestDatabase, type TestDatabase } from "@schoolpulse/db/testing";
import { DEV_ACCOUNTS, DEV_IDS, seedDev } from "@schoolpulse/db";
import type { AttendanceRecordOp, OpResult, TokenResponse } from "@schoolpulse/contracts";
import type { Deps } from "../src/deps.ts";
import { hashPassword } from "../src/auth/password.ts";
import { authenticate, login, type AuthContext } from "../src/services/auth.ts";

export const PASSWORD = "correct horse battery";
export const TODAY = "2026-10-08"; // Thursday
export const NOW_ISO = "2026-10-08T06:05:00.000Z"; // 08:05 in Harare
export const SECRET = "test-secret-test-secret-test-secret-0123";

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const EXTRA = {
  tendai: uid(12), // a second teacher at Mavambo, also teaches 7A
  tendaiMembership: uid(22),
  class5A: uid(103), // not taught by Ms. Chipo
  student5A: uid(2001),
  otherSchool: uid(2),
  otherTeacher: uid(13),
  otherTeacherMembership: uid(23),
  otherClass: uid(200),
  multiUser: uid(14),
};

export interface Fixture {
  t: TestDatabase;
  deps: Deps;
  clock: { now: Date };
  close(): Promise<void>;
}

export async function makeFixture(): Promise<Fixture> {
  const t = await createTestDatabase();
  const passwordHash = await hashPassword(PASSWORD);
  await seedDev(t.runner, { today: TODAY, passwordHash });
  const q = (sql: string, p: (string | number | null)[] = []) => t.runner.query(sql, p);

  // a second teacher in the same school, assigned to 7A
  await q(`insert into users (id, email, name, password_hash) values ($1, 'tendai@mavambo.example', 'Mr. Tendai', $2)`, [EXTRA.tendai, passwordHash]);
  await q(`insert into memberships (id, user_id, school_id, role) values ($1, $2, $3, 'teacher')`, [EXTRA.tendaiMembership, EXTRA.tendai, DEV_IDS.school]);
  await q(`insert into class_teachers (school_id, class_id, user_id) values ($1, $2, $3)`, [DEV_IDS.school, DEV_IDS.class7A, EXTRA.tendai]);
  // a class Ms. Chipo does not teach
  await q(`insert into classes (id, school_id, name, grade_level) values ($1, $2, 'Grade 5A', '5')`, [EXTRA.class5A, DEV_IDS.school]);
  await q(`insert into students (id, school_id, admission_no, first_name, last_name) values ($1, $2, 'MA9001', 'Kuda', 'Moyo')`, [EXTRA.student5A, DEV_IDS.school]);
  await q(`insert into enrollments (school_id, student_id, class_id, starts_on) values ($1, $2, $3, '2026-01-12')`, [DEV_IDS.school, EXTRA.student5A, EXTRA.class5A]);
  // a completely separate school with its own teacher and class
  await q(`insert into schools (id, name) values ($1, 'Other School')`, [EXTRA.otherSchool]);
  await q(`insert into users (id, email, name, password_hash) values ($1, 'teacher@other.example', 'Other Teacher', $2)`, [EXTRA.otherTeacher, passwordHash]);
  await q(`insert into memberships (id, user_id, school_id, role) values ($1, $2, $3, 'teacher')`, [EXTRA.otherTeacherMembership, EXTRA.otherTeacher, EXTRA.otherSchool]);
  await q(`insert into classes (id, school_id, name, grade_level) values ($1, $2, 'Form 1A', '8')`, [EXTRA.otherClass, EXTRA.otherSchool]);
  await q(`insert into class_teachers (school_id, class_id, user_id) values ($1, $2, $3)`, [EXTRA.otherSchool, EXTRA.otherClass, EXTRA.otherTeacher]);

  const clock = { now: new Date(NOW_ISO) };
  let n = 0;
  const deps: Deps = {
    db: t.db,
    now: () => clock.now,
    newId: () => crypto.randomUUID(),
    authSecret: SECRET,
  };
  void n;
  return { t, deps, clock, close: () => t.drop() };
}

export const EMAILS = { head: DEV_ACCOUNTS.head.email, chipo: DEV_ACCOUNTS.teacher.email, tendai: "tendai@mavambo.example", other: "teacher@other.example" };

export async function signIn(deps: Deps, email: string, deviceId: string, schoolId?: string): Promise<{ tokens: TokenResponse; auth: AuthContext; header: string }> {
  const tokens = await login(deps, { email, password: PASSWORD, deviceId, schoolId });
  const header = `Bearer ${tokens.accessToken}`;
  return { tokens, header, auth: await authenticate(deps, header) };
}

export async function studentsOf(f: Fixture, classId: string, date = TODAY): Promise<string[]> {
  const rows = await f.deps.db.store.enrolledStudents(DEV_IDS.school, [classId], date);
  return rows.map((r) => r.id);
}

export function attendanceOp(classId: string, date: string, entries: { studentId: string; status: "present" | "late" | "absent"; baseVersion?: number }[], opId = crypto.randomUUID()): AttendanceRecordOp {
  return {
    opId, type: "attendance.record", createdAt: "2026-10-08T06:00:00.000Z",
    payload: { classId, date, entries: entries.map((e) => ({ studentId: e.studentId, status: e.status, baseVersion: e.baseVersion ?? 0 })) },
  };
}

export function only(results: OpResult[]): OpResult {
  assert.equal(results.length, 1);
  return results[0]!;
}
