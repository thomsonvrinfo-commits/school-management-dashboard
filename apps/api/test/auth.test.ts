import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pgTestsEnabled } from "@schoolpulse/db/testing";
import { DEV_IDS } from "@schoolpulse/db";
import { authenticate, login, logout, refresh } from "../src/services/auth.ts";
import { HttpError } from "../src/errors.ts";
import { signAccessToken } from "../src/auth/token.ts";
import { EMAILS, EXTRA, PASSWORD, SECRET, makeFixture, signIn, type Fixture } from "./support.ts";

const skip = pgTestsEnabled() ? false : "no PostgreSQL configured (set PSQL_TEST_CONN)";
let f: Fixture;
before(async () => { if (!skip) f = await makeFixture(); });
after(async () => { if (!skip) await f.close(); });

const status = (e: unknown) => (e instanceof HttpError ? `${e.status} ${e.code}` : String(e));
const D = (n: number) => `device-aaaa000${n}`;

test("teacher and head can sign in and see their own role and school", { skip }, async () => {
  const t = await signIn(f.deps, EMAILS.chipo, D(1));
  assert.equal(t.tokens.me.role, "teacher");
  assert.equal(t.tokens.me.school.name, "Mavambo Academy");
  assert.equal(t.auth.principal.schoolId, DEV_IDS.school);
  const h = await signIn(f.deps, EMAILS.head, D(2));
  assert.equal(h.tokens.me.role, "head");
});

test("wrong password and unknown email give the same answer", { skip }, async () => {
  const a = await login(f.deps, { email: EMAILS.chipo, password: "nope", deviceId: D(1) }).catch(status);
  const b = await login(f.deps, { email: "ghost@nowhere.example", password: "nope", deviceId: D(1) }).catch(status);
  assert.equal(a, "401 invalid_credentials");
  assert.equal(b, "401 invalid_credentials");
});

test("a request without a valid bearer token is unauthenticated", { skip }, async () => {
  for (const h of [undefined, "", "Bearer", "Bearer garbage", "Basic abc"]) {
    assert.equal(await authenticate(f.deps, h).catch(status), "401 unauthenticated", String(h));
  }
});

test("an access token expires after 15 minutes", { skip }, async () => {
  const s = await signIn(f.deps, EMAILS.chipo, D(3));
  const before = f.clock.now;
  try {
    f.clock.now = new Date(before.getTime() + 16 * 60_000);
    assert.equal(await authenticate(f.deps, s.header).catch(status), "401 unauthenticated");
  } finally {
    f.clock.now = before;
  }
});

test("refresh issues new tokens and the old refresh token stops working", { skip }, async () => {
  const s = await signIn(f.deps, EMAILS.chipo, D(4));
  const next = await refresh(f.deps, { refreshToken: s.tokens.refreshToken, deviceId: D(4) });
  assert.notEqual(next.refreshToken, s.tokens.refreshToken);
  await authenticate(f.deps, `Bearer ${next.accessToken}`);
  assert.equal(await refresh(f.deps, { refreshToken: s.tokens.refreshToken, deviceId: D(4) }).catch(status), "401 invalid_session");
});

test("refresh from a different device is refused", { skip }, async () => {
  const s = await signIn(f.deps, EMAILS.chipo, D(5));
  assert.equal(await refresh(f.deps, { refreshToken: s.tokens.refreshToken, deviceId: D(6) }).catch(status), "401 invalid_session");
});

test("logout revokes the device at once: its access token and refresh token both die", { skip }, async () => {
  const s = await signIn(f.deps, EMAILS.chipo, D(7));
  await logout(f.deps, s.tokens.refreshToken);
  assert.equal(await authenticate(f.deps, s.header).catch(status), "401 unauthenticated");
  assert.equal(await refresh(f.deps, { refreshToken: s.tokens.refreshToken, deviceId: D(7) }).catch(status), "401 invalid_session");
  await logout(f.deps, s.tokens.refreshToken); // idempotent
});

test("deactivating a membership takes effect on the next request, not at token expiry", { skip }, async () => {
  const s = await signIn(f.deps, EMAILS.tendai, D(8));
  await f.t.runner.query(`update memberships set active = false where id = $1`, [EXTRA.tendaiMembership]);
  assert.equal(await authenticate(f.deps, s.header).catch(status), "401 unauthenticated");
  await f.t.runner.query(`update memberships set active = true where id = $1`, [EXTRA.tendaiMembership]);
});

test("a valid signature for a session that does not exist is refused", { skip }, async () => {
  const { token } = await signAccessToken(SECRET, { sub: DEV_IDS.teacher, sid: crypto.randomUUID() }, f.clock.now);
  assert.equal(await authenticate(f.deps, `Bearer ${token}`).catch(status), "401 unauthenticated");
});

test("a token for a real session but another user's id is refused", { skip }, async () => {
  const s = await signIn(f.deps, EMAILS.chipo, D(9));
  const { token } = await signAccessToken(SECRET, { sub: DEV_IDS.head, sid: s.auth.ctx.sessionId }, f.clock.now);
  assert.equal(await authenticate(f.deps, `Bearer ${token}`).catch(status), "401 unauthenticated");
});

test("multi-school accounts must choose a school, and only one they belong to", { skip }, async () => {
  const q = (sql: string, p: string[]) => f.t.runner.query(sql, p);
  await q(`insert into users (id, email, name, password_hash) select $1, 'both@example.com', 'Both', password_hash from users where id = $2`, [EXTRA.multiUser, DEV_IDS.teacher]);
  await q(`insert into memberships (user_id, school_id, role) values ($1, $2, 'teacher'), ($1, $3, 'teacher')`, [EXTRA.multiUser, DEV_IDS.school, EXTRA.otherSchool]);
  const base = { email: "both@example.com", password: PASSWORD, deviceId: D(1) };
  assert.equal(await login(f.deps, base).catch(status), "409 school_selection_required");
  const ok = await login(f.deps, { ...base, schoolId: EXTRA.otherSchool });
  assert.equal(ok.me.school.name, "Other School");
  assert.equal(await login(f.deps, { ...base, schoolId: crypto.randomUUID() }).catch(status), "403 no_active_membership");
});

test("an inactive user cannot sign in", { skip }, async () => {
  await f.t.runner.query(`update users set active = false where id = $1`, [EXTRA.otherTeacher]);
  assert.equal(await login(f.deps, { email: EMAILS.other, password: PASSWORD, deviceId: D(1) }).catch(status), "401 invalid_credentials");
  await f.t.runner.query(`update users set active = true where id = $1`, [EXTRA.otherTeacher]);
});
