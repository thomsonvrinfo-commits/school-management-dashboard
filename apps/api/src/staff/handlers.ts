/**
 * Staff-onboarding endpoints as plain functions, keyed "METHOD path" like routes.ts. The head's endpoints sit behind the
 * same role gate as school administration; the three public ones take no caller at all.
 */
import { acceptInvitationRequest, completePasswordResetRequest, inviteStaffRequest, previewInvitationRequest, uuid } from "@schoolpulse/contracts";
import { STAFF_ROUTES, routeKey } from "../routes.ts";
import { guardedBy, idParam, readBody, type AdminHandler, type PublicHandler } from "../school-admin/http.ts";
import { deactivateStaff, inviteStaff, issuePasswordReset, listStaff, reactivateStaff, revokeInvitation } from "./members.ts";
import { acceptInvitation, completePasswordReset, previewInvitation } from "./links.ts";

const guarded = guardedBy(STAFF_ROUTES);

export const STAFF_HANDLERS: Readonly<Record<string, AdminHandler>> = {
  "GET /v1/staff": guarded("GET /v1/staff", async (d, a) => ({ status: 200, body: await listStaff(d, a) })),
  "POST /v1/staff/invitations": guarded("POST /v1/staff/invitations", async (d, a, r) => ({ status: 201, body: await inviteStaff(d, a, await readBody(r, inviteStaffRequest)) })),
  "DELETE /v1/staff/invitations/:id": guarded("DELETE /v1/staff/invitations/:id", async (d, a, r) => {
    await revokeInvitation(d, a, idParam(r, "id", uuid));
    return { status: 204 };
  }),
  "POST /v1/staff/:membershipId/deactivate": guarded("POST /v1/staff/:membershipId/deactivate", async (d, a, r) => ({
    status: 200, body: await deactivateStaff(d, a, idParam(r, "membershipId", uuid)),
  })),
  "POST /v1/staff/:membershipId/reactivate": guarded("POST /v1/staff/:membershipId/reactivate", async (d, a, r) => ({
    status: 200, body: await reactivateStaff(d, a, idParam(r, "membershipId", uuid)),
  })),
  "POST /v1/staff/:membershipId/reset-link": guarded("POST /v1/staff/:membershipId/reset-link", async (d, a, r) => ({
    status: 201, body: await issuePasswordReset(d, a, idParam(r, "membershipId", uuid)),
  })),
};

export const PUBLIC_STAFF_HANDLERS: Readonly<Record<string, PublicHandler>> = {
  "POST /v1/invitations/preview": async (d, r) => ({ status: 200, body: await previewInvitation(d, await readBody(r, previewInvitationRequest)) }),
  "POST /v1/invitations/accept": async (d, r) => ({ status: 200, body: await acceptInvitation(d, await readBody(r, acceptInvitationRequest)) }),
  "POST /v1/password-reset/complete": async (d, r) => {
    await completePasswordReset(d, await readBody(r, completePasswordResetRequest));
    return { status: 204 };
  },
};

export const staffKeys = (): string[] => STAFF_ROUTES.map(routeKey);
