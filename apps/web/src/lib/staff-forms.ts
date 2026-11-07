/**
 * Pure helpers for the staff screens (invitations, access on and off, reset links, and the two public screens a person
 * reaches from a link). Passwords are judged by the SAME rule the server uses (packages/domain), so the reason a
 * password is refused is the same on the phone and at the server. No React, network or browser here: it runs under
 * `node --test`, and it must not import ./api.ts.
 */
import type { InvitationItem, InvitationPreview, InviteStaffRequest, StaffMember } from "@schoolpulse/contracts";
import { inviteStaffRequest } from "@schoolpulse/contracts";
import { normaliseStaffName, validateEmail, validatePassword, validateStaffName, type Problem } from "@schoolpulse/domain";
import { validate, type FieldErrors, type Validation } from "./admin-forms.ts";

const fail = (errors: FieldErrors): Validation => ({ ok: false, errors });
const finish = (errors: FieldErrors): Validation => (Object.keys(errors).length === 0 ? { ok: true } : fail(errors));
const note = (errors: FieldErrors, field: string, p: Problem | null): void => {
  if (p) errors[field] ??= p.message;
};

// ---------- inviting a teacher ----------

export interface InviteFormValues { email: string; name: string }
export const INVITE_FIELDS = ["email", "name"] as const;
export const emptyInviteForm = (): InviteFormValues => ({ email: "", name: "" });

export const toInviteRequest = (v: InviteFormValues): InviteStaffRequest => ({
  email: v.email.trim(),
  ...(v.name.trim() ? { name: v.name.trim() } : {}),
});

export function validateInvite(v: InviteFormValues): Validation {
  const errors: FieldErrors = {};
  if (v.email.trim() === "") errors.email = "Enter the teacher's email address.";
  else note(errors, "email", validateEmail(v.email));
  if (v.name.trim() !== "") note(errors, "name", validateStaffName(v.name));
  if (Object.keys(errors).length > 0) return fail(errors);
  return validate(inviteStaffRequest, toInviteRequest(v));
}

// ---------- accepting an invitation ----------

export interface AcceptFormValues { name: string; password: string; confirm: string }
export const ACCEPT_FIELDS = ["name", "password"] as const;
export const emptyAcceptForm = (suggestedName: string | null = null): AcceptFormValues => ({ name: suggestedName ?? "", password: "", confirm: "" });

type PreviewFacts = Pick<InvitationPreview, "email" | "accountExists" | "suggestedName">;

/** The name that will be used: what the person typed, else the head's suggestion. An existing account keeps its own name. */
export const chosenName = (v: AcceptFormValues, preview: PreviewFacts): string => normaliseStaffName(v.name.trim() !== "" ? v.name : (preview.suggestedName ?? ""));

export function validateAccept(v: AcceptFormValues, preview: PreviewFacts): Validation {
  const errors: FieldErrors = {};
  if (preview.accountExists) {
    if (v.password === "") errors.password = "Enter your current password.";
    return finish(errors);
  }
  note(errors, "name", validateStaffName(chosenName(v, preview)));
  if (v.password === "") errors.password = "Choose a password.";
  else note(errors, "password", validatePassword(v.password, { email: preview.email, name: chosenName(v, preview) }));
  if (!errors.password && v.confirm !== v.password) errors.confirm = "The two passwords are not the same.";
  return finish(errors);
}

export function toAcceptRequest(v: AcceptFormValues, preview: PreviewFacts, token: string): { token: string; password: string; name?: string } {
  const name = chosenName(v, preview);
  return { token, password: v.password, ...(!preview.accountExists && name ? { name } : {}) };
}

// ---------- finishing a password reset ----------

export interface ResetFormValues { password: string; confirm: string }
export const RESET_FIELDS = ["password"] as const;
export const emptyResetForm = (): ResetFormValues => ({ password: "", confirm: "" });

export function validateReset(v: ResetFormValues): Validation {
  const errors: FieldErrors = {};
  if (v.password === "") errors.password = "Choose a new password.";
  else note(errors, "password", validatePassword(v.password));
  if (!errors.password && v.confirm !== v.password) errors.confirm = "The two passwords are not the same.";
  return finish(errors);
}

// ---------- what to tell someone whose link does not work ----------

export interface LinkProblem { title: string; body: string }

export function describeLinkProblem(code: string | undefined, purpose: "invitation" | "reset"): LinkProblem {
  const ask = purpose === "invitation" ? "Ask your head teacher to send you a new invitation." : "Ask your head teacher for a new reset link.";
  switch (code) {
    case "link_used":
      return { title: "This link has already been used", body: purpose === "invitation" ? "If you set up your account, just sign in with the email and password you chose." : "If you chose a new password, sign in with it. Otherwise ask your head teacher for a new reset link." };
    case "link_expired":
      return { title: "This link has expired", body: ask };
    case "link_revoked":
      return { title: "This link is no longer valid", body: `It was replaced or withdrawn. ${ask} If you were sent more than one, use the newest.` };
    case "link_not_found":
      return { title: "This link is not valid", body: `It may have been copied incompletely. Open the whole link again from the message you received, or ask for a new one.` };
    case "shared_account":
    case "head_not_managed":
      return { title: "This password cannot be changed from here", body: "Ask the person who runs SchoolPulse for your school." };
    case "member_deactivated":
      return { title: "Your access is switched off", body: "Ask your head teacher to switch it back on." };
    default:
      return { title: "This link cannot be used", body: ask };
  }
}

/** Codes that mean the link itself is finished with, so the form should give way to the explanation. */
export const LINK_ENDED = new Set(["link_used", "link_expired", "link_revoked", "link_not_found", "shared_account", "head_not_managed", "member_deactivated"]);

// ---------- sharing a link by hand ----------

export function invitationMessage(school: string, link: string, expiresAt: string, timeZone?: string): string {
  return `You are invited to join ${school} on SchoolPulse. Open this link to set up your account (it works once, until ${expiryLabel(expiresAt, timeZone)}):\n${link}`;
}

export function resetMessage(name: string, school: string, link: string, expiresAt: string, timeZone?: string): string {
  return `Hello ${name}, here is your SchoolPulse link to choose a new password for ${school}. It works once, until ${expiryLabel(expiresAt, timeZone)}:\n${link}`;
}

export const whatsAppUrl = (text: string): string => `https://wa.me/?text=${encodeURIComponent(text)}`;

export function expiryLabel(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", ...(timeZone ? { timeZone } : {}) });
}

/** "6 days left", "5 hours left", "less than an hour left", or "expired". */
export function timeLeft(expiresAt: string, now: Date): string {
  const ms = new Date(expiresAt).getTime() - now.getTime();
  if (ms <= 0) return "expired";
  const hours = ms / 3_600_000;
  if (hours < 1) return "less than an hour left";
  if (hours < 24) return `${Math.floor(hours)} hour${Math.floor(hours) === 1 ? "" : "s"} left`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} left`;
}

// ---------- the staff list ----------

export const ROLE_LABEL = { head: "School head", teacher: "Teacher" } as const;

export function memberStatus(m: Pick<StaffMember, "active">): { label: string; tone: "good" | "bad" } {
  return m.active ? { label: "Access on", tone: "good" } : { label: "Access off", tone: "bad" };
}

/** Which actions the head is offered for a person: never for a head, and never for yourself. */
export function memberActions(m: Pick<StaffMember, "role" | "active" | "userId">, youUserId: string): { switchOff: boolean; switchOn: boolean; resetLink: boolean } {
  const managed = m.role === "teacher" && m.userId !== youUserId;
  return { switchOff: managed && m.active, switchOn: managed && !m.active, resetLink: managed && m.active };
}

export const inviteeLabel = (i: Pick<InvitationItem, "name" | "email">): string => (i.name ? `${i.name} (${i.email})` : i.email);
