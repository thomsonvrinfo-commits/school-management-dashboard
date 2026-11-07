/**
 * The head's activity screen: who changed what, and when, in their own school. Read-only.
 *
 * What an entry SAYS comes from packages/domain (describeAudit), which reads the stored details defensively. The raw
 * `details` object never leaves this function: a future audit entry that stores something personal cannot reach a
 * screen by accident, because only what a describer asks for is ever shown.
 */
import type { AuditItem, AuditPage, AuditParams } from "@schoolpulse/contracts";
import type { AuditRow } from "@schoolpulse/db";
import { describeAudit, prefixesOf } from "@schoolpulse/domain";
import type { Deps } from "../deps.ts";
import type { AuthContext } from "../services/auth.ts";
import { requireAction, schoolIdOf } from "../school-admin/common.ts";

const toItem = (r: AuditRow): AuditItem => {
  const d = describeAudit(r.action, r.details);
  return {
    id: r.id, at: r.at, actor: { id: r.actorId, name: r.actorName }, category: d.category, summary: d.summary, detail: d.detail,
    entity: { type: r.entityType, id: r.entityId },
  };
};

export async function listActivity(deps: Deps, auth: AuthContext, q: AuditParams): Promise<AuditPage> {
  requireAction(auth, "audit:read");
  // One more than a page asked for: whether it exists is how we know there is an older page, without counting everything.
  const rows = await deps.admin.store.listAudit(schoolIdOf(auth), {
    ...(q.category ? { actionPrefixes: prefixesOf(q.category) } : {}),
    ...(q.actor ? { actorUserId: q.actor } : {}),
    ...(q.from ? { fromDate: q.from } : {}),
    ...(q.to ? { toDate: q.to } : {}),
    ...(q.before ? { before: q.before } : {}),
    timeZone: auth.ctx.school.timezone,
  }, q.limit + 1);
  const page = rows.slice(0, q.limit);
  return { items: page.map(toItem), nextBefore: rows.length > q.limit ? page[page.length - 1]!.id : null };
}
