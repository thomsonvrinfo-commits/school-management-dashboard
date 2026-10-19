import type { SqlClient, SqlRunner } from "./sql.ts";
import type { AuditEntry } from "./store.ts";
import type {
  NewMembership, NewSchool, NewStaffToken, NewUser, SchoolSummary, StaffDb, StaffMemberRow, StaffStore, StaffTokenRow, UserAccount,
} from "./staff-store.ts";

// Timestamps come back as text in one fixed shape, whatever the driver does with native types.
const TS = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const MEMBER_SELECT = `m.id as "membershipId", u.id as "userId", u.name, u.email, m.role, m.active, ${TS("m.created_at")} as "joinedAt"`;

const TOKEN_SELECT = `t.id, t.school_id as "schoolId", s.name as "schoolName", t.purpose, t.email, t.name, t.role, t.user_id as "userId",
       ${TS("t.expires_at")} as "expiresAt", ${TS("t.used_at")} as "usedAt", ${TS("t.revoked_at")} as "revokedAt", ${TS("t.created_at")} as "createdAt"`;

export class PostgresStaffStore implements StaffStore {
  private readonly db: SqlClient;
  constructor(db: SqlClient) {
    this.db = db;
  }

  // ---------- the head's view of their own school ----------

  async listStaff(schoolId: string): Promise<StaffMemberRow[]> {
    return this.db.query<StaffMemberRow>(
      `select ${MEMBER_SELECT}
         from memberships m join users u on u.id = m.user_id
        where m.school_id = $1
        order by (m.role = 'head') desc, lower(u.name), u.id`,
      [schoolId],
    );
  }

  async getStaffMember(schoolId: string, membershipId: string): Promise<StaffMemberRow | null> {
    const rows = await this.db.query<StaffMemberRow>(
      `select ${MEMBER_SELECT} from memberships m join users u on u.id = m.user_id where m.school_id = $1 and m.id = $2`,
      [schoolId, membershipId],
    );
    return rows[0] ?? null;
  }

  async lockStaffMember(schoolId: string, membershipId: string): Promise<StaffMemberRow | null> {
    const rows = await this.db.query<StaffMemberRow>(
      `select ${MEMBER_SELECT} from memberships m join users u on u.id = m.user_id
        where m.school_id = $1 and m.id = $2 for no key update of m`,
      [schoolId, membershipId],
    );
    return rows[0] ?? null;
  }

  async findStaffByEmail(schoolId: string, email: string): Promise<StaffMemberRow | null> {
    const rows = await this.db.query<StaffMemberRow>(
      `select ${MEMBER_SELECT} from memberships m join users u on u.id = m.user_id where m.school_id = $1 and lower(u.email) = lower($2)`,
      [schoolId, email],
    );
    return rows[0] ?? null;
  }

  async setMembershipActive(schoolId: string, membershipId: string, active: boolean): Promise<void> {
    await this.db.query(`update memberships set active = $3 where school_id = $1 and id = $2`, [schoolId, membershipId, active]);
  }

  async revokeSessionsOfMembership(schoolId: string, membershipId: string): Promise<number> {
    const rows = await this.db.query(
      `update sessions set revoked_at = now() where school_id = $1 and membership_id = $2 and revoked_at is null returning id`,
      [schoolId, membershipId],
    );
    return rows.length;
  }

  async membershipCountForUser(userId: string): Promise<number> {
    const rows = await this.db.query<{ n: number }>(`select count(*)::int as n from memberships where user_id = $1`, [userId]);
    return rows[0]?.n ?? 0;
  }

  // ---------- invitation and reset links ----------

  async listOpenInvitations(schoolId: string, now: string): Promise<StaffTokenRow[]> {
    return this.db.query<StaffTokenRow>(
      `select ${TOKEN_SELECT} from staff_tokens t join schools s on s.id = t.school_id
        where t.school_id = $1 and t.purpose = 'invite' and t.used_at is null and t.revoked_at is null and t.expires_at > $2::timestamptz
        order by t.created_at desc, t.id`,
      [schoolId, now],
    );
  }

  async getToken(schoolId: string, id: string): Promise<StaffTokenRow | null> {
    const rows = await this.db.query<StaffTokenRow>(
      `select ${TOKEN_SELECT} from staff_tokens t join schools s on s.id = t.school_id where t.school_id = $1 and t.id = $2`,
      [schoolId, id],
    );
    return rows[0] ?? null;
  }

  async insertToken(t: NewStaffToken): Promise<void> {
    await this.db.query(
      `insert into staff_tokens (id, school_id, purpose, email, name, role, user_id, token_hash, expires_at, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10)`,
      [t.id, t.schoolId, t.purpose, t.email, t.name, t.role, t.userId, t.tokenHash, t.expiresAt, t.createdBy],
    );
  }

  async revokeWaitingInvitations(schoolId: string, email: string, now: string): Promise<number> {
    const rows = await this.db.query(
      `update staff_tokens set revoked_at = $3::timestamptz
        where school_id = $1 and purpose = 'invite' and email = lower($2) and used_at is null and revoked_at is null returning id`,
      [schoolId, email, now],
    );
    return rows.length;
  }

  async revokeWaitingResets(schoolId: string, userId: string, now: string): Promise<number> {
    const rows = await this.db.query(
      `update staff_tokens set revoked_at = $3::timestamptz
        where school_id = $1 and purpose = 'reset' and user_id = $2 and used_at is null and revoked_at is null returning id`,
      [schoolId, userId, now],
    );
    return rows.length;
  }

  async revokeInvitation(schoolId: string, id: string, now: string): Promise<boolean> {
    const rows = await this.db.query(
      `update staff_tokens set revoked_at = $3::timestamptz
        where school_id = $1 and id = $2 and purpose = 'invite' and used_at is null and revoked_at is null returning id`,
      [schoolId, id, now],
    );
    return rows.length > 0;
  }

  async findTokenByHash(hash: string): Promise<StaffTokenRow | null> {
    const rows = await this.db.query<StaffTokenRow>(
      `select ${TOKEN_SELECT} from staff_tokens t join schools s on s.id = t.school_id where t.token_hash = $1`,
      [hash],
    );
    return rows[0] ?? null;
  }

  async claimToken(id: string, now: string): Promise<boolean> {
    const rows = await this.db.query(
      `update staff_tokens set used_at = $2::timestamptz
        where id = $1 and used_at is null and revoked_at is null and expires_at > $2::timestamptz returning id`,
      [id, now],
    );
    return rows.length > 0;
  }

  // ---------- accounts ----------

  async findUserByEmail(email: string): Promise<UserAccount | null> {
    const rows = await this.db.query<UserAccount>(
      `select id, email, name, password_hash as "passwordHash", active from users where lower(email) = lower($1)`,
      [email],
    );
    return rows[0] ?? null;
  }

  async getUser(userId: string): Promise<UserAccount | null> {
    const rows = await this.db.query<UserAccount>(
      `select id, email, name, password_hash as "passwordHash", active from users where id = $1`,
      [userId],
    );
    return rows[0] ?? null;
  }

  async insertUser(u: NewUser): Promise<void> {
    await this.db.query(`insert into users (id, email, name, password_hash) values ($1, $2, $3, $4)`, [u.id, u.email, u.name, u.passwordHash]);
  }

  async insertMembership(m: NewMembership): Promise<void> {
    await this.db.query(`insert into memberships (id, user_id, school_id, role) values ($1, $2, $3, $4)`, [m.id, m.userId, m.schoolId, m.role]);
  }

  async setUserPassword(userId: string, passwordHash: string): Promise<void> {
    await this.db.query(`update users set password_hash = $2 where id = $1`, [userId, passwordHash]);
  }

  async revokeAllSessionsOfUser(userId: string): Promise<number> {
    const rows = await this.db.query(`update sessions set revoked_at = now() where user_id = $1 and revoked_at is null returning id`, [userId]);
    return rows.length;
  }

  // ---------- operator commands ----------

  async insertSchool(s: NewSchool): Promise<void> {
    await this.db.query(`insert into schools (id, name, code, timezone) values ($1, $2, $3, $4)`, [s.id, s.name, s.code, s.timezone]);
  }

  async findSchoolByCode(code: string): Promise<SchoolSummary | null> {
    const rows = await this.db.query<SchoolSummary>(`select id, name, code, timezone from schools where upper(code) = upper($1)`, [code]);
    return rows[0] ?? null;
  }

  async getSchool(schoolId: string): Promise<SchoolSummary | null> {
    const rows = await this.db.query<SchoolSummary>(`select id, name, code, timezone from schools where id = $1`, [schoolId]);
    return rows[0] ?? null;
  }

  async schoolsOfUser(userId: string): Promise<SchoolSummary[]> {
    return this.db.query<SchoolSummary>(
      `select s.id, s.name, s.code, s.timezone from memberships m join schools s on s.id = m.school_id where m.user_id = $1 order by s.name, s.id`,
      [userId],
    );
  }

  // ---------- audit ----------

  async appendAudit(e: AuditEntry): Promise<void> {
    await this.db.query(
      `insert into audit_log (school_id, actor_user_id, action, entity_type, entity_id, op_id, details)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [e.schoolId, e.actorUserId, e.action, e.entityType, e.entityId, e.opId, JSON.stringify(e.details)],
    );
  }
}

export function createStaffDb(runner: SqlRunner): StaffDb {
  return {
    store: new PostgresStaffStore(runner),
    transaction: (fn) => runner.transaction((tx) => fn(new PostgresStaffStore(tx))),
  };
}
