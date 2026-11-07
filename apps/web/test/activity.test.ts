import { test } from "node:test";
import assert from "node:assert/strict";
import type { AuditItem } from "@schoolpulse/contracts";
import {
  ACTIVITY_PAGE_SIZE, actorLabel, dayHeading, dayKey, emptyActivityFilters, entityLink, groupByDay, hasActivityFilters, peopleOptions, timeOf,
  toActivityQuery, validateActivityFilters,
} from "../src/lib/activity.ts";

const HARARE = "Africa/Harare";
const ID = "00000000-0000-4000-8000-000000000101";
const item = (at: string, over: Partial<AuditItem> = {}): AuditItem => ({
  id: at, at, actor: { id: ID, name: "Mrs. Moyo" }, category: "students", summary: "Registered a student", detail: null, entity: { type: "student", id: ID }, ...over,
});
const errors = (v: ReturnType<typeof validateActivityFilters>) => (v.ok ? {} : v.errors);

test("no filters means no request parameters beyond the page size", () => {
  assert.deepEqual(toActivityQuery(emptyActivityFilters()), { limit: ACTIVITY_PAGE_SIZE });
  assert.equal(hasActivityFilters(emptyActivityFilters()), false);
  assert.equal(hasActivityFilters({ ...emptyActivityFilters(), to: "2026-10-01" }), true);
});

test("filters become query parameters, blanks are left out, and the page marker is only for later pages", () => {
  const f = { category: "staff", actor: ID, from: "2026-10-01", to: "2026-10-08" };
  assert.deepEqual(toActivityQuery(f), { limit: ACTIVITY_PAGE_SIZE, category: "staff", actor: ID, from: "2026-10-01", to: "2026-10-08" });
  assert.deepEqual(toActivityQuery(f, "812"), { limit: ACTIVITY_PAGE_SIZE, category: "staff", actor: ID, from: "2026-10-01", to: "2026-10-08", before: "812" });
  assert.equal("before" in toActivityQuery(f, null), false);
  assert.equal("before" in toActivityQuery(f, ""), false);
});

test("dates are held back until they are real and in order; blank is fine", () => {
  assert.equal(validateActivityFilters(emptyActivityFilters()).ok, true);
  assert.equal(validateActivityFilters({ ...emptyActivityFilters(), from: "2026-10-01", to: "2026-10-01" }).ok, true);
  assert.deepEqual(errors(validateActivityFilters({ ...emptyActivityFilters(), from: "2026-02-30" })), { from: "Enter a real date." });
  assert.deepEqual(errors(validateActivityFilters({ ...emptyActivityFilters(), to: "20" })), { to: "Enter a real date." });
  assert.deepEqual(errors(validateActivityFilters({ ...emptyActivityFilters(), from: "2026-10-09", to: "2026-10-08" })), { from: "The start date is after the end date." });
});

test("a day is the school's day, not the phone's and not UTC's", () => {
  assert.equal(dayKey("2026-10-07T21:59:59Z", HARARE), "2026-10-07");
  assert.equal(dayKey("2026-10-07T22:00:00Z", HARARE), "2026-10-08");
  assert.equal(dayKey("2026-10-07T22:00:00Z", "UTC"), "2026-10-07");
  assert.equal(timeOf("2026-10-07T22:05:00Z", HARARE), "00:05");
  assert.equal(timeOf("2026-10-08T06:05:00Z", HARARE), "08:05");
});

test("headings say Today and Yesterday, then the date; the year only when it is another year", () => {
  assert.equal(dayHeading("2026-10-19", "2026-10-19"), "Today");
  assert.equal(dayHeading("2026-10-18", "2026-10-19"), "Yesterday");
  assert.equal(dayHeading("2026-09-30", "2026-10-01"), "Yesterday", "across a month end");
  assert.equal(dayHeading("2026-10-14", "2026-10-19"), "Wednesday 14 October");
  assert.equal(dayHeading("2025-12-31", "2026-01-02"), "Wednesday 31 December 2025");
});

test("entries are grouped by school day in the order given, and a day that comes back later starts a new group", () => {
  const now = new Date("2026-10-19T10:00:00Z");
  const items = [
    item("2026-10-19T09:00:00Z"), item("2026-10-18T22:30:00Z"), // 00:30 on the 19th in Harare: still today
    item("2026-10-18T10:00:00Z"), item("2026-10-17T10:00:00Z"),
  ];
  const groups = groupByDay(items, HARARE, now);
  assert.deepEqual(groups.map((g) => [g.day, g.heading, g.items.length]), [["2026-10-19", "Today", 2], ["2026-10-18", "Yesterday", 1], ["2026-10-17", "Saturday 17 October", 1]]);
  assert.deepEqual(groupByDay([], HARARE, now), []);
  assert.equal(groupByDay(items, "UTC", now).map((g) => g.items.length).join(), "1,2,1", "the zone decides which day an entry falls on");
});

test("links go only to pages that exist, and only with real ids", () => {
  assert.deepEqual(entityLink({ type: "student", id: ID }), { to: `/students/${ID}`, label: "Open student" });
  assert.deepEqual(entityLink({ type: "class", id: ID }), { to: `/classes/${ID}`, label: "Open class" });
  assert.deepEqual(entityLink({ type: "term", id: ID }), { to: "/school", label: "Open school settings" });
  assert.deepEqual(entityLink({ type: "academic_year", id: null }), { to: "/school", label: "Open school settings" });
  assert.deepEqual(entityLink({ type: "membership", id: ID }), { to: "/staff", label: "Open staff" });
  assert.deepEqual(entityLink({ type: "staff_invitation", id: ID }), { to: "/staff", label: "Open staff" });
  assert.equal(entityLink({ type: "student", id: null }), null);
  assert.equal(entityLink({ type: "student", id: "../../admin" }), null, "an id that is not a UUID never reaches an address");
  assert.equal(entityLink({ type: "student", id: `${ID}/../x` }), null);
  assert.equal(entityLink({ type: "thing", id: ID }), null);
});

test("your own actions say You; people are offered by name", () => {
  assert.equal(actorLabel({ id: ID, name: "Mrs. Moyo" }, ID), "You");
  assert.equal(actorLabel({ id: ID, name: "Mrs. Moyo" }, "someone-else"), "Mrs. Moyo");
  assert.deepEqual(peopleOptions([{ userId: ID, name: "Mrs. Moyo" }]), [{ value: ID, label: "Mrs. Moyo" }]);
});
