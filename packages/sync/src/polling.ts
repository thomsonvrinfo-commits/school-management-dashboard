/**
 * When a phone should ask the server for news, and whether it may ask for "only if changed". Pure functions: the web app
 * keeps the few numbers (see `PollState`) and sets the timer; the rules are tested here without a browser or a clock.
 *
 * The aim is mobile data. A teacher's phone should not download the whole register data every 30 seconds while nothing
 * is happening, but it must still notice quickly when she has something to send or she has just come back to the app.
 */

import type { BootstrapResponse, BootstrapUnchanged } from "@schoolpulse/contracts";

export const BASE_POLL_MS = 30_000;
export const MAX_IDLE_POLL_MS = 300_000;
export const MAX_PENDING_POLL_MS = 60_000;
/** A full download is forced at least this often, whatever the server says, as a safety net against local drift. */
export const FULL_REFRESH_AFTER_MS = 6 * 60 * 60 * 1000;

const VERSION = /^[A-Za-z0-9_-]{16,64}$/;

export interface PollState {
  /** Consecutive refreshes where the server said nothing had changed. */
  unchangedStreak: number;
  /** Consecutive refreshes that did not reach the server. */
  failures: number;
}

export const freshPollState: PollState = { unchangedStreak: 0, failures: 0 };

export type RunOutcome = "changed" | "unchanged" | "failed";

/** What a finished sync means for how soon to ask again. Sending something of her own always resets the waiting. */
export function afterRun(s: PollState, outcome: RunOutcome, sentSomething: boolean): PollState {
  if (outcome === "failed") return { unchangedStreak: s.unchangedStreak, failures: s.failures + 1 };
  if (outcome === "unchanged" && !sentSomething) return { unchangedStreak: s.unchangedStreak + 1, failures: 0 };
  return { unchangedStreak: 0, failures: 0 };
}

export interface PollContext extends PollState {
  /** The app is on screen. */
  visible: boolean;
  online: boolean;
  /** Registers are waiting to be sent (not ones waiting for a human to settle a conflict). */
  pending: boolean;
}

/**
 * Milliseconds until the next check, or null for "do not set a timer" (offline: the browser's `online` event restarts it).
 * `random` (0..1) spreads phones out so they do not all call at the same instant; pass 0.5 for no spread.
 */
export function nextPollDelayMs(c: PollContext, random = 0.5): number | null {
  if (!c.online) return null;
  const cap = c.pending ? MAX_PENDING_POLL_MS : MAX_IDLE_POLL_MS;
  // Idle in the background: slowest straight away. Otherwise start at 30 s and back off while nothing happens or nothing is reachable.
  const base = c.pending || c.visible ? BASE_POLL_MS : MAX_IDLE_POLL_MS;
  const doublings = Math.min(Math.floor(Math.max(0, c.unchangedStreak) / 2) + Math.max(0, c.failures), 10);
  const delay = Math.min(cap, base * 2 ** doublings);
  const spread = 0.9 + 0.2 * Math.min(1, Math.max(0, random));
  return Math.round(delay * spread);
}

/** What the phone remembers about the copy it holds (stored with the replica). Anything else is treated as "nothing". */
export interface HeldReplica {
  version?: unknown;
  downloadedAt?: unknown;
}

/**
 * The version to send as `?since=`, or undefined for "send me everything": nothing held, the held version is malformed,
 * the last full download was too long ago (or in the future, so the clock cannot be trusted), or the caller insists.
 */
export function sinceFor(held: HeldReplica | undefined, nowMs: number, opts: { forceFull?: boolean } = {}): string | undefined {
  if (opts.forceFull || !held) return undefined;
  if (typeof held.version !== "string" || !VERSION.test(held.version)) return undefined;
  if (typeof held.downloadedAt !== "string") return undefined;
  const at = Date.parse(held.downloadedAt);
  if (!Number.isFinite(at)) return undefined;
  const age = nowMs - at;
  if (age < 0 || age >= FULL_REFRESH_AFTER_MS) return undefined;
  return held.version;
}

/** The small record kept next to the downloaded copy. `version` and `downloadedAt` are what make "only if changed" possible. */
export interface ReplicaMeta {
  today: string;
  school: BootstrapResponse["school"];
  serverTime: string;
  version?: string;
  downloadedAt?: string;
}

/**
 * What to remember after the server answered. A whole copy replaces the record and starts the six-hour clock again.
 * "Unchanged" keeps the copy, its version and its download time, and only notes the server's clock and school day.
 * Returns null for "unchanged" when nothing was held: that cannot happen with a correct server, so the caller downloads in full.
 */
export function replicaMetaAfter(held: ReplicaMeta | undefined, answer: BootstrapResponse | BootstrapUnchanged, nowIso: string): ReplicaMeta | null {
  if ("unchanged" in answer) {
    if (!held) return null;
    return { ...held, today: answer.today, serverTime: answer.serverTime };
  }
  return { today: answer.today, school: answer.school, serverTime: answer.serverTime, version: answer.version, downloadedAt: nowIso };
}
