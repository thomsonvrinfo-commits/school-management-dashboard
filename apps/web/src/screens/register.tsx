import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import type { AttendanceStatus } from "@schoolpulse/domain";
import { registerCounts } from "@schoolpulse/sync";
import { CountsBar, RegisterList } from "../components/attendance.tsx";
import { db, getMeta } from "../lib/db.ts";
import { useLive } from "../lib/hooks.ts";
import { longDate } from "../lib/format.ts";
import { saveRegisterLocally } from "../lib/register.ts";
import { engineStatus } from "../lib/sync-engine.ts";

interface Replica {
  today: string;
}

export function Register() {
  const { classId = "" } = useParams();
  const replica = useLive(() => getMeta<Replica>("replica"), [], undefined);
  const cls = useLive(() => db.classes.get(classId), [classId], undefined);
  const students = useLive(
    async () => (await db.students.where("classId").equals(classId).toArray()).sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName)),
    [classId],
    [],
  );
  const date = replica?.today;
  const rows = useLive(
    async () => (date ? db.attendance.where("classId").equals(classId).and((r) => r.date === date).toArray() : []),
    [classId, date],
    [],
  );

  const saved = useMemo(() => Object.fromEntries(rows.map((r) => [r.studentId, r.status])) as Record<string, AttendanceStatus>, [rows]);
  const waiting = useMemo(() => new Set(rows.filter((r) => r.dirty === 1).map((r) => r.studentId)), [rows]);
  const [draft, setDraft] = useState<Record<string, AttendanceStatus>>({});
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  const marks = { ...saved, ...draft };
  const counts = registerCounts(students.map((s) => s.id), marks);
  const changed = Object.entries(draft).filter(([id, s]) => saved[id] !== s);

  useEffect(() => {
    if (changed.length === 0) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [changed.length]);

  if (!replica || !cls) {
    return (
      <section>
        <p className="text-dim">This class has not loaded on this phone. Go back to Today, connect to the internet once, and try again.</p>
        <Link to="/today" className="mt-3 inline-block min-h-11 py-2.5 font-semibold text-violet underline">Back to Today</Link>
      </section>
    );
  }

  const mark = (id: string, status: AttendanceStatus) => {
    setMessage("");
    setDraft((d) => ({ ...d, [id]: status }));
  };

  const markRestPresent = () => {
    setMessage("");
    setDraft((d) => {
      const next = { ...d };
      for (const s of students) if (!marks[s.id]) next[s.id] = "present";
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const n = await saveRegisterLocally({ classId, date: replica.today, marks: Object.fromEntries(changed) });
      setDraft({});
      const live = engineStatus.get();
      setMessage(
        n === 0
          ? "Nothing to save."
          : live.online && live.reachable
            ? "Saved. Sending to the school now."
            : "Saved on this phone. It will send when you are back online.",
      );
    } catch (e) {
      console.error(e);
      setMessage("Could not save on this phone. Free up some storage and try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 pb-24">
      <header>
        <Link to="/today" className="inline-block min-h-11 py-2.5 text-sm font-semibold text-violet">Back to Today</Link>
        <h1 className="text-2xl font-extrabold tracking-tight">{cls.name} register</h1>
        <p className="text-dim">{longDate(replica.today)}</p>
      </header>

      <div className="sticky top-[3.25rem] z-10 -mx-4 border-b border-white/10 bg-night/90 px-4 py-2.5 backdrop-blur-sm">
        <CountsBar counts={counts} />
      </div>

      {counts.unmarked > 0 ? (
        <button type="button" onClick={markRestPresent} className="min-h-12 w-full rounded-xl border border-white/15 bg-white/5 text-base font-semibold">
          Mark the remaining {counts.unmarked} present
        </button>
      ) : null}

      <RegisterList students={students} marks={marks} waiting={waiting} onMark={mark} />

      <div className="glass fixed inset-x-0 bottom-14 z-10 border-t px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <div className="mx-auto max-w-[30rem]">
          <p aria-live="polite" className="mb-2 min-h-5 text-sm text-dim">{message}</p>
          <button
            type="button"
            onClick={save}
            disabled={saving || changed.length === 0}
            className="min-h-12 w-full rounded-xl bg-violet text-base font-bold text-night disabled:bg-white/10 disabled:text-dim"
          >
            {changed.length === 0 ? "Register saved" : `Save register (${changed.length} changed)`}
          </button>
        </div>
      </div>
    </div>
  );
}
