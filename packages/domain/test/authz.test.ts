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

// ---------- Slice 2: school administration ----------

const ADMIN_ONLY = [
  "school:read", "school:manage", "student:read", "student:manage", "class:read", "class:manage", "teacher:read", "teacher:assign",
] as const;

test("school administration actions belong to the head and to nobody else", () => {
  for (const action of ADMIN_ONLY) {
    assert.equal(authorize(head, action, { schoolId: S1 }).allowed, true, `head ${action}`);
    assert.deepEqual(authorize(teacher, action, { schoolId: S1 }), { allowed: false, reason: "role_not_permitted" }, `teacher ${action}`);
    // a teacher who teaches the class still gets nothing extra
    assert.equal(authorize(teacher, action, { schoolId: S1, classId: "c", teachesClass: true }).allowed, false, `teacher+assigned ${action}`);
  }
});

test("a class roster is readable by the head, and by a teacher only for a class they teach", () => {
  assert.equal(authorize(head, "class:read-roster", { schoolId: S1, classId: "c" }).allowed, true);
  assert.equal(authorize(teacher, "class:read-roster", { schoolId: S1, classId: "c", teachesClass: true }).allowed, true);
  assert.deepEqual(authorize(teacher, "class:read-roster", { schoolId: S1, classId: "c", teachesClass: false }), { allowed: false, reason: "not_assigned_to_class" });
  assert.equal(authorize(teacher, "class:read-roster", { schoolId: S1, classId: "c" }).allowed, false, "a missing fact is a denial");
});

test("'my classes' is a teacher action: the head has no classes of their own to list", () => {
  assert.equal(authorize(teacher, "teaching:own-classes", { schoolId: S1 }).allowed, true);
  assert.deepEqual(authorize(head, "teaching:own-classes", { schoolId: S1 }), { allowed: false, reason: "role_not_permitted" });
});

test("roleMayAttempt agrees with the matrix for the new actions", () => {
  for (const action of ADMIN_ONLY) {
    assert.equal(roleMayAttempt(head, action), true, action);
    assert.equal(roleMayAttempt(teacher, action), false, action);
  }
  assert.equal(roleMayAttempt(teacher, "class:read-roster"), true);
  assert.equal(roleMayAttempt(teacher, "teaching:own-classes"), true);
  assert.equal(roleMayAttempt(head, "teaching:own-classes"), false);
});

test("every Slice 1 action keeps exactly the answer it had before Slice 2", () => {
  const at = (p: Principal, a: string, r: object = {}) => authorize(p, a, { schoolId: S1, ...r }).allowed;
  assert.equal(at(teacher, "sync:bootstrap"), true);
  assert.equal(at(head, "sync:bootstrap"), false);
  assert.equal(at(teacher, "attendance:record", { teachesClass: true }), true);
  assert.equal(at(head, "attendance:record", { teachesClass: true }), false);
  assert.equal(at(head, "attendance:read-class"), true);
  assert.equal(at(teacher, "attendance:read-class", { teachesClass: true }), true);
  assert.equal(at(teacher, "attendance:read-class", { teachesClass: false }), false);
  assert.equal(at(head, "attendance:summary"), true);
  assert.equal(at(teacher, "attendance:summary"), false);
});

// ---------- P1: staff accounts ----------

test("only the head may read or manage staff accounts, or read the activity log", () => {
  for (const action of ["staff:read", "staff:manage", "audit:read"] as const) {
    assert.equal(authorize(head, action, { schoolId: S1 }).allowed, true, `head ${action}`);
    assert.deepEqual(authorize(teacher, action, { schoolId: S1 }), { allowed: false, reason: "role_not_permitted" }, `teacher ${action}`);
    assert.equal(roleMayAttempt(teacher, action), false);
    assert.equal(roleMayAttempt(head, action), true);
  }
});

test("the activity log is closed to another school's head too", () => {
  assert.deepEqual(authorize(head, "audit:read", { schoolId: "00000000-0000-4000-8000-000000000002" }), { allowed: false, reason: "wrong_school" });
});
