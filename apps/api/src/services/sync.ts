import type { AttendanceRecordOp, BootstrapResponse, EntryResult, OpResult, PushRequest, PushResponse, RejectionReason } from "@schoolpulse/contracts";
import { opResult } from "@schoolpulse/contracts";
import type { Store } from "@schoolpulse/db";
import { addDays, authorize, decideAttendanceWrite, roleMayAttempt, todayInTimezone, weekdayOf } from "@schoolpulse/domain";
import type { Deps } from "../deps.ts";
import { HttpError } from "../errors.ts";
import type { AuthContext } from "./auth.ts";

const REPLICA_DAYS = 14;

/** The permission-filtered copy of the data a teacher's phone works from. */
export async function bootstrap(deps: Deps, auth: AuthContext): Promise<BootstrapResponse> {
  const { principal, ctx } = auth;
  const decision = authorize(principal, "sync:bootstrap", { schoolId: ctx.school.id });
  if (!decision.allowed) throw new HttpError(403, "forbidden", "Your role cannot use the offline register.");

  const store = deps.db.store;
  const now = deps.now();
  const today = todayInTimezone(now, ctx.school.timezone);
  const classes = await store.teacherClasses(ctx.school.id, ctx.user.id);
  const classIds = classes.map((c) => c.id);
  const [students, todaySlots, attendance] = await Promise.all([
    store.enrolledStudents(ctx.school.id, classIds, today),
    store.timetableForTeacher(ctx.school.id, ctx.user.id, weekdayOf(today)),
    store.attendanceInRange(ctx.school.id, classIds, addDays(today, -REPLICA_DAYS), today),
  ]);
  return {
    serverTime: now.toISOString(),
    today,
    school: ctx.school,
    classes,
    students,
    todaySlots,
    attendance: attendance.map(({ studentId, classId, date, status, version }) => ({ studentId, classId, date, status, version })),
  };
}

export async function push(deps: Deps, auth: AuthContext, req: PushRequest): Promise<PushResponse> {
  const { principal, ctx } = auth;
  if (!roleMayAttempt(principal, "attendance:record")) throw new HttpError(403, "forbidden", "Your role cannot record attendance.");
  if (req.deviceId !== ctx.deviceId) throw new HttpError(403, "device_mismatch", "This device is not the one that signed in.");

  const results: OpResult[] = [];
  // One transaction per operation: a problem with one never undoes the others, and a retry of the batch is safe.
  for (const op of req.ops) {
    results.push(await deps.db.transaction((tx) => processOp(deps, tx, auth, req.deviceId, op)));
  }
  return { results, serverTime: deps.now().toISOString() };
}

const rejected = (opId: string, reason: RejectionReason): OpResult => ({ opId, outcome: "rejected", replayed: false, reason, entries: [] });

async function processOp(deps: Deps, tx: Store, auth: AuthContext, deviceId: string, op: AttendanceRecordOp): Promise<OpResult> {
  const { ctx } = auth;
  const claimed = await tx.claimOperation(ctx.school.id, op.opId, ctx.user.id, deviceId, op.type);
  if (!claimed) {
    const prior = await tx.getOperation(ctx.school.id, op.opId);
    if (!prior) throw new Error("Operation id was claimed but is not readable; retry");
    // Somebody else's operation id in this school: say nothing about it.
    if (prior.userId !== ctx.user.id) return rejected(op.opId, "forbidden");
    const stored = opResult.safeParse(prior.result);
    if (!stored.success) throw new Error("Stored operation result is unreadable");
    return { ...stored.data, replayed: true };
  }
  const result = await applyAttendance(deps, tx, auth, deviceId, op);
  await tx.saveOperationResult(ctx.school.id, op.opId, result);
  return result;
}

async function applyAttendance(deps: Deps, tx: Store, auth: AuthContext, deviceId: string, op: AttendanceRecordOp): Promise<OpResult> {
  const { principal, ctx } = auth;
  const schoolId = ctx.school.id;
  const { classId, date, entries } = op.payload;

  if (date > todayInTimezone(deps.now(), ctx.school.timezone)) return rejected(op.opId, "future_date");
  if (!(await tx.classExists(schoolId, classId))) return rejected(op.opId, "not_found");

  const teachesClass = await tx.teachesClass(schoolId, ctx.user.id, classId);
  if (!authorize(principal, "attendance:record", { schoolId, classId, teachesClass }).allowed) return rejected(op.opId, "forbidden");

  const ids = entries.map((e) => e.studentId);
  if (new Set(ids).size !== ids.length) return rejected(op.opId, "invalid");
  const enrolled = new Set((await tx.enrolledStudents(schoolId, [classId], date)).map((s) => s.id));
  if (ids.some((id) => !enrolled.has(id))) return rejected(op.opId, "invalid");

  const stored = new Map((await tx.lockAttendance(schoolId, ids, date)).map((r) => [r.studentId, r]));
  const byStudent = new Map<string, EntryResult>();
  const changes: { studentId: string; from: string | null; to: string }[] = [];

  // Write in a fixed order so two overlapping operations cannot lock each other's rows in opposite orders.
  for (const e of [...entries].sort((a, b) => a.studentId.localeCompare(b.studentId))) {
    const write = { schoolId, studentId: e.studentId, classId, date, status: e.status, recordedBy: ctx.user.id, deviceId, opId: op.opId };
    let current = stored.get(e.studentId) ?? null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const decision = decideAttendanceWrite(
        current ? { status: current.status, version: current.version, deviceId: current.deviceId } : null,
        { status: e.status, baseVersion: e.baseVersion, deviceId },
      );
      if (decision.kind === "insert") {
        const inserted = await tx.insertAttendance(write);
        if (inserted) {
          byStudent.set(e.studentId, { studentId: e.studentId, outcome: "applied", status: e.status, version: inserted.version });
          changes.push({ studentId: e.studentId, from: null, to: e.status });
          break;
        }
        // Someone else inserted this student/day between our read and write: look again and decide properly.
        current = (await tx.lockAttendance(schoolId, [e.studentId], date))[0] ?? null;
        continue;
      }
      if (decision.kind === "update") {
        await tx.updateAttendance(write, decision.nextVersion);
        byStudent.set(e.studentId, { studentId: e.studentId, outcome: "applied", status: e.status, version: decision.nextVersion });
        changes.push({ studentId: e.studentId, from: current!.status, to: e.status });
      } else if (decision.kind === "noop") {
        byStudent.set(e.studentId, { studentId: e.studentId, outcome: "noop", status: e.status, version: decision.version });
      } else {
        byStudent.set(e.studentId, { studentId: e.studentId, outcome: "conflict", status: decision.serverStatus, version: decision.serverVersion });
      }
      break;
    }
    if (!byStudent.has(e.studentId)) throw new Error("Could not settle attendance entry; retry");
  }

  if (changes.length > 0) {
    await tx.appendAudit({
      schoolId, actorUserId: ctx.user.id, action: "attendance.recorded", entityType: "class", entityId: classId,
      opId: op.opId, details: { date, deviceId, changes },
    });
  }
  const results = entries.map((e) => byStudent.get(e.studentId)!);
  return {
    opId: op.opId,
    outcome: results.some((r) => r.outcome === "conflict") ? "conflict" : "applied",
    replayed: false,
    entries: results,
  };
}
