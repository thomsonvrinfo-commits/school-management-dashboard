/**
 * Staff onboarding (P1), against a real PostgreSQL: the head invites a teacher, the teacher opens the link and gets an
 * account, access can be switched off and on, and a forgotten password is replaced through a link the head hands over.
 * Every link is single-use, expires, and is stored only as a hash; every change is audited without personal values.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  invitationPreview, resetLinkResponse, staffListResponse, tokenResponse, type InviteStaffResponse,
} from "@schoolpulse/contracts";
import { pgTestsEnabled } from "@schoolpulse/db/testing";
import { hashOpaqueToken } from "../src/auth/token.ts";
import { HttpError } from "../src/errors.ts";
import { authenticate, login, refresh } from "../src/services/auth.ts";
import { DEV_IDS, EXTRA, call, callPublic, expectError, expectOk, makeAdminFixture, type AdminFixture } from "./admin-support.ts";
import { NOW_ISO, PASSWORD } from "./support.ts";

const skip = pgTestsEnabled() ? false : "no PostgreSQL configured (set PSQL_TEST_CONN)";
let f: AdminFixture;

const STRONG = "violet harbour lantern";
const STRONGER = "granite meadow whisper";
let deviceCounter = 0;
const device = () => `device-new-${String(++deviceCounter).padStart(5, "0")}`;
let emailCounter = 0;
const freshEmail = () => `teacher${++emailCounter}@mavambo.example`;

const list = async (who = f.head) => expectOk(await call(f, who, "GET /v1/staff")).body as { members: { membershipId: string; userId: string; name: string; email: string; role: string; active: boolean }[]; invitations: { id: string; email: string; name: string | null }[] };
const invite = async (email: string, name?: string, who = f.head) =>
  expectOk(await call(f, who, "POST /v1/staff/invitations", { body: name === undefined ? { email } : { email, name } }), 201).body as InviteStaffResponse;
const preview = (token: string) => callPublic(f, "POST /v1/invitations/preview", { body: { token } });
const accept = (token: string, body: Record<string, unknown> = {}) =>
  callPublic(f, "POST /v1/invitations/accept", { body: { token, name: "Rudo Ncube", password: STRONG, deviceId: device(), ...body } });
const complete = (token: string, password = STRONGER) => callPublic(f, "POST /v1/password-reset/complete", { body: { token, password } });
const issueReset = async (membershipId: string, who = f.head) =>
  expectOk(await call(f, who, "POST /v1/staff/:membershipId/reset-link", { params: { membershipId } }), 201).body as { token: string; expiresAt: string; staffName: string };
const q = <T extends object>(sql: string, p: (string | null)[] = []) => f.t.runner.query<T>(sql, p);
const actions = async (like = "staff.%") =>
  (await q<{ action: string }>(`select action from audit_log where school_id = $1 and action like $2 order by id`, [DEV_IDS.school, like])).map((r) => r.action);

/** Invites and accepts in one go: a signed-in teacher who works at Mavambo, with their membership id. */
async function onboard(name: string): Promise<{ email: string; userId: string; membershipId: string; accessToken: string; refreshToken: string; deviceId: string }> {
  const email = freshEmail();
  const inv = await invite(email, name);
  const deviceId = device();
  const res = expectOk(await accept(inv.token, { deviceId, name }));
  const t = tokenResponse.parse(res.body);
  const member = (await list()).members.find((m) => m.email === email)!;
  return { email, userId: t.me.user.id, membershipId: member.membershipId, accessToken: t.accessToken, refreshToken: t.refreshToken, deviceId };
}

before(async () => {
  if (skip) return;
  f = await makeAdminFixture();
});
after(async () => {
  if (!skip) await f.close();
});

// ---------- the staff list ----------

test("the head sees everyone at their school, heads first, and a teacher is refused", { skip }, async () => {
  const res = expectOk(await call(f, f.head, "GET /v1/staff"));
  assert.equal(staffListResponse.safeParse(res.body).success, true, JSON.stringify(staffListResponse.safeParse(res.body)));
  const { members, invitations } = res.body as Awaited<ReturnType<typeof list>>;
  assert.deepEqual(members.map((m) => m.email), ["head@mavambo.example", "tendai@mavambo.example", "chipo@mavambo.example"], "heads first, then by name (Mr. Tendai, Ms. Chipo)");
  assert.deepEqual(members.map((m) => m.role), ["head", "teacher", "teacher"]);
  assert.equal(members.every((m) => m.active), true);
  assert.deepEqual(invitations, []);
  expectError(await call(f, f.chipo, "GET /v1/staff"), 403, "forbidden");
});

test("another school's head sees only their own school's people", { skip }, async () => {
  const { members } = await list(f.otherHead);
  assert.deepEqual(members.map((m) => m.email).sort(), ["head@other.example", "teacher@other.example"]);
});

// ---------- inviting ----------

test("an invitation returns its secret once; the database holds only a hash, and the list never shows it", { skip }, async () => {
  const email = freshEmail();
  const inv = await invite(email, "  Rudo   Ncube ");
  assert.match(inv.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(inv.invitation.email, email);
  assert.equal(inv.invitation.name, "Rudo Ncube", "the name is tidied");
  assert.equal(inv.invitation.role, "teacher");
  const days = (new Date(inv.invitation.expiresAt).getTime() - new Date(NOW_ISO).getTime()) / 86_400_000;
  assert.equal(days, 7, "valid for a week");

  const [row] = await q<{ token_hash: string; school_id: string; role: string }>(`select token_hash, school_id, role from staff_tokens where id = $1`, [inv.invitation.id]);
  assert.equal(row!.token_hash, await hashOpaqueToken(inv.token));
  assert.notEqual(row!.token_hash, inv.token);
  assert.equal(row!.school_id, DEV_IDS.school);
  assert.equal(row!.role, "teacher", "invitations from the app are always for teachers");
  const everything = await q<{ t: string }>(`select x::text as t from staff_tokens x where id = $1`, [inv.invitation.id]);
  assert.ok(!everything[0]!.t.includes(inv.token), "the secret is nowhere in the stored row");

  const shown = JSON.stringify(await list());
  assert.ok(!shown.includes(inv.token), "the list does not repeat the secret");
  assert.ok((await list()).invitations.some((i) => i.id === inv.invitation.id));
});

test("an email address is matched without regard to case and is stored in lower case", { skip }, async () => {
  const inv = await invite("  Mixed.Case@Mavambo.EXAMPLE ");
  assert.equal(inv.invitation.email, "mixed.case@mavambo.example");
  const again = expectOk(await call(f, f.head, "POST /v1/staff/invitations", { body: { email: "MIXED.CASE@mavambo.example" } }), 201).body as InviteStaffResponse;
  assert.equal(again.invitation.id !== inv.invitation.id, true);
  assert.equal((await list()).invitations.filter((i) => i.email === "mixed.case@mavambo.example").length, 1, "still only one waiting link for them");
});

test("bad input to an invitation is a 400 that names the field", { skip }, async () => {
  expectError(await call(f, f.head, "POST /v1/staff/invitations", { body: { email: "not-an-email" } }), 400, "invalid_email", "email");
  expectError(await call(f, f.head, "POST /v1/staff/invitations", { body: { email: freshEmail(), name: "x".repeat(201) } }), 400, "invalid_request");
  expectError(await call(f, f.head, "POST /v1/staff/invitations", { body: {} }), 400, "invalid_request");
  expectError(await call(f, f.head, "POST /v1/staff/invitations", { rawBody: "{nope" }), 400, "invalid_json");
});

test("an invitation cannot name a school or a role: unknown keys are refused", { skip }, async () => {
  expectError(await call(f, f.head, "POST /v1/staff/invitations", { body: { email: freshEmail(), schoolId: EXTRA.otherSchool } }), 400, "invalid_request");
  expectError(await call(f, f.head, "POST /v1/staff/invitations", { body: { email: freshEmail(), role: "head" } }), 400, "invalid_request");
});

test("a person who already works here, or whose access was switched off, cannot be invited again", { skip }, async () => {
  expectError(await call(f, f.head, "POST /v1/staff/invitations", { body: { email: "CHIPO@mavambo.example" } }), 409, "already_a_member", "email");
  const gone = await onboard("Leaver One");
  expectOk(await call(f, f.head, "POST /v1/staff/:membershipId/deactivate", { params: { membershipId: gone.membershipId } }));
  expectError(await call(f, f.head, "POST /v1/staff/invitations", { body: { email: gone.email } }), 409, "member_deactivated", "email");
});

test("inviting again replaces the waiting link: the old one stops working and the new one works", { skip }, async () => {
  const email = freshEmail();
  const first = await invite(email);
  const second = await invite(email);
  assert.notEqual(first.token, second.token);
  expectError(await preview(first.token), 409, "link_revoked");
  expectOk(await preview(second.token));
  assert.equal((await list()).invitations.filter((i) => i.email === email).length, 1);
  const [{ n }] = await q<{ n: number }>(`select count(*)::int as n from staff_tokens where email = $1 and revoked_at is null and used_at is null`, [email]) as [{ n: number }];
  assert.equal(n, 1);
});

// ---------- opening a link ----------

test("previewing shows the school and the address, and whether this person already has an account", { skip }, async () => {
  const fresh = await invite(freshEmail(), "Suggested Name");
  const a = expectOk(await preview(fresh.token));
  assert.equal(invitationPreview.safeParse(a.body).success, true);
  assert.deepEqual(
    { schoolName: a.body.schoolName, role: a.body.role, suggestedName: a.body.suggestedName, accountExists: a.body.accountExists },
    { schoolName: (await q<{ name: string }>(`select name from schools where id = $1`, [DEV_IDS.school]))[0]!.name, role: "teacher", suggestedName: "Suggested Name", accountExists: false },
  );
  const known = await invite("teacher@other.example");
  assert.equal(expectOk(await preview(known.token)).body.accountExists, true, "an account at another school");
});

test("a link that does not exist, is malformed, or is for the other purpose all look the same", { skip }, async () => {
  expectError(await preview("A".repeat(43)), 404, "link_not_found");
  expectError(await preview("short"), 400, "invalid_request");
  expectError(await preview("not a token!!!not a token!!!"), 400, "invalid_request");
  const resetLink = await issueReset(f.chipo.auth.ctx.membershipId ?? DEV_IDS.teacherMembership);
  expectError(await preview(resetLink.token), 404, "link_not_found");
  expectError(await accept(resetLink.token), 404, "link_not_found");
  const inv = await invite(freshEmail());
  expectError(await complete(inv.token), 404, "link_not_found");
});

test("accepting creates the account and the membership and signs the person in", { skip }, async () => {
  const email = freshEmail();
  const inv = await invite(email, "Suggested Name");
  const res = expectOk(await accept(inv.token, { name: "  Rudo   Ncube ", deviceId: "device-rudo-0001" }));
  const t = tokenResponse.parse(res.body);
  assert.equal(t.me.role, "teacher");
  assert.equal(t.me.school.id, DEV_IDS.school);
  assert.equal(t.me.user.name, "Rudo Ncube", "the person's own name wins over the head's suggestion");
  assert.equal(t.me.user.email, email);

  const auth = await authenticate(f.deps, `Bearer ${t.accessToken}`);
  assert.equal(auth.principal.role, "teacher");
  assert.equal((await login(f.deps, { email: email.toUpperCase(), password: STRONG, deviceId: "device-rudo-0002" })).me.user.id, t.me.user.id, "can sign in normally afterwards");

  const [m] = await q<{ role: string; active: boolean; school_id: string }>(`select role, active, school_id from memberships where user_id = $1`, [t.me.user.id]);
  assert.deepEqual(m, { role: "teacher", active: true, school_id: DEV_IDS.school });
  const [u] = await q<{ password_hash: string }>(`select password_hash from users where id = $1`, [t.me.user.id]);
  assert.ok(!u!.password_hash.includes(STRONG) && u!.password_hash.length > 40, "only a hash of the password is stored");
  assert.equal((await list()).members.some((x) => x.email === email && x.role === "teacher" && x.active), true);
  assert.equal((await list()).invitations.some((i) => i.id === inv.invitation.id), false, "no longer waiting");
});

test("with no name typed, the head's suggested name is used; with neither, the name is required", { skip }, async () => {
  const withSuggestion = await invite(freshEmail(), "Suggested Person");
  const t = tokenResponse.parse(expectOk(await accept(withSuggestion.token, { name: undefined })).body);
  assert.equal(t.me.user.name, "Suggested Person");
  const none = await invite(freshEmail());
  expectError(await accept(none.token, { name: undefined }), 400, "name_required", "name");
  expectError(await accept(none.token, { name: "   " }), 400, "name_required", "name");
  expectOk(await preview(none.token), 200); // the failed attempts did not use the link up
});

test("a weak password is refused with the reason, and the link stays usable", { skip }, async () => {
  const inv = await invite(freshEmail());
  expectError(await accept(inv.token, { password: "short" }), 400, "password_too_short", "password");
  expectError(await accept(inv.token, { password: "aaaaaaaaaaaaaaaa" }), 400, "password_too_simple", "password");
  expectError(await accept(inv.token, { password: "password123" }), 400, "password_too_common", "password");
  expectError(await accept(inv.token, { password: "Rudo Ncube 2026!", name: "Rudo Ncube" }), 400, "password_contains_identity", "password");
  expectError(await accept(inv.token, { password: "" }), 400, "invalid_request", "password");
  expectOk(await preview(inv.token));
  assert.equal((await q(`select id from staff_tokens where id = $1 and used_at is not null`, [inv.invitation.id])).length, 0);
  expectOk(await accept(inv.token));
});

test("the role and school come from the invitation: extra keys in the request are refused", { skip }, async () => {
  const inv = await invite(freshEmail());
  expectError(await accept(inv.token, { role: "head" }), 400, "invalid_request");
  expectError(await accept(inv.token, { schoolId: EXTRA.otherSchool }), 400, "invalid_request");
  expectError(await accept(inv.token, { email: "someone-else@example.com" }), 400, "invalid_request");
  const t = tokenResponse.parse(expectOk(await accept(inv.token)).body);
  assert.equal(t.me.role, "teacher");
  assert.equal(t.me.school.id, DEV_IDS.school);
});

test("a link works once: opening it again says it was used", { skip }, async () => {
  const inv = await invite(freshEmail());
  expectOk(await accept(inv.token));
  expectError(await accept(inv.token), 409, "link_used");
  expectError(await preview(inv.token), 409, "link_used");
});

test("two people opening the same link at the same moment: exactly one gets in", { skip }, async () => {
  const email = freshEmail();
  const inv = await invite(email);
  const results = await Promise.all([accept(inv.token, { name: "First Person" }), accept(inv.token, { name: "Second Person" }), accept(inv.token, { name: "Third Person" })]);
  assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => r.status)));
  for (const r of results.filter((x) => x.status !== 200)) expectError(r, 409, "link_used");
  assert.equal((await q(`select id from users where lower(email) = $1`, [email])).length, 1, "one account");
  assert.equal((await q(`select m.id from memberships m join users u on u.id = m.user_id where lower(u.email) = $1`, [email])).length, 1, "one membership");
});

test("an invitation works for a week and not a moment longer", { skip }, async () => {
  const early = await invite(freshEmail());
  const late = await invite(freshEmail());
  const start = f.clock.now;
  try {
    f.clock.now = new Date(start.getTime() + 6.9 * 86_400_000);
    expectOk(await preview(early.token));
    expectOk(await accept(early.token));
    f.clock.now = new Date(start.getTime() + 7 * 86_400_000);
    expectError(await preview(late.token), 409, "link_expired");
    expectError(await accept(late.token), 409, "link_expired");
    assert.equal((await q(`select 1 from users where lower(email) = $1`, [late.invitation.email])).length, 0, "an expired link creates nothing");
  } finally {
    f.clock.now = start;
  }
});

test("withdrawing an invitation: it stops working, drops off the list, and can only be done once", { skip }, async () => {
  const inv = await invite(freshEmail());
  expectOk(await call(f, f.head, "DELETE /v1/staff/invitations/:id", { params: { id: inv.invitation.id } }), 204);
  expectError(await preview(inv.token), 409, "link_revoked");
  expectError(await accept(inv.token), 409, "link_revoked");
  assert.equal((await list()).invitations.some((i) => i.id === inv.invitation.id), false);
  expectError(await call(f, f.head, "DELETE /v1/staff/invitations/:id", { params: { id: inv.invitation.id } }), 409, "invitation_not_waiting");
  expectError(await call(f, f.head, "DELETE /v1/staff/invitations/:id", { params: { id: "00000000-0000-4000-8000-00000000ffff" } }), 404, "not_found");
  expectError(await call(f, f.head, "DELETE /v1/staff/invitations/:id", { params: { id: "nope" } }), 404, "not_found");
  const used = await invite(freshEmail());
  expectOk(await accept(used.token));
  expectError(await call(f, f.head, "DELETE /v1/staff/invitations/:id", { params: { id: used.invitation.id } }), 409, "invitation_not_waiting");
});

test("someone with an account at another school proves it with their password, and keeps one account", { skip }, async () => {
  const inv = await invite("teacher@other.example", "Whatever");
  // the wrong password does not get in, and does not use the link up
  expectError(await accept(inv.token, { password: "not the password at all" }), 401, "invalid_credentials", "password");
  expectOk(await preview(inv.token));
  // a new password chosen by someone else is not accepted for an existing account
  expectError(await accept(inv.token, { password: STRONG }), 401, "invalid_credentials");

  const res = expectOk(await accept(inv.token, { password: PASSWORD, name: "A Different Name" }));
  const t = tokenResponse.parse(res.body);
  assert.equal(t.me.user.id, EXTRA.otherTeacher, "the same account");
  assert.equal(t.me.user.name, "Other Teacher", "the existing account's name is left alone");
  assert.equal(t.me.school.id, DEV_IDS.school, "signed in at the school that invited them");
  assert.equal((await q(`select 1 from users where lower(email) = 'teacher@other.example'`)).length, 1);
  assert.equal((await q(`select 1 from memberships where user_id = $1`, [EXTRA.otherTeacher])).length, 2);
  await assert.rejects(
    login(f.deps, { email: "teacher@other.example", password: PASSWORD, deviceId: device() }),
    (e: unknown) => e instanceof HttpError && e.status === 409 && e.code === "school_selection_required",
  );
  // and their password at the other school is untouched
  assert.equal((await login(f.deps, { email: "teacher@other.example", password: PASSWORD, deviceId: device(), schoolId: EXTRA.otherSchool })).me.school.id, EXTRA.otherSchool);
});

// ---------- switching access off and on ----------

test("switching access off signs the person out everywhere and stops them signing in; switching it on lets them back", { skip }, async () => {
  const p = await onboard("Access Person");
  const otherDevice = device();
  const second = await login(f.deps, { email: p.email, password: STRONG, deviceId: otherDevice });
  await authenticate(f.deps, `Bearer ${p.accessToken}`);

  const res = expectOk(await call(f, f.head, "POST /v1/staff/:membershipId/deactivate", { params: { membershipId: p.membershipId } }));
  assert.equal(res.body.active, false);
  assert.equal(res.body.email, p.email);

  for (const header of [`Bearer ${p.accessToken}`, `Bearer ${second.accessToken}`]) {
    await assert.rejects(authenticate(f.deps, header), (e: unknown) => e instanceof HttpError && e.status === 401);
  }
  await assert.rejects(refresh(f.deps, { refreshToken: p.refreshToken, deviceId: p.deviceId }), (e: unknown) => e instanceof HttpError && e.status === 401);
  await assert.rejects(refresh(f.deps, { refreshToken: second.refreshToken, deviceId: otherDevice }), (e: unknown) => e instanceof HttpError && e.status === 401);
  await assert.rejects(login(f.deps, { email: p.email, password: STRONG, deviceId: device() }), (e: unknown) => e instanceof HttpError && e.status === 403 && e.code === "no_active_membership");
  assert.equal((await list()).members.find((m) => m.membershipId === p.membershipId)!.active, false, "still on the list, marked off");
  assert.equal((await q(`select 1 from sessions where membership_id = $1 and revoked_at is null`, [p.membershipId])).length, 0);

  expectError(await call(f, f.head, "POST /v1/staff/:membershipId/deactivate", { params: { membershipId: p.membershipId } }), 409, "already_inactive");

  assert.equal(expectOk(await call(f, f.head, "POST /v1/staff/:membershipId/reactivate", { params: { membershipId: p.membershipId } })).body.active, true);
  const back = await login(f.deps, { email: p.email, password: STRONG, deviceId: device() });
  assert.equal(back.me.role, "teacher");
  await assert.rejects(authenticate(f.deps, `Bearer ${p.accessToken}`), (e: unknown) => e instanceof HttpError && e.status === 401, "the old sessions stay ended");
  expectError(await call(f, f.head, "POST /v1/staff/:membershipId/reactivate", { params: { membershipId: p.membershipId } }), 409, "already_active");
});

test("switching one person off leaves everyone else signed in", { skip }, async () => {
  const a = await onboard("Person A");
  const b = await onboard("Person B");
  expectOk(await call(f, f.head, "POST /v1/staff/:membershipId/deactivate", { params: { membershipId: a.membershipId } }));
  await authenticate(f.deps, `Bearer ${b.accessToken}`);
  await authenticate(f.deps, f.tendai.header);
  await authenticate(f.deps, f.head.header);
});

test("a head's access cannot be switched off or reset from the app, not even their own", { skip }, async () => {
  const headMembership = (await list()).members.find((m) => m.role === "head")!.membershipId;
  for (const key of ["POST /v1/staff/:membershipId/deactivate", "POST /v1/staff/:membershipId/reactivate", "POST /v1/staff/:membershipId/reset-link"]) {
    expectError(await call(f, f.head, key, { params: { membershipId: headMembership } }), 409, "head_not_managed");
  }
  await authenticate(f.deps, f.head.header);
});

test("a membership id from another school, or one that does not exist, is a plain 404", { skip }, async () => {
  const mine = (await list()).members.find((m) => m.email === "tendai@mavambo.example")!.membershipId;
  const theirs = (await list(f.otherHead)).members.find((m) => m.email === "teacher@other.example")!.membershipId;
  for (const key of ["POST /v1/staff/:membershipId/deactivate", "POST /v1/staff/:membershipId/reactivate", "POST /v1/staff/:membershipId/reset-link"]) {
    expectError(await call(f, f.otherHead, key, { params: { membershipId: mine } }), 404, "not_found");
    expectError(await call(f, f.head, key, { params: { membershipId: theirs } }), 404, "not_found");
    expectError(await call(f, f.head, key, { params: { membershipId: "00000000-0000-4000-8000-00000000ffff" } }), 404, "not_found");
    expectError(await call(f, f.head, key, { params: { membershipId: "not-a-uuid" } }), 404, "not_found");
  }
  await authenticate(f.deps, f.tendai.header);
  assert.equal((await q(`select 1 from staff_tokens where user_id = $1`, [EXTRA.tendai])).length, 0, "no reset link was made by the refused calls");
});

test("invitations belong to one school: another school's head cannot see or withdraw them", { skip }, async () => {
  const inv = await invite(freshEmail());
  assert.equal((await list(f.otherHead)).invitations.some((i) => i.id === inv.invitation.id), false);
  expectError(await call(f, f.otherHead, "DELETE /v1/staff/invitations/:id", { params: { id: inv.invitation.id } }), 404, "not_found");
  expectOk(await preview(inv.token));
});

// ---------- password reset ----------

test("a reset link lets a teacher choose a new password and signs out their old sessions", { skip }, async () => {
  const p = await onboard("Forgetful Person");
  const link = await issueReset(p.membershipId);
  assert.equal(resetLinkResponse.safeParse(link).success, true);
  assert.equal(link.staffName, "Forgetful Person");
  assert.equal((new Date(link.expiresAt).getTime() - new Date(NOW_ISO).getTime()) / 3_600_000, 24, "valid for a day");
  const [row] = await q<{ token_hash: string }>(`select token_hash from staff_tokens where purpose = 'reset' and user_id = $1 and used_at is null`, [p.userId]);
  assert.equal(row!.token_hash, await hashOpaqueToken(link.token));

  expectError(await complete(link.token, "short"), 400, "password_too_short", "password");
  expectError(await complete(link.token, "forgetful person 1"), 400, "password_contains_identity", "password");
  expectOk(await complete(link.token), 204);

  await assert.rejects(login(f.deps, { email: p.email, password: STRONG, deviceId: device() }), (e: unknown) => e instanceof HttpError && e.code === "invalid_credentials");
  assert.equal((await login(f.deps, { email: p.email, password: STRONGER, deviceId: device() })).me.user.id, p.userId);
  await assert.rejects(authenticate(f.deps, `Bearer ${p.accessToken}`), (e: unknown) => e instanceof HttpError && e.status === 401);
  await assert.rejects(refresh(f.deps, { refreshToken: p.refreshToken, deviceId: p.deviceId }), (e: unknown) => e instanceof HttpError && e.status === 401);
  expectError(await complete(link.token), 409, "link_used");
});

test("a newer reset link replaces the older one", { skip }, async () => {
  const p = await onboard("Twice Forgetful");
  const first = await issueReset(p.membershipId);
  const second = await issueReset(p.membershipId);
  expectError(await complete(first.token), 409, "link_revoked");
  expectOk(await complete(second.token), 204);
});

test("a reset link lasts a day", { skip }, async () => {
  const p = await onboard("Slow Person");
  const link = await issueReset(p.membershipId);
  const start = f.clock.now;
  try {
    f.clock.now = new Date(start.getTime() + 24 * 3_600_000);
    expectError(await complete(link.token), 409, "link_expired");
  } finally {
    f.clock.now = start;
  }
  await login(f.deps, { email: p.email, password: STRONG, deviceId: device() });
});

test("no reset link for someone whose access is off; and switching access off withdraws a link made earlier", { skip }, async () => {
  const p = await onboard("Switched Off");
  const link = await issueReset(p.membershipId);
  expectOk(await call(f, f.head, "POST /v1/staff/:membershipId/deactivate", { params: { membershipId: p.membershipId } }));
  expectError(await complete(link.token), 409, "link_revoked");
  expectError(await call(f, f.head, "POST /v1/staff/:membershipId/reset-link", { params: { membershipId: p.membershipId } }), 409, "member_deactivated");
});

test("an account that also works at another school cannot have its password reset by this school's head", { skip }, async () => {
  const p = await onboard("Two Schools");
  await q(`insert into memberships (id, user_id, school_id, role) values (gen_random_uuid(), $1, $2, 'teacher')`, [p.userId, EXTRA.otherSchool]);
  expectError(await call(f, f.head, "POST /v1/staff/:membershipId/reset-link", { params: { membershipId: p.membershipId } }), 409, "shared_account");
  expectError(await call(f, f.otherHead, "POST /v1/staff/:membershipId/reset-link", { params: { membershipId: p.membershipId } }), 404, "not_found");
  assert.equal((await q(`select 1 from staff_tokens where user_id = $1`, [p.userId])).length, 0);
});

test("the rule is checked again when the link is used: joining another school in between blocks it, without using the link up", { skip }, async () => {
  const p = await onboard("Joins Later");
  const link = await issueReset(p.membershipId);
  await q(`insert into memberships (id, user_id, school_id, role) values (gen_random_uuid(), $1, $2, 'teacher')`, [p.userId, EXTRA.otherSchool]);
  expectError(await complete(link.token), 409, "shared_account");
  assert.equal((await q(`select 1 from staff_tokens where token_hash = $1 and used_at is null and revoked_at is null`, [await hashOpaqueToken(link.token)])).length, 1);
  assert.equal((await login(f.deps, { email: p.email, password: STRONG, deviceId: device(), schoolId: DEV_IDS.school })).me.user.id, p.userId, "the password did not change");
});

test("two people using the same reset link at once: one wins", { skip }, async () => {
  const p = await onboard("Raced Person");
  const link = await issueReset(p.membershipId);
  const results = await Promise.all([complete(link.token, "first granite meadow"), complete(link.token, "second granite meadow")]);
  assert.deepEqual(results.map((r) => r.status).sort(), [204, 409]);
  expectError(results.find((r) => r.status === 409)!, 409, "link_used");
});

// ---------- the record ----------

test("every change is in the audit trail, with no email, name, password or link in it", { skip }, async () => {
  const got = new Set(await actions());
  for (const a of [
    "staff.invited", "staff.invitation_revoked", "staff.joined", "staff.deactivated", "staff.reactivated", "staff.reset_link_issued", "staff.password_reset",
  ]) assert.ok(got.has(a), `missing audit action ${a}`);

  const rows = await q<{ action: string; details: unknown; actor_user_id: string }>(`select action, details, actor_user_id from audit_log where action like 'staff.%'`);
  const text = JSON.stringify(rows.map((r) => r.details));
  assert.ok(!text.includes("@"), "no email address in any detail");
  assert.ok(!/[A-Za-z0-9_-]{40,}/.test(text), "nothing that looks like a link secret or hash");
  for (const word of ["Rudo", "Ncube", "violet", "granite", STRONG, PASSWORD]) assert.ok(!text.includes(word), `${word} must not be in the trail`);

  const issued = rows.filter((r) => r.action === "staff.invited");
  assert.ok(issued.every((r) => r.actor_user_id === DEV_IDS.head || r.actor_user_id === f.head.auth.ctx.user.id));
  const joined = rows.filter((r) => r.action === "staff.joined");
  assert.ok(joined.length >= 5);
  assert.ok(joined.every((r) => r.actor_user_id !== DEV_IDS.head), "a person joining is recorded as themselves");
  // no link secret was ever written to a plain-text column anywhere
  assert.equal((await q(`select 1 from staff_tokens where token_hash !~ '^[A-Za-z0-9_-]{43}$'`)).length, 0, "all hashes are 43-character base64url SHA-256 digests");
});

test("a teacher is refused every head-only staff action", { skip }, async () => {
  const someone = (await list()).members.find((m) => m.email === "tendai@mavambo.example")!.membershipId;
  const some = "00000000-0000-4000-8000-00000000ffff";
  expectError(await call(f, f.chipo, "POST /v1/staff/invitations", { body: { email: freshEmail() } }), 403, "forbidden");
  expectError(await call(f, f.chipo, "DELETE /v1/staff/invitations/:id", { params: { id: some } }), 403, "forbidden");
  for (const key of ["POST /v1/staff/:membershipId/deactivate", "POST /v1/staff/:membershipId/reactivate", "POST /v1/staff/:membershipId/reset-link"]) {
    expectError(await call(f, f.chipo, key, { params: { membershipId: someone } }), 403, "forbidden");
  }
  await authenticate(f.deps, f.tendai.header);
});
