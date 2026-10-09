import type { SqlClient, SqlRunner } from "./sql.ts";
import type {
  ActiveContext, AttendanceRow, AttendanceWrite, AuditEntry, ClassCounts, ClassRow, Db, MembershipRow,
  NewSession, SessionRow, SlotRow, Store, StudentRow, UserRow,
} from "./store.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres array literal for a `$n::uuid[]` parameter. Ids are checked, so the literal cannot be malformed. */
export function uuidArray(ids: readonly string[]): string {
  for (const id of ids) if (!UUID.test(id)) throw new TypeError(`Not a UUID: ${id}`);
  return `{${ids.join(",")}}`;
}

// Timestamps and dates come back as text in a fixed shape, whatever the driver does with native types.
const TS = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

export class PostgresStore implements Store {
  private readonly db: SqlClient;
  constructor(db: SqlClient) {
    this.db = db;
  }

  // ---------- identity ----------

  async findUserByEmail(email: string): Promise<UserRow | null> {
    const rows = await this.db.query<UserRow>(
      `select id, email, name, password_hash as "passwordHash", active from users where lower(email) = lower($1)`,
      [email],
    );
    return rows[0] ?? null;
  }

  async listMemberships(userId: string): Promise<MembershipRow[]> {
    return this.db.query<MembershipRow>(
      `select m.id, m.school_id as "schoolId", s.name as "schoolName", m.role
         from memberships m join schools s on s.id = m.school_id
        where m.user_id = $1 and m.active order by s.name`,
      [userId],
    );
  }

  async createSession(s: NewSession): Promise<void> {
    await this.db.query(
      `insert into sessions (id, user_id, school_id, membership_id, device_id, refresh_hash, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
      [s.id, s.userId, s.schoolId, s.membershipId, s.deviceId, s.refreshHash, s.expiresAt],
    );
  }

  async findSessionByRefreshHash(hash: string): Promise<SessionRow | null> {
    const rows = await this.db.query<SessionRow>(
      `select id, user_id as "userId", school_id as "schoolId", membership_id as "membershipId",
              device_id as "deviceId", ${TS("expires_at")} as "expiresAt", (revoked_at is not null) as revoked
         from sessions where refresh_hash = $1`,
      [hash],
    );
    return rows[0] ?? null;
  }

  async rotateSession(id: string, newHash: string, expiresAt: string): Promise<void> {
    await this.db.query(
      `update sessions set refresh_hash = $2, expires_at = $3::timestamptz where id = $1 and revoked_at is null`,
      [id, newHash, expiresAt],
    );
  }

  async revokeSession(id: string): Promise<void> {
    await this.db.query(`update sessions set revoked_at = coalesce(revoked_at, now()) where id = $1`, [id]);
  }

  async getActiveContext(sessionId: string, now: string): Promise<ActiveContext | null> {
    const rows = await this.db.query<{
      sessionId: string; deviceId: string; userId: string; userName: string; userEmail: string;
      schoolId: string; schoolName: string; timezone: string; role: ActiveContext["role"];
    }>(
      `select se.id as "sessionId", se.device_id as "deviceId",
              u.id as "userId", u.name as "userName", u.email as "userEmail",
              sc.id as "schoolId", sc.name as "schoolName", sc.timezone, m.role
         from sessions se
         join users u on u.id = se.user_id and u.active
         join memberships m on m.school_id = se.school_id and m.id = se.membership_id and m.active
         join schools sc on sc.id = se.school_id
        where se.id = $1 and se.revoked_at is null and se.expires_at > $2::timestamptz`,
      [sessionId, now],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      sessionId: r.sessionId,
      deviceId: r.deviceId,
      user: { id: r.userId, name: r.userName, email: r.userEmail },
      school: { id: r.schoolId, name: r.schoolName, timezone: r.timezone },
      role: r.role,
    };
  }

  // ---------- teaching ----------

  async teacherClasses(schoolId: string, userId: string): Promise<ClassRow[]> {
    return this.db.query<ClassRow>(
      `select c.id, c.name, c.grade_level as "gradeLevel"
         from classes c join class_teachers ct on ct.school_id = c.school_id and ct.class_id = c.id
        where c.school_id = $1 and ct.user_id = $2 order by c.name`,
      [schoolId, userId],
    );
  }

  async teachesClass(schoolId: string, userId: string, classId: string): Promise<boolean> {
    const rows = await this.db.query(
      `select 1 from class_teachers where school_id = $1 and user_id = $2 and class_id = $3`,
      [schoolId, userId, classId],
    );
    return rows.length > 0;
  }

  async classExists(schoolId: string, classId: string): Promise<boolean> {
    const rows = await this.db.query(`select 1 from classes where school_id = $1 and id = $2`, [schoolId, classId]);
    return rows.length > 0;
  }

  async enrolledStudents(schoolId: string, classIds: readonly string[], onDate: string): Promise<StudentRow[]> {
    if (classIds.length === 0) return [];
    return this.db.query<StudentRow>(
      `select s.id, e.class_id as "classId", s.admission_no as "admissionNo",
              s.first_name as "firstName", s.last_name as "lastName"
         from enrollments e join students s on s.school_id = e.school_id and s.id = e.student_id
        where e.school_id = $1 and e.class_id = any($2::uuid[]) and s.active
          and e.starts_on <= $3::date and (e.ends_on is null or e.ends_on >= $3::date)
        order by s.last_name, s.first_name`,
      [schoolId, uuidArray(classIds), onDate],
    );
  }

  async timetableForTeacher(schoolId: string, userId: string, weekday: number): Promise<SlotRow[]> {
    return this.db.query<SlotRow>(
      `select t.id, t.class_id as "classId", c.name as "className", t.subject,
              to_char(t.starts_at, 'HH24:MI') as "startsAt", to_char(t.ends_at, 'HH24:MI') as "endsAt"
         from timetable_slots t join classes c on c.school_id = t.school_id and c.id = t.class_id
        where t.school_id = $1 and t.teacher_user_id = $2 and t.weekday = $3
        order by t.starts_at`,
      [schoolId, userId, weekday],
    );
  }

  async attendanceInRange(schoolId: string, classIds: readonly string[], from: string, to: string): Promise<AttendanceRow[]> {
    if (classIds.length === 0) return [];
    return this.db.query<AttendanceRow>(
      `select id, student_id as "studentId", class_id as "classId", to_char(date, 'YYYY-MM-DD') as date, status, version, device_id as "deviceId"
         from attendance_records
        where school_id = $1 and class_id = any($2::uuid[]) and date between $3::date and $4::date
        order by date, student_id`,
      [schoolId, uuidArray(classIds), from, to],
    );
  }

  // ---------- attendance writes ----------

  async lockAttendance(schoolId: string, studentIds: readonly string[], date: string): Promise<AttendanceRow[]> {
    if (studentIds.length === 0) return [];
    return this.db.query<AttendanceRow>(
      `select id, student_id as "studentId", class_id as "classId", to_char(date, 'YYYY-MM-DD') as date, status, version, device_id as "deviceId"
         from attendance_records
        where school_id = $1 and student_id = any($2::uuid[]) and date = $3::date
        order by student_id
          for update`,
      [schoolId, uuidArray(studentIds), date],
    );
  }

  async insertAttendance(w: AttendanceWrite): Promise<{ version: number } | null> {
    const rows = await this.db.query<{ version: number }>(
      `insert into attendance_records (school_id, student_id, class_id, date, status, recorded_by, device_id, op_id)
       values ($1, $2, $3, $4::date, $5, $6, $7, $8)
       on conflict (school_id, student_id, date) do nothing
       returning version`,
      [w.schoolId, w.studentId, w.classId, w.date, w.status, w.recordedBy, w.deviceId, w.opId],
    );
    return rows[0] ?? null;
  }

  async updateAttendance(w: AttendanceWrite, nextVersion: number): Promise<void> {
    await this.db.query(
      `update attendance_records
          set status = $4, version = $5, class_id = $6, recorded_by = $7, device_id = $8, op_id = $9,
              updated_at = clock_timestamp()
        where school_id = $1 and student_id = $2 and date = $3::date`,
      [w.schoolId, w.studentId, w.date, w.status, nextVersion, w.classId, w.recordedBy, w.deviceId, w.opId],
    );
  }

  // ---------- idempotency + audit ----------

  async claimOperation(schoolId: string, opId: string, userId: string, deviceId: string, type: string): Promise<boolean> {
    const rows = await this.db.query(
      `insert into processed_operations (school_id, op_id, user_id, device_id, type)
       values ($1, $2, $3, $4, $5) on conflict do nothing returning op_id`,
      [schoolId, opId, userId, deviceId, type],
    );
    return rows.length > 0;
  }

  async getOperation(schoolId: string, opId: string): Promise<{ userId: string; result: unknown } | null> {
    const rows = await this.db.query<{ userId: string; result: unknown }>(
      `select user_id as "userId", result from processed_operations where school_id = $1 and op_id = $2`,
      [schoolId, opId],
    );
    const r = rows[0];
    if (!r) return null;
    return { userId: r.userId, result: typeof r.result === "string" ? JSON.parse(r.result) : r.result };
  }

  async saveOperationResult(schoolId: string, opId: string, result: unknown): Promise<void> {
    await this.db.query(
      `update processed_operations set result = $3::jsonb where school_id = $1 and op_id = $2`,
      [schoolId, opId, JSON.stringify(result)],
    );
  }

  async appendAudit(e: AuditEntry): Promise<void> {
    await this.db.query(
      `insert into audit_log (school_id, actor_user_id, action, entity_type, entity_id, op_id, details)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [e.schoolId, e.actorUserId, e.action, e.entityType, e.entityId, e.opId, JSON.stringify(e.details)],
    );
  }

  // ---------- admin ----------

  async attendanceCountsByClass(schoolId: string, from: string, to: string): Promise<ClassCounts[]> {
    return this.db.query<ClassCounts>(
      `select c.id as "classId", c.name,
              (count(a.id) filter (where a.status = 'present'))::int as present,
              (count(a.id) filter (where a.status = 'late'))::int as late,
              (count(a.id) filter (where a.status = 'absent'))::int as absent
         from classes c
         left join attendance_records a
           on a.school_id = c.school_id and a.class_id = c.id and a.date between $2::date and $3::date
        where c.school_id = $1
        group by c.id, c.name order by c.name`,
      [schoolId, from, to],
    );
  }
}

export function createDb(runner: SqlRunner): Db {
  return {
    store: new PostgresStore(runner),
    transaction: (fn) => runner.transaction((tx) => fn(new PostgresStore(tx))),
  };
}
