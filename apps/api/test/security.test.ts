import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/errors.ts";
import { ROUTES, routeKey } from "../src/routes.ts";
import { API_SECURITY_HEADERS } from "../src/security/headers.ts";
import { callerOf, checkRate, limitKey, mustLimit, type RateLimiter } from "../src/security/rate-limit.ts";

const publicKeys = ROUTES.filter((r) => r.access === "public").map(routeKey).sort();

const recording = (success = true) => {
  const keys: string[] = [];
  const limiter: RateLimiter = { limit: async ({ key }) => (keys.push(key), { success }) };
  return { limiter, keys };
};
const req = (method: string, path: string, address: string | undefined = "203.0.113.7") => ({ method, path, address });

test("exactly the public endpoints are limited, and the list comes from the route table", () => {
  const limited = ROUTES.filter((r) => mustLimit(r.method, r.path, ROUTES)).map(routeKey).sort();
  assert.deepEqual(limited, publicKeys);
  assert.ok(publicKeys.length >= 6, "login, refresh, logout and the three link endpoints");
  for (const k of ["POST /v1/auth/login", "POST /v1/auth/refresh", "POST /v1/invitations/accept", "POST /v1/invitations/preview", "POST /v1/password-reset/complete"]) {
    assert.ok(publicKeys.includes(k), k);
  }
});

test("a signed-in endpoint, an unknown path, a browser preflight and the wrong verb are never limited", () => {
  assert.equal(mustLimit("GET", "/v1/students", ROUTES), false);
  assert.equal(mustLimit("POST", "/v1/staff/invitations", ROUTES), false);
  assert.equal(mustLimit("POST", "/v1/nothing", ROUTES), false);
  assert.equal(mustLimit("OPTIONS", "/v1/auth/login", ROUTES), false);
  assert.equal(mustLimit("GET", "/v1/auth/login", ROUTES), false);
  // a new public route added to a table is limited without anyone remembering to
  const extra = [...ROUTES, { method: "POST" as const, path: "/v1/auth/new-thing", access: "public" as const }];
  assert.equal(mustLimit("POST", "/v1/auth/new-thing", extra), true);
});

test("with no limiter configured nothing is limited (local development and the test suite)", async () => {
  await checkRate(undefined, req("POST", "/v1/auth/login"), ROUTES);
});

test("when the limiter says no, the caller gets a 429 that says wait, and nothing else is revealed", async () => {
  const { limiter } = recording(false);
  await assert.rejects(
    checkRate(limiter, req("POST", "/v1/auth/login"), ROUTES),
    (e: unknown) => e instanceof HttpError && e.status === 429 && e.code === "too_many_requests" && /wait a minute/i.test(e.message),
  );
});

test("when the limiter says yes the request goes on; protected endpoints never even ask", async () => {
  const ok = recording(true);
  await checkRate(ok.limiter, req("POST", "/v1/auth/login"), ROUTES);
  assert.equal(ok.keys.length, 1);
  const refuse = recording(false);
  await checkRate(refuse.limiter, req("GET", "/v1/students"), ROUTES);
  await checkRate(refuse.limiter, req("OPTIONS", "/v1/auth/login"), ROUTES);
  assert.deepEqual(refuse.keys, [], "a signed-in request is not counted, and so cannot be refused here");
});

test("a broken limiter lets people in: it must never stop a teacher signing in", async () => {
  const broken: RateLimiter = { limit: async () => { throw new Error("binding unavailable"); } };
  const quiet = console.error;
  console.error = () => {};
  try {
    await checkRate(broken, req("POST", "/v1/auth/login"), ROUTES);
  } finally {
    console.error = quiet;
  }
});

test("buckets are per endpoint and per address, and never contain an email, a password or a link", async () => {
  assert.notEqual(limitKey("/v1/auth/login", "203.0.113.7"), limitKey("/v1/auth/refresh", "203.0.113.7"), "refresh traffic cannot use up the sign-in allowance");
  assert.notEqual(limitKey("/v1/auth/login", "203.0.113.7"), limitKey("/v1/auth/login", "203.0.113.8"));
  assert.equal(limitKey("/v1/auth/login", undefined), "/v1/auth/login|unknown");
  assert.equal(limitKey("/v1/auth/login", "  "), "/v1/auth/login|unknown");
  assert.equal(limitKey("/v1/auth/login", " 203.0.113.7 "), limitKey("/v1/auth/login", "203.0.113.7"));
  // the limiter is only ever handed the endpoint and the address
  const { limiter, keys } = recording(true);
  await checkRate(limiter, req("POST", "/v1/invitations/accept"), ROUTES);
  assert.deepEqual(keys, ["/v1/invitations/accept|203.0.113.7"]);
});

test("API responses are data only: not framed, not sniffed, not cached, no Referer, no scripts", () => {
  assert.equal(API_SECURITY_HEADERS["X-Content-Type-Options"], "nosniff");
  assert.equal(API_SECURITY_HEADERS["Cache-Control"], "no-store");
  assert.equal(API_SECURITY_HEADERS["Content-Security-Policy"], "default-src 'none'; frame-ancestors 'none'");
  assert.equal(API_SECURITY_HEADERS["Referrer-Policy"], "no-referrer");
  for (const [k, v] of Object.entries(API_SECURITY_HEADERS)) assert.ok(v.length > 0 && !/[\r\n]/.test(v), k);
});

test("an IPv6 caller is counted per /64, so hopping inside it does not earn a fresh allowance", () => {
  const a = "2001:db8:abcd:12:aaaa:bbbb:cccc:dddd";
  assert.equal(callerOf(a), "2001:0db8:abcd:0012::/64");
  assert.equal(limitKey("/v1/auth/login", a), limitKey("/v1/auth/login", "2001:db8:abcd:12:1:2:3:4"), "same /64, same bucket");
  assert.equal(limitKey("/v1/auth/login", a), limitKey("/v1/auth/login", "2001:DB8:ABCD:12::1"), "case and :: shorthand do not matter");
  assert.notEqual(limitKey("/v1/auth/login", a), limitKey("/v1/auth/login", "2001:db8:abcd:13:aaaa:bbbb:cccc:dddd"), "a different /64 is a different caller");
  assert.equal(callerOf("2001:db8::"), "2001:0db8:0000:0000::/64");
  assert.equal(callerOf("::1"), "0000:0000:0000:0000::/64");
});

test("an IPv4 address is one caller, however it is written, and anything unreadable is kept as it is", () => {
  assert.equal(callerOf("203.0.113.7"), "203.0.113.7");
  assert.equal(callerOf("::ffff:203.0.113.7"), "203.0.113.7", "an IPv4 address written the IPv6 way is that IPv4 address");
  assert.equal(callerOf(" 203.0.113.7 "), "203.0.113.7");
  assert.equal(callerOf(undefined), "unknown");
  assert.equal(callerOf(""), "unknown");
  for (const odd of ["not-an-address", "1:2:3", "1::2::3", "gggg::1", "1:2:3:4:5:6:7:8:9"]) assert.equal(callerOf(odd), odd);
});
