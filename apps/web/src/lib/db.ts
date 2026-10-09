/**
 * The device's local database (IndexedDB through Dexie). The server stays the source of truth; this holds
 * the permission-filtered copy a teacher works from, plus the queue of changes waiting to sync.
 */
import Dexie, { type Table } from "dexie";
import type { BootstrapResponse, MeResponse } from "@schoolpulse/contracts";
import type { LocalAttendance, QueuedOp } from "@schoolpulse/sync";

export interface MetaRow {
  key: string;
  value: unknown;
}

/** IndexedDB cannot index booleans, so `dirty` is stored as 0 or 1. */
export interface AttendanceDbRow extends Omit<LocalAttendance, "dirty"> {
  dirty: 0 | 1;
}

export type OpDbRow = QueuedOp & { opId: string; createdAt: string };

export type ClassRow = BootstrapResponse["classes"][number];
export type StudentRow = BootstrapResponse["students"][number];
export type SlotRow = BootstrapResponse["todaySlots"][number];

export interface StoredSession {
  refreshToken: string;
  me: MeResponse;
}

class SchoolPulseDb extends Dexie {
  declare meta: Table<MetaRow, string>;
  declare classes: Table<ClassRow, string>;
  declare students: Table<StudentRow, string>;
  declare slots: Table<SlotRow, string>;
  declare attendance: Table<AttendanceDbRow, [string, string]>;
  declare ops: Table<OpDbRow, string>;

  constructor() {
    super("schoolpulse");
    this.version(1).stores({
      meta: "key",
      classes: "id",
      students: "id, classId",
      slots: "id, startsAt",
      attendance: "[studentId+date], classId, date, dirty",
      ops: "opId, status, createdAt",
    });
  }
}

export const db = new SchoolPulseDb();

export const toLocal = (r: AttendanceDbRow): LocalAttendance => ({ ...r, dirty: r.dirty === 1 });
export const toDbRow = (r: LocalAttendance): AttendanceDbRow => ({ ...r, dirty: r.dirty ? 1 : 0 });
export const toOpRow = (q: QueuedOp): OpDbRow => ({ ...q, opId: q.op.opId, createdAt: q.op.createdAt });
export const fromOpRow = (r: OpDbRow): QueuedOp => {
  const { opId: _opId, createdAt: _createdAt, ...queued } = r;
  return queued;
};

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await db.meta.get(key))?.value as T | undefined;
}
export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}

/** Remove everything held for the signed-in person (used on sign-out and when another person signs in). */
export async function wipeLocalData(): Promise<void> {
  await db.transaction("rw", [db.meta, db.classes, db.students, db.slots, db.attendance, db.ops], async () => {
    const deviceId = await getMeta<string>("deviceId"); // identifies this install, not a person: keep it
    await Promise.all([db.meta, db.classes, db.students, db.slots, db.attendance, db.ops].map((t) => t.clear()));
    if (deviceId) await setMeta("deviceId", deviceId);
  });
}
