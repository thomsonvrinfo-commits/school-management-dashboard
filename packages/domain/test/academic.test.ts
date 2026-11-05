import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, findOverlap, rangeContains, rangesOverlap, termsOutside, validateTermWithinYear, validateYearDates, yearOn, MAX_YEAR_DAYS } from "../src/index.ts";

const Y2026 = { startsOn: "2026-01-13", endsOn: "2026-12-04" };

test("a year must be real dates, end after it starts, and not run for years", () => {
  assert.equal(validateYearDates(Y2026), null);
  assert.equal(validateYearDates({ startsOn: "2026-02-30", endsOn: "2026-12-01" })?.code, "invalid_date");
  assert.equal(validateYearDates({ startsOn: "2026-01-13", endsOn: "not-a-date" })?.code, "invalid_date");
  assert.equal(validateYearDates({ startsOn: "2026-12-04", endsOn: "2026-01-13" })?.code, "invalid_dates");
  assert.equal(validateYearDates({ startsOn: "2026-01-13", endsOn: "2026-01-13" })?.code, "invalid_dates", "a one-day year is not a year");
  assert.equal(validateYearDates({ startsOn: "2026-01-01", endsOn: "2028-01-01" })?.code, "year_too_long");
  assert.equal(MAX_YEAR_DAYS, 400);
  assert.equal(validateYearDates({ startsOn: "2026-01-01", endsOn: addDays("2026-01-01", MAX_YEAR_DAYS - 1) }), null, "400 days inclusive is allowed");
  assert.equal(validateYearDates({ startsOn: "2026-01-01", endsOn: addDays("2026-01-01", MAX_YEAR_DAYS) })?.code, "year_too_long");
});

test("overlap is inclusive on both ends", () => {
  const a = { startsOn: "2026-01-01", endsOn: "2026-04-30" };
  assert.equal(rangesOverlap(a, { startsOn: "2026-04-30", endsOn: "2026-08-01" }), true, "sharing the last day is an overlap");
  assert.equal(rangesOverlap(a, { startsOn: "2026-05-01", endsOn: "2026-08-01" }), false, "the next day is not");
  assert.equal(rangesOverlap(a, { startsOn: "2025-01-01", endsOn: "2026-12-31" }), true, "containment");
  assert.equal(rangesOverlap({ startsOn: "2026-05-01", endsOn: "2026-08-01" }, a), false, "symmetric");
});

test("findOverlap ignores the row being edited", () => {
  const years = [{ id: "a", startsOn: "2025-01-13", endsOn: "2025-12-05" }, { id: "b", ...Y2026 }];
  assert.equal(findOverlap({ startsOn: "2026-06-01", endsOn: "2027-01-01" }, years)?.id, "b");
  assert.equal(findOverlap({ startsOn: "2026-06-01", endsOn: "2027-01-01" }, years, "b"), undefined);
  assert.equal(findOverlap({ startsOn: "2027-01-12", endsOn: "2027-12-01" }, years), undefined);
});

test("a term must sit inside its year", () => {
  assert.equal(validateTermWithinYear({ startsOn: "2026-01-13", endsOn: "2026-04-10" }, Y2026), null);
  assert.equal(validateTermWithinYear({ startsOn: "2026-01-12", endsOn: "2026-04-10" }, Y2026)?.code, "term_outside_year");
  assert.equal(validateTermWithinYear({ startsOn: "2026-09-01", endsOn: "2026-12-05" }, Y2026)?.code, "term_outside_year");
  assert.equal(validateTermWithinYear({ startsOn: "2026-04-10", endsOn: "2026-01-13" }, Y2026)?.code, "invalid_dates");
});

test("shrinking a year reports exactly the terms it would strand", () => {
  const terms = [
    { id: "t1", startsOn: "2026-01-13", endsOn: "2026-04-10" },
    { id: "t2", startsOn: "2026-05-05", endsOn: "2026-08-07" },
    { id: "t3", startsOn: "2026-09-08", endsOn: "2026-12-04" },
  ];
  assert.deepEqual(termsOutside({ startsOn: "2026-01-13", endsOn: "2026-12-04" }, terms), []);
  assert.deepEqual(termsOutside({ startsOn: "2026-02-01", endsOn: "2026-10-01" }, terms).map((t) => t.id), ["t1", "t3"]);
});

test("rangeContains and yearOn find the year a date belongs to", () => {
  assert.equal(rangeContains(Y2026, "2026-01-13"), true);
  assert.equal(rangeContains(Y2026, "2026-12-04"), true);
  assert.equal(rangeContains(Y2026, "2026-12-05"), false);
  const years = [{ id: "a", startsOn: "2025-01-13", endsOn: "2025-12-05" }, { id: "b", ...Y2026 }];
  assert.equal(yearOn("2026-10-08", years)?.id, "b");
  assert.equal(yearOn("2026-12-20", years), undefined);
});

test("a school time zone is a name the database reads the same way: offsets like +02:00 are refused", async () => {
  const { isValidTimeZone } = await import("../src/index.ts");
  for (const ok of ["Africa/Harare", "UTC", "Europe/London", "America/Argentina/Buenos_Aires"]) assert.equal(isValidTimeZone(ok), true, ok);
  for (const bad of ["+02:00", "-05:00", "02:00", "+2", "", "Not/AZone", "x".repeat(65)]) assert.equal(isValidTimeZone(bad), false, bad);
});
