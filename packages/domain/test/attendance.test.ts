import { test } from "node:test";
import assert from "node:assert/strict";
import {
  summarise,
  countStatuses,
  addCounts,
  rateChange,
  decideAttendanceWrite,
} from "../src/index.ts";

test("summarise: late counts as attended, rate has one decimal", () => {
  const s = summarise({ present: 1836, late: 102, absent: 168 });
  assert.equal(s.total, 2106);
  assert.equal(s.attended, 1938);
  assert.equal(s.rate, 92); // 1938/2106 = 92.02%
});

test("summarise: 14 of 16 attended is 87.5%", () => {
  assert.equal(summarise({ present: 12, late: 2, absent: 2 }).rate, 87.5);
});

test("summarise: no records gives null, not NaN or 0", () => {
  const s = summarise({ present: 0, late: 0, absent: 0 });
  assert.equal(s.total, 0);
  assert.equal(s.rate, null);
});

test("countStatuses and addCounts", () => {
  const a = countStatuses(["present", "present", "late", "absent"]);
  assert.deepEqual(a, { present: 2, late: 1, absent: 1 });
  assert.deepEqual(addCounts(a, { present: 1, late: 0, absent: 3 }), { present: 3, late: 1, absent: 4 });
});

test("rateChange in percentage points; null when either side unknown", () => {
  assert.equal(rateChange(91.8, 93.9), -2.1);
  assert.equal(rateChange(95, 90), 5);
  assert.equal(rateChange(null, 90), null);
  assert.equal(rateChange(90, null), null);
});

test("decide: nothing stored -> insert", () => {
  assert.deepEqual(decideAttendanceWrite(null, { status: "absent", baseVersion: 0, deviceId: "dev-a" }), { kind: "insert" });
});

test("decide: same value is a noop (safe replay), regardless of baseVersion", () => {
  assert.deepEqual(
    decideAttendanceWrite({ status: "absent", version: 3, deviceId: "dev-a" }, { status: "absent", baseVersion: 1, deviceId: "dev-b" }),
    { kind: "noop", version: 3 },
  );
});

test("decide: device saw the stored version -> update with next version", () => {
  assert.deepEqual(
    decideAttendanceWrite({ status: "present", version: 2, deviceId: "dev-a" }, { status: "late", baseVersion: 2, deviceId: "dev-b" }),
    { kind: "update", nextVersion: 3 },
  );
});

test("decide: someone else changed it since the device last saw it -> conflict, no overwrite", () => {
  assert.deepEqual(
    decideAttendanceWrite({ status: "present", version: 2, deviceId: "dev-a" }, { status: "absent", baseVersion: 1, deviceId: "dev-b" }),
    { kind: "conflict", serverStatus: "present", serverVersion: 2 },
  );
});

test("decide: device had no record but one now exists with a different value -> conflict", () => {
  assert.deepEqual(
    decideAttendanceWrite({ status: "present", version: 1, deviceId: "dev-a" }, { status: "absent", baseVersion: 0, deviceId: "dev-b" }),
    { kind: "conflict", serverStatus: "present", serverVersion: 1 },
  );
});

test("decide: a device's own earlier save never conflicts with itself (saved twice while offline)", () => {
  assert.deepEqual(
    decideAttendanceWrite({ status: "absent", version: 1, deviceId: "dev-a" }, { status: "present", baseVersion: 0, deviceId: "dev-a" }),
    { kind: "update", nextVersion: 2 },
  );
});

test("decide: the own-device rule does not excuse a change made by ANOTHER device in between", () => {
  // dev-a wrote v1, dev-b edited to v2, then dev-a (still thinking v1) sends a change: that is a real conflict
  assert.deepEqual(
    decideAttendanceWrite({ status: "late", version: 2, deviceId: "dev-b" }, { status: "absent", baseVersion: 1, deviceId: "dev-a" }),
    { kind: "conflict", serverStatus: "late", serverVersion: 2 },
  );
});
