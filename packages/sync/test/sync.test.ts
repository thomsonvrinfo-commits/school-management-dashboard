import { test } from "node:test";
import assert from "node:assert/strict";
import type { AttendanceRecordOp, OpResult } from "@schoolpulse/contracts";
import {
  enqueue, dueOps, markSending, markNetworkFailure, recoverInterrupted, applyResults,
  resolveKeepTheirs, resolveUseMine, discard, backoffMs, syncState, type QueuedOp,
} from "../src/index.ts";

const CLASS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const S1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const S2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function op(n: number, createdAt = `2026-10-08T06:0${n}:00.000Z`): AttendanceRecordOp {
  return {
    opId: id(n), type: "attendance.record", createdAt,
    payload: { classId: CLASS, date: "2026-10-08", entries: [
      { studentId: S1, status: "absent", baseVersion: 0 },
      { studentId: S2, status: "present", baseVersion: 1 },
    ] },
  };
}
const result = (n: number, over: Partial<OpResult> = {}): OpResult => ({
  opId: id(n), outcome: "applied", replayed: false,
  entries: [
    { studentId: S1, outcome: "applied", status: "absent", version: 1 },
    { studentId: S2, outcome: "noop", status: "present", version: 1 },
  ], ...over,
});

test("backoff doubles and is capped at five minutes", () => {
  assert.equal(backoffMs(1), 2000);
  assert.equal(backoffMs(2), 4000);
  assert.equal(backoffMs(3), 8000);
  assert.equal(backoffMs(20), 300_000);
});

test("dueOps: oldest first, only pending ones that are due", () => {
  const q: QueuedOp[] = [enqueue(op(2), 0), enqueue(op(1), 0), { ...enqueue(op(3), 0), nextAttemptAt: 10_000 }, { ...enqueue(op(4), 0), status: "conflict" }];
  assert.deepEqual(dueOps(q, 5000).map((x) => x.op.opId), [id(1), id(2)]);
});

test("a network failure keeps the op, counts the attempt and delays the retry", () => {
  let q = [enqueue(op(1), 0)];
  q = markSending(q, new Set([id(1)]));
  assert.equal(q[0]!.status, "sending");
  q = markNetworkFailure(q, new Set([id(1)]), 1000, "offline");
  assert.equal(q[0]!.status, "pending");
  assert.equal(q[0]!.attempts, 1);
  assert.equal(q[0]!.nextAttemptAt, 3000);
  assert.deepEqual(dueOps(q, 2000), []);
  assert.equal(dueOps(q, 3000).length, 1);
});

test("an op interrupted mid-send goes back to pending (the server dedupes by opId)", () => {
  const q = recoverInterrupted(markSending([enqueue(op(1), 0)], new Set([id(1)])));
  assert.equal(q[0]!.status, "pending");
});

test("applied result removes the op and confirms every entry locally", () => {
  const { queue, confirmed } = applyResults([enqueue(op(1), 0)], [result(1)]);
  assert.equal(queue.length, 0);
  assert.deepEqual(confirmed.map((c) => [c.studentId, c.status, c.version, c.date, c.classId]), [
    [S1, "absent", 1, "2026-10-08", CLASS],
    [S2, "present", 1, "2026-10-08", CLASS],
  ]);
});

test("a replayed result is handled exactly like the original", () => {
  const a = applyResults([enqueue(op(1), 0)], [result(1)]);
  const b = applyResults([enqueue(op(1), 0)], [result(1, { replayed: true })]);
  assert.deepEqual(a, b);
});

test("partial conflict: applied entries are confirmed, the conflicting one stays for review", () => {
  const r = result(1, {
    outcome: "conflict",
    entries: [
      { studentId: S1, outcome: "conflict", status: "present", version: 2 },
      { studentId: S2, outcome: "applied", status: "present", version: 2 },
    ],
  });
  const { queue, confirmed } = applyResults([enqueue(op(1), 0)], [r]);
  assert.equal(queue.length, 1);
  assert.equal(queue[0]!.status, "conflict");
  assert.deepEqual(queue[0]!.conflicts, [{ studentId: S1, mine: "absent", theirs: "present", serverVersion: 2 }]);
  assert.deepEqual(confirmed.map((c) => c.studentId), [S2]);
});

test("rejection is kept visible with its reason and is not retried", () => {
  const { queue } = applyResults([enqueue(op(1), 0)], [result(1, { outcome: "rejected", reason: "forbidden", entries: [] })]);
  assert.equal(queue[0]!.status, "failed");
  assert.equal(queue[0]!.rejection, "forbidden");
  assert.deepEqual(dueOps(queue, 1e12), []);
});

test("results for unknown ops are ignored and unrelated ops are untouched", () => {
  const q = [enqueue(op(1), 0), enqueue(op(2), 0)];
  const { queue } = applyResults(q, [result(9), result(1)]);
  assert.deepEqual(queue.map((x) => x.op.opId), [id(2)]);
});

function conflicted(): QueuedOp[] {
  const r = result(1, { outcome: "conflict", entries: [{ studentId: S1, outcome: "conflict", status: "present", version: 2 }] });
  return applyResults([enqueue(op(1), 0)], [r]).queue;
}

test("keep theirs: drops the local change and adopts the server value", () => {
  const { queue, adopt } = resolveKeepTheirs(conflicted(), id(1));
  assert.equal(queue.length, 0);
  assert.deepEqual(adopt.map((a) => [a.studentId, a.status, a.version]), [[S1, "present", 2]]);
});

test("use mine: re-queues a NEW op based on the server's version, only for the conflicted students", () => {
  const q = resolveUseMine(conflicted(), id(1), id(7), "2026-10-08T07:00:00.000Z", 5000);
  assert.equal(q.length, 1);
  const redo = q[0]!;
  assert.equal(redo.op.opId, id(7));
  assert.equal(redo.status, "pending");
  assert.deepEqual(redo.op.payload.entries, [{ studentId: S1, status: "absent", baseVersion: 2 }]);
});

test("discard only removes finished-with-problem ops, never one still waiting to sync", () => {
  const failed: QueuedOp = { ...enqueue(op(1), 0), status: "failed", rejection: "forbidden" };
  const waiting = enqueue(op(2), 0);
  assert.deepEqual(discard([failed, waiting], id(1)).map((x) => x.op.opId), [id(2)]);
  assert.deepEqual(discard([failed, waiting], id(2)).map((x) => x.op.opId), [id(1), id(2)]);
});

test("sync indicator: the four states the teacher sees", () => {
  const pending = [enqueue(op(1), 0)];
  assert.deepEqual(syncState({ online: true, queue: [], syncing: false }), { indicator: "synced", waiting: 0, conflicts: 0, failed: 0, label: "Synced" });
  assert.equal(syncState({ online: false, queue: pending, syncing: false }).label, "Offline, 1 waiting");
  assert.equal(syncState({ online: true, queue: pending, syncing: true }).indicator, "syncing");
  const problem = syncState({ online: true, queue: conflicted(), syncing: false });
  assert.equal(problem.indicator, "problem");
  assert.equal(problem.label, "1 change needs attention");
});
