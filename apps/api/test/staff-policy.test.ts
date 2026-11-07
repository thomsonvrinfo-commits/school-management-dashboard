/**
 * Route-by-route net for the P1 staff endpoints: every route has a handler and a policy, only the three link endpoints
 * are public (and they are handed no caller at all), and the role gate runs before anything is read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { roleMayAttempt, type Role } from "@schoolpulse/domain";
import type { Deps } from "../src/deps.ts";
import { HttpError } from "../src/errors.ts";
import { ROUTES, STAFF_ROUTES, routeKey } from "../src/routes.ts";
import type { AuthContext } from "../src/services/auth.ts";
import { PUBLIC_STAFF_HANDLERS, STAFF_HANDLERS, staffKeys } from "../src/staff/handlers.ts";

test("every staff route has exactly one handler, and every handler has a route", () => {
  const authed = STAFF_ROUTES.filter((r) => r.access !== "public").map(routeKey).sort();
  const open = STAFF_ROUTES.filter((r) => r.access === "public").map(routeKey).sort();
  assert.deepEqual(authed, Object.keys(STAFF_HANDLERS).sort());
  assert.deepEqual(open, Object.keys(PUBLIC_STAFF_HANDLERS).sort());
  assert.equal(new Set(staffKeys()).size, staffKeys().length);
  assert.ok(staffKeys().every((k) => ROUTES.some((r) => routeKey(r) === k)), "all of them are in the master route table");
});

test("the head's staff routes each name an action; exactly three routes are public", () => {
  for (const r of STAFF_ROUTES) if (r.access !== "public") assert.ok(typeof r.access === "object", `${routeKey(r)} must name a policy action`);
  assert.equal(STAFF_ROUTES.filter((r) => r.access === "public").length, 3);
  assert.ok(STAFF_ROUTES.filter((r) => r.access === "public").every((r) => r.method === "POST"), "public endpoints only accept POST (the secret never goes in a URL)");
});

test("only a head may use the staff routes", () => {
  const teacher = { userId: "u", schoolId: "s", role: "teacher" as const };
  const head = { userId: "u", schoolId: "s", role: "head" as const };
  for (const r of STAFF_ROUTES) {
    if (typeof r.access !== "object") continue;
    assert.equal(roleMayAttempt(teacher, r.access.action), false, `${routeKey(r)} must refuse teachers`);
    assert.equal(roleMayAttempt(head, r.access.action), true, `${routeKey(r)} must allow heads`);
  }
});

test("a teacher gets a 403 on every head-only staff route before the input is even looked at", async () => {
  const stubDeps = new Proxy({}, { get() { throw new Error("the service layer must not be reached"); } }) as unknown as Deps;
  const auth = (role: Role): AuthContext => ({ principal: { userId: "u", schoolId: "s", role }, ctx: {} } as unknown as AuthContext);
  let refused = 0;
  for (const r of STAFF_ROUTES) {
    if (typeof r.access !== "object") continue;
    const req = { params: { id: "not-a-uuid", membershipId: "x" }, query: {}, json: async () => { throw new Error("the body must not be read"); } };
    await assert.rejects(
      STAFF_HANDLERS[routeKey(r)]!(stubDeps, auth("teacher"), req),
      (e: unknown) => e instanceof HttpError && e.status === 403 && e.code === "forbidden",
      routeKey(r),
    );
    refused++;
  }
  assert.equal(refused, 6);
});

test("the public handlers take no caller: they cannot read a school from anywhere but the link", () => {
  for (const [key, h] of Object.entries(PUBLIC_STAFF_HANDLERS)) assert.equal(h.length, 2, `${key} takes (deps, request) only`);
});
