/** The activity-screen endpoint as a plain function, keyed "METHOD path" like routes.ts. */
import { auditQuery } from "@schoolpulse/contracts";
import { AUDIT_ROUTES, routeKey } from "../routes.ts";
import { guardedBy, readQuery, type AdminHandler } from "../school-admin/http.ts";
import { listActivity } from "./activity.ts";

const guarded = guardedBy(AUDIT_ROUTES);

export const AUDIT_HANDLERS: Readonly<Record<string, AdminHandler>> = {
  "GET /v1/audit": guarded("GET /v1/audit", async (d, a, r) => ({ status: 200, body: await listActivity(d, a, readQuery(r, auditQuery)) })),
};

export const auditKeys = (): string[] => AUDIT_ROUTES.map(routeKey);
