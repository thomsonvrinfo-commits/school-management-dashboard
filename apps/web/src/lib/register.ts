import type { AttendanceEntry, AttendanceRecordOp } from "@schoolpulse/contracts";
import type { AttendanceStatus } from "@schoolpulse/domain";
import { enqueue, planRegisterSave } from "@schoolpulse/sync";
import { db, toDbRow, toLocal, toOpRow } from "./db.ts";
import { syncNow } from "./sync-engine.ts";

/** The contract allows 100 entries per operation, so a very large class becomes several operations. */
const ENTRIES_PER_OP = 100;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Save a register ON THIS DEVICE and queue it for the server. Resolves as soon as it is safely stored locally,
 * whether or not there is a connection. Returns how many students' marks changed.
 */
export async function saveRegisterLocally(input: {
  classId: string;
  date: string;
  marks: Readonly<Record<string, AttendanceStatus>>;
}): Promise<number> {
  const changed = await db.transaction("rw", db.attendance, db.ops, async () => {
    const rows = await db.attendance.where("classId").equals(input.classId).and((r) => r.date === input.date).toArray();
    const existing = new Map(rows.map((r) => [r.studentId, toLocal(r)]));
    const plan = planRegisterSave({ ...input, existing });
    if (plan.entries.length === 0) return 0;

    await db.attendance.bulkPut(plan.rows.map(toDbRow));
    const createdAt = new Date();
    for (const part of chunks<AttendanceEntry>(plan.entries, ENTRIES_PER_OP)) {
      const op: AttendanceRecordOp = {
        opId: crypto.randomUUID(),
        type: "attendance.record",
        createdAt: createdAt.toISOString(),
        payload: { classId: input.classId, date: input.date, entries: part },
      };
      await db.ops.put(toOpRow(enqueue(op, createdAt.getTime())));
    }
    return plan.entries.length;
  });
  if (changed > 0) void syncNow();
  return changed;
}
