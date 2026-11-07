/**
 * P1 wire contracts: staff invitations, access on/off, password-reset links, and the two public screens that use them.
 * Written requests are STRICT, like Slice 2: an unknown key (a `schoolId` in a body, say) is a 400. The school always
 * comes from the signed-in session, or, on the public endpoints, from the link itself.
 *
 * Password RULES (length, common passwords) live in packages/domain so the form and the server give the same answer;
 * these schemas only check the shape, so a refusal arrives as a friendly, field-specific message and not a bare 400.
 */
import { z } from "zod";
import { deviceId, role, tokenResponse, uuid } from "./primitives.ts";

/** What an invitation or reset link carries. 256 random bits, base64url: 43 characters. */
export const linkToken = z.string().min(20).max(200).regex(/^[A-Za-z0-9_-]+$/, "Not a valid link");

const email = z.string().trim().min(3).max(254);
const optionalName = z.string().trim().max(200);

// ---------- the head's staff screen ----------

export const staffMember = z.object({
  membershipId: uuid,
  userId: uuid,
  name: z.string(),
  email: z.string(),
  role,
  /** False when the head has switched this person's access off. */
  active: z.boolean(),
  joinedAt: z.string(),
});
export type StaffMember = z.infer<typeof staffMember>;

export const invitationItem = z.object({
  id: uuid,
  email: z.string(),
  name: z.string().nullable(),
  role,
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type InvitationItem = z.infer<typeof invitationItem>;

export const staffListResponse = z.object({
  members: z.array(staffMember),
  /** Links that have not been used, revoked or expired. */
  invitations: z.array(invitationItem),
});
export type StaffListResponse = z.infer<typeof staffListResponse>;

/** Only teachers are invited from the app; a head's account is created by the platform operator. */
export const inviteStaffRequest = z.object({ email, name: optionalName.optional() }).strict();
export type InviteStaffRequest = z.input<typeof inviteStaffRequest>;

/** The only time the link's secret is shown. It is not stored, so a lost link is replaced, not recovered. */
export const inviteStaffResponse = z.object({ invitation: invitationItem, token: linkToken });
export type InviteStaffResponse = z.infer<typeof inviteStaffResponse>;

export const resetLinkResponse = z.object({
  token: linkToken,
  expiresAt: z.string(),
  staffName: z.string(),
});
export type ResetLinkResponse = z.infer<typeof resetLinkResponse>;

// ---------- public: someone opening an invitation ----------

export const previewInvitationRequest = z.object({ token: linkToken }).strict();
export type PreviewInvitationRequest = z.input<typeof previewInvitationRequest>;

export const invitationPreview = z.object({
  schoolName: z.string(),
  email: z.string(),
  role,
  suggestedName: z.string().nullable(),
  /** True when this email already has an account (at another school): the person proves it with their current password. */
  accountExists: z.boolean(),
  expiresAt: z.string(),
});
export type InvitationPreview = z.infer<typeof invitationPreview>;

export const acceptInvitationRequest = z
  .object({
    token: linkToken,
    /** Needed for a new account; ignored when the account already exists. */
    name: z.string().trim().max(200).optional(),
    /** A new account: the password to set. An existing account: its current password, to prove it is theirs. */
    password: z.string().min(1).max(200),
    deviceId,
  })
  .strict();
export type AcceptInvitationRequest = z.input<typeof acceptInvitationRequest>;

/** Accepting signs the person in, exactly as a normal sign-in would. */
export const acceptInvitationResponse = tokenResponse;

// ---------- public: someone opening a reset link ----------

export const completePasswordResetRequest = z
  .object({ token: linkToken, password: z.string().min(1).max(200) })
  .strict();
export type CompletePasswordResetRequest = z.input<typeof completePasswordResetRequest>;
