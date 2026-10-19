import type { AuditEntry } from "@schoolpulse/db";
import { classifyDbError } from "@schoolpulse/db";
import { authorize, todayInTimezone, type Action, type Problem } from "@schoolpulse/domain";
import type { Deps } from "../deps.ts";
import { HttpError } from "../errors.ts";
import type { AuthContext } from "../services/auth.ts";

/**
 * Per-request permission check. The school comes from the authenticated session (never from the request), so the
 * tenant boundary check inside `authorize` is a second line of defence, and every query below is scoped by the same id.
 */
export function requireAction(auth: AuthContext, action: Action, extra: { classId?: string; teachesClass?: boolean } = {}): void {
  const d = authorize(auth.principal, action, { schoolId: auth.ctx.school.id, ...extra });
  if (!d.allowed) throw new HttpError(403, "forbidden", "You do not have permission to do that.");
}

export const schoolIdOf = (auth: AuthContext): string => auth.ctx.school.id;
export const todayOf = (deps: Deps, auth: AuthContext): string => todayInTimezone(deps.now(), auth.ctx.school.timezone);

// ---- business-rule problems -> HTTP ----

/** Rule failures that are about the current STATE of the data (so: conflict) rather than about the shape of the input. */
const CONFLICTS = new Set([
  "already_in_class", "class_archived", "student_not_enrolled", "move_before_current_start", "change_before_current_start",
  "overlaps_enrolment", "no_change", "class_has_students", "class_year_locked", "year_excludes_history", "class_year_ended",
  "not_latest_placement", "placement_has_attendance",
  // P1 staff onboarding: the person's current state, not the shape of the request, is what stands in the way.
  "already_a_member", "member_deactivated", "head_not_managed", "already_inactive", "already_active", "shared_account",
]);

export function httpFromProblem(p: Problem): HttpError {
  if (p.code === "not_found") return new HttpError(404, "not_found", p.message);
  return new HttpError(CONFLICTS.has(p.code) ? 409 : 400, p.code, p.message, p.field);
}

/** Throws the HttpError for a failed rule, or does nothing when the rule is satisfied. */
export function ensure(p: Problem | null): void {
  if (p) throw httpFromProblem(p);
}

// ---- database constraint -> HTTP ----

export interface ConstraintRule {
  status: 400 | 404 | 409;
  code: string;
  message: string;
  field?: string;
}

/**
 * Runs `fn`; if the database refuses it for a reason we have a friendly answer for (a race that slipped past the
 * pre-checks, or the rule living only in a constraint), throw that answer instead of a 500.
 * Must wrap the WHOLE transaction: PostgreSQL aborts a transaction on any error.
 */
export async function withConstraints<T>(rules: Readonly<Record<string, ConstraintRule>>, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const info = classifyDbError(e);
    const rule = info.constraint ? rules[info.constraint] : undefined;
    if (rule) throw new HttpError(rule.status, rule.code, rule.message, rule.field);
    throw e;
  }
}

// ---- audit ----

export function audit(tx: { appendAudit(e: AuditEntry): Promise<void> }, auth: AuthContext, action: string, entityType: string, entityId: string | null, details: unknown = {}): Promise<void> {
  return tx.appendAudit({
    schoolId: auth.ctx.school.id, actorUserId: auth.ctx.user.id, action, entityType, entityId, opId: null, details,
  });
}

/** Names of the keys the caller actually sent: what an audit entry records instead of the (possibly personal) values. */
export const changedFields = (patch: object): string[] => Object.entries(patch).filter(([, v]) => v !== undefined).map(([k]) => k);
