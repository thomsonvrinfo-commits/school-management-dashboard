import type { AttendanceSummaryResponse } from "@schoolpulse/contracts";
import { addCounts, addDays, authorize, daysBetween, rateChange, summarise, todayInTimezone, type AttendanceCounts } from "@schoolpulse/domain";
import type { Deps } from "../deps.ts";
import { HttpError } from "../errors.ts";
import type { AuthContext } from "./auth.ts";

const MAX_DAYS = 92;
const ZERO: AttendanceCounts = { present: 0, late: 0, absent: 0 };

/**
 * Attendance for a period, compared with the period of equal length just before it.
 * Every figure comes with the raw counts it was calculated from, so the head can see how it was worked out.
 */
export async function attendanceSummary(deps: Deps, auth: AuthContext, query: { from?: string; to?: string }): Promise<AttendanceSummaryResponse> {
  const { principal, ctx } = auth;
  if (!authorize(principal, "attendance:summary", { schoolId: ctx.school.id }).allowed) {
    throw new HttpError(403, "forbidden", "Only the head can see school-wide attendance.");
  }
  const today = todayInTimezone(deps.now(), ctx.school.timezone);
  const to = query.to ?? today;
  const from = query.from ?? addDays(to, -6);
  const length = daysBetween(from, to) + 1;
  if (length < 1) throw new HttpError(400, "invalid_period", "The start date must not be after the end date.");
  if (length > MAX_DAYS) throw new HttpError(400, "invalid_period", `The period cannot be longer than ${MAX_DAYS} days.`);
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(length - 1));

  const [current, previous] = await Promise.all([
    deps.db.store.attendanceCountsByClass(ctx.school.id, from, to),
    deps.db.store.attendanceCountsByClass(ctx.school.id, prevFrom, prevTo),
  ]);
  const prevById = new Map(previous.map((p) => [p.classId, p]));
  const countsOf = (r?: { present: number; late: number; absent: number }): AttendanceCounts => (r ? { present: r.present, late: r.late, absent: r.absent } : ZERO);

  const classes = current.map((c) => {
    const cur = summarise(countsOf(c));
    const prev = summarise(countsOf(prevById.get(c.classId)));
    return { classId: c.classId, name: c.name, current: cur, previous: prev, changePoints: rateChange(cur.rate, prev.rate) };
  });
  const school = summarise(current.reduce((acc, c) => addCounts(acc, countsOf(c)), ZERO));
  const previousSchool = summarise(previous.reduce((acc, c) => addCounts(acc, countsOf(c)), ZERO));
  return {
    period: { from, to },
    previousPeriod: { from: prevFrom, to: prevTo },
    school,
    previousSchool,
    changePoints: rateChange(school.rate, previousSchool.rate),
    classes,
  };
}
