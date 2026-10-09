/**
 * Offline operation queue: pure logic, no storage and no network.
 * The web app persists `QueuedOp[]` in IndexedDB and feeds it through these functions,
 * so the rules (retry, dedupe, conflicts, status shown to the teacher) are testable without a browser.
 */
import type { AttendanceRecordOp, EntryResult, OpResult, RejectionReason } from "@schoolpulse/contracts";
import type { AttendanceStatus } from "@schoolpulse/domain";

export type QueuedStatus = "pending" | "sending" | "conflict" | "failed";

export interface ConflictItem {
  studentId: string;
  mine: AttendanceStatus;
  theirs: AttendanceStatus;
  serverVersion: number;
}

export interface QueuedOp {
  op: AttendanceRecordOp;
  status: QueuedStatus;
  attempts: number;
  /** Earliest time (ms epoch) to try again after a network failure. */
  nextAttemptAt: number;
  lastError?: string;
  /** Present when status is "failed" because the server rejected it (not retryable). */
  rejection?: RejectionReason;
  conflicts?: ConflictItem[];
}

export function enqueue(op: AttendanceRecordOp, now: number): QueuedOp {
  return { op, status: "pending", attempts: 0, nextAttemptAt: now };
}

/** Exponential backoff: 2s, 4s, 8s ... capped at 5 minutes. `jitter` is 0..1 (inject for tests). */
export function backoffMs(attempts: number, jitter = 0): number {
  const base = Math.min(2000 * 2 ** Math.max(0, attempts - 1), 300_000);
  return Math.round(base * (1 + 0.2 * jitter));
}

/** Operations ready to send now, oldest first. Conflicts and rejections wait for a human. */
export function dueOps(queue: readonly QueuedOp[], now: number): QueuedOp[] {
  return queue
    .filter((q) => q.status === "pending" && q.nextAttemptAt <= now)
    .sort((a, b) => a.op.createdAt.localeCompare(b.op.createdAt));
}

export function markSending(queue: readonly QueuedOp[], opIds: ReadonlySet<string>): QueuedOp[] {
  return queue.map((q) => (opIds.has(q.op.opId) ? { ...q, status: "sending" as const } : q));
}

/** The request never got an answer (offline, timeout, 5xx): keep the op, try again later. */
export function markNetworkFailure(
  queue: readonly QueuedOp[],
  opIds: ReadonlySet<string>,
  now: number,
  error: string,
  jitter = 0,
): QueuedOp[] {
  return queue.map((q) => {
    if (!opIds.has(q.op.opId)) return q;
    const attempts = q.attempts + 1;
    return { ...q, status: "pending" as const, attempts, nextAttemptAt: now + backoffMs(attempts, jitter), lastError: error };
  });
}

/** Any op left "sending" when the app was closed mid-request goes back to pending (the server dedupes by opId). */
export function recoverInterrupted(queue: readonly QueuedOp[]): QueuedOp[] {
  return queue.map((q) => (q.status === "sending" ? { ...q, status: "pending" as const } : q));
}

export interface AppliedEntry extends EntryResult {
  date: string;
  classId: string;
}

export interface ApplyOutcome {
  queue: QueuedOp[];
  /** Server-confirmed entries to write into the local replica (marks them clean). */
  confirmed: AppliedEntry[];
}

/**
 * Fold the server's per-operation results into the queue.
 * - applied: the op leaves the queue and its entries are confirmed locally
 * - conflict: applied entries are confirmed; the conflicting ones stay for the teacher to resolve
 * - rejected: the op stays as "failed" with the reason (never retried automatically, never silently dropped)
 * Results for unknown opIds are ignored. A replayed result is treated exactly like the original.
 */
export function applyResults(queue: readonly QueuedOp[], results: readonly OpResult[]): ApplyOutcome {
  const byId = new Map(results.map((r) => [r.opId, r]));
  const confirmed: AppliedEntry[] = [];
  const next: QueuedOp[] = [];

  for (const q of queue) {
    const r = byId.get(q.op.opId);
    if (!r) {
      next.push(q);
      continue;
    }
    const { classId, date } = q.op.payload;
    if (r.outcome === "rejected") {
      next.push({ ...q, status: "failed", rejection: r.reason ?? "invalid", conflicts: undefined });
      continue;
    }
    const mine = new Map(q.op.payload.entries.map((e) => [e.studentId, e.status]));
    const conflicts: ConflictItem[] = [];
    for (const e of r.entries) {
      if (e.outcome === "conflict") {
        conflicts.push({
          studentId: e.studentId,
          mine: mine.get(e.studentId) ?? e.status,
          theirs: e.status,
          serverVersion: e.version,
        });
      } else {
        confirmed.push({ ...e, classId, date });
      }
    }
    if (r.outcome === "conflict" && conflicts.length > 0) {
      next.push({ ...q, status: "conflict", conflicts, rejection: undefined });
    }
    // applied: dropped from the queue
  }
  return { queue: next, confirmed };
}

/**
 * "Keep theirs": drop the local change for these students and adopt the server's value.
 * Returns the queue without the conflicted op, plus the server states to write into the replica.
 */
export function resolveKeepTheirs(
  queue: readonly QueuedOp[],
  opId: string,
): { queue: QueuedOp[]; adopt: AppliedEntry[] } {
  const target = queue.find((q) => q.op.opId === opId && q.status === "conflict");
  if (!target?.conflicts) return { queue: [...queue], adopt: [] };
  const { classId, date } = target.op.payload;
  return {
    queue: queue.filter((q) => q.op.opId !== opId),
    adopt: target.conflicts.map((c) => ({
      studentId: c.studentId,
      outcome: "noop" as const,
      status: c.theirs,
      version: c.serverVersion,
      classId,
      date,
    })),
  };
}

/**
 * "Use mine": replace the conflicted op with a fresh one carrying the server's current version as its base,
 * so the server treats it as a deliberate edit. A new opId is required: the old one is already recorded.
 */
export function resolveUseMine(
  queue: readonly QueuedOp[],
  opId: string,
  newOpId: string,
  nowIso: string,
  now: number,
): QueuedOp[] {
  const target = queue.find((q) => q.op.opId === opId && q.status === "conflict");
  if (!target?.conflicts) return [...queue];
  const { classId, date } = target.op.payload;
  const redo: AttendanceRecordOp = {
    opId: newOpId,
    type: "attendance.record",
    createdAt: nowIso,
    payload: {
      classId,
      date,
      entries: target.conflicts.map((c) => ({ studentId: c.studentId, status: c.mine, baseVersion: c.serverVersion })),
    },
  };
  return [...queue.filter((q) => q.op.opId !== opId), enqueue(redo, now)];
}

/** Discard a rejected operation after the teacher has seen why. */
export function discard(queue: readonly QueuedOp[], opId: string): QueuedOp[] {
  return queue.filter((q) => q.op.opId !== opId || q.status === "pending" || q.status === "sending");
}

export type SyncIndicator = "synced" | "offline" | "syncing" | "problem";

export interface SyncState {
  indicator: SyncIndicator;
  waiting: number;
  conflicts: number;
  failed: number;
  /** One short sentence for the top bar. */
  label: string;
}

export function syncState(input: { online: boolean; queue: readonly QueuedOp[]; syncing: boolean }): SyncState {
  const { online, queue, syncing } = input;
  const conflicts = queue.filter((q) => q.status === "conflict").length;
  const failed = queue.filter((q) => q.status === "failed").length;
  const waiting = queue.filter((q) => q.status === "pending" || q.status === "sending").length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  if (conflicts + failed > 0) {
    return { indicator: "problem", waiting, conflicts, failed, label: `${conflicts + failed} ${conflicts + failed === 1 ? "change needs" : "changes need"} attention` };
  }
  if (!online) {
    return { indicator: "offline", waiting, conflicts, failed, label: waiting > 0 ? `Offline, ${waiting} waiting` : "Offline" };
  }
  if (syncing || waiting > 0) {
    return { indicator: "syncing", waiting, conflicts, failed, label: waiting > 0 ? `Syncing ${plural(waiting, "change")}` : "Syncing" };
  }
  return { indicator: "synced", waiting, conflicts, failed, label: "Synced" };
}
export * from "./replica.ts";
