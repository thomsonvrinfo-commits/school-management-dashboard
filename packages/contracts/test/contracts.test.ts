import { test } from "node:test";
import assert from "node:assert/strict";
import { pushRequest, loginRequest, isoDate, attendanceEntry, summaryQuery } from "../src/index.ts";

const U = "3f2b8c1e-9d4a-4e6b-8a7c-1d2e3f4a5b6c";
const op = (over: Record<string, unknown> = {}) => ({
  opId: U,
  type: "attendance.record",
  createdAt: "2026-10-08T06:10:00.000Z",
  payload: { classId: U, date: "2026-10-08", entries: [{ studentId: U, status: "absent", baseVersion: 0 }] },
  ...over,
});

test("a well-formed push is accepted", () => {
  assert.equal(pushRequest.safeParse({ deviceId: "device-12345678", ops: [op()] }).success, true);
});

test("unknown operation types, bad statuses and fake dates are rejected", () => {
  const bad = (o: unknown) => pushRequest.safeParse({ deviceId: "device-12345678", ops: [o] }).success;
  assert.equal(bad(op({ type: "fees.pay" })), false);
  assert.equal(bad(op({ payload: { classId: U, date: "2026-02-30", entries: [{ studentId: U, status: "absent", baseVersion: 0 }] } })), false);
  assert.equal(attendanceEntry.safeParse({ studentId: U, status: "excused", baseVersion: 0 }).success, false);
  assert.equal(attendanceEntry.safeParse({ studentId: U, status: "absent", baseVersion: -1 }).success, false);
});

test("an op must carry at least one entry, and no more than 100", () => {
  const withEntries = (n: number) =>
    op({ payload: { classId: U, date: "2026-10-08", entries: Array.from({ length: n }, () => ({ studentId: U, status: "present", baseVersion: 0 })) } });
  const ok = (o: unknown) => pushRequest.safeParse({ deviceId: "device-12345678", ops: [o] }).success;
  assert.equal(ok(withEntries(0)), false);
  assert.equal(ok(withEntries(100)), true);
  assert.equal(ok(withEntries(101)), false);
});

test("login: device id is constrained, email must be an email", () => {
  assert.equal(loginRequest.safeParse({ email: "a@b.co", password: "x", deviceId: "device-12345678" }).success, true);
  assert.equal(loginRequest.safeParse({ email: "nope", password: "x", deviceId: "device-12345678" }).success, false);
  assert.equal(loginRequest.safeParse({ email: "a@b.co", password: "x", deviceId: "../../etc" }).success, false);
});

test("isoDate and summaryQuery", () => {
  assert.equal(isoDate.safeParse("2026-10-08").success, true);
  assert.equal(isoDate.safeParse("2026-10-8").success, false);
  assert.equal(summaryQuery.safeParse({}).success, true);
  assert.equal(summaryQuery.safeParse({ from: "yesterday" }).success, false);
});
