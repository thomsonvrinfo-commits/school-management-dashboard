/**
 * What staff onboarding needs from persistence (P1). Implemented once, against PostgreSQL, on the same `SqlRunner` as
 * the Slice 1 `Store` and the Slice 2 `AdminStore`.
 *
 * It has its own store because one operation (accepting an invitation, say) must create a user, a membership and mark
 * the link used in ONE transaction, which touches tables the other two stores split between them. Methods that touch
 * tenant data take the school id and filter by it. The only lookups that do not are the ones a person with a link
 * needs BEFORE anyone knows their school: `findTokenByHash` and the user lookups. Those return the school the link was
 * issued for, and everything after them is scoped to it.
 */
import type { Role } from "@schoolpulse/domain";
import type { AuditEntry } from "./store.ts";

export interface StaffMemberRow {
  membershipId: string; userId: string; name: string; email: string; role: Role; active: boolean; joinedAt: string;
}

export type TokenPurpose = "invite" | "reset";

export interface StaffTokenRow {
  id: string; schoolId: string; schoolName: string; purpose: TokenPurpose;
  email: string; name: string | null; role: Role | null; userId: string | null;
  expiresAt: string; usedAt: string | null; revokedAt: string | null; createdAt: string;
  /** The head who issued it, or null when the platform operator did (from the command line). */
  createdBy: string | null;
}

export interface NewStaffToken {
  id: string; schoolId: string; purpose: TokenPurpose; email: string; name: string | null; role: Role | null;
  userId: string | null; tokenHash: string; expiresAt: string; createdBy: string | null;
}

export interface UserAccount { id: string; email: string; name: string; passwordHash: string; active: boolean }
export interface NewUser { id: string; email: string; name: string; passwordHash: string }
export interface NewMembership { id: string; userId: string; schoolId: string; role: Role }

export interface SchoolSummary { id: string; name: string; code: string | null; timezone: string }
export interface NewSchool { id: string; name: string; code: string | null; timezone: string }

export interface StaffStore {
  // ---- the head's view of their own school ----
  /** Everyone with a membership here, heads first, then by name. */
  listStaff(schoolId: string): Promise<StaffMemberRow[]>;
  getStaffMember(schoolId: string, membershipId: string): Promise<StaffMemberRow | null>;
  /** Like getStaffMember, but row-locks the membership so two heads acting on the same person queue up. */
  lockStaffMember(schoolId: string, membershipId: string): Promise<StaffMemberRow | null>;
  /** Matches the sign-in email ignoring case. */
  findStaffByEmail(schoolId: string, email: string): Promise<StaffMemberRow | null>;
  setMembershipActive(schoolId: string, membershipId: string, active: boolean): Promise<void>;
  /** Signs the person out of every device at this school. Returns how many sessions were ended. */
  revokeSessionsOfMembership(schoolId: string, membershipId: string): Promise<number>;
  /** In how many schools does this account hold a membership (active or not)? */
  membershipCountForUser(userId: string): Promise<number>;

  // ---- invitation and reset links ----
  /** Links that are still waiting: not used, not revoked, not past `now`. Newest first. */
  listOpenInvitations(schoolId: string, now: string): Promise<StaffTokenRow[]>;
  getToken(schoolId: string, id: string): Promise<StaffTokenRow | null>;
  insertToken(t: NewStaffToken): Promise<void>;
  /** Retires every link of this purpose that is still waiting for the person (used before issuing a replacement). */
  revokeWaitingInvitations(schoolId: string, email: string, now: string): Promise<number>;
  revokeWaitingResets(schoolId: string, userId: string, now: string): Promise<number>;
  /** Revokes one invitation that is still waiting. False if it was already used, revoked or does not exist here. */
  revokeInvitation(schoolId: string, id: string, now: string): Promise<boolean>;
  /** Public lookup by the token's hash. The school comes from the row, never from the caller. */
  findTokenByHash(hash: string): Promise<StaffTokenRow | null>;
  /**
   * Marks the link used if, and only if, it is still waiting. Atomic: when two people open the same link at the same
   * moment exactly one gets `true`.
   */
  claimToken(id: string, now: string): Promise<boolean>;

  // ---- accounts ----
  findUserByEmail(email: string): Promise<UserAccount | null>;
  getUser(userId: string): Promise<UserAccount | null>;
  insertUser(u: NewUser): Promise<void>;
  insertMembership(m: NewMembership): Promise<void>;
  setUserPassword(userId: string, passwordHash: string): Promise<void>;
  /** Signs the account out everywhere. Returns how many sessions were ended. */
  revokeAllSessionsOfUser(userId: string): Promise<number>;

  // ---- operator commands (never reachable from the HTTP API) ----
  insertSchool(s: NewSchool): Promise<void>;
  findSchoolByCode(code: string): Promise<SchoolSummary | null>;
  getSchool(schoolId: string): Promise<SchoolSummary | null>;
  /** Schools where this account holds a membership. */
  schoolsOfUser(userId: string): Promise<SchoolSummary[]>;

  // ---- audit (same transaction as the change it describes) ----
  appendAudit(e: AuditEntry): Promise<void>;
}

export interface StaffDb {
  store: StaffStore;
  transaction<T>(fn: (store: StaffStore) => Promise<T>): Promise<T>;
}
