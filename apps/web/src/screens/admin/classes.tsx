import { useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import type { ClassDetail, TeacherRef } from "@schoolpulse/contracts";
import { ClassForm } from "../../components/admin-forms.tsx";
import { ClassRows, RosterList, TeacherPanel } from "../../components/admin-views.tsx";
import { Button, ConfirmDialog, Loading, Notice, PageHeader, Pager, SelectField, Section, StatusPill, TextField, buttonClass } from "../../components/ui.tsx";
import { adminApi } from "../../lib/admin-api.ts";
import {
  CLASS_FIELDS, CLASS_STATUS_LABEL, classToForm, emptyClassForm, pageWindow, toCreateClass, toFailure, toUpdateClass, validateCreateClass, validateUpdateClass,
  type ClassFormValues,
} from "../../lib/admin-forms.ts";
import { plural } from "../../lib/format.ts";
import { useFormState } from "../../lib/use-form-state.ts";
import { useRequest } from "../../lib/use-request.ts";

const PAGE_SIZE = 25;

export function ClassList() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "active";
  const academicYearId = params.get("academicYearId") ?? "";
  const offset = Math.max(0, Number.parseInt(params.get("offset") ?? "0", 10) || 0);
  const [draft, setDraft] = useState(q);
  const years = useRequest(() => adminApi.academicYears(), []);

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
    () => adminApi.classes({ q: q || undefined, status: status === "all" ? undefined : (status as "active" | "archived"), academicYearId: academicYearId || undefined, limit: PAGE_SIZE, offset }),
    [q, status, academicYearId, offset],
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Classes" subtitle="The groups registers are taken for." action={<Link to="/classes/new" className={buttonClass("primary")}>Create a class</Link>} />
      <form role="search" aria-label="Find classes" onSubmit={(e) => { e.preventDefault(); setParam({ q: draft.trim() || undefined }); }} className="space-y-3">
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <TextField label="Search by class name" value={draft} onChange={setDraft} maxLength={100} />
          </div>
          <button type="submit" className={`${buttonClass("primary")} self-end`}>Search</button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField label="Status" value={status} onChange={(v) => setParam({ status: v === "active" ? undefined : v })}
            options={[{ value: "active", label: "Active" }, { value: "archived", label: "Archived" }, { value: "all", label: "All" }]} />
          <SelectField label="Academic year" value={academicYearId} onChange={(v) => setParam({ academicYearId: v || undefined })} placeholder="Any year"
            options={years.state.status === "ready" ? years.state.data.items.map((y) => ({ value: y.id, label: y.name })) : []} />
        </div>
      </form>
      {state.status === "loading" ? <Loading what="classes" /> : null}
      {state.status === "failed" ? (
        <div className="space-y-3"><Notice tone="error">{state.failure.message}</Notice><Button onClick={reload}>Try again</Button></div>
      ) : null}
      {state.status === "ready" ? (
        <>
          <ClassRows items={state.data.items} />
          {(() => {
            const w = pageWindow(state.data);
            return <Pager from={w.from} to={w.to} total={state.data.total} hasPrev={w.hasPrev} hasNext={w.hasNext} noun="classes"
              onPrev={() => setParam({ offset: w.prevOffset > 0 ? String(w.prevOffset) : undefined })} onNext={() => setParam({ offset: String(w.nextOffset) })} />;
          })()}
        </>
      ) : null}
    </div>
  );
}

export function ClassCreate() {
  const years = useRequest(() => adminApi.academicYears(), []);
  if (years.state.status === "loading") return <Loading what="academic years" />;
  if (years.state.status === "failed") return <Notice tone="error">{years.state.failure.message}</Notice>;
  const yearList = years.state.data.items;
  if (yearList.length === 0) {
    return (
      <div className="space-y-4">
        <PageHeader title="Create a class" />
        <Notice tone="warn">Every class belongs to an academic year, and this school has none yet.</Notice>
        <Link to="/school" className={buttonClass("primary")}>Add an academic year</Link>
      </div>
    );
  }
  return <CreateClassForm years={yearList} />;
}

function CreateClassForm({ years }: { years: readonly { id: string; name: string; isActive: boolean }[] }) {
  const navigate = useNavigate();
  // The current academic year is pre-selected: most classes are created for it.
  const f = useFormState<ClassFormValues>(() => emptyClassForm(years.find((y) => y.isActive)?.id ?? ""));
  const save = async () => {
    let createdId = "";
    const ok = await f.submit(validateCreateClass(f.values), async () => { createdId = (await adminApi.createClass(toCreateClass(f.values))).id; }, CLASS_FIELDS);
    if (ok) navigate(`/classes/${createdId}`, { state: { flash: "Class created." } });
  };
  return (
    <div className="space-y-6">
      <PageHeader title="Create a class" subtitle={<Link to="/classes" className="underline">Back to classes</Link>} />
      <ClassForm mode="create" years={years} values={f.values} errors={f.errors} banner={f.banner} busy={f.busy} onChange={f.change} onSubmit={() => void save()} onCancel={() => navigate("/classes")} submitLabel="Create class" />
    </div>
  );
}

export function ClassDetailScreen() {
  const { id } = useParams();
  const location = useLocation();
  const [editing, setEditing] = useState(false);
  const [flash, setFlash] = useState<string | null>((location.state as { flash?: string } | null)?.flash ?? null);
  const [rosterDate, setRosterDate] = useState("");
  const [selected, setSelected] = useState("");
  const [teacherBusy, setTeacherBusy] = useState(false);
  const [teacherError, setTeacherError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<TeacherRef | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const { state, reload } = useRequest(async () => {
    const [cls, years, teachers] = await Promise.all([adminApi.class(id ?? ""), adminApi.academicYears(), adminApi.teachers()]);
    return { cls, years: years.items, teachers: teachers.items };
  }, [id]);
  const roster = useRequest(() => adminApi.roster(id ?? "", rosterDate || undefined), [id, rosterDate]);

  if (!id) return <Notice tone="error">That class could not be found.</Notice>;
  if (state.status === "loading") return <Loading what="the class" />;
  if (state.status === "failed") {
    return (
      <div className="space-y-3">
        <Notice tone="error">{state.failure.code === "not_found" ? "That class could not be found. It may belong to a different school." : state.failure.message}</Notice>
        <Link to="/classes" className={buttonClass("secondary")}>Back to classes</Link>
      </div>
    );
  }
  const { cls, years, teachers } = state.data;
  const archived = cls.status === "archived";
  const assignedIds = new Set(cls.teachers.map((t) => t.id));
  const available = teachers.filter((t) => !assignedIds.has(t.id));

  const refreshed = (message: string) => { setFlash(message); setEditing(false); reload(); roster.reload(); };

  const assign = async () => {
    if (!selected) return;
    setTeacherBusy(true);
    setTeacherError(null);
    try {
      await adminApi.assignTeacher(cls.id, selected);
      setSelected("");
      refreshed("Teacher assigned. They will see this class the next time their phone syncs.");
    } catch (e) {
      setTeacherError(toFailure(e).message);
    } finally {
      setTeacherBusy(false);
    }
  };

  const confirmRemoval = async () => {
    if (!removing) return;
    setDialogBusy(true);
    setDialogError(null);
    try {
      await adminApi.removeTeacher(cls.id, removing.id);
      const name = removing.name;
      setRemoving(null);
      refreshed(`${name} was removed from ${cls.name}.`);
    } catch (e) {
      setDialogError(toFailure(e).message);
    } finally {
      setDialogBusy(false);
    }
  };

  const setStatus = async (status: "active" | "archived") => {
    setDialogBusy(true);
    setDialogError(null);
    try {
      await adminApi.updateClass(cls.id, { status });
      setArchiving(false);
      refreshed(status === "archived" ? `${cls.name} was archived.` : `${cls.name} is active again.`);
    } catch (e) {
      setDialogError(toFailure(e).message);
    } finally {
      setDialogBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <PageHeader
        title={cls.name}
        subtitle={<><Link to="/classes" className="underline">Classes</Link> · Grade {cls.gradeLevel}{cls.stream ? ` · Stream ${cls.stream}` : ""} · {cls.academicYear?.name ?? "No academic year yet"}</>}
        action={<StatusPill tone={archived ? "quiet" : "good"}>{CLASS_STATUS_LABEL[cls.status]}</StatusPill>}
      />
      {flash ? <Notice tone="success">{flash}</Notice> : null}
      {!cls.academicYear ? <Notice tone="warn">This class was created before academic years existed. Edit it to choose its year.</Notice> : null}
      {!archived && cls.teacherCount === 0 ? <Notice tone="warn">No teacher is assigned, so nobody can take this class's register yet.</Notice> : null}

      <div className="flex flex-wrap gap-3">
        <Button onClick={() => { setFlash(null); setEditing(!editing); }} aria-expanded={editing}>Edit details</Button>
        {archived ? (
          <Button busy={dialogBusy} busyLabel="Saving…" onClick={() => void setStatus("active")}>Reactivate class</Button>
        ) : (
          <Button onClick={() => { setDialogError(null); setArchiving(true); }}>Archive class</Button>
        )}
      </div>

      {editing ? <EditClass cls={cls} years={years} onCancel={() => setEditing(false)} onSaved={() => refreshed("Class details saved.")} /> : null}

      <Section id="teachers" title="Teachers">
        <p className="text-sm text-dim">Teachers assigned here can take this class's register on their phones.</p>
        {teacherError ? <Notice tone="error">{teacherError}</Notice> : null}
        <TeacherPanel
          assigned={cls.teachers} available={available} selected={selected} onSelect={setSelected} onAssign={() => void assign()}
          onRemove={(t) => { setDialogError(null); setRemoving(t); }} busy={teacherBusy}
          blockedReason={archived ? "This class is archived. Reactivate it before assigning teachers." : null}
        />
      </Section>

      <Section id="students" title={`Students (${plural(cls.studentCount, "student")} today)`}>
        <div className="max-w-xs"><TextField label="Show the class on" type="date" value={rosterDate} onChange={setRosterDate} hint="Leave blank for today." /></div>
        {roster.state.status === "loading" ? <Loading what="the class list" /> : null}
        {roster.state.status === "failed" ? <Notice tone="error">{roster.state.failure.message}</Notice> : null}
        {roster.state.status === "ready" ? <RosterList roster={roster.state.data} /> : null}
        <p className="text-sm text-dim">To change who is in a class, open the student and use “Move to another class”.</p>
      </Section>

      {removing ? (
        <ConfirmDialog title={`Remove ${removing.name} from ${cls.name}?`} confirmLabel="Remove teacher" busyLabel="Removing…" danger busy={dialogBusy} error={dialogError}
          onConfirm={() => void confirmRemoval()} onCancel={() => setRemoving(null)}>
          <p>{removing.name} will no longer see {cls.name} on their phone or be able to take its register. Their phone updates the next time it syncs.</p>
          <p>Registers they already took stay as they are.</p>
        </ConfirmDialog>
      ) : null}
      {archiving ? (
        <ConfirmDialog title={`Archive ${cls.name}?`} confirmLabel="Archive class" busyLabel="Archiving…" danger busy={dialogBusy} error={dialogError}
          onConfirm={() => void setStatus("archived")} onCancel={() => setArchiving(false)}>
          <p>An archived class disappears from teachers' registers and cannot take new students or teachers. Its history is kept, and you can reactivate it later.</p>
          <p>A class that still has students cannot be archived: move them to another class first.</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

function EditClass({ cls, years, onCancel, onSaved }: { cls: ClassDetail; years: readonly { id: string; name: string }[]; onCancel: () => void; onSaved: () => void }) {
  const f = useFormState<ClassFormValues>(() => classToForm(cls));
  const save = async () => {
    const req = toUpdateClass(cls, f.values);
    if (Object.keys(req).length === 0) { f.setBanner("Nothing has changed."); return; }
    if (await f.submit(validateUpdateClass(req), async () => { await adminApi.updateClass(cls.id, req); }, CLASS_FIELDS)) onSaved();
  };
  return (
    <div className="rounded-2xl border border-white/15 bg-white/5 p-4">
      <ClassForm mode="edit" years={years} yearLocked={Boolean(cls.academicYear) && cls.studentCount > 0} values={f.values} errors={f.errors} banner={f.banner} busy={f.busy}
        onChange={f.change} onSubmit={() => void save()} onCancel={onCancel} submitLabel="Save changes" />
    </div>
  );
}
