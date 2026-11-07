/**
 * Pure helpers for the head's activity screen: filters, the request they make, grouping entries by school day, and where an
 * entry can take the head. No React, network or browser here: it runs under `node --test`, and it must not import ./api.ts.
 */
import type { AuditItem, AuditQuery } from "@schoolpulse/contracts";
import { AUDIT_FILTER_CATEGORIES, isIsoDate } from "@schoolpulse/domain";
import type { FieldErrors, Validation } from "./admin-forms.ts";

/** How many entries one page asks for. Small: this is read on a phone, often over mobile data. */
export const ACTIVITY_PAGE_SIZE = 30;

export interface ActivityFilters { category: string; actor: string; from: string; to: string }
export const emptyActivityFilters = (): ActivityFilters => ({ category: "", actor: "", from: "", to: "" });
export const hasActivityFilters = (f: ActivityFilters): boolean => f.category !== "" || f.actor !== "" || f.from !== "" || f.to !== "";

export const CATEGORY_OPTIONS = AUDIT_FILTER_CATEGORIES.map((c) => ({ value: c.value as string, label: c.label as string }));
export const CATEGORY_LABEL: Readonly<Record<AuditItem["category"], string>> = {
  students: "Students", classes: "Classes", attendance: "Attendance", staff: "Staff", school: "School settings", other: "Other",
};

/** A filter the head typed that cannot be asked for yet (a half-typed date, a start after the end). Blank is fine. */
export function validateActivityFilters(f: ActivityFilters): Validation {
  const errors: FieldErrors = {};
  if (f.from !== "" && !isIsoDate(f.from)) errors.from = "Enter a real date.";
  if (f.to !== "" && !isIsoDate(f.to)) errors.to = "Enter a real date.";
  if (!errors.from && !errors.to && f.from !== "" && f.to !== "" && f.from > f.to) errors.from = "The start date is after the end date.";
  return Object.keys(errors).length === 0 ? { ok: true } : { ok: false, errors };
}

/** The request for one page: blanks left out, `before` only for pages after the first. */
export function toActivityQuery(f: ActivityFilters, before?: string | null): AuditQuery {
  return {
    limit: ACTIVITY_PAGE_SIZE,
    ...(f.category ? { category: f.category as NonNullable<AuditQuery["category"]> } : {}),
    ...(f.actor ? { actor: f.actor } : {}),
    ...(f.from ? { from: f.from } : {}),
    ...(f.to ? { to: f.to } : {}),
    ...(before ? { before } : {}),
  };
}

// ---------- days and times, in the SCHOOL's time zone ----------

/** `YYYY-MM-DD` of an instant as the wall calendar of `timeZone` shows it. */
export function dayKey(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export const timeOf = (iso: string, timeZone: string): string =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone });

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

/**
 * "Today", "Yesterday", or "Tuesday 14 October" (with the year when it is not this year). Built from fixed names, not
 * from the browser's locale data, so every phone and every test run words it the same way.
 */
export function dayHeading(day: string, today: string): string {
  if (day === today) return "Today";
  const t = new Date(`${today}T12:00:00Z`).getTime();
  if (day === new Date(t - 86_400_000).toISOString().slice(0, 10)) return "Yesterday";
  const d = new Date(`${day}T12:00:00Z`);
  const year = day.slice(0, 4) === today.slice(0, 4) ? "" : ` ${d.getUTCFullYear()}`;
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year}`;
}

export interface ActivityDay { day: string; heading: string; items: AuditItem[] }

/** Consecutive entries on the same school day, in the order given (newest first). */
export function groupByDay(items: readonly AuditItem[], timeZone: string, now: Date): ActivityDay[] {
  const today = dayKey(now.toISOString(), timeZone);
  const out: ActivityDay[] = [];
  for (const item of items) {
    const day = dayKey(item.at, timeZone);
    const last = out[out.length - 1];
    if (last && last.day === day) last.items.push(item);
    else out.push({ day, heading: dayHeading(day, today), items: [item] });
  }
  return out;
}

// ---------- where an entry can take the head ----------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A page the entry is about, if one still makes sense to open. Ids are only put in an address when they are real UUIDs. */
export function entityLink(entity: AuditItem["entity"]): { to: string; label: string } | null {
  switch (entity.type) {
    case "student":
      return entity.id !== null && UUID.test(entity.id) ? { to: `/students/${entity.id}`, label: "Open student" } : null;
    case "class":
      return entity.id !== null && UUID.test(entity.id) ? { to: `/classes/${entity.id}`, label: "Open class" } : null;
    case "school":
    case "academic_year":
    case "term":
      return { to: "/school", label: "Open school settings" };
    case "membership":
    case "staff_invitation":
      return { to: "/staff", label: "Open staff" };
    default:
      return null;
  }
}

/** "You" for the head's own actions, otherwise the person's name. */
export const actorLabel = (actor: AuditItem["actor"], youUserId: string): string => (actor.id === youUserId ? "You" : actor.name);

export const peopleOptions = (members: readonly { userId: string; name: string }[]): { value: string; label: string }[] =>
  members.map((m) => ({ value: m.userId, label: m.name }));
