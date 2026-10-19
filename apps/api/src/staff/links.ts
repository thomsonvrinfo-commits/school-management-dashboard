/**
 * The three endpoints a person reaches with a link and no sign-in: look at an invitation, accept it, or finish a
 * password reset. The school is taken from the link's own row, never from the request. A link is 256 random bits, kept
 * only as a hash, single-use (claimed atomically), and expires; a link that cannot be used says which of those happened.
 */
import type { AcceptInvitationRequest, CompletePasswordResetRequest, InvitationPreview, PreviewInvitationRequest, TokenResponse } from "@schoolpulse/contracts";
import type { StaffStore, StaffTokenRow } from "@schoolpulse/db";
import {
  normaliseStaffName, tokenProblem, tokenState, validateInvitation, validateOperatorResetTarget, validatePassword, validateResetTarget, validateStaffName,
  type Problem,
} from "@schoolpulse/domain";
import type { Deps } from "../deps.ts";
import { HttpError } from "../errors.ts";
import { hashPassword, verifyPassword } from "../auth/password.ts";
import { hashOpaqueToken } from "../auth/token.ts";
import { startSession } from "../services/auth.ts";
import { ensure, withConstraints, type ConstraintRule } from "../school-admin/common.ts";

/** A link that does not exist looks the same as one for the wrong purpose: the caller learns nothing about either. */
const unknownLink = () => new HttpError(404, "link_not_found", "This link is not valid. Ask your head teacher for a new one.");

/** Link problems are about the state of the link (used, expired, revoked): a conflict, not a malformed request. */
const linkError = (p: Problem): HttpError => new HttpError(409, p.code, p.message, p.field);

async function findLink(deps: Deps, token: string, purpose: "invite" | "reset"): Promise<StaffTokenRow> {
  const row = await deps.staff.store.findTokenByHash(await hashOpaqueToken(token));
  if (!row || row.purpose !== purpose) throw unknownLink();
  return row;
}

function requireUsable(row: StaffTokenRow, now: Date): void {
  const state = tokenState(row, now);
  if (state !== "usable") throw linkError(tokenProblem(state));
}

/**
 * Uses up the link, or says why that is no longer possible. Two people opening the same link at the same moment: the
 * database lets exactly one claim win; the other is told the link was used (or whatever happened to it in between).
 */
async function claimOrExplain(tx: StaffStore, deps: Deps, row: StaffTokenRow): Promise<void> {
  const now = deps.now();
  if (await tx.claimToken(row.id, now.toISOString())) return;
  const fresh = await tx.getToken(row.schoolId, row.id);
  const state = fresh ? tokenState(fresh, now) : "used";
  throw linkError(tokenProblem(state === "usable" ? "used" : state));
}

const acceptRules: Record<string, ConstraintRule> = {
  users_email_lower_key: { status: 409, code: "account_exists", message: "An account with this email was just created. Open the link again to continue." },
  memberships_user_id_school_id_key: { status: 409, code: "already_a_member", message: "This person already works at the school." },
};

export async function previewInvitation(deps: Deps, req: PreviewInvitationRequest): Promise<InvitationPreview> {
  const row = await findLink(deps, req.token, "invite");
  requireUsable(row, deps.now());
  const account = await deps.staff.store.findUserByEmail(row.email);
  return {
    schoolName: row.schoolName, email: row.email, role: row.role ?? "teacher", suggestedName: row.name,
    accountExists: account !== null, expiresAt: row.expiresAt,
  };
}

/**
 * Accepting an invitation. A new person chooses a name and a password; someone who already has an account (at another
 * school) proves it is theirs with their current password. The role comes from the invitation, never from the request.
 * The account (if new), the membership and the used-up link are one transaction, so a failure leaves nothing half-done.
 * Then the person is signed in exactly as a normal sign-in would.
 */
export async function acceptInvitation(deps: Deps, req: AcceptInvitationRequest): Promise<TokenResponse> {
  const store = deps.staff.store;
  const row = await findLink(deps, req.token, "invite");
  requireUsable(row, deps.now());

  const existing = await store.findUserByEmail(row.email);
  let newAccount: { name: string; passwordHash: string } | null = null;
  if (existing) {
    if (!existing.active || !(await verifyPassword(req.password, existing.passwordHash))) {
      throw new HttpError(401, "invalid_credentials", "That is not the right password for this email address.", "password");
    }
  } else {
    const name = normaliseStaffName(req.name && req.name.trim() !== "" ? req.name : (row.name ?? ""));
    ensure(validateStaffName(name));
    ensure(validatePassword(req.password, { email: row.email, name }));
    // Hashed BEFORE the transaction opens: it is the slow step and nothing should be locked while it runs.
    newAccount = { name, passwordHash: await hashPassword(req.password) };
  }

  const membershipId = deps.newId();
  const userId = existing?.id ?? deps.newId();
  const role = row.role ?? "teacher";

  await withConstraints(acceptRules, () =>
    deps.staff.transaction(async (tx) => {
      await claimOrExplain(tx, deps, row);
      ensure(validateInvitation(await tx.findStaffByEmail(row.schoolId, row.email)));
      if (newAccount) await tx.insertUser({ id: userId, email: row.email, name: newAccount.name, passwordHash: newAccount.passwordHash });
      await tx.insertMembership({ id: membershipId, userId, schoolId: row.schoolId, role });
      await tx.appendAudit({
        schoolId: row.schoolId, actorUserId: userId, action: "staff.joined", entityType: "membership", entityId: membershipId,
        opId: null, details: { role, newAccount: newAccount !== null, invitationId: row.id },
      });
    }),
  );

  return startSession(deps, { id: userId }, { id: membershipId, schoolId: row.schoolId }, req.deviceId);
}

/**
 * Finishing a reset: chooses the new password, ends every session the account has, and uses up the link. The rules that
 * allowed the link to be made are checked AGAIN here (the person may have been switched off, or joined another school,
 * since). The membership is locked while that happens as belt and braces; what actually stops a reset from slipping past
 * a simultaneous "switch off" is that switching off withdraws the person's waiting links in its own transaction, so the
 * claim below fails.
 */
export async function completePasswordReset(deps: Deps, req: CompletePasswordResetRequest): Promise<void> {
  const row = await findLink(deps, req.token, "reset");
  requireUsable(row, deps.now());
  const user = row.userId ? await deps.staff.store.getUser(row.userId) : null;
  if (!user || !user.active) throw unknownLink();

  ensure(validatePassword(req.password, { email: user.email, name: user.name }));
  const passwordHash = await hashPassword(req.password);

  await deps.staff.transaction(async (tx) => {
    const member = await tx.findStaffByEmail(row.schoolId, user.email);
    const locked = member ? await tx.lockStaffMember(row.schoolId, member.membershipId) : null;
    if (!locked) throw unknownLink();
    // A link a head made is held to the head's rules; one the operator made (no head behind it) only needs the access to be on.
    ensure(row.createdBy === null ? validateOperatorResetTarget(locked) : validateResetTarget(locked, await tx.membershipCountForUser(user.id)));
    await claimOrExplain(tx, deps, row);
    await tx.setUserPassword(user.id, passwordHash);
    const sessionsEnded = await tx.revokeAllSessionsOfUser(user.id);
    await tx.appendAudit({
      schoolId: row.schoolId, actorUserId: user.id, action: "staff.password_reset", entityType: "membership", entityId: locked.membershipId,
      opId: null, details: { sessionsEnded, resetLinkId: row.id },
    });
  });
}
