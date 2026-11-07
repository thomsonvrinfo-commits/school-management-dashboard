/**
 * Staff accounts: which passwords are acceptable, when an invitation or reset link still works, and who may be
 * invited, switched off or given a new password. Pure rules with no database or clock of their own.
 *
 * Deliberately narrow: the head manages TEACHERS. A head's own account is created and recovered by the platform
 * operator, so no head can lock out or take over another.
 */
import type { Role } from "./authz.ts";
import { problem, type Problem } from "./problem.ts";

/** An invitation is a week: long enough for a message to reach someone with patchy connectivity. */
export const INVITATION_DAYS = 7;
/** A reset link is shared by hand, so it is short-lived. */
export const RESET_HOURS = 24;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

export type TokenPurpose = "invite" | "reset";

/** Email is the sign-in name, matched ignoring case, so it is stored lower-case. */
export const normaliseEmail = (raw: string): string => raw.trim().toLowerCase();

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateEmail(raw: string, field = "email"): Problem | null {
  const e = normaliseEmail(raw);
  if (e.length < 3 || e.length > 254 || !EMAIL.test(e)) return problem("invalid_email", "Enter a valid email address.", field);
  return null;
}

/** Whitespace squeezed to single spaces; empty after trimming is invalid. */
export const normaliseStaffName = (raw: string): string => raw.trim().replace(/\s+/g, " ");

export function validateStaffName(raw: string, field = "name"): Problem | null {
  const n = normaliseStaffName(raw);
  if (n.length < 1) return problem("name_required", "Enter a name.", field);
  if (n.length > 200) return problem("name_too_long", "Use 200 characters or fewer.", field);
  return null;
}

// Passwords that are at least PASSWORD_MIN long and still among the first things anyone tries.
const COMMON = new Set([
  "1234567890", "12345678910", "0123456789", "qwertyuiop", "1q2w3e4r5t", "abcdefghij", "password12", "password123",
  "password1234", "passw0rd123", "iloveyou12", "iloveyou123", "welcome123", "welcome1234", "letmein1234", "administrator",
  "schoolpulse", "schoolpulse1", "zimbabwe123", "harare12345", "teacher1234", "headmaster1", "changeme123", "changemenow",
]);

// The word underneath a password. "Password123!", "PASSWORD-2024" and "p@ssword1" are all "password" with decoration, and
// decoration is the first thing anyone guesses. A passphrase of several words is never equal to one of these.
const COMMON_WORDS = new Set([
  "password", "passwd", "passw0rd", "pass", "qwerty", "qwertyuiop", "asdfgh", "asdfghjkl", "zxcvbn", "zxcvbnm", "azerty", "iloveyou",
  "letmein", "welcome", "football", "baseball", "basketball", "soccer", "dragon", "monkey", "master", "admin", "administrator", "login",
  "secret", "sunshine", "princess", "superman", "batman", "shadow", "freedom", "whatever", "starwars", "hello", "hunter", "trustno",
  "abc", "abcdef", "abcdefgh", "changeme", "default", "test", "testing", "user", "school", "schoolpulse", "teacher", "headmaster",
  "headteacher", "principal", "harare", "bulawayo", "zimbabwe", "mavambo", "kingdom", "blessed", "jesus", "godisgood", "lovely",
]);
// Runs along a keyboard or the alphabet: any stretch of these, forwards or backwards, is as guessable as the whole.
const RUNS = ["012345678901234567890123456789", "abcdefghijklmnopqrstuvwxyz", "qwertyuiopasdfghjklzxcvbnm", "1q2w3e4r5t6y7u8i9o0p", "1qaz2wsx3edc4rfv5tgb", "zaq12wsxcde3"];

function looksCommon(lower: string): boolean {
  const compact = lower.replace(/[\s_-]/g, "");
  if (COMMON.has(compact)) return true;
  // the letters alone, and the letters after the usual look-alike swaps ("p@ssw0rd" is "password"). Decoration at the END
  // (digits, a year, "!") is cut off before swapping, so "p@ssw0rd2024" does not turn its year into letters.
  const swapped = lower.replace(/[^\p{L}]+$/u, "").replace(/[@$013457]/g, (c) => ({ "@": "a", $: "s", "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t" } as Record<string, string>)[c]!);
  for (const text of [lower, swapped]) {
    const letters = text.replace(/[^\p{L}]/gu, "");
    if (COMMON_WORDS.has(letters)) return true;
    // one common word said twice or more ("passwordpassword")
    for (const w of COMMON_WORDS) if (w.length >= 4 && letters.length >= w.length * 2 && letters.length % w.length === 0 && w.repeat(letters.length / w.length) === letters) return true;
  }
  const plain = lower.replace(/[^\p{L}\p{N}]/gu, "");
  const backwards = [...plain].reverse().join("");
  return plain.length >= 8 && RUNS.some((r) => r.includes(plain) || r.includes(backwards));
}

/**
 * What a new password must satisfy. Length is what matters, so there are no "one capital, one symbol" rules; a long
 * phrase is welcome. Spaces are allowed and never trimmed. `about` lets the rule refuse a password built from the
 * person's own email or name.
 */
export function validatePassword(password: string, about: { email?: string; name?: string } = {}, field = "password"): Problem | null {
  const chars = [...password];
  if (chars.length < PASSWORD_MIN) return problem("password_too_short", `Use at least ${PASSWORD_MIN} characters. A short phrase of a few words works well.`, field);
  if (chars.length > PASSWORD_MAX) return problem("password_too_long", `Use ${PASSWORD_MAX} characters or fewer.`, field);
  if (new Set(chars).size < 5) return problem("password_too_simple", "That password repeats too few different characters.", field);

  const lower = password.toLowerCase();
  if (looksCommon(lower)) return problem("password_too_common", "That password is too easy to guess. Choose something less common.", field);

  const parts: string[] = [];
  const local = about.email?.split("@")[0]?.toLowerCase();
  if (local) parts.push(local);
  for (const w of (about.name ?? "").toLowerCase().split(/\s+/)) parts.push(w);
  if (parts.some((p) => p.length >= 4 && lower.includes(p))) {
    return problem("password_contains_identity", "Do not build the password from your name or email address.", field);
  }
  return null;
}

// ---------- invitation and reset links ----------

export interface TokenFacts {
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}
export type TokenState = "usable" | "used" | "revoked" | "expired";

/** A revoked link is revoked even if it was also used or has expired; "used" beats "expired". */
export function tokenState(t: TokenFacts, now: Date): TokenState {
  if (t.revokedAt) return "revoked";
  if (t.usedAt) return "used";
  if (new Date(t.expiresAt).getTime() <= now.getTime()) return "expired";
  return "usable";
}

export function tokenExpiry(purpose: TokenPurpose, now: Date): string {
  const ms = purpose === "invite" ? INVITATION_DAYS * 86_400_000 : RESET_HOURS * 3_600_000;
  return new Date(now.getTime() + ms).toISOString();
}

/** What to tell the person holding a link that no longer works. */
export function tokenProblem(state: Exclude<TokenState, "usable">): Problem {
  switch (state) {
    case "used":
      return problem("link_used", "This link has already been used. Sign in, or ask your head teacher for a new link.");
    case "expired":
      return problem("link_expired", "This link has expired. Ask your head teacher for a new one.");
    case "revoked":
      return problem("link_revoked", "This link is no longer valid. Ask your head teacher for a new one.");
  }
}

// ---------- who may be managed ----------

export interface StaffTarget {
  role: Role;
  active: boolean;
}

/** Someone already holding a membership here (active or not) cannot be invited again. */
export function validateInvitation(existing: StaffTarget | null): Problem | null {
  if (!existing) return null;
  return existing.active
    ? problem("already_a_member", "This person already works at your school.", "email")
    : problem("member_deactivated", "This person's access was switched off. Switch it back on instead of sending a new invitation.", "email");
}

const notTeacher = () => problem("head_not_managed", "Head teacher accounts are managed by the platform operator, not from here.");

export function validateDeactivation(target: StaffTarget): Problem | null {
  if (target.role !== "teacher") return notTeacher();
  if (!target.active) return problem("already_inactive", "This person's access is already switched off.");
  return null;
}

export function validateReactivation(target: StaffTarget): Problem | null {
  if (target.role !== "teacher") return notTeacher();
  if (target.active) return problem("already_active", "This person's access is already on.");
  return null;
}

/**
 * A password belongs to the person, not to a school. If the account also works at another school, the head here must
 * not be able to set its password, because that would hand them a way into the other school.
 */
export function validateResetTarget(target: StaffTarget, schoolCount: number): Problem | null {
  if (target.role !== "teacher") return notTeacher();
  if (!target.active) return problem("member_deactivated", "Switch this person's access back on before giving them a reset link.");
  if (schoolCount > 1) {
    return problem("shared_account", "This person's account is also used at another school, so only they or the platform operator can change its password.");
  }
  return null;
}

/**
 * A reset link made by the platform operator (the only way a head's password is replaced) needs only that the person's
 * access is still on: the operator is trusted with shared accounts, the head of a school is not.
 */
export function validateOperatorResetTarget(target: { active: boolean }): Problem | null {
  return target.active ? null : problem("member_deactivated", "This person's access is switched off.");
}
