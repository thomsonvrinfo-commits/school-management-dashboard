import { useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import type { ChangeStudentStatusRequest, PlacementDto, StudentDetail } from "@schoolpulse/contracts";
import type { StudentStatus } from "@schoolpulse/domain";
import { PlacementForm, StatusForm, StudentForm, type ClassOption } from "../../components/admin-forms.tsx";
import { AttendanceByClass, PlacementList, StudentFacts, StudentFilterBar, StudentRows, type StudentFilterValues } from "../../components/admin-views.tsx";
import { Button, ConfirmDialog, Loading, Notice, PageHeader, Pager, Section, StatusPill, buttonClass } from "../../components/ui.tsx";
import { adminApi } from "../../lib/admin-api.ts";
import {
  STUDENT_FIELDS, STUDENT_STATUS_LABEL, emptyStudentForm, fullName, latestPlacement, pageWindow, studentToForm, toCreateStudent, toFailure, toPlacement,
  toStatusChange, toUpdateStudent, validateCreateStudent, validatePlacement, validateStatusChange, validateUpdateStudent,
  type PlacementFormValues, type StatusFormValues, type StudentFormValues,
} from "../../lib/admin-forms.ts";
import { useFormState } from "../../lib/use-form-state.ts";
import { useRequest } from "../../lib/use-request.ts";

const PAGE_SIZE = 25;

/** Active classes, for the pickers on the student screens. (A school with more than 100 active classes sees the first 100.) */
function useActiveClasses() {
  const { state } = useRequest(() => adminApi.classes({ status: "active", limit: 100 }), []);
  const options: ClassOption[] = state.status === "ready" ? state.data.items : [];
  return { state, options };
}

// ---------- the register ----------

export function StudentList() {
  const [params, setParams] = useSearchParams();
  const applied: StudentFilterValues = {
    q: params.get("q") ?? "", status: params.get("status") ?? "", classId: params.get("classId") ?? "", unplaced: params.get("unplaced") === "true",
  };
  const offset = Math.max(0, Number.parseInt(params.get("offset") ?? "0", 10) || 0);
  const [draft, setDraft] = useState(applied.q);
  const classes = useActiveClasses();

  /** Filters live in the address, so Back works and a search can be shared. Changing a filter returns to the first page. */
  const setParam = (patch: Record<string, string | undefined>) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      if (!("offset" in patch)) next.delete("offset");
      return next;
    }, { replace: true });

  const { state, reload } = useRequest(
    () => adminApi.students({
      q: applied.q || undefined, status: (applied.status || undefined) as StudentStatus | undefined, classId: applied.classId || undefined,
      unplaced: applied.unplaced ? "true" : undefined, limit: PAGE_SIZE, offset,
    }),
    [applied.q, applied.status, applied.classId, applied.unplaced, offset],
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Students" subtitle="Everyone enrolled at your school." action={<Link to="/students/new" className={buttonClass("primary")}>Register a student</Link>} />
      <StudentFilterBar
        draft={draft} applied={applied} classes={classes.options}
        onDraft={setDraft}
        onSearch={() => setParam({ q: draft.trim() || undefined })}
        onApply={(patch) => setParam({
          ...(patch.status !== undefined ? { status: patch.status || undefined } : {}),
          ...(patch.classId !== undefined ? { classId: patch.classId || undefined } : {}),
          ...(patch.unplaced !== undefined ? { unplaced: patch.unplaced ? "true" : undefined } : {}),
        })}
      />
      {state.status === "loading" ? <Loading what="students" /> : null}
      {state.status === "failed" ? (
        <div className="space-y-3">
          <Notice tone="error">{state.failure.message}</Notice>
          <Button onClick={reload}>Try again</Button>
        </div>
      ) : null}
      {state.status === "ready" ? (
        <>
          <StudentRows items={state.data.items} />
          <PagerFor page={state.data} onOffset={(o) => setParam({ offset: o > 0 ? String(o) : undefined })} />
        </>
      ) : null}
    </div>
  );
}

function PagerFor({ page, onOffset }: { page: { total: number; limit: number; offset: number }; onOffset: (offset: number) => void }) {
  const w = pageWindow(page);
  return <Pager from={w.from} to={w.to} total={page.total} hasPrev={w.hasPrev} hasNext={w.hasNext} onPrev={() => onOffset(w.prevOffset)} onNext={() => onOffset(w.nextOffset)} noun="students" />;
}

export function StudentCreate() {
  const navigate = useNavigate();
  const classes = useActiveClasses();
  const f = useFormState<StudentFormValues>(emptyStudentForm);

  const save = async () => {
    let createdId = "";
    const ok = await f.submit(validateCreateStudent(f.values), async () => { createdId = (await adminApi.createStudent(toCreateStudent(f.values))).id; }, STUDENT_FIELDS);
    if (ok) navigate(`/students/${createdId}`, { state: { flash: "Student registered." } });
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Register a student" subtitle={<Link to="/students" className="underline">Back to students</Link>} />
      {classes.state.status === "loading" ? <Loading what="classes" /> : (
        <>
          {classes.state.status === "failed" ? <Notice tone="warn">The class list could not be loaded, so you cannot pick a class now. You can place the student in a class from their page afterwards.</Notice> : null}
          <StudentForm
            mode="create" classes={classes.options} values={f.values} errors={f.errors} banner={f.banner} busy={f.busy}
            onChange={f.change} onSubmit={() => void save()} onCancel={() => navigate("/students")} submitLabel="Register student"
          />
        </>
      )}
    </div>
  );
}

// ---------- one student ----------

type Panel = "edit" | "move" | "status" | null;

export function StudentDetailScreen() {
  const { id } = useParams();
  const location = useLocation();
  const initialFlash = (location.state as { flash?: string } | null)?.flash ?? null;
  const [panel, setPanel] = useState<Panel>(null);
  const [flash, setFlash] = useState<string | null>(initialFlash);
  const [removing, setRemoving] = useState<PlacementDto | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const classes = useActiveClasses();
  const { state, reload } = useRequest(() => adminApi.student(id ?? ""), [id]);

  if (!id) return <Notice tone="error">That student could not be found.</Notice>;
  if (state.status === "loading") return <Loading what="the student" />;
  if (state.status === "failed") {
    return (
      <div className="space-y-3">
        <Notice tone="error">{state.failure.code === "not_found" ? "That student could not be found. They may belong to a different school." : state.failure.message}</Notice>
        <Link to="/students" className={buttonClass("secondary")}>Back to students</Link>
      </div>
    );
  }

  const s = state.data;
  const enrolled = s.status === "enrolled";
  const latest = latestPlacement(s.placements);
  const done = (message: string) => { setPanel(null); setFlash(message); reload(); };

  const removePlacement = async () => {
    if (!removing) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await adminApi.removePlacement(s.id, removing.id);
      setRemoving(null);
      done("The placement was removed.");
    } catch (e) {
      setRemoveError(toFailure(e).message);
    } finally {
      setRemoveBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <PageHeader
        title={fullName(s)}
        subtitle={<><Link to="/students" className="underline">Students</Link> · {s.admissionNo}</>}
        action={<StatusPill tone={enrolled ? "good" : "quiet"}>{STUDENT_STATUS_LABEL[s.status]}</StatusPill>}
      />
      {flash ? <Notice tone="success">{flash}</Notice> : null}
      {enrolled && !s.currentClass && !s.upcomingClass ? <Notice tone="warn">{s.firstName} is not in a class yet, so they will not appear on any register. Use “Move to a class”.</Notice> : null}

      <div className="flex flex-wrap gap-3">
        <Button onClick={() => { setFlash(null); setPanel(panel === "edit" ? null : "edit"); }} aria-expanded={panel === "edit"}>Edit details</Button>
        {enrolled ? <Button onClick={() => { setFlash(null); setPanel(panel === "move" ? null : "move"); }} aria-expanded={panel === "move"}>{s.currentClass ? "Move to another class" : "Move to a class"}</Button> : null}
        <Button onClick={() => { setFlash(null); setPanel(panel === "status" ? null : "status"); }} aria-expanded={panel === "status"}>{enrolled ? "Withdraw or transfer" : "Change status"}</Button>
      </div>

      {panel === "edit" ? <EditPanel student={s} onCancel={() => setPanel(null)} onSaved={() => done("Student details saved.")} /> : null}
      {panel === "move" ? <MovePanel student={s} classes={classes.options} onCancel={() => setPanel(null)} onSaved={() => done("The class change was saved.")} /> : null}
      {panel === "status" ? <StatusPanel student={s} onCancel={() => setPanel(null)} onSaved={(m) => done(m)} /> : null}

      <Section id="details" title="Details"><StudentFacts student={s} /></Section>
      <Section id="classes" title="Class history">
        <p className="text-sm text-dim">Changing class adds a dated row; earlier rows are never overwritten, so old registers keep pointing at the class they were taken for.</p>
        <PlacementList placements={s.placements} removableId={latest?.id ?? null} onRemove={(p) => { setRemoveError(null); setRemoving(p); }} />
      </Section>
      <Section id="attendance" title="Registers taken"><AttendanceByClass rows={s.attendance} /></Section>

      {removing ? (
        <ConfirmDialog
          title="Remove this class placement?" confirmLabel="Remove placement" busyLabel="Removing…" danger busy={removeBusy} error={removeError}
          onConfirm={() => void removePlacement()} onCancel={() => setRemoving(null)}
        >
          <p>This deletes the record that {s.firstName} was in {removing.className} from {removing.startsOn}. Use it only to correct a mistake.</p>
          <p>It is refused if any register was taken for {s.firstName} in that class: attendance history is never deleted.</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

function EditPanel({ student, onCancel, onSaved }: { student: StudentDetail; onCancel: () => void; onSaved: () => void }) {
  const f = useFormState<StudentFormValues>(() => studentToForm(student));
  const save = async () => {
    const req = toUpdateStudent(student, f.values);
    if (Object.keys(req).length === 0) { f.setBanner("Nothing has changed."); return; }
    if (await f.submit(validateUpdateStudent(req), async () => { await adminApi.updateStudent(student.id, req); }, STUDENT_FIELDS)) onSaved();
  };
  return (
    <div className="rounded-2xl border border-white/15 bg-white/5 p-4">
      <StudentForm mode="edit" classes={[]} values={f.values} errors={f.errors} banner={f.banner} busy={f.busy} onChange={f.change} onSubmit={() => void save()} onCancel={onCancel} submitLabel="Save changes" />
    </div>
  );
}

function MovePanel({ student, classes, onCancel, onSaved }: { student: StudentDetail; classes: readonly ClassOption[]; onCancel: () => void; onSaved: () => void }) {
  const f = useFormState<PlacementFormValues>({ classId: "", effectiveFrom: "" });
  const save = async () => {
    if (await f.submit(validatePlacement(f.values), async () => { await adminApi.placeStudent(student.id, toPlacement(f.values)); }, ["classId", "effectiveFrom"])) onSaved();
  };
  return (
    <div className="rounded-2xl border border-white/15 bg-white/5 p-4">
      <PlacementForm classes={classes} currentClassId={student.currentClass?.id ?? null} values={f.values} errors={f.errors} banner={f.banner} busy={f.busy}
        onChange={f.change} onSubmit={() => void save()} onCancel={onCancel} submitLabel="Move student" />
    </div>
  );
}

function StatusPanel({ student, onCancel, onSaved }: { student: StudentDetail; onCancel: () => void; onSaved: (message: string) => void }) {
  const f = useFormState<StatusFormValues>({ status: "", effectiveFrom: "" });
  const [pending, setPending] = useState<ChangeStudentStatusRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const message = (status: StudentStatus) => `${student.firstName} is now marked ${STUDENT_STATUS_LABEL[status].toLowerCase()}.`;

  const review = async () => {
    const check = validateStatusChange(f.values);
    if (!check.ok) { await f.submit(check, async () => {}, ["status", "effectiveFrom"]); return; }
    const req = toStatusChange(f.values);
    // Coming back to the school changes nothing about registers, so it needs no warning. Leaving does.
    if (req.status === "enrolled") {
      if (await f.submit(check, async () => { await adminApi.changeStudentStatus(student.id, req); }, ["status", "effectiveFrom"])) onSaved(message(req.status));
      return;
    }
    setError(null);
    setPending(req);
  };

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi.changeStudentStatus(student.id, pending);
      setPending(null);
      onSaved(message(pending.status));
    } catch (e) {
      const failure = toFailure(e);
      setError(failure.message);
      // a refusal about the date belongs back on the form, where it can be fixed
      if (failure.field === "effectiveFrom" || failure.field === "status") { f.setErrors({ [failure.field]: failure.message }); setPending(null); }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-white/15 bg-white/5 p-4">
      <StatusForm currentStatus={student.status} values={f.values} errors={f.errors} banner={f.banner} busy={f.busy} onChange={f.change} onSubmit={() => void review()} onCancel={onCancel} submitLabel="Continue" />
      {pending ? (
        <ConfirmDialog
          title={`Mark ${student.firstName} as ${STUDENT_STATUS_LABEL[pending.status].toLowerCase()}?`} confirmLabel="Yes, change status" busyLabel="Saving…" danger busy={busy} error={error}
          onConfirm={() => void confirm()} onCancel={() => { setPending(null); setError(null); }}
        >
          <p>{student.firstName} will leave {student.currentClass ? student.currentClass.name : "the school"} {pending.effectiveFrom ? `from ${pending.effectiveFrom}` : "from tomorrow"} and will not appear on registers from then on.</p>
          <p>Registers already taken are kept. You can bring them back later by changing the status to Enrolled.</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
