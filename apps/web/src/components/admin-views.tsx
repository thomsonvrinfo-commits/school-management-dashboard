/** Read-only views for the school-administration screens: lists, facts and history. Props in, markup out. */
import { Link } from "react-router";
import type {
  AcademicYearDto, ClassListItem, PlacementDto, RosterResponse, StudentDetail, StudentListItem, TeacherListItem, TeacherRef, TermDto,
} from "@schoolpulse/contracts";
import { plural } from "../lib/format.ts";
import {
  CLASS_STATUS_LABEL, GENDER_LABEL, STUDENT_STATUS_LABEL, dateLabel, describePlacement, fullName,
} from "../lib/admin-forms.ts";
import { Button, EmptyState, SelectField, StatusPill, buttonClass } from "./ui.tsx";
import type { ClassOption } from "./admin-forms.tsx";

// ---------- students ----------

export function StudentRows({ items }: { items: readonly StudentListItem[] }) {
  if (items.length === 0) return <EmptyState title="No students match">Try a different search, or clear the filters.</EmptyState>;
  return (
    <ul className="divide-y divide-white/10">
      {items.map((s) => {
        const where = s.currentClass ? s.currentClass.name : s.status === "enrolled" ? "No class yet" : "Not in a class";
        return (
          <li key={s.id}>
            <Link to={`/students/${s.id}`} className="flex min-h-16 items-center gap-3 py-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{fullName(s)}</span>
                <span className="block text-sm text-dim">
                  {s.admissionNo} · {where}
                  {s.upcomingClass ? ` · moving to ${s.upcomingClass.name} on ${dateLabel(s.upcomingClass.startsOn)}` : ""}
                </span>
              </span>
              {s.status !== "enrolled" ? <StatusPill>{STUDENT_STATUS_LABEL[s.status]}</StatusPill> : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export interface StudentFilterValues { q: string; status: string; classId: string; unplaced: boolean }

export function StudentFilterBar({ draft, applied, classes, onDraft, onSearch, onApply }: {
  draft: string; applied: StudentFilterValues; classes: readonly ClassOption[];
  onDraft: (q: string) => void; onSearch: () => void; onApply: (patch: Partial<StudentFilterValues>) => void;
}) {
  return (
    <form role="search" aria-label="Find students" onSubmit={(e) => { e.preventDefault(); onSearch(); }} className="space-y-3">
      <div className="flex gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor="student-search" className="text-sm font-semibold">Search by name or admission number</label>
          <input id="student-search" type="search" value={draft} onChange={(e) => onDraft(e.target.value)} maxLength={100} autoComplete="off"
            className="mt-1 min-h-12 w-full rounded-xl border border-white/15 bg-white/5 px-3 text-base" />
        </div>
        <button type="submit" className={`${buttonClass("primary")} self-end`}>Search</button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField label="Status" value={applied.status} onChange={(status) => onApply({ status })} placeholder="Any status"
          options={(Object.keys(STUDENT_STATUS_LABEL) as (keyof typeof STUDENT_STATUS_LABEL)[]).map((s) => ({ value: s, label: STUDENT_STATUS_LABEL[s] }))} />
        <SelectField label="Class today" value={applied.classId} onChange={(classId) => onApply({ classId, unplaced: false })} placeholder="Any class"
          options={classes.map((c) => ({ value: c.id, label: c.academicYear ? `${c.name} (${c.academicYear.name})` : c.name }))} />
      </div>
      <label className="flex min-h-11 items-center gap-3 text-sm font-semibold">
        <input type="checkbox" checked={applied.unplaced} onChange={(e) => onApply({ unplaced: e.target.checked, classId: e.target.checked ? "" : applied.classId })} className="size-6 accent-violet" />
        Only enrolled students who are not in a class yet
      </label>
    </form>
  );
}

export function StudentFacts({ student: s }: { student: StudentDetail }) {
  const rows: [string, string][] = [
    ["Admission number", s.admissionNo],
    ["Status", STUDENT_STATUS_LABEL[s.status]],
    ["Enrolled on", dateLabel(s.enrolmentDate)],
    ["Date of birth", s.dateOfBirth ? dateLabel(s.dateOfBirth) : "Not recorded"],
    ["Gender", s.gender ? GENDER_LABEL[s.gender] : "Not recorded"],
    ...(s.otherNames ? ([["Other names", s.otherNames]] as [string, string][]) : []),
    ["Class today", s.currentClass ? s.currentClass.name : "No class"],
    ...(s.upcomingClass ? ([["Moving to", `${s.upcomingClass.name} on ${dateLabel(s.upcomingClass.startsOn)}`]] as [string, string][]) : []),
  ];
  return (
    <dl className="divide-y divide-white/10">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4 py-3">
          <dt className="text-dim">{k}</dt>
          <dd className="text-right font-semibold">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Newest first. Only the latest placement can be removed (as a mistake), and only if no register was taken in it. */
export function PlacementList({ placements, removableId, onRemove }: { placements: readonly PlacementDto[]; removableId: string | null; onRemove: (p: PlacementDto) => void }) {
  if (placements.length === 0) return <EmptyState title="Not in any class yet">Use “Move to a class” to place this student.</EmptyState>;
  const newestFirst = [...placements].sort((a, b) => (a.startsOn < b.startsOn ? 1 : -1));
  return (
    <ol className="divide-y divide-white/10">
      {newestFirst.map((p) => (
        <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <p className="min-w-0 text-sm"><span className="font-semibold">{describePlacement(p)}</span></p>
          {p.id === removableId ? <Button variant="secondary" aria-label={`Remove the placement in ${p.className}`} onClick={() => onRemove(p)}>Remove</Button> : null}
        </li>
      ))}
    </ol>
  );
}

export function AttendanceByClass({ rows }: { rows: StudentDetail["attendance"] }) {
  if (rows.length === 0) return <p className="text-sm text-dim">No registers have been taken for this student yet.</p>;
  return (
    <ul className="divide-y divide-white/10">
      {rows.map((r) => (
        <li key={r.classId} className="py-3 text-sm">
          <span className="font-semibold">{r.className}</span>: {plural(r.days, "day")} recorded{r.lastDate ? `, last on ${dateLabel(r.lastDate)}` : ""}
        </li>
      ))}
    </ul>
  );
}

// ---------- classes ----------

export function ClassRows({ items }: { items: readonly ClassListItem[] }) {
  if (items.length === 0) return <EmptyState title="No classes match">Create a class, or clear the filters.</EmptyState>;
  return (
    <ul className="divide-y divide-white/10">
      {items.map((c) => (
        <li key={c.id}>
          <Link to={`/classes/${c.id}`} className="flex min-h-16 items-center gap-3 py-3">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold">{c.name}</span>
              <span className="block text-sm text-dim">
                Grade {c.gradeLevel}{c.stream ? ` · Stream ${c.stream}` : ""} · {c.academicYear ? c.academicYear.name : "No academic year yet"}
              </span>
              <span className="block text-sm text-dim">{plural(c.studentCount, "student")} · {plural(c.teacherCount, "teacher")}</span>
            </span>
            {c.status === "archived" ? <StatusPill>{CLASS_STATUS_LABEL.archived}</StatusPill> : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function TeacherPanel({ assigned, available, selected, onSelect, onAssign, onRemove, busy, blockedReason }: {
  assigned: readonly TeacherRef[]; available: readonly TeacherListItem[]; selected: string; onSelect: (userId: string) => void;
  onAssign: () => void; onRemove: (t: TeacherRef) => void; busy: boolean; blockedReason?: string | null;
}) {
  return (
    <div className="space-y-4">
      {assigned.length === 0 ? (
        <EmptyState title="No teacher assigned">Until a teacher is assigned, nobody can take this class's register.</EmptyState>
      ) : (
        <ul className="divide-y divide-white/10">
          {assigned.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 py-3">
              <span className="min-w-0 truncate font-semibold">{t.name}</span>
              <Button variant="secondary" disabled={busy} aria-label={`Remove ${t.name} from this class`} onClick={() => onRemove(t)}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
      {blockedReason ? (
        <p className="text-sm text-dim">{blockedReason}</p>
      ) : available.length === 0 ? (
        <p className="text-sm text-dim">Every teacher at this school is already assigned to this class.</p>
      ) : (
        <div className="flex items-end gap-3">
          <div className="min-w-0 flex-1">
            <SelectField label="Add a teacher" value={selected} onChange={onSelect} placeholder="Choose a teacher"
              options={available.map((t) => ({ value: t.id, label: `${t.name} (${plural(t.classCount, "class", "classes")})` }))} />
          </div>
          <Button variant="primary" disabled={!selected} busy={busy} busyLabel="Adding…" onClick={onAssign}>Add</Button>
        </div>
      )}
    </div>
  );
}

export function RosterList({ roster }: { roster: RosterResponse }) {
  if (roster.students.length === 0) return <EmptyState title={`No students in ${roster.className} on ${dateLabel(roster.date)}`} />;
  return (
    <ol className="divide-y divide-white/10" aria-label={`Students in ${roster.className} on ${dateLabel(roster.date)}`}>
      {roster.students.map((s) => (
        <li key={s.id} className="py-2.5">
          <Link to={`/students/${s.id}`} className="flex min-h-11 items-center justify-between gap-3">
            <span className="font-semibold">{fullName(s)}</span>
            <span className="text-sm text-dim">{s.admissionNo}</span>
          </Link>
        </li>
      ))}
    </ol>
  );
}

// ---------- school ----------

export function ProfileFacts({ rows }: { rows: readonly [string, string][] }) {
  return (
    <dl className="divide-y divide-white/10">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4 py-3">
          <dt className="text-dim">{k}</dt>
          <dd className="text-right font-semibold">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function YearCard({ year, onEdit, onDelete, onMakeCurrent, onAddTerm, onEditTerm, onDeleteTerm }: {
  year: AcademicYearDto; onEdit: () => void; onDelete: () => void; onMakeCurrent: () => void; onAddTerm: () => void;
  onEditTerm: (t: TermDto) => void; onDeleteTerm: (t: TermDto) => void;
}) {
  const terms = [...year.terms].sort((a, b) => (a.startsOn < b.startsOn ? -1 : 1));
  return (
    <li className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-lg font-bold">{year.name} {year.isActive ? <StatusPill tone="good">Current year</StatusPill> : null}</h3>
          <p className="text-sm text-dim">{dateLabel(year.startsOn)} to {dateLabel(year.endsOn)} · {plural(year.classCount, "class", "classes")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {year.isActive ? null : <Button variant="secondary" aria-label={`Make ${year.name} the current year`} onClick={onMakeCurrent}>Make current</Button>}
          <Button variant="secondary" aria-label={`Edit ${year.name}`} onClick={onEdit}>Edit</Button>
          <Button variant="secondary" aria-label={`Delete ${year.name}`} onClick={onDelete}>Delete</Button>
        </div>
      </div>
      {terms.length === 0 ? (
        <p className="text-sm text-dim">No terms added yet.</p>
      ) : (
        <ul className="divide-y divide-white/10">
          {terms.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <p className="text-sm"><span className="font-semibold">{t.name}</span> · {dateLabel(t.startsOn)} to {dateLabel(t.endsOn)}</p>
              <span className="flex gap-2">
                <Button variant="secondary" aria-label={`Edit ${t.name}, ${year.name}`} onClick={() => onEditTerm(t)}>Edit</Button>
                <Button variant="secondary" aria-label={`Delete ${t.name}, ${year.name}`} onClick={() => onDeleteTerm(t)}>Delete</Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <Button variant="secondary" onClick={onAddTerm}>Add a term to {year.name}</Button>
    </li>
  );
}
