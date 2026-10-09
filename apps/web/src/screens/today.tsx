import { Link } from "react-router";
import { authStore } from "../lib/auth.ts";
import { db, getMeta } from "../lib/db.ts";
import { useLive, useStore } from "../lib/hooks.ts";
import { greeting, longDate } from "../lib/format.ts";

interface Replica {
  today: string;
}

/** The teacher's first screen: what is on today, and whether each register has been taken. */
export function Today() {
  const auth = useStore(authStore);
  const replica = useLive(() => getMeta<Replica>("replica"), [], undefined);
  const slots = useLive(() => db.slots.orderBy("startsAt").toArray(), [], []);
  const classes = useLive(() => db.classes.toArray(), [], []);
  const sizes = useLive(async () => {
    const students = await db.students.toArray();
    const out: Record<string, number> = {};
    for (const s of students) out[s.classId] = (out[s.classId] ?? 0) + 1;
    return out;
  }, [], {} as Record<string, number>);
  const taken = useLive(async () => {
    if (!replica) return {} as Record<string, { marked: number; waiting: number }>;
    const rows = await db.attendance.where("date").equals(replica.today).toArray();
    const out: Record<string, { marked: number; waiting: number }> = {};
    for (const r of rows) {
      const e = (out[r.classId] ??= { marked: 0, waiting: 0 });
      e.marked += 1;
      e.waiting += r.dirty;
    }
    return out;
  }, [replica?.today], {} as Record<string, { marked: number; waiting: number }>);

  if (auth.status !== "signedIn") return null;

  if (!replica) {
    return (
      <section>
        <h1 className="text-2xl font-extrabold">{greeting(new Date())}, {auth.me.user.name}</h1>
        <p className="mt-3 text-dim">Your classes have not loaded on this phone yet. Connect to the internet once and they will appear here, ready to use offline.</p>
      </section>
    );
  }

  const status = (classId: string) => {
    const t = taken[classId];
    const size = sizes[classId] ?? 0;
    if (!t) return { text: "Register not taken", tone: "text-dim" };
    const base = `${t.marked} of ${size} marked`;
    return { text: t.waiting > 0 ? `${base}, waiting to sync` : base, tone: t.marked >= size ? "text-present" : "text-late" };
  };

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-extrabold tracking-tight">{greeting(new Date())}, {auth.me.user.name}</h1>
        <p className="mt-1 text-dim">{longDate(replica.today)}</p>
      </header>

      {slots.length > 0 ? (
        <section aria-labelledby="lessons">
          <h2 id="lessons" className="text-lg font-bold">Your lessons today</h2>
          <ul className="mt-2 divide-y divide-white/10">
            {slots.map((s) => {
              const st = status(s.classId);
              return (
                <li key={s.id}>
                  <Link to={`/classes/${s.classId}/attendance`} className="flex min-h-20 items-center gap-4 py-3">
                    <span className="w-14 shrink-0 text-lg font-bold tabular-nums">{s.startsAt}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold">{s.className}</span>
                      <span className="block text-sm text-dim">{s.subject}</span>
                    </span>
                    <span className={`max-w-32 text-right text-xs font-medium ${st.tone}`}>{st.text}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
        <section aria-labelledby="no-lessons">
          <h2 id="no-lessons" className="text-lg font-bold">No lessons on your timetable today</h2>
          <p className="mt-1 text-sm text-dim">You can still open a class register.</p>
        </section>
      )}

      <section aria-labelledby="classes">
        <h2 id="classes" className="text-lg font-bold">Your classes</h2>
        <ul className="mt-2 divide-y divide-white/10">
          {classes.map((c) => (
            <li key={c.id}>
              <Link to={`/classes/${c.id}/attendance`} className="flex min-h-14 items-center justify-between py-2.5">
                <span className="font-semibold">{c.name}</span>
                <span className="text-sm text-dim">{sizes[c.id] ?? 0} pupils</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
