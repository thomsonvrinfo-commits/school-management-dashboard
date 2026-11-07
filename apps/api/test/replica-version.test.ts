/** The replica fingerprint: stable, order-independent, and sensitive to every change a phone would show. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, replicaVersion } from "../src/services/replica-version.ts";

test("canonicalJson sorts object keys at every depth and keeps array order", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, 2, 1], c: null } }), '{"a":{"c":null,"d":[3,2,1]},"b":1}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]), "order of a list matters: it is the order the phone shows");
});

test("canonicalJson ignores undefined fields and quotes strings safely", () => {
  assert.equal(canonicalJson({ a: undefined, b: 'x"y' }), '{"b":"x\\"y"}');
  assert.equal(canonicalJson(undefined), "null");
});

const base = { today: "2026-10-08", students: [{ id: "s1", firstName: "Tendai" }], attendance: [{ studentId: "s1", status: "present", version: 1 }] };

test("the same data gives the same version, however its keys were ordered", async () => {
  const reordered = { attendance: [{ version: 1, status: "present", studentId: "s1" }], students: [{ firstName: "Tendai", id: "s1" }], today: "2026-10-08" };
  assert.equal(await replicaVersion("u1", base), await replicaVersion("u1", reordered));
});

test("a version is 43 base64url characters, and so is accepted by the request schema", async () => {
  const v = await replicaVersion("u1", base);
  assert.match(v, /^[A-Za-z0-9_-]{43}$/);
});

test("any change a phone would show changes the version", async () => {
  const v = await replicaVersion("u1", base);
  const changed = [
    { ...base, today: "2026-10-09" },
    { ...base, students: [{ id: "s1", firstName: "Tendayi" }] },
    { ...base, students: [] },
    { ...base, attendance: [{ studentId: "s1", status: "late", version: 2 }] },
    { ...base, attendance: [{ studentId: "s1", status: "present", version: 2 }] },
  ];
  for (const c of changed) assert.notEqual(await replicaVersion("u1", c), v, JSON.stringify(c));
});

test("two people never share a version, even for identical data", async () => {
  assert.notEqual(await replicaVersion("u1", base), await replicaVersion("u2", base));
});
