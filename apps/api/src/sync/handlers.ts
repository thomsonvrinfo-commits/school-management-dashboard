/** The offline-register download as a plain function, keyed "METHOD path" like routes.ts. */
import { bootstrapQuery } from "@schoolpulse/contracts";
import { ROUTES } from "../routes.ts";
import { guardedBy, readQuery, type AdminHandler } from "../school-admin/http.ts";
import { bootstrapSince } from "../services/sync.ts";

const guarded = guardedBy(ROUTES);

export const SYNC_HANDLERS: Readonly<Record<string, AdminHandler>> = {
  "GET /v1/sync/bootstrap": guarded("GET /v1/sync/bootstrap", async (d, a, r) => ({
    status: 200,
    body: await bootstrapSince(d, a, readQuery(r, bootstrapQuery).since),
  })),
};
