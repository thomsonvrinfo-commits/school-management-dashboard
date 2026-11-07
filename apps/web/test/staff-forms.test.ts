import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeLinkProblem, emptyAcceptForm, expiryLabel, invitationMessage, inviteeLabel, memberActions, memberStatus, resetMessage, timeLeft, toAcceptRequest,
  toInviteRequest, validateAccept, validateInvite, validateReset, whatsAppUrl, LINK_ENDED, chosenName,
} from "../src/lib/staff-forms.ts";
import { forgetLinkToken, linkUrl, readLinkToken, takeLinkToken } from "../src/lib/link-token.ts";

const TOKEN = "Abc_def-123456789Abc_def-123456789Abc_def-12";
const fresh = { email: "rudo.ncube@school.example", accountExists: false, suggestedName: null as string | null };
const errorsOf = (v: ReturnType<typeof validateAccept>) => (v.ok ? {} : v.errors);
const memory = () => {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

// ---------- link tokens ----------

test("the token is read from #token=… and anything that is not a token is ignored", () => {
  assert.equal(readLinkToken(`#token=${TOKEN}`), TOKEN);
  assert.equal(readLinkToken(`token=${TOKEN}`), TOKEN);
  assert.equal(readLinkToken(`#token=${TOKEN}&x=1`), TOKEN);
  for (const bad of ["", "#", "#token=", "#token=short", `#token=${TOKEN}!`, "#other=abc", `#token=${"a".repeat(201)}`]) assert.equal(readLinkToken(bad), null, bad);
});

test("a token in the address is remembered for the tab and scrubbed; a reload finds it again; using it forgets it", () => {
  const s = memory();
  assert.deepEqual(takeLinkToken("accept", `#token=${TOKEN}`, s), { token: TOKEN, scrub: true });
  assert.deepEqual(takeLinkToken("accept", "", s), { token: TOKEN, scrub: false }, "after the address was scrubbed");
  assert.deepEqual(takeLinkToken("reset", "", s), { token: null, scrub: false }, "an invitation is not a reset link");
  forgetLinkToken("accept", s);
  assert.deepEqual(takeLinkToken("accept", "", s), { token: null, scrub: false });
});

test("with no storage, or storage that refuses, the token still works for this visit", () => {
  assert.deepEqual(takeLinkToken("accept", `#token=${TOKEN}`, null), { token: TOKEN, scrub: true });
  const angry = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
  assert.deepEqual(takeLinkToken("accept", `#token=${TOKEN}`, angry), { token: TOKEN, scrub: true });
  assert.deepEqual(takeLinkToken("accept", "", angry), { token: null, scrub: false });
  forgetLinkToken("accept", angry);
  assert.deepEqual(takeLinkToken("accept", "#garbage", memory()), { token: null, scrub: true }, "a useless fragment is still taken out of the address");
});

test("a remembered value that is not a token is not trusted", () => {
  const s = memory();
  s.setItem("schoolpulse:link:accept", "<script>");
  assert.equal(takeLinkToken("accept", "", s).token, null);
});

test("the link a person is given puts the secret after the #, so it never reaches a server", () => {
  assert.equal(linkUrl("https://app.example.org", "accept", TOKEN), `https://app.example.org/accept#token=${TOKEN}`);
  assert.equal(linkUrl("https://app.example.org///", "reset", TOKEN), `https://app.example.org/reset#token=${TOKEN}`);
  assert.equal(readLinkToken(new URL(linkUrl("https://app.example.org", "accept", TOKEN)).hash), TOKEN);
  assert.equal(new URL(linkUrl("https://app.example.org", "accept", TOKEN)).search, "");
});

// ---------- the invitation form ----------

test("inviting: an email is required and checked; the name is optional but must be sensible", () => {
  assert.deepEqual(validateInvite({ email: "", name: "" }), { ok: false, errors: { email: "Enter the teacher's email address." } });
  assert.equal(validateInvite({ email: "not-an-email", name: "" }).ok, false);
  assert.deepEqual(validateInvite({ email: "a@b.co", name: "" }), { ok: true });
  assert.deepEqual(validateInvite({ email: "  A@B.co ", name: " Rudo " }), { ok: true });
  const long = validateInvite({ email: "a@b.co", name: "x".repeat(201) });
  assert.equal(long.ok, false);
  assert.deepEqual(toInviteRequest({ email: " a@b.co ", name: "  " }), { email: "a@b.co" });
  assert.deepEqual(toInviteRequest({ email: "a@b.co", name: " Rudo Ncube " }), { email: "a@b.co", name: "Rudo Ncube" });
});

// ---------- accepting an invitation ----------

test("a new person needs a name (their own or the head's suggestion) and a good password typed twice", () => {
  assert.deepEqual(errorsOf(validateAccept({ name: "", password: "", confirm: "" }, fresh)), { name: "Enter a name.", password: "Choose a password." });
  assert.deepEqual(validateAccept({ name: "", password: "violet harbour lantern", confirm: "violet harbour lantern" }, { ...fresh, suggestedName: "Suggested" }), { ok: true });
  assert.equal(errorsOf(validateAccept({ name: "Rudo Ncube", password: "short", confirm: "short" }, fresh)).password?.includes("at least 10"), true);
  assert.match(errorsOf(validateAccept({ name: "Rudo Ncube", password: "password123", confirm: "password123" }, fresh)).password ?? "", /too easy to guess/);
  assert.match(errorsOf(validateAccept({ name: "Rudo Ncube", password: "rudo.ncube!2026", confirm: "rudo.ncube!2026" }, fresh)).password ?? "", /name or email/);
  assert.deepEqual(errorsOf(validateAccept({ name: "Rudo Ncube", password: "violet harbour lantern", confirm: "violet harbour lanterns" }, fresh)), { confirm: "The two passwords are not the same." });
  assert.deepEqual(validateAccept({ name: "Rudo Ncube", password: "violet harbour lantern", confirm: "violet harbour lantern" }, fresh), { ok: true });
});

test("someone with an account already only types their current password: no name, no strength rule, no confirmation", () => {
  const existing = { ...fresh, accountExists: true };
  assert.deepEqual(errorsOf(validateAccept({ name: "", password: "", confirm: "" }, existing)), { password: "Enter your current password." });
  assert.deepEqual(validateAccept({ name: "", password: "x", confirm: "" }, existing), { ok: true });
});

test("the accept request carries the typed name only for a new account, and never a role or a school", () => {
  const v = { name: "  Rudo   Ncube ", password: "violet harbour lantern", confirm: "violet harbour lantern" };
  assert.deepEqual(toAcceptRequest(v, fresh, TOKEN), { token: TOKEN, password: v.password, name: "Rudo Ncube" });
  assert.deepEqual(toAcceptRequest(v, { ...fresh, accountExists: true }, TOKEN), { token: TOKEN, password: v.password });
  assert.deepEqual(toAcceptRequest({ ...v, name: "" }, { ...fresh, suggestedName: "Suggested  Name" }, TOKEN).name, "Suggested Name");
  assert.deepEqual(Object.keys(toAcceptRequest(v, fresh, TOKEN)).sort(), ["name", "password", "token"]);
  assert.equal(emptyAcceptForm("Suggested").name, "Suggested");
  assert.equal(chosenName({ name: "", password: "", confirm: "" }, fresh), "");
});

// ---------- finishing a reset ----------

test("a reset needs a good password typed twice", () => {
  assert.deepEqual(validateReset({ password: "", confirm: "" }), { ok: false, errors: { password: "Choose a new password." } });
  assert.equal(validateReset({ password: "short", confirm: "short" }).ok, false);
  assert.deepEqual(validateReset({ password: "granite meadow whisper", confirm: "granite meadow whispers" }), { ok: false, errors: { confirm: "The two passwords are not the same." } });
  assert.deepEqual(validateReset({ password: "granite meadow whisper", confirm: "granite meadow whisper" }), { ok: true });
});

// ---------- explanations ----------

test("every way a link can fail has its own plain explanation, and the form gives way for those that end the link", () => {
  const codes = ["link_used", "link_expired", "link_revoked", "link_not_found", "shared_account", "head_not_managed", "member_deactivated"];
  const titles = new Set(codes.map((c) => describeLinkProblem(c, "reset").title));
  assert.ok(titles.size >= 5, "distinct explanations");
  for (const c of codes) assert.ok(LINK_ENDED.has(c));
  assert.ok(!LINK_ENDED.has("password_too_short") && !LINK_ENDED.has("invalid_credentials"), "a fixable mistake keeps the form");
  assert.match(describeLinkProblem("link_expired", "invitation").body, /new invitation/);
  assert.match(describeLinkProblem("link_expired", "reset").body, /new reset link/);
  assert.match(describeLinkProblem("link_used", "invitation").body, /sign in/i);
  assert.match(describeLinkProblem(undefined, "reset").title, /cannot be used/);
});

// ---------- sharing ----------

test("the message to share names the school, carries the link, and says it works once", () => {
  const link = linkUrl("https://app.example.org", "accept", TOKEN);
  const text = invitationMessage("Mavambo Academy", link, "2026-10-15T06:05:00.000Z", "UTC");
  assert.match(text, /Mavambo Academy/);
  assert.match(text, /works once/);
  assert.match(text, /15 Oct/);
  assert.ok(text.endsWith(link));
  const reset = resetMessage("Ms. Chipo", "Mavambo Academy", linkUrl("https://app.example.org", "reset", TOKEN), "2026-10-09T06:05:00.000Z", "UTC");
  assert.match(reset, /Ms\. Chipo/);
  assert.match(reset, /new password/);
  const wa = whatsAppUrl(text);
  assert.ok(wa.startsWith("https://wa.me/?text="));
  assert.equal(decodeURIComponent(wa.slice("https://wa.me/?text=".length)), text, "the link survives the encoding intact, # and all");
  assert.match(expiryLabel("2026-10-09T06:05:00.000Z", "UTC"), /9 Oct.*06:05/);
});

test("time left reads like a person would say it", () => {
  const now = new Date("2026-10-08T06:00:00.000Z");
  const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
  assert.equal(timeLeft(at(0), now), "expired");
  assert.equal(timeLeft(at(-5000), now), "expired");
  assert.equal(timeLeft(at(59 * 60_000), now), "less than an hour left");
  assert.equal(timeLeft(at(3_600_000), now), "1 hour left");
  assert.equal(timeLeft(at(5.5 * 3_600_000), now), "5 hours left");
  assert.equal(timeLeft(at(24 * 3_600_000), now), "1 day left");
  assert.equal(timeLeft(at(6.9 * 86_400_000), now), "6 days left");
});

// ---------- the staff list ----------

test("the head is offered the right actions: only for other teachers, matching their state", () => {
  const me = "u-head";
  assert.deepEqual(memberActions({ role: "teacher", active: true, userId: "u1" }, me), { switchOff: true, switchOn: false, resetLink: true });
  assert.deepEqual(memberActions({ role: "teacher", active: false, userId: "u1" }, me), { switchOff: false, switchOn: true, resetLink: false });
  assert.deepEqual(memberActions({ role: "head", active: true, userId: "u2" }, me), { switchOff: false, switchOn: false, resetLink: false });
  assert.deepEqual(memberActions({ role: "head", active: true, userId: me }, me), { switchOff: false, switchOn: false, resetLink: false });
  assert.deepEqual(memberActions({ role: "teacher", active: true, userId: me }, me), { switchOff: false, switchOn: false, resetLink: false }, "never yourself");
  assert.deepEqual(memberStatus({ active: true }), { label: "Access on", tone: "good" });
  assert.deepEqual(memberStatus({ active: false }), { label: "Access off", tone: "bad" });
  assert.equal(inviteeLabel({ name: "Rudo", email: "r@x.co" }), "Rudo (r@x.co)");
  assert.equal(inviteeLabel({ name: null, email: "r@x.co" }), "r@x.co");
});
