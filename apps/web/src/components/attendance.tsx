import type { AttendanceStatus } from "@schoolpulse/domain";
import type { RegisterCounts } from "@schoolpulse/sync";

export const STATUS_LABEL: Record<AttendanceStatus, string> = { present: "Present", late: "Late", absent: "Absent" };
const LETTER: Record<AttendanceStatus, string> = { present: "P", late: "L", absent: "A" };
const ACTIVE: Record<AttendanceStatus, string> = {
  present: "bg-present text-night border-present",
  late: "bg-late text-night border-late",
  absent: "bg-absent text-night border-absent",
};
const DOT: Record<AttendanceStatus, string> = { present: "bg-present", late: "bg-late", absent: "bg-absent" };

export interface RegisterStudent {
  id: string;
  firstName: string;
  lastName: string;
  admissionNo: string;
}

/** Three large buttons. The letter and the accessible name say the status; colour only reinforces it. */
export function StatusButtons({ name, value, onChange }: { name: string; value: AttendanceStatus | undefined; onChange: (s: AttendanceStatus) => void }) {
  return (
    <div role="group" aria-label={`Attendance for ${name}`} className="flex gap-1.5">
      {(Object.keys(LETTER) as AttendanceStatus[]).map((s) => {
        const on = value === s;
        return (
          <button
            key={s}
            type="button"
            aria-pressed={on}
            aria-label={`${STATUS_LABEL[s]}: ${name}`}
            onClick={() => onChange(s)}
            className={`size-11 rounded-xl border text-base font-bold transition-colors ${on ? ACTIVE[s] : "border-white/15 bg-white/5 text-dim active:bg-white/15"}`}
          >
            {LETTER[s]}
          </button>
        );
      })}
    </div>
  );
}

export function RegisterList({ students, marks, waiting, onMark }: {
  students: readonly RegisterStudent[];
  marks: Readonly<Record<string, AttendanceStatus | undefined>>;
  waiting: ReadonlySet<string>;
  onMark: (studentId: string, status: AttendanceStatus) => void;
}) {
  return (
    <ul className="divide-y divide-white/10">
      {students.map((s) => {
        const full = `${s.firstName} ${s.lastName}`;
        return (
          <li key={s.id} className="flex items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate font-semibold">{full}</p>
              <p className="text-xs text-dim">
                {s.admissionNo}
                {waiting.has(s.id) ? <span className="ml-2 text-late">Waiting to sync</span> : null}
              </p>
            </div>
            <StatusButtons name={full} value={marks[s.id]} onChange={(status) => onMark(s.id, status)} />
          </li>
        );
      })}
    </ul>
  );
}

/** Doubles as the legend: each count is labelled with the same colour the buttons use. */
export function CountsBar({ counts }: { counts: RegisterCounts }) {
  const item = (label: string, n: number, dot: string) => (
    <div className="flex items-center gap-1.5">
      <span aria-hidden="true" className={`size-2.5 rounded-full ${dot}`} />
      <span className="text-sm text-dim">{label}</span>
      <span className="text-sm font-bold tabular-nums">{n}</span>
    </div>
  );
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {item("Present", counts.present, DOT.present)}
      {item("Late", counts.late, DOT.late)}
      {item("Absent", counts.absent, DOT.absent)}
      {item("Not marked", counts.unmarked, "bg-white/30")}
    </div>
  );
}
