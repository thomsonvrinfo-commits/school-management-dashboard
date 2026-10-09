import type { AttendanceSummaryResponse } from "@schoolpulse/contracts";
import { describeChange, formatRate, plural, shortDate } from "../lib/format.ts";

type Figures = AttendanceSummaryResponse["school"];

/** Present, late and absent as proportions of the register entries they come from. */
export function ProportionBar({ f }: { f: Pick<Figures, "present" | "late" | "absent" | "total"> }) {
  if (f.total === 0) return <div className="h-2 rounded-full bg-white/10" aria-hidden="true" />;
  const pct = (n: number) => `${(n / f.total) * 100}%`;
  return (
    <div
      className="flex h-2 overflow-hidden rounded-full bg-white/10"
      role="img"
      aria-label={`${f.present} present, ${f.late} late, ${f.absent} absent`}
    >
      <span className="bg-present" style={{ width: pct(f.present) }} />
      <span className="bg-late" style={{ width: pct(f.late) }} />
      <span className="bg-absent" style={{ width: pct(f.absent) }} />
    </div>
  );
}

function Change({ points, previousLabel }: { points: number | null; previousLabel: string }) {
  const text = describeChange(points);
  if (text === null) return <p className="text-sm text-dim">Nothing to compare with in {previousLabel}.</p>;
  const arrow = points === 0 ? "" : points! > 0 ? "▲ " : "▼ ";
  return (
    <p className="text-sm text-dim">
      <span className={`font-semibold ${points! < 0 ? "text-absent" : points! > 0 ? "text-present" : "text-mist"}`}>
        {arrow}
        {text}
      </span>{" "}
      on {previousLabel}
    </p>
  );
}

export function SummaryView({ data }: { data: AttendanceSummaryResponse }) {
  const { school, period, previousPeriod } = data;
  const range = (p: { from: string; to: string }) => (p.from === p.to ? shortDate(p.from) : `${shortDate(p.from)} to ${shortDate(p.to)}`);
  const classes = [...data.classes].sort((a, b) => (a.changePoints ?? Infinity) - (b.changePoints ?? Infinity));

  return (
    <div className="space-y-8">
      <section aria-labelledby="school-rate">
        <h2 id="school-rate" className="text-sm font-medium text-dim">
          In school, {range(period)}
        </h2>
        <p className="mt-1 text-5xl font-extrabold tracking-tight tabular-nums">{school.rate === null ? "No registers yet" : `${school.rate}%`}</p>
        <Change points={data.changePoints} previousLabel={`the previous period, ${range(previousPeriod)}`} />
        <div className="mt-4">
          <ProportionBar f={school} />
        </div>

        <details className="mt-4 rounded-xl border border-white/10 bg-white/5 px-4 py-3">
          <summary className="cursor-pointer text-sm font-semibold">How this was worked out</summary>
          <p className="mt-2 text-sm leading-relaxed text-dim">
            {school.total === 0
              ? "No register entries were recorded in this period."
              : `${school.present.toLocaleString()} present plus ${school.late.toLocaleString()} late is ${school.attended.toLocaleString()} in school, out of ${school.total.toLocaleString()} register entries. ${plural(school.absent, "entry", "entries")} marked absent. A late pupil counts as in school.`}
          </p>
        </details>
      </section>

      <section aria-labelledby="by-class">
        <h2 id="by-class" className="text-lg font-bold">
          By class
        </h2>
        <p className="text-sm text-dim">Biggest drops first.</p>
        <ul className="mt-3 divide-y divide-white/10">
          {classes.map((c) => (
            <li key={c.classId} className="py-3">
              <div className="flex items-baseline justify-between gap-3">
                <p className="font-semibold">{c.name}</p>
                <p className="text-lg font-bold tabular-nums">{formatRate(c.current.rate)}</p>
              </div>
              <div className="mt-2">
                <ProportionBar f={c.current} />
              </div>
              <p className="mt-1.5 text-xs text-dim tabular-nums">
                {c.current.total === 0
                  ? "No registers in this period."
                  : `${c.current.present} present, ${c.current.late} late, ${c.current.absent} absent${describeChange(c.changePoints) ? `. ${describeChange(c.changePoints)} on the previous period` : ""}`}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
