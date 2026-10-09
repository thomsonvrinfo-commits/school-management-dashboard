import { test } from "node:test";
import assert from "node:assert/strict";
import { isIsoDate, weekdayOf, addDays, daysBetween, todayInTimezone } from "../src/index.ts";

test("isIsoDate accepts real dates only", () => {
  assert.equal(isIsoDate("2026-10-08"), true);
  assert.equal(isIsoDate("2024-02-29"), true);
  assert.equal(isIsoDate("2026-02-29"), false);
  assert.equal(isIsoDate("2026-13-01"), false);
  assert.equal(isIsoDate("2026-1-1"), false);
  assert.equal(isIsoDate("not a date"), false);
});

test("weekdayOf: Monday=1 .. Sunday=7", () => {
  assert.equal(weekdayOf("2026-10-05"), 1); // Monday
  assert.equal(weekdayOf("2026-10-08"), 4); // Thursday
  assert.equal(weekdayOf("2026-10-11"), 7); // Sunday
});

test("addDays and daysBetween cross month and year boundaries", () => {
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(daysBetween("2026-10-01", "2026-10-08"), 7);
  assert.equal(daysBetween("2026-10-08", "2026-10-01"), -7);
});

test("todayInTimezone uses the school's zone, not UTC", () => {
  const now = new Date("2026-10-08T23:30:00Z"); // 01:30 on the 9th in Harare (UTC+2)
  assert.equal(todayInTimezone(now, "Africa/Harare"), "2026-10-09");
  assert.equal(todayInTimezone(now, "UTC"), "2026-10-08");
});

test("invalid dates throw instead of silently rolling over", () => {
  assert.throws(() => weekdayOf("2026-02-30"), RangeError);
});
