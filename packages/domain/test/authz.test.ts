import { test } from "node:test";
import assert from "node:assert/strict";
import { authorize, roleMayAttempt, ACTIONS, ROLES, type Principal } from "../src/index.ts";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const teacher: Principal = { userId: "u1", schoolId: S1, role: "teacher" };
const head: Principal = { userId: "u2", schoolId: S1, role: "head" };

test("teacher may record attendance only for a class they teach", () => {
  assert.equal(authorize(teacher, "attendance:record", { schoolId: S1, classId: "c", teachesClass: true }).allowed, true);
  const d = authorize(teacher, "attendance:record", { schoolId: S1, classId: "c", teachesClass: false });
  assert.deepEqual(d, { allowed: false, reason: "not_assigned_to_class" });
  // a missing fact is a denial, never an accidental allow
  assert.equal(authorize(teacher, "attendance:record", { schoolId: S1, classId: "c" }).allowed, false);
});

test("head cannot record attendance but can read any class and the summary", () => {
  assert.equal(authorize(head, "attendance:record", { schoolId: S1, classId: "c", teachesClass: true }).allowed, false);
  assert.equal(authorize(head, "attendance:read-class", { schoolId: S1, classId: "c" }).allowed, true);
  assert.equal(authorize(head, "attendance:summary", { schoolId: S1 }).allowed, true);
});

test("teacher cannot read the school summary or finance-style admin data", () => {
  assert.deepEqual(authorize(teacher, "attendance:summary", { schoolId: S1 }), {
    allowed: false,
    reason: "role_not_permitted",
  });
});

test("another school's data is always denied, even for the head", () => {
  for (const action of ACTIONS) {
    for (const p of [teacher, head]) {
      const d = authorize(p, action, { schoolId: S2, classId: "c", teachesClass: true });
      assert.deepEqual(d, { allowed: false, reason: "wrong_school" }, `${p.role} ${action}`);
    }
  }
});

test("unknown actions are denied by default", () => {
  assert.deepEqual(authorize(head, "finance:read", { schoolId: S1 }), { allowed: false, reason: "unknown_action" });
});

test("every role/action pair has an explicit, non-throwing answer", () => {
  for (const role of ROLES) {
    for (const action of ACTIONS) {
      const d = authorize({ userId: "u", schoolId: S1, role }, action, { schoolId: S1 });
      assert.equal(typeof d.allowed, "boolean");
    }
  }
});

test("roleMayAttempt is a coarse role gate only", () => {
  assert.equal(roleMayAttempt(teacher, "attendance:record"), true);
  assert.equal(roleMayAttempt(head, "attendance:record"), false);
  assert.equal(roleMayAttempt(teacher, "attendance:summary"), false);
  assert.equal(roleMayAttempt(head, "attendance:summary"), true);
});
