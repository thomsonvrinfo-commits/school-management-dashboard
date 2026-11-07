/**
 * The platform-operator commands: a school and its first head, a replacement head invitation, and a head's password
 * reset. They are not part of the HTTP API; the person on the other end uses the same public link endpoints as everyone.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tokenResponse } from "@schoolpulse/contracts";
import { pgTestsEnabled } from "@schoolpulse/db/testing";
import { authenticate, login } from "../src/services/auth.ts";
import { OperatorError, createSchoolWithHead, inviteHead, resetHeadPassword, type OperatorDeps } from "../src/staff/operator.ts";
import { ADMIN_EXTRA, DEV_IDS, callPublic, expectError, expectOk, makeAdminFixture, type AdminFixture } from "./admin-support.ts";
import { PASSWORD } from "./support.ts";

const skip = pgTestsEnabled() ? false : "no PostgreSQL configured (set PSQL_TEST_CONN)";
let f: AdminFixture;
let ops: OperatorDeps;
const STRONG = "violet harbour lantern";
let n = 0;
const device = () => `device-op-${String(++n).padStart(6, "0")}`;
const q = <T extends object>(sql: string, p: (string | null)[] = []) => f.t.runner.query<T>(sql, p);
const accept = (token: string, body: Record<string, unknown> = {}) =>
  callPublic(f, "POST /v1/invitations/accept", { body: { token, name: "New Head", password: STRONG, deviceId: device(), ...body } });
const refuses = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: unknown) => e instanceof OperatorError && re.test(e.message));

before(async () => {
  if (skip) return;
  f = await makeAdminFixture();
  ops = { staff: f.deps.staff, now: () => f.clock.now, newId: () => crypto.randomUUID() };
});
after(async () => {
  if (!skip) await f.close();
});

test("a new school and its first head teacher: the head opens the link and is signed in as head of that school only", { skip }, async () => {
  const { school, invitation } = await createSchoolWithHead(ops, { name: "  Chipinge   Primary ", code: "CHIP", headEmail: " Head@Chipinge.example ", headName: "Mrs. Moyo" });
  assert.equal(school.name, "Chipinge Primary");
  const [row] = await q<{ name: string; code: string; timezone: string }>(`select name, code, timezone from schools where id = $1`, [school.id]);
  assert.deepEqual(row, { name: "Chipinge Primary", code: "CHIP", timezone: "Africa/Harare" });
  assert.equal((await q(`select 1 from memberships where school_id = $1`, [school.id])).length, 0, "nobody has a membership until the head accepts");

  const preview = expectOk(await callPublic(f, "POST /v1/invitations/preview", { body: { token: invitation.token } })).body;
  assert.deepEqual({ schoolName: preview.schoolName, role: preview.role, email: preview.email, suggestedName: preview.suggestedName }, { schoolName: "Chipinge Primary", role: "head", email: "head@chipinge.example", suggestedName: "Mrs. Moyo" });

  const t = tokenResponse.parse(expectOk(await accept(invitation.token, { name: "Mrs. Moyo" })).body);
  assert.equal(t.me.role, "head");
  assert.equal(t.me.school.id, school.id);
  assert.equal((await q(`select 1 from memberships where user_id = $1`, [t.me.user.id])).length, 1, "a member of exactly one school");
  const auth = await authenticate(f.deps, `Bearer ${t.accessToken}`);
  assert.equal(auth.principal.role, "head");
  assert.equal(auth.principal.schoolId, school.id);
  assert.notEqual(auth.principal.schoolId, DEV_IDS.school);
  assert.ok((await q<{ details: { role: string } }>(`select details from audit_log where school_id = $1 and action = 'staff.joined'`, [school.id])).some((r) => r.details.role === "head"), "joining is audited");
});

test("creating a school is all-or-nothing, and the school code is unique ignoring case", { skip }, async () => {
  await refuses(createSchoolWithHead(ops, { name: "Clash School", code: "chip", headEmail: "x@clash.example" }), /already uses the code/);
  assert.equal((await q(`select 1 from schools where name = 'Clash School'`)).length, 0, "no school without its invitation, or the reverse");
  assert.equal((await q(`select 1 from staff_tokens where email = 'x@clash.example'`)).length, 0);
});

test("bad input to create-school is explained in words", { skip }, async () => {
  await refuses(createSchoolWithHead(ops, { name: "   ", headEmail: "a@b.co" }), /school name/);
  await refuses(createSchoolWithHead(ops, { name: "S", code: "!!", headEmail: "a@b.co" }), /School code/);
  await refuses(createSchoolWithHead(ops, { name: "S", timezone: "Mars/Olympus", headEmail: "a@b.co" }), /time zone/);
  await refuses(createSchoolWithHead(ops, { name: "S", headEmail: "not-an-email" }), /Head teacher email/);
  await refuses(createSchoolWithHead(ops, { name: "S", headEmail: "a@b.co", headName: "x".repeat(201) }), /Head teacher name/);
  assert.equal((await q(`select 1 from schools where name = 'S'`)).length, 0);
});

test("a head invitation lapses after a week like any other", { skip }, async () => {
  const { invitation } = await createSchoolWithHead(ops, { name: "Lapsing School", headEmail: "lapse@lapsing.example" });
  const start = f.clock.now;
  try {
    f.clock.now = new Date(start.getTime() + 7 * 86_400_000);
    expectError(await accept(invitation.token), 409, "link_expired");
  } finally {
    f.clock.now = start;
  }
});

test("inviting a head to an existing school: by code, refused for people already there, warns when a head exists", { skip }, async () => {
  await refuses(inviteHead(ops, { schoolCode: "NOPE", headEmail: "a@b.co" }), /No school has the code/);
  await q(`update schools set code = 'MAV' where id = $1`, [DEV_IDS.school]);
  await refuses(inviteHead(ops, { schoolCode: "mav", headEmail: "chipo@mavambo.example" }), /already has a membership/);
  const r = await inviteHead(ops, { schoolCode: "mav", headEmail: "deputy@mavambo.example", headName: "Deputy" });
  assert.equal(r.school.id, DEV_IDS.school);
  assert.match(r.warnings[0] ?? "", /already has 1 active head teacher/);
  const t = tokenResponse.parse(expectOk(await accept(r.invitation.token, { name: "Deputy Head" })).body);
  assert.equal(t.me.role, "head");
  assert.equal(t.me.school.id, DEV_IDS.school);
  // inviting the same person again replaces the waiting link
  const again = await inviteHead(ops, { schoolCode: "MAV", headEmail: "second@mavambo.example" });
  const newer = await inviteHead(ops, { schoolCode: "MAV", headEmail: "second@mavambo.example" });
  expectError(await callPublic(f, "POST /v1/invitations/preview", { body: { token: again.invitation.token } }), 409, "link_revoked");
  expectOk(await callPublic(f, "POST /v1/invitations/preview", { body: { token: newer.invitation.token } }));
});

test("a head's forgotten password: the operator makes a link, the head chooses a new password, old sessions end", { skip }, async () => {
  const r = await resetHeadPassword(ops, { schoolCode: "MAV", headEmail: "HEAD@mavambo.example" });
  assert.equal(r.headName, "Mr. Mbewe");
  assert.deepEqual(r.warnings, []);
  const [row] = await q<{ created_by: string | null; purpose: string }>(`select created_by, purpose from staff_tokens where user_id = $1 and used_at is null`, [DEV_IDS.head]);
  assert.deepEqual(row, { created_by: null, purpose: "reset" }, "marked as made by the operator");

  expectError(await callPublic(f, "POST /v1/password-reset/complete", { body: { token: r.reset.token, password: "short" } }), 400, "password_too_short");
  expectOk(await callPublic(f, "POST /v1/password-reset/complete", { body: { token: r.reset.token, password: "granite meadow whisper" } }), 204);
  await assert.rejects(authenticate(f.deps, f.head.header), (e: unknown) => (e as { status?: number }).status === 401, "the head's old session is gone");
  await assert.rejects(login(f.deps, { email: "head@mavambo.example", password: PASSWORD, deviceId: device() }), (e: unknown) => (e as { code?: string }).code === "invalid_credentials");
  assert.equal((await login(f.deps, { email: "head@mavambo.example", password: "granite meadow whisper", deviceId: device() })).me.role, "head");
  expectError(await callPublic(f, "POST /v1/password-reset/complete", { body: { token: r.reset.token, password: "another long phrase" } }), 409, "link_used");
});

test("the operator reset is for heads only, for people who exist, and with access on", { skip }, async () => {
  await refuses(resetHeadPassword(ops, { schoolCode: "NOPE", headEmail: "head@mavambo.example" }), /No school has the code/);
  await refuses(resetHeadPassword(ops, { schoolCode: "MAV", headEmail: "nobody@mavambo.example" }), /no membership/);
  await refuses(resetHeadPassword(ops, { schoolCode: "MAV", headEmail: "chipo@mavambo.example" }), /Staff screen/);
  await q(`update memberships set active = false where user_id = $1 and school_id = $2`, [DEV_IDS.head, DEV_IDS.school]);
  await refuses(resetHeadPassword(ops, { schoolCode: "MAV", headEmail: "head@mavambo.example" }), /switched off/);
  await q(`update memberships set active = true where user_id = $1 and school_id = $2`, [DEV_IDS.head, DEV_IDS.school]);
});

test("a head who also works elsewhere is warned about, and the link works (the operator is trusted with that)", { skip }, async () => {
  await q(`insert into memberships (id, user_id, school_id, role) values (gen_random_uuid(), $1, $2, 'head')`, [ADMIN_EXTRA.otherHead, DEV_IDS.school]);
  const r = await resetHeadPassword(ops, { schoolCode: "MAV", headEmail: "head@other.example" });
  assert.match(r.warnings[0] ?? "", /other school/);
  expectOk(await callPublic(f, "POST /v1/password-reset/complete", { body: { token: r.reset.token, password: "granite meadow whisper" } }), 204);
});

test("a link made by a head teacher is still held to the head's rules; only an operator link may reset a head", { skip }, async () => {
  // a reset link with a head behind it, aimed at a head's account (cannot be made through the API, so make it directly)
  const token = "H".repeat(43);
  const { hashOpaqueToken } = await import("../src/auth/token.ts");
  await q(
    `insert into staff_tokens (id, school_id, purpose, email, user_id, token_hash, expires_at, created_by)
     values (gen_random_uuid(), $1, 'reset', 'head@mavambo.example', $2, $3, $4::timestamptz, $5)`,
    [DEV_IDS.school, DEV_IDS.head, await hashOpaqueToken(token), new Date(f.clock.now.getTime() + 3_600_000).toISOString(), DEV_IDS.head],
  );
  expectError(await callPublic(f, "POST /v1/password-reset/complete", { body: { token, password: "granite meadow whisper" } }), 409, "head_not_managed");
});

/** One spelling of a path whatever the computer: Windows gives `C:\\...\\src\\` and this test adds `/`, so the two kinds must be made one. */
const slashes = (p: string) => p.replaceAll("\\", "/");

test("paths from a Windows computer are compared in the same way as paths from Linux", () => {
  // what `fileURLToPath` plus this test's own walk produce on Windows: backslashes from the start, a forward slash added for each folder
  assert.ok(slashes("C:\\work\\apps\\api\\src\\staff/operator.ts").endsWith("/staff/operator.ts"));
  assert.ok(slashes("/work/apps/api/src/staff/operator.ts").endsWith("/staff/operator.ts"));
  assert.ok(!slashes("C:\\work\\apps\\api\\src\\staff/not-operator.ts").endsWith("/staff/operator.ts"));
});

test("the operator commands are not reachable from the HTTP API", () => {
  const src = fileURLToPath(new URL("../src/", import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(dir + e.name + "/");
      else if (e.name.endsWith(".ts")) files.push(slashes(dir + e.name));
    }
  };
  walk(src);
  // The scan must really have looked: with a wrong path or a wrong separator it would find nothing and "pass".
  for (const must of ["/src/app.ts", "/src/routes.ts", "/src/staff/handlers.ts", "/src/staff/members.ts"]) {
    assert.ok(files.some((p) => p.endsWith(must)), `the scan did not reach ${must} (${files.length} files found): it is not looking where it should`);
  }
  const own = files.filter((p) => p.endsWith("/staff/operator.ts"));
  assert.equal(own.length, 1, "the one file allowed to name the operator commands must be found, so the exclusion below is really exercised");
  const offenders = files.filter((p) => !p.endsWith("/staff/operator.ts") && /operator\.ts|createSchoolWithHead|resetHeadPassword|inviteHead/.test(readFileSync(p, "utf8")));
  assert.deepEqual(offenders, [], "nothing under apps/api/src may import the operator commands");
});
