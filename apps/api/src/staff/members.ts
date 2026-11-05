/**
 * The head's side of staff onboarding: who works here, inviting a teacher, switching access off and on, and handing a
 * teacher a password-reset link. Every operation acts on the signed-in head's own school and is audited in the same
 * transaction as the change. Audit details name WHAT changed, never the person's email or name.
 */
import type { InvitationItem, InviteStaffRequest, InviteStaffResponse, ResetLinkResponse, StaffListResponse, StaffMember } from "@schoolpulse/contracts";
import type { StaffMemberRow, StaffTokenRow } from "@schoolpulse/db";
import {
  normaliseEmail, normaliseStaffName, tokenExpiry, validateDeactivation, validateEmail, validateInvitation, validateReactivation,
  validateResetTarget, validateStaffName,
} from "@schoolpulse/domain";
import type { Deps } from "../deps.ts";
import { HttpError } from "../errors.ts";
import type { AuthContext } from "../services/auth.ts";
import { hashOpaqueToken, newOpaqueToken } from "../auth/token.ts";
import { audit, ensure, requireAction, schoolIdOf, withConstraints, type ConstraintRule } from "../school-admin/common.ts";

const notFound = () => new HttpError(404, "not_found", "Not found.");
const headInvitationWaiting = () =>
  new HttpError(409, "head_invitation", "That is a head teacher's invitation. Those are handled by the platform operator, not from here.");

const toMember = (m: StaffMemberRow): StaffMember => ({
  membershipId: m.membershipId, userId: m.userId, name: m.name, email: m.email, role: m.role, active: m.active, joinedAt: m.joinedAt,
});

const toInvitation = (t: StaffTokenRow): InvitationItem => ({
  id: t.id, email: t.email, name: t.name, role: t.role ?? "teacher", createdAt: t.createdAt, expiresAt: t.expiresAt,
});

const linkRules: Record<string, ConstraintRule> = {
  staff_tokens_one_open_invite: { status: 409, code: "invitation_conflict", message: "Someone just sent this person an invitation. Reload and check the list." },
  staff_tokens_one_open_reset: { status: 409, code: "reset_conflict", message: "Someone just made a reset link for this person. Reload and try again." },
};

export async function listStaff(deps: Deps, auth: AuthContext): Promise<StaffListResponse> {
  requireAction(auth, "staff:read");
  const schoolId = schoolIdOf(auth);
  const [members, invitations] = await Promise.all([
    deps.staff.store.listStaff(schoolId),
    deps.staff.store.listOpenInvitations(schoolId, deps.now().toISOString()),
  ]);
  return { members: members.map(toMember), invitations: invitations.map(toInvitation) };
}

/**
 * Creates an invitation for a teacher and returns its secret ONCE. Inviting someone who already has a waiting link
 * replaces it (the old one stops working), which is how a lost link is dealt with.
 */
export async function inviteStaff(deps: Deps, auth: AuthContext, req: InviteStaffRequest): Promise<InviteStaffResponse> {
  requireAction(auth, "staff:manage");
  const schoolId = schoolIdOf(auth);
  ensure(validateEmail(req.email));
  const email = normaliseEmail(req.email);
  let name: string | null = null;
  if (req.name !== undefined && req.name.trim() !== "") {
    ensure(validateStaffName(req.name));
    name = normaliseStaffName(req.name);
  }

  const now = deps.now();
  const id = deps.newId();
  const token = newOpaqueToken();
  const tokenHash = await hashOpaqueToken(token);
  const expiresAt = tokenExpiry("invite", now);

  return withConstraints(linkRules, () =>
    deps.staff.transaction(async (tx) => {
      ensure(validateInvitation(await tx.findStaffByEmail(schoolId, email)));
      // A head's invitation belongs to the platform operator. Replacing it from here would kill the operator's link
      // (and could turn an invited head into a teacher), so this refuses instead.
      const waiting = await tx.listOpenInvitations(schoolId, now.toISOString());
      if (waiting.some((w) => w.email === email && w.role === "head")) throw headInvitationWaiting();
      const replaced = await tx.revokeWaitingInvitations(schoolId, email, now.toISOString());
      await tx.insertToken({
        id, schoolId, purpose: "invite", email, name, role: "teacher", userId: null, tokenHash, expiresAt, createdBy: auth.ctx.user.id,
      });
      await audit(tx, auth, "staff.invited", "staff_invitation", id, { role: "teacher", replacedLinks: replaced });
      const row = await tx.getToken(schoolId, id);
      if (!row) throw new Error("invitation vanished inside its own transaction");
      return { invitation: toInvitation(row), token };
    }),
  );
}

/** Withdraws an invitation that has not been used yet. */
export async function revokeInvitation(deps: Deps, auth: AuthContext, invitationId: string): Promise<void> {
  requireAction(auth, "staff:manage");
  const schoolId = schoolIdOf(auth);
  await deps.staff.transaction(async (tx) => {
    const row = await tx.getToken(schoolId, invitationId);
    if (!row || row.purpose !== "invite") throw notFound();
    if (row.role === "head") throw headInvitationWaiting();
    const revoked = await tx.revokeInvitation(schoolId, invitationId, deps.now().toISOString());
    if (!revoked) throw new HttpError(409, "invitation_not_waiting", "That invitation was already used or withdrawn.");
    await audit(tx, auth, "staff.invitation_revoked", "staff_invitation", invitationId, {});
  });
}

/** Switches a teacher's access off: they are signed out of every device and cannot sign in until it is switched back on. */
export async function deactivateStaff(deps: Deps, auth: AuthContext, membershipId: string): Promise<StaffMember> {
  requireAction(auth, "staff:manage");
  const schoolId = schoolIdOf(auth);
  return deps.staff.transaction(async (tx) => {
    const member = await tx.lockStaffMember(schoolId, membershipId);
    if (!member) throw notFound();
    ensure(validateDeactivation(member));
    await tx.setMembershipActive(schoolId, membershipId, false);
    const sessionsEnded = await tx.revokeSessionsOfMembership(schoolId, membershipId);
    // A reset link made earlier must not outlive the access it was made for.
    const resetLinksWithdrawn = await tx.revokeWaitingResets(schoolId, member.userId, deps.now().toISOString());
    await audit(tx, auth, "staff.deactivated", "membership", membershipId, { sessionsEnded, resetLinksWithdrawn });
    return toMember((await tx.getStaffMember(schoolId, membershipId))!);
  });
}

export async function reactivateStaff(deps: Deps, auth: AuthContext, membershipId: string): Promise<StaffMember> {
  requireAction(auth, "staff:manage");
  const schoolId = schoolIdOf(auth);
  return deps.staff.transaction(async (tx) => {
    const member = await tx.lockStaffMember(schoolId, membershipId);
    if (!member) throw notFound();
    ensure(validateReactivation(member));
    await tx.setMembershipActive(schoolId, membershipId, true);
    await audit(tx, auth, "staff.reactivated", "membership", membershipId, {});
    return toMember((await tx.getStaffMember(schoolId, membershipId))!);
  });
}

/**
 * Makes a one-day link the head can hand to a teacher who forgot their password. A newer link replaces an older one.
 * Refused for an account that also works at another school: its password is not this school's to change.
 */
export async function issuePasswordReset(deps: Deps, auth: AuthContext, membershipId: string): Promise<ResetLinkResponse> {
  requireAction(auth, "staff:manage");
  const schoolId = schoolIdOf(auth);
  const now = deps.now();
  const id = deps.newId();
  const token = newOpaqueToken();
  const tokenHash = await hashOpaqueToken(token);
  const expiresAt = tokenExpiry("reset", now);

  return withConstraints(linkRules, () =>
    deps.staff.transaction(async (tx) => {
      const member = await tx.lockStaffMember(schoolId, membershipId);
      if (!member) throw notFound();
      ensure(validateResetTarget(member, await tx.membershipCountForUser(member.userId)));
      const replaced = await tx.revokeWaitingResets(schoolId, member.userId, now.toISOString());
      await tx.insertToken({
        id, schoolId, purpose: "reset", email: normaliseEmail(member.email), name: null, role: null, userId: member.userId,
        tokenHash, expiresAt, createdBy: auth.ctx.user.id,
      });
      await audit(tx, auth, "staff.reset_link_issued", "membership", membershipId, { replacedLinks: replaced });
      return { token, expiresAt, staffName: member.name };
    }),
  );
}
