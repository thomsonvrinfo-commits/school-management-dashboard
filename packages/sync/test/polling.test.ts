import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASE_POLL_MS, FULL_REFRESH_AFTER_MS, MAX_IDLE_POLL_MS, MAX_PENDING_POLL_MS, afterRun, freshPollState, nextPollDelayMs, sinceFor,
  replicaMetaAfter, type PollContext, type ReplicaMeta,
} from "../src/index.ts";
import type { BootstrapResponse, BootstrapUnchanged } from "@schoolpulse/contracts";

const ctx = (over: Partial<PollContext> = {}): PollContext => ({ visible: true, online: true, pending: false, unchangedStreak: 0, failures: 0, ...over });
const V = "A".repeat(43);
const NOW = Date.parse("2026-10-08T10:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

// ---------- how soon to ask again ----------

test("offline: no timer at all (the browser's online event restarts it)", () => {
  assert.equal(nextPollDelayMs(ctx({ online: false })), null);
  assert.equal(nextPollDelayMs(ctx({ online: false, pending: true })), null);
});

test("on screen and just opened: every 30 seconds", () => {
  assert.equal(nextPollDelayMs(ctx()), BASE_POLL_MS);
});

test("on screen and nothing happening: waits longer every second quiet answer, never more than 5 minutes", () => {
  const delays = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 20].map((n) => nextPollDelayMs(ctx({ unchangedStreak: n })));
  assert.deepEqual(delays, [30_000, 30_000, 60_000, 60_000, 120_000, 120_000, 240_000, 240_000, 300_000, 300_000, 300_000]);
  assert.ok(delays.every((d, i) => i === 0 || d! >= delays[i - 1]!), "never speeds up by itself");
});

test("in the background and idle: slowest straight away", () => {
  assert.equal(nextPollDelayMs(ctx({ visible: false })), MAX_IDLE_POLL_MS);
  assert.equal(nextPollDelayMs(ctx({ visible: false, unchangedStreak: 50 })), MAX_IDLE_POLL_MS);
});

test("registers waiting to be sent keep the checks frequent, in the background too, and never slower than a minute", () => {
  assert.equal(nextPollDelayMs(ctx({ pending: true })), BASE_POLL_MS);
  assert.equal(nextPollDelayMs(ctx({ pending: true, visible: false })), BASE_POLL_MS);
  assert.equal(nextPollDelayMs(ctx({ pending: true, unchangedStreak: 40, failures: 9 })), MAX_PENDING_POLL_MS);
});

test("failing to reach the server backs off too, and a good answer clears it", () => {
  assert.deepEqual([0, 1, 2, 3].map((n) => nextPollDelayMs(ctx({ failures: n }))), [30_000, 60_000, 120_000, 240_000]);
  assert.equal(nextPollDelayMs(ctx({ failures: 99 })), MAX_IDLE_POLL_MS);
});

test("the spread keeps every delay within 10% of the plan, and never below zero", () => {
  const lo = nextPollDelayMs(ctx(), 0)!;
  const hi = nextPollDelayMs(ctx(), 1)!;
  assert.equal(lo, 27_000);
  assert.equal(hi, 33_000);
  assert.equal(nextPollDelayMs(ctx(), -5), lo, "out-of-range randomness is clamped");
  assert.equal(nextPollDelayMs(ctx(), 7), hi);
});

test("nonsense counters are treated as zero", () => {
  assert.equal(nextPollDelayMs(ctx({ unchangedStreak: -3, failures: -1 })), BASE_POLL_MS);
});

// ---------- what a finished sync means ----------

test("a quiet answer adds to the streak; a change, or sending something of her own, resets it", () => {
  let s = freshPollState;
  s = afterRun(s, "unchanged", false);
  s = afterRun(s, "unchanged", false);
  assert.deepEqual(s, { unchangedStreak: 2, failures: 0 });
  assert.deepEqual(afterRun(s, "changed", false), freshPollState);
  assert.deepEqual(afterRun(s, "unchanged", true), freshPollState);
});

test("a failure counts up without touching the quiet streak, and the next success clears it", () => {
  const quiet = { unchangedStreak: 4, failures: 0 };
  const failed = afterRun(afterRun(quiet, "failed", false), "failed", false);
  assert.deepEqual(failed, { unchangedStreak: 4, failures: 2 });
  assert.deepEqual(afterRun(failed, "unchanged", false), { unchangedStreak: 5, failures: 0 });
  assert.deepEqual(afterRun(failed, "changed", false), freshPollState);
});

// ---------- whether to ask for "only if changed" ----------

test("a recent full download with a well-formed version may be asked about", () => {
  assert.equal(sinceFor({ version: V, downloadedAt: ago(60_000) }, NOW), V);
});

test("nothing held, or anything odd about it: ask for everything", () => {
  assert.equal(sinceFor(undefined, NOW), undefined);
  assert.equal(sinceFor({}, NOW), undefined);
  assert.equal(sinceFor({ version: V }, NOW), undefined, "no download time");
  assert.equal(sinceFor({ downloadedAt: ago(1) }, NOW), undefined, "no version");
  for (const version of [123, null, "", "short", "has space in it........", "x".repeat(65), "bad/char+++++++++++++"]) {
    assert.equal(sinceFor({ version, downloadedAt: ago(1) }, NOW), undefined, String(version));
  }
  assert.equal(sinceFor({ version: V, downloadedAt: "yesterday-ish" }, NOW), undefined);
  assert.equal(sinceFor({ version: V, downloadedAt: 12345 }, NOW), undefined);
});

test("a copy older than six hours is replaced in full, as is one 'downloaded in the future'", () => {
  assert.equal(sinceFor({ version: V, downloadedAt: ago(FULL_REFRESH_AFTER_MS - 1) }, NOW), V);
  assert.equal(sinceFor({ version: V, downloadedAt: ago(FULL_REFRESH_AFTER_MS) }, NOW), undefined);
  assert.equal(sinceFor({ version: V, downloadedAt: ago(-1000) }, NOW), undefined, "the clock went backwards: do not trust it");
});

test("forceFull always wins (after sending registers or settling a problem)", () => {
  assert.equal(sinceFor({ version: V, downloadedAt: ago(1000) }, NOW, { forceFull: true }), undefined);
});

// ---------- what to remember ----------

const SCHOOL = { id: "11111111-1111-4111-8111-111111111111", name: "Mavambo Academy", timezone: "Africa/Harare" };
const full = (over: Partial<BootstrapResponse> = {}): BootstrapResponse => ({
  version: V, serverTime: "2026-10-08T10:00:00.000Z", today: "2026-10-08", school: SCHOOL, classes: [], students: [], todaySlots: [], attendance: [], ...over,
});
const quiet = (over: Partial<BootstrapUnchanged> = {}): BootstrapUnchanged => ({ unchanged: true, version: V, serverTime: "2026-10-08T10:05:00.000Z", today: "2026-10-08", ...over });
const held: ReplicaMeta = { today: "2026-10-08", school: SCHOOL, serverTime: "2026-10-08T10:00:00.000Z", version: V, downloadedAt: "2026-10-08T10:00:01.000Z" };

test("a whole copy replaces the record and starts the six-hour clock", () => {
  const m = replicaMetaAfter(held, full({ version: "B".repeat(43), today: "2026-10-09" }), "2026-10-09T05:00:00.000Z")!;
  assert.deepEqual(m, { today: "2026-10-09", school: SCHOOL, serverTime: "2026-10-08T10:00:00.000Z", version: "B".repeat(43), downloadedAt: "2026-10-09T05:00:00.000Z" });
});

test("'unchanged' keeps the copy's version and download time, and only notes the clock and day", () => {
  const m = replicaMetaAfter(held, quiet({ serverTime: "2026-10-08T10:09:00.000Z" }), "2026-10-08T10:09:00.500Z")!;
  assert.equal(m.version, held.version);
  assert.equal(m.downloadedAt, held.downloadedAt, "a quiet answer must not restart the six-hour clock");
  assert.equal(m.serverTime, "2026-10-08T10:09:00.000Z");
  assert.deepEqual(m.school, SCHOOL);
});

test("'unchanged' with nothing held is not trusted: the caller must download in full", () => {
  assert.equal(replicaMetaAfter(undefined, quiet(), "2026-10-08T10:09:00.500Z"), null);
});

test("a copy from a server that sends no version is never asked about again", () => {
  const old = { ...full(), version: undefined } as unknown as BootstrapResponse;
  const m = replicaMetaAfter(held, old, "2026-10-08T10:09:00.000Z")!;
  assert.equal(sinceFor(m, NOW), undefined);
});
