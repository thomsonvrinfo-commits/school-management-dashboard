import { useState } from "react";
import { syncState, type QueuedOp } from "@schoolpulse/sync";
import { STATUS_LABEL } from "../components/attendance.tsx";
import { db } from "../lib/db.ts";
import { useLive, useStore } from "../lib/hooks.ts";
import { clock, plural, shortDate } from "../lib/format.ts";
import { discardFailed, engineStatus, loadQueue, resolveWithMine, resolveWithTheirs, syncNow } from "../lib/sync-engine.ts";

const REJECTION: Record<string, string> = {
  forbidden: "You are not assigned to this class, or your role cannot record attendance.",
  invalid: "The school could not accept this register as sent.",
  not_found: "This class no longer exists at the school.",
  future_date: "The register was dated in the future.",
};

export function SyncPanel() {
  const status = useStore(engineStatus);
  const queue = useLive(loadQueue, [], [] as QueuedOp[]);
  const names = useLive(async () => Object.fromEntries((await db.students.toArray()).map((s) => [s.id, `${s.firstName} ${s.lastName}`])), [], {} as Record<string, string>);
  const classes = useLive(async () => Object.fromEntries((await db.classes.toArray()).map((c) => [c.id, c.name])), [], {} as Record<string, string>);
  const [busy, setBusy] = useState(false);

  const state = syncState({ online: status.online && status.reachable, queue, syncing: status.syncing });
  const waiting = queue.filter((q) => q.status === "pending" || q.status === "sending");
  const waitingMarks = waiting.reduce((n, q) => n + q.op.payload.entries.length, 0);
  const conflicts = queue.filter((q) => q.status === "conflict");
  const failed = queue.filter((q) => q.status === "failed");

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-extrabold tracking-tight">{state.label}</h1>
        <p className="mt-1 text-dim">
          {status.lastSyncedAt ? `Last synced at ${clock(status.lastSyncedAt)}.` : "Not synced since this app opened."}
          {waiting.length > 0 ? ` ${plural(waitingMarks, "mark")} saved on this phone, waiting to send.` : " Everything on this phone has reached the school."}
        </p>
        <button
          type="button"
          disabled={busy || status.syncing}
          onClick={() => run(syncNow)}
          className="mt-4 min-h-12 rounded-xl bg-violet px-5 text-base font-bold text-night disabled:opacity-60"
        >
          {status.syncing ? "Syncing…" : "Sync now"}
        </button>
      </header>

      {conflicts.length > 0 ? (
        <section aria-labelledby="conflicts">
          <h2 id="conflicts" className="text-lg font-bold">Different marks to review</h2>
          <p className="text-sm text-dim">Someone else recorded these while you were offline. Nothing was overwritten.</p>
          <ul className="mt-3 space-y-5">
            {conflicts.map((q) => (
              <li key={q.op.opId} className="rounded-2xl border border-late/40 bg-late/5 p-4">
                <p className="font-semibold">{classes[q.op.payload.classId] ?? "Class"}, {shortDate(q.op.payload.date)}</p>
                <ul className="mt-2 space-y-1.5 text-sm">
                  {(q.conflicts ?? []).map((c) => (
                    <li key={c.studentId}>
                      <span className="font-semibold">{names[c.studentId] ?? "Pupil"}</span>: you marked {STATUS_LABEL[c.mine].toLowerCase()}, the register says {STATUS_LABEL[c.theirs].toLowerCase()}.
                    </li>
                  ))}
                </ul>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button type="button" disabled={busy} onClick={() => run(() => resolveWithTheirs(q.op.opId))} className="min-h-12 flex-1 rounded-xl border border-white/20 bg-white/5 px-3 font-semibold">
                    Keep the register's mark
                  </button>
                  <button type="button" disabled={busy} onClick={() => run(() => resolveWithMine(q.op.opId))} className="min-h-12 flex-1 rounded-xl bg-violet px-3 font-bold text-night">
                    Use my mark
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {failed.length > 0 ? (
        <section aria-labelledby="failed">
          <h2 id="failed" className="text-lg font-bold">Not accepted</h2>
          <ul className="mt-3 space-y-4">
            {failed.map((q) => (
              <li key={q.op.opId} className="rounded-2xl border border-absent/40 bg-absent/5 p-4">
                <p className="font-semibold">{classes[q.op.payload.classId] ?? "Class"}, {shortDate(q.op.payload.date)}</p>
                <p className="mt-1 text-sm text-dim">{REJECTION[q.rejection ?? "invalid"] ?? REJECTION.invalid}</p>
                <button type="button" disabled={busy} onClick={() => run(() => discardFailed(q.op.opId))} className="mt-3 min-h-12 rounded-xl border border-white/20 bg-white/5 px-4 font-semibold">
                  Discard these marks
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {waiting.length > 0 ? (
        <section aria-labelledby="waiting">
          <h2 id="waiting" className="text-lg font-bold">Waiting to send</h2>
          <ul className="mt-2 divide-y divide-white/10">
            {waiting.map((q) => (
              <li key={q.op.opId} className="flex items-center justify-between gap-3 py-3">
                <span>
                  <span className="block font-semibold">{classes[q.op.payload.classId] ?? "Class"}, {shortDate(q.op.payload.date)}</span>
                  <span className="block text-sm text-dim">{plural(q.op.payload.entries.length, "mark")}{q.lastError ? `. Last try failed: ${q.lastError}` : ""}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
