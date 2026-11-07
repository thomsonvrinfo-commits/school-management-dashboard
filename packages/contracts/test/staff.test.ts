import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acceptInvitationRequest, completePasswordResetRequest, inviteStaffRequest, invitationPreview, linkToken, previewInvitationRequest,
  resetLinkResponse, staffListResponse,
} from "../src/index.ts";

const TOKEN = "A".repeat(43);
const DEVICE = "device-0001";
const ID = "00000000-0000-4000-8000-000000000001";

test("a link token is URL-safe and neither tiny nor huge", () => {
  assert.equal(linkToken.safeParse(TOKEN).success, true);
  assert.equal(linkToken.safeParse("abc_DEF-123".repeat(3)).success, true);
  for (const bad of ["", "short", "a".repeat(19), "a".repeat(201), `${TOKEN}=`, `${TOKEN} `, `${TOKEN}/x`, `${TOKEN}.x`, "é".repeat(30)]) {
    assert.equal(linkToken.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("inviting takes an email and an optional name, and nothing else", () => {
  assert.equal(inviteStaffRequest.safeParse({ email: "a@b.co" }).success, true);
  assert.equal(inviteStaffRequest.safeParse({ email: "a@b.co", name: "Rudo" }).success, true);
  assert.equal(inviteStaffRequest.safeParse({}).success, false);
  assert.equal(inviteStaffRequest.safeParse({ email: "a@b.co", schoolId: ID }).success, false, "no school in the body");
  assert.equal(inviteStaffRequest.safeParse({ email: "a@b.co", role: "head" }).success, false, "no role in the body");
  assert.equal(inviteStaffRequest.safeParse({ email: "a@b.co", name: "x".repeat(201) }).success, false);
});

test("opening, accepting and finishing a reset are strict: only the fields they need", () => {
  assert.equal(previewInvitationRequest.safeParse({ token: TOKEN }).success, true);
  assert.equal(previewInvitationRequest.safeParse({ token: TOKEN, schoolId: ID }).success, false);

  assert.equal(acceptInvitationRequest.safeParse({ token: TOKEN, password: "x", deviceId: DEVICE }).success, true);
  assert.equal(acceptInvitationRequest.safeParse({ token: TOKEN, password: "x", deviceId: DEVICE, name: "Rudo" }).success, true);
  for (const extra of [{ role: "head" }, { schoolId: ID }, { email: "a@b.co" }, { userId: ID }]) {
    assert.equal(acceptInvitationRequest.safeParse({ token: TOKEN, password: "x", deviceId: DEVICE, ...extra }).success, false, JSON.stringify(extra));
  }
  assert.equal(acceptInvitationRequest.safeParse({ token: TOKEN, password: "", deviceId: DEVICE }).success, false);
  assert.equal(acceptInvitationRequest.safeParse({ token: TOKEN, password: "x" }).success, false, "a device is needed to open a session");
  assert.equal(acceptInvitationRequest.safeParse({ token: TOKEN, password: "x".repeat(201), deviceId: DEVICE }).success, false);

  assert.equal(completePasswordResetRequest.safeParse({ token: TOKEN, password: "x" }).success, true);
  assert.equal(completePasswordResetRequest.safeParse({ token: TOKEN, password: "x", deviceId: DEVICE }).success, false);
  assert.equal(completePasswordResetRequest.safeParse({ token: "nope", password: "x" }).success, false);
});

test("the password's strength is NOT judged by the wire schema: that is the domain rule's job, with a clear reason", () => {
  assert.equal(acceptInvitationRequest.safeParse({ token: TOKEN, password: "a", deviceId: DEVICE }).success, true);
  assert.equal(completePasswordResetRequest.safeParse({ token: TOKEN, password: "a" }).success, true);
});

test("responses have the shapes the screens rely on", () => {
  const invitation = { id: ID, email: "a@b.co", name: null, role: "teacher", createdAt: "2026-10-08T06:05:00.000Z", expiresAt: "2026-10-15T06:05:00.000Z" };
  const member = { membershipId: ID, userId: ID, name: "A", email: "a@b.co", role: "teacher", active: true, joinedAt: "2026-10-08T06:05:00.000Z" };
  assert.equal(staffListResponse.safeParse({ members: [member], invitations: [invitation] }).success, true);
  assert.equal(staffListResponse.safeParse({ members: [{ ...member, role: "owner" }], invitations: [] }).success, false);
  assert.equal(resetLinkResponse.safeParse({ token: TOKEN, expiresAt: "2026-10-09T06:05:00.000Z", staffName: "A" }).success, true);
  assert.equal(invitationPreview.safeParse({ schoolName: "S", email: "a@b.co", role: "teacher", suggestedName: null, accountExists: false, expiresAt: "2026-10-15T06:05:00.000Z" }).success, true);
  assert.equal(invitationPreview.safeParse({ schoolName: "S", email: "a@b.co", role: "teacher", suggestedName: null, expiresAt: "x" }).success, false);
});
