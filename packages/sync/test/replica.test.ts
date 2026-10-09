import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planRegisterSave, applyConfirmed, mergeServerRow, rebase, registerCounts, type LocalAttendance,
} from "../src/index.ts";

const C = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const row = (over: Partial<LocalAttendance> = {}): LocalAttendance => ({
  studentId: "s1", classId: C, date: "2026-10-08", status: "present", version: 1, dirty: false, ...over,
});

test("a first-ever mark is based on version 0", () => {
  const { rows, entries } = planRegisterSave({ classId: C, date: "2026-10-08", marks: { s1: "absent" }, existing: new Map() });
  assert.deepEqual(entries, [{ studentId: "s1", status: "absent", baseVersion: 0 }]);
  assert.deepEqual(rows, [{ studentId: "s1", classId: C, date: "2026-10-08", status: "absent", version: 0, dirty: true }]);
});

test("changing a confirmed mark is based on the version the server last confirmed", () => {
  const { entries, rows } = planRegisterSave({ classId: C, date: "2026-10-08", marks: { s1: "late" }, existing: new Map([["s1", row({ version: 3 })]]) });
  assert.deepEqual(entries, [{ studentId: "s1", status: "late", baseVersion: 3 }]);
  assert.equal(rows[0]!.version, 3); // local version stays the server's, so a second edit uses the same base
});

test("saving an unchanged register queues nothing", () => {
  const existing = new Map([["s1", row()], ["s2", row({ studentId: "s2", status: "absent" })]]);
  const { entries, rows } = planRegisterSave({ classId: C, date: "2026-10-08", marks: { s1: "present", s2: "absent" }, existing });
  assert.deepEqual([entries, rows], [[], []]);
});

test("only the students who changed are queued", () => {
  const existing = new Map([["s1", row()], ["s2", row({ studentId: "s2", status: "absent" })]]);
  const { entries } = planRegisterSave({ classId: C, date: "2026-10-08", marks: { s1: "present", s2: "present", s3: "late" }, existing });
  assert.deepEqual(entries.map((e) => [e.studentId, e.status, e.baseVersion]), [["s2", "present", 1], ["s3", "late", 0]]);
});

test("confirmed: a fresh row is created clean; a matching dirty row becomes clean at the server version", () => {
  const e = { studentId: "s1", classId: C, date: "2026-10-08", outcome: "applied" as const, status: "absent" as const, version: 1 };
  assert.deepEqual(applyConfirmed(undefined, e), { studentId: "s1", classId: C, date: "2026-10-08", status: "absent", version: 1, dirty: false });
  assert.deepEqual(applyConfirmed(row({ status: "absent", version: 0, dirty: true }), e), row({ status: "absent", version: 1, dirty: false }));
});

test("confirmed: a newer local edit that is still waiting is NOT overwritten", () => {
  const e = { studentId: "s1", classId: C, date: "2026-10-08", outcome: "applied" as const, status: "absent" as const, version: 1 };
  const local = row({ status: "present", version: 0, dirty: true });
  assert.deepEqual(applyConfirmed(local, e), { ...local, version: 1 });
});

test("downloading never overwrites unsynced local work, but refreshes clean rows", () => {
  const server = { studentId: "s1", classId: C, date: "2026-10-08", status: "late" as const, version: 4 };
  const mine = row({ status: "absent", dirty: true });
  assert.equal(mergeServerRow(mine, server), mine);
  assert.deepEqual(mergeServerRow(row(), server), { ...server, dirty: false });
  assert.deepEqual(mergeServerRow(undefined, server), { ...server, dirty: false });
});

test("rebase keeps my value but moves its base to the server's version", () => {
  assert.deepEqual(rebase(row({ status: "absent", version: 1, dirty: true }), 5), row({ status: "absent", version: 5, dirty: true }));
});

test("registerCounts counts every student exactly once", () => {
  assert.deepEqual(registerCounts(["a", "b", "c", "d"], { a: "present", b: "late", c: "absent" }), { present: 1, late: 1, absent: 1, unmarked: 1 });
  assert.deepEqual(registerCounts([], {}), { present: 0, late: 0, absent: 0, unmarked: 0 });
});
