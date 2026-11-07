/**
 * Platform-operator commands: creating a school, giving it its first head teacher, and replacing a head's forgotten
 * password. These are NOT reachable from the HTTP API (nothing in routes.ts or app.ts refers to this file; a test
 * checks that). They run from the command line, by someone who already holds the database credentials, and they hand
 * back a link exactly as the head's screen does, so a head teacher's account never needs a password to be typed or
 * pasted anywhere by anyone but the head.
 *
 * Operator actions have no signed-in user, and the audit log requires one, so they are not in the audit log. The
 * command line prints what it did, and the person joining or resetting IS audited from the moment they use the link.
 */
import { schoolCode } from "@schoolpulse/contracts";
import type { StaffDb } from "@schoolpulse/db";
import { classifyDbError } from "@schoolpulse/db";
import {
  isValidTimeZone, normaliseEmail, normaliseStaffName, tokenExpiry, validateEmail, validateOperatorResetTarget, validateStaffName,
} from "@schoolpulse/domain";
import { hashOpaqueToken, newOpaqueToken } from "../auth/token.ts";

export interface OperatorDeps {
  staff: StaffDb;
  now: () => Date;
  newId: () => string;
}

/** A refusal with a message fit to print on a terminal. */
export class OperatorError extends Error {}

const fail = (message: string): never => {
  throw new OperatorError(message);
};

export interface LinkIssued {
  token: string;
  expiresAt: string;
}

export interface SchoolRef {
  id: string;
  name: string;
  code: string | null;
}

async function schoolByCode(deps: OperatorDeps, code: string): Promise<SchoolRef> {
  const school = await deps.staff.store.findSchoolByCode(code.trim());
  return school ?? fail(`No school has the code "${code.trim()}".`);
}

function headDetails(email: string, name: string | undefined): { email: string; name: string | null } {
  const problem = validateEmail(email);
  if (problem) fail(`Head teacher email: ${problem.message}`);
  let cleanName: string | null = null;
  if (name !== undefined && name.trim() !== "") {
    const p = validateStaffName(name);
    if (p) fail(`Head teacher name: ${p.message}`);
    cleanName = normaliseStaffName(name);
  }
  return { email: normaliseEmail(email), name: cleanName };
}

async function insertHeadInvitation(
  tx: StaffDb["store"], deps: OperatorDeps, school: { id: string }, head: { email: string; name: string | null },
): Promise<LinkIssued> {
  const now = deps.now();
  const token = newOpaqueToken();
  const expiresAt = tokenExpiry("invite", now);
  await tx.revokeWaitingInvitations(school.id, head.email, now.toISOString());
  await tx.insertToken({
    id: deps.newId(), schoolId: school.id, purpose: "invite", email: head.email, name: head.name, role: "head", userId: null,
    tokenHash: await hashOpaqueToken(token), expiresAt, createdBy: null,
  });
  return { token, expiresAt };
}

export interface CreateSchoolInput {
  name: string;
  code?: string;
  timezone?: string;
  headEmail: string;
  headName?: string;
}

/** A new school and a seven-day invitation for its first head teacher, in one transaction: both exist or neither does. */
export async function createSchoolWithHead(deps: OperatorDeps, input: CreateSchoolInput): Promise<{ school: SchoolRef; invitation: LinkIssued }> {
  const name = normaliseStaffName(input.name);
  if (name.length < 1 || name.length > 200) fail("The school name must be 1 to 200 characters.");
  let code: string | null = null;
  if (input.code !== undefined && input.code.trim() !== "") {
    const parsed = schoolCode.safeParse(input.code);
    if (!parsed.success) fail(`School code: ${parsed.error.issues[0]?.message ?? "not valid"}.`);
    code = input.code.trim();
  }
  const timezone = input.timezone?.trim() || "Africa/Harare";
  if (!isValidTimeZone(timezone)) fail(`"${timezone}" is not a known time zone (for example Africa/Harare).`);
  const head = headDetails(input.headEmail, input.headName);

  const school: SchoolRef = { id: deps.newId(), name, code };
  try {
    const invitation = await deps.staff.transaction(async (tx) => {
      await tx.insertSchool({ id: school.id, name, code, timezone });
      return insertHeadInvitation(tx, deps, school, head);
    });
    return { school, invitation };
  } catch (e) {
    if (classifyDbError(e).constraint === "schools_code_key") fail(`Another school already uses the code "${code}".`);
    throw e;
  }
}

/**
 * A fresh invitation for a head teacher at an EXISTING school (the first one lapsed, or the school lost its head).
 * Anyone who already holds a membership there, active or not, cannot be invited again.
 */
export async function inviteHead(deps: OperatorDeps, input: { schoolCode: string; headEmail: string; headName?: string }): Promise<{ school: SchoolRef; invitation: LinkIssued; warnings: string[] }> {
  const school = await schoolByCode(deps, input.schoolCode);
  const head = headDetails(input.headEmail, input.headName);
  return deps.staff.transaction(async (tx) => {
    const existing = await tx.findStaffByEmail(school.id, head.email);
    if (existing) fail(`${head.email} already has a membership at ${school.name}${existing.active ? "" : " (switched off)"}.`);
    const heads = (await tx.listStaff(school.id)).filter((m) => m.role === "head" && m.active);
    const warnings = heads.length > 0 ? [`${school.name} already has ${heads.length} active head teacher${heads.length === 1 ? "" : "s"}; this adds another.`] : [];
    return { school, invitation: await insertHeadInvitation(tx, deps, school, head), warnings };
  });
}

/** A one-day link for a head teacher who has forgotten their password. The head chooses the new password; nobody else sees it. */
export async function resetHeadPassword(deps: OperatorDeps, input: { schoolCode: string; headEmail: string }): Promise<{ school: SchoolRef; headName: string; reset: LinkIssued; warnings: string[] }> {
  const school = await schoolByCode(deps, input.schoolCode);
  const email = normaliseEmail(input.headEmail);
  return deps.staff.transaction(async (tx) => {
    const member = await tx.findStaffByEmail(school.id, email);
    if (!member) return fail(`${email} has no membership at ${school.name}.`);
    if (member.role !== "head") return fail(`${email} is a teacher at ${school.name}. A head teacher resets a teacher's password from the Staff screen.`);
    const refused = validateOperatorResetTarget(member);
    if (refused) return fail(`${email}: ${refused.message} Switch access back on first.`);
    const warnings: string[] = [];
    const schools = await tx.schoolsOfUser(member.userId);
    if (schools.length > 1) warnings.push(`This account also works at ${schools.length - 1} other school(s); changing its password changes it everywhere.`);

    const now = deps.now();
    const token = newOpaqueToken();
    const expiresAt = tokenExpiry("reset", now);
    await tx.revokeWaitingResets(school.id, member.userId, now.toISOString());
    await tx.insertToken({
      id: deps.newId(), schoolId: school.id, purpose: "reset", email: normaliseEmail(member.email), name: null, role: null, userId: member.userId,
      tokenHash: await hashOpaqueToken(token), expiresAt, createdBy: null,
    });
    return { school, headName: member.name, reset: { token, expiresAt }, warnings };
  });
}
