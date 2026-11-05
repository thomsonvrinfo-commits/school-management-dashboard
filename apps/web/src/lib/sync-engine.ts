/**
 * Moves data between this phone and the server. All decisions (what to send, how to read the answer, how a
 * conflict is resolved) are made by pure functions in @schoolpulse/sync; this file only does the storage and network.
 *
 * One rule runs through it: a change is written to the local database FIRST, and only removed from the queue
 * once the server has confirmed it. Nothing is ever dropped because a request failed.
 */
import type { OpResult } from "@schoolpulse/contracts";
import {
  afterRun, applyConfirmed, applyResults, discard, dueOps, freshPollState, markNetworkFailure, markSending, mergeServerRow, nextPollDelayMs,
  rebase, recoverInterrupted, replicaMetaAfter, resolveKeepTheirs, resolveUseMine, sinceFor, type PollState, type QueuedOp, type ReplicaMeta,
  type RunOutcome,
} from "@schoolpulse/sync";
import { ApiFailure, NetworkFailure, api } from "./api.ts";
import { db, fromOpRow, getMeta, setMeta, toDbRow, toLocal, toOpRow } from "./db.ts";
import { getDeviceId } from "./session.ts";
import { createStore } from "./store.ts";

export interface EngineStatus {
  /** What the browser says. Unreliable on its own (captive portals), so it is combined with `reachable`. */
  online: boolean;
  /** False after a request failed to get through; true after one succeeded. */
  reachable: boolean;
  syncing: boolean;
  lastSyncedAt: string | null;
}

export const engineStatus = createStore<EngineStatus>({
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  reachable: true,
  syncing: false,
  lastSyncedAt: null,
});

const patch = (p: Partial<EngineStatus>) => engineStatus.set((s) => ({ ...s, ...p }));

export const loadQueue = async (): Promise<QueuedOp[]> => (await db.ops.toArray()).map(fromOpRow);

/** Write only what changed between two versions of the queue, so an op added while we were syncing is never lost. */
async function persistQueueChange(before: readonly QueuedOp[], after: readonly QueuedOp[]): Promise<void> {
  const afterById = new Map(after.map((q) => [q.op.opId, q]));
  const removed = before.filter((q) => !afterById.has(q.op.opId)).map((q) => q.op.opId);
  const beforeJson = new Map(before.map((q) => [q.op.opId, JSON.stringify(q)]));
  const changed = after.filter((q) => beforeJson.get(q.op.opId) !== JSON.stringify(q));
  if (removed.length) await db.ops.bulkDelete(removed);
  if (changed.length) await db.ops.bulkPut(changed.map(toOpRow));
}

let first = true;
let running: Promise<void> | null = null;
let again = false;

// How soon to ask again depends on how the last runs went (see @schoolpulse/sync polling.ts). Kept here, in memory:
// after a restart the app simply starts at the fastest pace again.
let poll: PollState = freshPollState;
let pending = false;
let onRunFinished: (() => void) | null = null;

/** Push whatever is waiting, then refresh the local copy. Safe to call at any time and as often as you like. */
export function syncNow(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = run().finally(() => {
    running = null;
    if (again) {
      again = false;
      void syncNow();
    }
    onRunFinished?.();
  });
  return running;
}

function rejectAll(ops: readonly QueuedOp[], reason: "forbidden" | "invalid"): OpResult[] {
  return ops.map((q) => ({ opId: q.op.opId, outcome: "rejected" as const, replayed: false, reason, entries: [] }));
}

async function run(): Promise<void> {
  patch({ syncing: true });
  let sentSomething = false;
  try {
    let queue = await loadQueue();
    if (first) {
      first = false;
      const recovered = recoverInterrupted(queue);
      await persistQueueChange(queue, recovered);
      queue = recovered;
    }

    const due = dueOps(queue, Date.now());
    if (due.length > 0) {
      sentSomething = true;
      const ids = new Set(due.map((q) => q.op.opId));
      const sending = markSending(queue, ids);
      await persistQueueChange(queue, sending);
      queue = sending;
      try {
        const res = await api.push({ deviceId: await getDeviceId(), ops: due.map((q) => q.op) });
        await absorbResults(queue, res.results);
        patch({ reachable: true });
      } catch (e) {
        if (e instanceof ApiFailure && (e.status === 403 || e.status === 400)) {
          // The server read the request and refused it for good: show the teacher, never retry silently.
          await absorbResults(queue, rejectAll(due, e.status === 403 ? "forbidden" : "invalid"));
        } else {
          const msg = e instanceof Error ? e.message : "Could not sync";
          const retry = markNetworkFailure(queue, ids, Date.now(), msg, Math.random());
          await persistQueueChange(queue, retry);
          if (e instanceof NetworkFailure) patch({ reachable: false });
          poll = afterRun(poll, "failed", false);
          return;
        }
      }
    }

    // After sending registers, always download in full: whatever the server now holds is what this phone should show.
    const outcome: RunOutcome = await refreshReplica({ forceFull: sentSomething });
    poll = afterRun(poll, outcome, sentSomething);
    patch({ reachable: true, lastSyncedAt: new Date().toISOString() });
  } catch (e) {
    poll = afterRun(poll, "failed", false);
    if (e instanceof NetworkFailure) patch({ reachable: false });
    else if (!(e instanceof ApiFailure)) console.error("Sync failed", e);
  } finally {
    pending = await hasPendingOps();
    patch({ syncing: false });
  }
}

/** Registers waiting to go to the server (not ones waiting for a person to settle a conflict or a refusal). */
async function hasPendingOps(): Promise<boolean> {
  try {
    return (await loadQueue()).some((q) => q.status === "pending" || q.status === "sending");
  } catch {
    return false;
  }
}

async function absorbResults(queueBefore: readonly QueuedOp[], results: readonly OpResult[]): Promise<void> {
  const { queue: after, confirmed } = applyResults(queueBefore, results);
  await db.transaction("rw", db.attendance, db.ops, async () => {
    for (const c of confirmed) {
      const existing = await db.attendance.get([c.studentId, c.date]);
      await db.attendance.put(toDbRow(applyConfirmed(existing ? toLocal(existing) : undefined, c)));
    }
    await persistQueueChange(queueBefore, after);
  });
}

/**
 * Download the teacher's classes, students, timetable and recent attendance. Unsynced local marks are never overwritten.
 * When this phone already holds a recent copy the server is asked "has anything changed?" and, if not, sends a few dozen
 * bytes instead of the lot. `forceFull` skips that question.
 */
export async function refreshReplica(opts: { forceFull?: boolean } = {}): Promise<"changed" | "unchanged"> {
  const held = await getMeta<ReplicaMeta>("replica");
  const b = await api.bootstrap(sinceFor(held, Date.now(), opts));
  const meta = replicaMetaAfter(held, b, new Date().toISOString());
  if (!meta) {
    // "unchanged" about a copy we do not hold: never happens, but never trust it. Ask once for everything; if even that is
    // answered "unchanged" the server is broken, so stop (the engine retries later with a back-off) instead of looping.
    if (opts.forceFull) throw new Error("The server answered 'unchanged' to a request for the whole copy.");
    return refreshReplica({ forceFull: true });
  }
  if ("unchanged" in b) {
    await setMeta("replica", meta);
    return "unchanged";
  }
  await db.transaction("rw", [db.meta, db.classes, db.students, db.slots, db.attendance], async () => {
    await Promise.all([db.classes.clear(), db.students.clear(), db.slots.clear()]);
    await db.classes.bulkPut(b.classes);
    await db.students.bulkPut(b.students);
    await db.slots.bulkPut(b.todaySlots);
    await db.attendance.where("dirty").equals(0).delete();
    for (const row of b.attendance) {
      const local = await db.attendance.get([row.studentId, row.date]);
      const merged = mergeServerRow(local ? toLocal(local) : undefined, row);
      if (!local || !local.dirty) await db.attendance.put(toDbRow(merged));
    }
    await setMeta("replica", meta);
  });
  return "changed";
}

/**
 * Forget which copy this phone holds, so the next refresh downloads in full. For anything that changes the local
 * attendance in a way the server's copy does not know about (the server would otherwise say "unchanged").
 */
async function forgetReplicaVersion(): Promise<void> {
  const held = await getMeta<ReplicaMeta>("replica");
  if (held?.version) {
    const { version: _gone, ...rest } = held;
    await setMeta("replica", rest);
  }
}

// ---------- resolving problems the teacher has seen ----------

/** Conflict: accept the register's current value and drop my change. */
export async function resolveWithTheirs(opId: string): Promise<void> {
  const queue = await loadQueue();
  const { queue: next, adopt } = resolveKeepTheirs(queue, opId);
  await db.transaction("rw", db.attendance, db.ops, async () => {
    for (const a of adopt) {
      await db.attendance.put(toDbRow({ studentId: a.studentId, classId: a.classId, date: a.date, status: a.status, version: a.version, dirty: false }));
    }
    await persistQueueChange(queue, next);
  });
}

/** Conflict: keep my mark, based on the version the server now has. */
export async function resolveWithMine(opId: string): Promise<void> {
  const queue = await loadQueue();
  const target = queue.find((q) => q.op.opId === opId);
  const next = resolveUseMine(queue, opId, crypto.randomUUID(), new Date().toISOString(), Date.now());
  await db.transaction("rw", db.attendance, db.ops, async () => {
    for (const c of target?.conflicts ?? []) {
      const row = await db.attendance.get([c.studentId, target!.op.payload.date]);
      if (row) await db.attendance.put(toDbRow(rebase(toLocal(row), c.serverVersion)));
    }
    await persistQueueChange(queue, next);
  });
  void syncNow();
}

/** Rejected change: forget it and go back to what the server has. */
export async function discardFailed(opId: string): Promise<void> {
  const queue = await loadQueue();
  const target = queue.find((q) => q.op.opId === opId);
  const next = discard(queue, opId);
  await db.transaction("rw", db.attendance, db.ops, async () => {
    for (const e of target?.op.payload.entries ?? []) {
      const row = await db.attendance.get([e.studentId, target!.op.payload.date]);
      if (row && row.dirty === 1) await db.attendance.delete([e.studentId, target!.op.payload.date]);
    }
    await persistQueueChange(queue, next);
  });
  // The rows just removed may exist on the server: the next refresh must bring them back, not say "unchanged".
  await forgetReplicaVersion();
  void syncNow();
}

// ---------- when to sync ----------

let started = false;
export function startSyncEngine(): () => void {
  if (started) return () => {};
  started = true;
  let timer: number | undefined;

  // One timer, set again after EVERY sync (from the timer, an event or a saved register), so the pace always
  // reflects what just happened: quick after something changed or is waiting, slower while everything is quiet.
  const schedule = () => {
    window.clearTimeout(timer);
    timer = undefined;
    const delay = nextPollDelayMs(
      { ...poll, visible: document.visibilityState === "visible", online: navigator.onLine, pending },
      Math.random(),
    );
    if (delay !== null) timer = window.setTimeout(() => void syncNow(), delay);
  };
  onRunFinished = schedule;

  const onOnline = () => {
    patch({ online: true });
    poll = { ...poll, failures: 0 };
    void syncNow();
  };
  const onOffline = () => {
    patch({ online: false });
    schedule();
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") {
      poll = freshPollState; // she is back: check now, then at the quick pace again
      void syncNow();
    } else {
      schedule();
    }
  };
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  document.addEventListener("visibilitychange", onVisible);
  void syncNow();
  return () => {
    started = false;
    onRunFinished = null;
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    document.removeEventListener("visibilitychange", onVisible);
    window.clearTimeout(timer);
  };
}
