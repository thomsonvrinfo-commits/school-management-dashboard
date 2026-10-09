/** Calendar-date helpers. Dates are plain `YYYY-MM-DD` strings (no time zone), the way a school register thinks. */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function toUtc(date: string): Date {
  if (!isIsoDate(date)) throw new RangeError(`Invalid date: ${date}`);
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d));
}

function fromUtc(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}

/** ISO weekday: Monday = 1 ... Sunday = 7. */
export function weekdayOf(date: string): number {
  const day = toUtc(date).getUTCDay();
  return day === 0 ? 7 : day;
}

export function addDays(date: string, days: number): string {
  const dt = toUtc(date);
  dt.setUTCDate(dt.getUTCDate() + days);
  return fromUtc(dt);
}

/** Number of days from `from` to `to` (to - from). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / 86_400_000);
}

/** The calendar date it currently is in the given IANA time zone, e.g. "Africa/Harare". */
export function todayInTimezone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
