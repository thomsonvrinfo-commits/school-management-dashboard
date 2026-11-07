import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INVITATION_DAYS, PASSWORD_MAX, PASSWORD_MIN, RESET_HOURS, normaliseEmail, normaliseStaffName, tokenExpiry, tokenProblem, tokenState,
  validateDeactivation, validateEmail, validateInvitation, validatePassword, validateReactivation, validateResetTarget, validateStaffName,
} from "../src/index.ts";

const NOW = new Date("2026-10-19T08:00:00.000Z");
const code = (p: { code: string } | null) => p?.code ?? null;

test("emails are compared ignoring case and surrounding spaces", () => {
  assert.equal(normaliseEmail("  Chipo@Mavambo.Example "), "chipo@mavambo.example");
  assert.equal(validateEmail("chipo@mavambo.example"), null);
  for (const bad of ["", "chipo", "chipo@", "@mavambo.example", "chipo@mavambo", "a b@c.de", "x".repeat(250) + "@a.bc"]) {
    assert.equal(code(validateEmail(bad)), "invalid_email", bad);
  }
  assert.equal(validateEmail("bad", "contact")?.field, "contact");
});

test("a staff name is squeezed to single spaces and must not be empty or huge", () => {
  assert.equal(normaliseStaffName("  Ms.   Chipo \n Moyo "), "Ms. Chipo Moyo");
  assert.equal(code(validateStaffName("   ")), "name_required");
  assert.equal(code(validateStaffName("x".repeat(201))), "name_too_long");
  assert.equal(validateStaffName("x".repeat(200)), null);
});

test("password: length is what counts, and a long phrase with spaces is welcome", () => {
  assert.equal(validatePassword("correct horse battery"), null);
  assert.equal(validatePassword("tr0ub4dor&3x"), null);
  assert.equal(code(validatePassword("a".repeat(PASSWORD_MIN - 1))), "password_too_short");
  assert.equal(code(validatePassword("")), "password_too_short");
  assert.equal(validatePassword("x1y2z3q4r5"), null, "exactly the minimum length is allowed");
  assert.equal(code(validatePassword("x".repeat(PASSWORD_MAX + 1))), "password_too_long");
  // (not "abcdefgh" repeated: an alphabet run said sixteen times is exactly the kind of password the rule refuses)
  assert.equal(validatePassword("aB3$eF9&hJ1#kL5%".repeat(8)), null, "exactly the maximum length (128) is allowed");
  assert.equal([..."aB3$eF9&hJ1#kL5%".repeat(8)].length, PASSWORD_MAX);
});

test("password: counts characters, not UTF-16 units, so emoji and accents are not double-counted", () => {
  // 5 code points but 10 UTF-16 units: must be refused as too short
  assert.equal(code(validatePassword("😀😁😂🤣😃")), "password_too_short");
  assert.equal(validatePassword("ñandú-café-señor"), null);
});

test("password: refuses repetitive and very common choices, however they are spaced or cased", () => {
  assert.equal(code(validatePassword("aaaaaaaaaaaa")), "password_too_simple");
  assert.equal(code(validatePassword("abababababab")), "password_too_simple");
  assert.equal(code(validatePassword("1234567890")), "password_too_common");
  assert.equal(code(validatePassword("PassWord 123")), "password_too_common");
  assert.equal(code(validatePassword("pass-word_123")), "password_too_common");
  assert.equal(code(validatePassword("schoolpulse")), "password_too_common");
});

test("password: refuses one built from the person's own email or name", () => {
  const about = { email: "chipo.moyo@mavambo.example", name: "Chipo Moyo" };
  assert.equal(code(validatePassword("chipo.moyo-2026!", about)), "password_contains_identity");
  assert.equal(code(validatePassword("MOYO is my name!", about)), "password_contains_identity");
  assert.equal(validatePassword("three green mangoes", about), null);
  // short name parts are ignored (they would block half of all passwords)
  assert.equal(validatePassword("li has a long walk home", { name: "Li Wu" }), null);
  assert.equal(validatePassword("pass phrase with ab inside", { email: "ab@x.example" }), null);
});

test("password: every refusal names the field so a form can put the message by the right box", () => {
  assert.equal(validatePassword("short")?.field, "password");
  assert.equal(validatePassword("short", {}, "newPassword")?.field, "newPassword");
});

test("a link is usable until it is used, revoked or expired; revoked and used beat expired", () => {
  const fresh = { expiresAt: "2026-10-20T08:00:00.000Z", usedAt: null, revokedAt: null };
  assert.equal(tokenState(fresh, NOW), "usable");
  assert.equal(tokenState({ ...fresh, expiresAt: NOW.toISOString() }, NOW), "expired", "expires AT the instant, not after");
  assert.equal(tokenState({ ...fresh, expiresAt: "2026-10-19T07:59:59.999Z" }, NOW), "expired");
  assert.equal(tokenState({ ...fresh, usedAt: "2026-10-19T07:00:00.000Z" }, NOW), "used");
  assert.equal(tokenState({ ...fresh, revokedAt: "2026-10-19T07:00:00.000Z" }, NOW), "revoked");
  assert.equal(tokenState({ expiresAt: "2026-01-01T00:00:00.000Z", usedAt: "2026-01-02T00:00:00.000Z", revokedAt: null }, NOW), "used");
  assert.equal(tokenState({ expiresAt: "2026-01-01T00:00:00.000Z", usedAt: null, revokedAt: "2026-01-02T00:00:00.000Z" }, NOW), "revoked");
});

test("invitations last a week and reset links a day", () => {
  assert.equal(tokenExpiry("invite", NOW), new Date(NOW.getTime() + INVITATION_DAYS * 86_400_000).toISOString());
  assert.equal(tokenExpiry("reset", NOW), new Date(NOW.getTime() + RESET_HOURS * 3_600_000).toISOString());
  assert.equal(INVITATION_DAYS, 7);
  assert.equal(RESET_HOURS, 24);
});

test("each way a link can fail has its own plain explanation", () => {
  assert.deepEqual(["used", "expired", "revoked"].map((s) => tokenProblem(s as "used").code), ["link_used", "link_expired", "link_revoked"]);
  for (const s of ["used", "expired", "revoked"] as const) assert.match(tokenProblem(s).message, /head teacher/);
});

test("an invitation is refused for someone already at the school, with a different hint when they were switched off", () => {
  assert.equal(validateInvitation(null), null);
  assert.equal(code(validateInvitation({ role: "teacher", active: true })), "already_a_member");
  assert.equal(code(validateInvitation({ role: "teacher", active: false })), "member_deactivated");
  assert.equal(code(validateInvitation({ role: "head", active: true })), "already_a_member");
  assert.equal(validateInvitation({ role: "teacher", active: true })?.field, "email");
});

test("the head manages teachers only: heads cannot be switched off, switched on or reset from here", () => {
  const head = { role: "head", active: true } as const;
  assert.equal(code(validateDeactivation(head)), "head_not_managed");
  assert.equal(code(validateReactivation({ role: "head", active: false })), "head_not_managed");
  assert.equal(code(validateResetTarget(head, 1)), "head_not_managed");
});

test("switching access off and on only applies when it would change something", () => {
  assert.equal(validateDeactivation({ role: "teacher", active: true }), null);
  assert.equal(code(validateDeactivation({ role: "teacher", active: false })), "already_inactive");
  assert.equal(validateReactivation({ role: "teacher", active: false }), null);
  assert.equal(code(validateReactivation({ role: "teacher", active: true })), "already_active");
});

test("a reset link needs an active teacher whose account is used at this school only", () => {
  assert.equal(validateResetTarget({ role: "teacher", active: true }, 1), null);
  assert.equal(code(validateResetTarget({ role: "teacher", active: false }, 1)), "member_deactivated");
  assert.equal(code(validateResetTarget({ role: "teacher", active: true }, 2)), "shared_account");
  assert.equal(code(validateResetTarget({ role: "teacher", active: true }, 3)), "shared_account");
});

test("password: a common word with digits, capitals or symbols added is still refused (the review found 'Password123!' was accepted)", () => {
  for (const pw of [
    "password12345", "Password123!", "PASSWORD-2024!", "p@ssw0rd12345", "P@ssw0rd!2024", "qwerty123456", "iloveyou1234", "letmein12345",
    "1qaz2wsx3edc", "welcome12345", "passwordpassword", "football123", "Qwerty!2024", "schoolpulse2026", "Admin#12345",
    "12345678901", "0987654321098", "qwertyuiopas", "zyxwvutsrqpo",
  ]) assert.equal(code(validatePassword(pw)), "password_too_common", pw);
});

test("password: ordinary phrases and passwords that merely CONTAIN a common word are still welcome", () => {
  for (const pw of [
    "correct horse battery staple", "pa55 the salt and pepper", "my password is much longer now", "teacher of grade seven maths", "Sunrise over Harare at six",
    "tr0ub4dor&3x", "blue-elephant-7-lantern", "ñandú-café-señor",
  ]) assert.equal(validatePassword(pw), null, pw);
});
