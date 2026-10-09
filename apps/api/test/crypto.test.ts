import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, PBKDF2_ITERATIONS } from "../src/auth/password.ts";
import { signAccessToken, verifyAccessToken, hashRefreshToken, newRefreshToken } from "../src/auth/token.ts";
import { toB64Url, utf8 } from "../src/encoding.ts";

const SECRET = "test-secret-test-secret-test-secret-0123";
const NOW = new Date("2026-10-08T06:00:00Z");

test("password: correct verifies, wrong does not, each hash has its own salt", async () => {
  const a = await hashPassword("s3cret-pass");
  const b = await hashPassword("s3cret-pass");
  assert.notEqual(a, b);
  assert.ok(a.startsWith(`pbkdf2-sha256$${PBKDF2_ITERATIONS}$`));
  assert.equal(await verifyPassword("s3cret-pass", a), true);
  assert.equal(await verifyPassword("s3cret-pasS", a), false);
  assert.equal(await verifyPassword("", a), false);
});

test("password: malformed or foreign stored hashes never verify (and never throw)", async () => {
  for (const bad of ["", "plain", "pbkdf2-sha256$x$y$z", "md5$1$a$b", "pbkdf2-sha256$100000$$"]) {
    assert.equal(await verifyPassword("anything", bad), false, bad);
  }
});

test("token: round trip carries the claims", async () => {
  const { token, expiresAt } = await signAccessToken(SECRET, { sub: "u1", sid: "s1" }, NOW);
  assert.equal(expiresAt, "2026-10-08T06:15:00.000Z");
  const claims = await verifyAccessToken(SECRET, token, NOW);
  assert.equal(claims?.sub, "u1");
  assert.equal(claims?.sid, "s1");
});

test("token: expired, wrong secret, tampered payload and alg=none are all rejected", async () => {
  const { token } = await signAccessToken(SECRET, { sub: "u1", sid: "s1" }, NOW);
  assert.equal(await verifyAccessToken(SECRET, token, new Date(NOW.getTime() + 15 * 60_000 + 1000)), null);
  assert.equal(await verifyAccessToken("another-secret-another-secret-0000000", token, NOW), null);

  const [h, , s] = token.split(".") as [string, string, string];
  const forgedBody = toB64Url(utf8(JSON.stringify({ sub: "admin", sid: "s1", iat: 1, exp: 9_999_999_999 })));
  assert.equal(await verifyAccessToken(SECRET, `${h}.${forgedBody}.${s}`, NOW), null);

  const none = `${toB64Url(utf8(JSON.stringify({ alg: "none", typ: "JWT" })))}.${forgedBody}.`;
  assert.equal(await verifyAccessToken(SECRET, none, NOW), null);
  assert.equal(await verifyAccessToken(SECRET, "garbage", NOW), null);
  assert.equal(await verifyAccessToken(SECRET, "a.b.c", NOW), null);
});

test("token: a short secret is refused rather than silently weak", async () => {
  await assert.rejects(signAccessToken("short", { sub: "u", sid: "s" }, NOW), /at least 32/);
});

test("refresh tokens are long, unique, and hashed deterministically", async () => {
  const a = newRefreshToken();
  const b = newRefreshToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 40);
  assert.equal(await hashRefreshToken(a), await hashRefreshToken(a));
  assert.notEqual(await hashRefreshToken(a), a);
});
