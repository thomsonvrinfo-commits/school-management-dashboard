import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTIONS } from "@schoolpulse/domain";
import { ROUTES } from "../src/routes.ts";

test("only the sign-in endpoints and the three link endpoints are public", () => {
  const pub = ROUTES.filter((r) => r.access === "public").map((r) => `${r.method} ${r.path}`).sort();
  assert.deepEqual(pub, [
    "POST /v1/auth/login", "POST /v1/auth/logout", "POST /v1/auth/refresh",
    "POST /v1/invitations/accept", "POST /v1/invitations/preview", "POST /v1/password-reset/complete",
  ]);
});

test("every protected route names a real policy action or is explicitly 'authenticated'", () => {
  for (const r of ROUTES) {
    if (r.access === "public" || r.access === "authenticated") continue;
    assert.ok((ACTIONS as readonly string[]).includes(r.access.action), `${r.method} ${r.path} -> ${r.access.action}`);
  }
});

test("route table has no duplicates and every path is versioned", () => {
  const keys = ROUTES.map((r) => `${r.method} ${r.path}`);
  assert.equal(new Set(keys).size, keys.length);
  for (const r of ROUTES) assert.ok(r.path.startsWith("/v1/"), r.path);
});
