/**
 * Academic years and terms: date rules only. Pure functions; the database enforces the same rules with
 * exclusion/unique constraints as a backstop, and the service uses these to give the person a clear message first.
 * Ranges are inclusive on both ends ("1 Jan to 31 Dec" contains both days).
 */
import { daysBetween, isIsoDate } from "./dates.ts";
import { problem, type Problem } from "./problem.ts";

export interface DateRange {
  startsOn: string;
  endsOn: string;
}

/** A year is a school year, not a decade: anything longer than this is almost certainly a typo. */
export const MAX_YEAR_DAYS = 400;

export function validateRange(range: DateRange, what: string): Problem | null {
  if (!isIsoDate(range.startsOn)) return problem("invalid_date", `The ${what} start date is not a real date.`, "startsOn");
  if (!isIsoDate(range.endsOn)) return problem("invalid_date", `The ${what} end date is not a real date.`, "endsOn");
  if (range.endsOn <= range.startsOn) return problem("invalid_dates", `The ${what} must end after it starts.`, "endsOn");
  return null;
}

export function validateYearDates(range: DateRange): Problem | null {
  const bad = validateRange(range, "academic year");
  if (bad) return bad;
  if (daysBetween(range.startsOn, range.endsOn) + 1 > MAX_YEAR_DAYS) {
    return problem("year_too_long", `An academic year cannot be longer than ${MAX_YEAR_DAYS} days.`, "endsOn");
  }
  return null;
}

export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  return a.startsOn <= b.endsOn && b.startsOn <= a.endsOn;
}

export function rangeContains(range: DateRange, date: string): boolean {
  return range.startsOn <= date && date <= range.endsOn;
}

/** The first of `others` (ignoring `ignoreId`) that overlaps `candidate`, if any. */
export function findOverlap<T extends DateRange & { id: string }>(candidate: DateRange, others: readonly T[], ignoreId?: string): T | undefined {
  return others.find((o) => o.id !== ignoreId && rangesOverlap(candidate, o));
}

/** A term must lie entirely inside its academic year. */
export function validateTermWithinYear(term: DateRange, year: DateRange): Problem | null {
  const bad = validateRange(term, "term");
  if (bad) return bad;
  if (term.startsOn < year.startsOn || term.endsOn > year.endsOn) {
    return problem("term_outside_year", `A term must fall inside its academic year (${year.startsOn} to ${year.endsOn}).`, "startsOn");
  }
  return null;
}

/** Terms that would fall (even partly) outside `year` if the year were changed to these dates. */
export function termsOutside<T extends DateRange>(year: DateRange, terms: readonly T[]): T[] {
  return terms.filter((t) => t.startsOn < year.startsOn || t.endsOn > year.endsOn);
}

/** Which academic year contains `date`, if any. */
export function yearOn<T extends DateRange>(date: string, years: readonly T[]): T | undefined {
  return years.find((y) => rangeContains(y, date));
}

/** True for an IANA time-zone name the runtime knows ("Africa/Harare"). Used when the school's time zone is edited. */
export function isValidTimeZone(zone: string): boolean {
  if (zone.length === 0 || zone.length > 64) return false;
  // The runtime accepts "+02:00", but PostgreSQL reads the sign the other way round, so day boundaries would be hours out.
  if (/^[+\-\d]/.test(zone)) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
