import { test } from "node:test";
import assert from "node:assert/strict";
import { AUDIT_ACTIONS, AUDIT_FILTER_CATEGORIES, categoryOf, describeAudit, prefixesOf } from "../src/index.ts";

test("every action is in a category a person can filter by, and none falls into 'other'", () => {
  assert.ok(AUDIT_ACTIONS.length >= 24);
  for (const a of AUDIT_ACTIONS) assert.notEqual(categoryOf(a), "other", a);
  assert.equal(categoryOf("student.registered"), "students");
  assert.equal(categoryOf("academic_year.created"), "school");
  assert.equal(categoryOf("term.deleted"), "school");
  assert.equal(categoryOf("attendance.recorded"), "attendance");
  assert.equal(categoryOf("staff.joined"), "staff");
  assert.equal(categoryOf("something.new"), "other");
  assert.equal(categoryOf(""), "other");
});

test("the category filter and the category of each action agree", () => {
  for (const c of AUDIT_FILTER_CATEGORIES) {
    const prefixes = prefixesOf(c.value);
    assert.ok(prefixes.length > 0, c.value);
    for (const a of AUDIT_ACTIONS) assert.equal(prefixes.includes(a.split(".")[0]!), categoryOf(a) === c.value, `${a} vs ${c.value}`);
  }
  assert.deepEqual(prefixesOf("school").sort(), ["academic_year", "school", "term"]);
});

test("every action has a summary written as what was done, not as who did it", () => {
  for (const a of AUDIT_ACTIONS) {
    const d = describeAudit(a, {});
    assert.ok(d.summary.length > 5 && d.summary.length < 60, a);
    assert.ok(!/\b(you|your)\b/i.test(d.summary), `${a}: ${d.summary}`);
  }
});

test("an action nobody described is shown as a plain change with no detail", () => {
  assert.deepEqual(describeAudit("newthing.happened", { secret: "x" }), { category: "other", summary: "Made a change", detail: null });
});

test("details are read, not echoed: an admission number, ids and a teacher's id never reach the screen", () => {
  const hostile = {
    admissionNo: "MA-1234", userId: "00000000-0000-4000-8000-000000000011", classId: "00000000-0000-4000-8000-000000000101",
    email: "chipo@mavambo.example", name: "Kuda Moyo", firstName: "Kuda", deviceId: "device-chipo-001", studentId: "00000000-0000-4000-8000-000000002001",
    fromClassId: "00000000-0000-4000-8000-000000000102", restoredPlacementId: "00000000-0000-4000-8000-000000000555",
  };
  for (const a of AUDIT_ACTIONS) {
    const d = describeAudit(a, hostile);
    const shown = `${d.summary} ${d.detail ?? ""}`;
    for (const secret of ["MA-1234", "00000000", "chipo@", "Kuda", "device-chipo"]) {
      // a class or year NAME is shown on purpose; nothing else from the hostile object is
      if (secret === "Kuda" && ["class.created", "academic_year.created", "academic_year.deleted", "term.created", "term.deleted"].includes(a)) continue;
      assert.ok(!shown.includes(secret), `${a} leaked ${secret}: ${shown}`);
    }
  }
});

test("a register's per-pupil changes are counted, never listed", () => {
  const d = describeAudit("attendance.recorded", {
    date: "2026-10-08", deviceId: "d", changes: [{ studentId: "a", from: null, to: "absent" }, { studentId: "b", from: "present", to: "late" }],
  });
  assert.equal(d.detail, "Register for 2026-10-08. 2 marks changed");
  assert.equal(describeAudit("attendance.recorded", { date: "2026-10-08", changes: [{ studentId: "a" }] }).detail, "Register for 2026-10-08. 1 mark changed");
  assert.ok(!JSON.stringify(d).includes("absent"));
});

test("field lists show readable names, only plain ones, and not too many", () => {
  assert.equal(describeAudit("student.updated", { fields: ["firstName", "dateOfBirth"] }).detail, "Changed: first name, date of birth");
  assert.equal(describeAudit("student.updated", { fields: ["firstName", "x y", "<script>", 5, "a".repeat(41)] }).detail, "Changed: first name");
  assert.equal(describeAudit("student.updated", { fields: [] }).detail, null);
  assert.equal(describeAudit("student.updated", { fields: "firstName" }).detail, null);
  const many = Array.from({ length: 30 }, (_, i) => `field${String.fromCharCode(97 + (i % 26))}`);
  assert.equal(describeAudit("school.updated", { fields: many }).detail!.split(", ").length, 12);
});

test("status changes, placements and class edits say what changed in words", () => {
  assert.equal(describeAudit("student.status_changed", { from: "enrolled", to: "withdrawn", effectiveFrom: "2026-10-12" }).detail, "From enrolled to withdrawn. Effective 2026-10-12");
  assert.equal(describeAudit("student.status_changed", { from: "enrolled", to: "dropped" }).detail, null, "an unknown status is not echoed");
  assert.equal(describeAudit("student.placed", { fromClassId: null, effectiveFrom: "2026-01-12" }).detail, "First class placement. From 2026-01-12");
  assert.equal(describeAudit("student.placed", { fromClassId: "x", effectiveFrom: "2026-02-02" }).detail, "Moved from another class. From 2026-02-02");
  assert.equal(describeAudit("student.placement_removed", { startsOn: "2026-02-02", restoredPlacementId: "x" }).detail, "It started 2026-02-02. The earlier placement was reopened");
  assert.equal(describeAudit("class.updated", { fields: ["name"], status: "archived" }).detail, "Changed: name. Status: archived");
  assert.equal(describeAudit("class.updated", { fields: ["name"], status: "weird" }).detail, "Changed: name");
});

test("names of classes, years and terms are shown, trimmed and capped", () => {
  assert.equal(describeAudit("class.created", { name: "  Grade   4A " }).detail, "Grade 4A");
  assert.equal(describeAudit("academic_year.created", { name: "2026", active: true }).detail, "2026. Made current");
  assert.equal(describeAudit("academic_year.created", { name: "2027", active: false }).detail, "2027");
  assert.equal(describeAudit("term.deleted", { name: "Term 1" }).detail, "Term 1");
  assert.equal(describeAudit("class.created", { name: "x".repeat(200) }).detail!.length, 60);
  assert.equal(describeAudit("class.created", { name: 5 }).detail, null);
  assert.equal(describeAudit("class.created", { name: "   " }).detail, null);
});

test("staff entries: counts are shown as words, and who the teacher was is not", () => {
  assert.equal(describeAudit("staff.deactivated", { sessionsEnded: 2, resetLinksWithdrawn: 1 }).detail, "Signed out of 2 devices");
  assert.equal(describeAudit("staff.deactivated", { sessionsEnded: 1 }).detail, "Signed out of 1 device");
  assert.equal(describeAudit("staff.deactivated", { sessionsEnded: -1 }).detail, null);
  assert.equal(describeAudit("staff.deactivated", { sessionsEnded: "2" }).detail, null);
  assert.equal(describeAudit("staff.password_reset", { sessionsEnded: 0, resetLinkId: "x" }).detail, "Signed out of 0 devices");
  assert.equal(describeAudit("staff.joined", { newAccount: true, role: "teacher" }).detail, "Created a new account");
  assert.equal(describeAudit("staff.joined", { newAccount: false }).detail, "Used an existing account");
  assert.equal(describeAudit("staff.invited", { replacedLinks: 1 }).detail, "An earlier link for them was withdrawn");
  assert.equal(describeAudit("staff.invited", { replacedLinks: 0 }).detail, null);
});

test("details that are not an object at all are survived", () => {
  for (const bad of [null, undefined, "x", 5, [], [1, 2]]) {
    for (const a of AUDIT_ACTIONS) {
      const d = describeAudit(a, bad);
      assert.equal(typeof d.summary, "string");
    }
  }
});
