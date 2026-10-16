import { useState } from "react";
import type { AcademicYearDto, SchoolProfile, TermDto } from "@schoolpulse/contracts";
import { ProfileFacts, YearCard } from "../../components/admin-views.tsx";
import { ProfileForm, TermForm, YearForm } from "../../components/admin-forms.tsx";
import { Button, ConfirmDialog, EmptyState, Loading, Notice, PageHeader, Section } from "../../components/ui.tsx";
import { adminApi } from "../../lib/admin-api.ts";
import {
  PROFILE_FIELDS, TERM_FIELDS, YEAR_FIELDS, emptyTermForm, emptyYearForm, profileToForm, termToForm, toCreateTerm, toCreateYear, toFailure,
  toUpdateProfile, toUpdateTerm, toUpdateYear, validateCreateTerm, validateCreateYear, validateUpdateProfile, validateUpdateTerm, validateUpdateYear, yearToForm,
  type ProfileFormValues, type TermFormValues, type YearFormValues,
} from "../../lib/admin-forms.ts";
import { useFormState } from "../../lib/use-form-state.ts";
import { useRequest } from "../../lib/use-request.ts";

type Panel =
  | { kind: "profile" }
  | { kind: "year-new" }
  | { kind: "year-edit"; year: AcademicYearDto }
  | { kind: "term-new"; year: AcademicYearDto }
  | { kind: "term-edit"; year: AcademicYearDto; term: TermDto };

type Confirm =
  | { kind: "delete-year"; year: AcademicYearDto }
  | { kind: "delete-term"; year: AcademicYearDto; term: TermDto }
  | { kind: "make-current"; year: AcademicYearDto };

/** The head's school settings: the profile, the academic years, and the terms inside each year. */
export function SchoolSettings() {
  const { state, reload } = useRequest(async () => {
    const [school, years] = await Promise.all([adminApi.school(), adminApi.academicYears()]);
    return { school, years: years.items };
  }, []);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  if (state.status === "loading") return <Loading what="school settings" />;
  if (state.status === "failed") return <Notice tone="error">{state.failure.message}</Notice>;
  const { school, years } = state.data;

  const done = (message: string) => {
    setPanel(null);
    setConfirm(null);
    setFlash(message);
    reload();
  };

  const runConfirm = async () => {
    if (!confirm) return;
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      if (confirm.kind === "delete-year") {
        await adminApi.deleteYear(confirm.year.id);
        done(`${confirm.year.name} was deleted.`);
      } else if (confirm.kind === "delete-term") {
        await adminApi.deleteTerm(confirm.term.id);
        done(`${confirm.term.name} was deleted from ${confirm.year.name}.`);
      } else {
        await adminApi.updateYear(confirm.year.id, { isActive: true });
        done(`${confirm.year.name} is now the current academic year.`);
      }
    } catch (e) {
      setConfirmError(toFailure(e).message);
    } finally {
      setConfirmBusy(false);
    }
  };

  const confirmView = confirm ? (
    <ConfirmDialog
      title={confirm.kind === "delete-year" ? `Delete ${confirm.year.name}?` : confirm.kind === "delete-term" ? `Delete ${confirm.term.name}?` : `Make ${confirm.year.name} the current year?`}
      confirmLabel={confirm.kind === "make-current" ? "Make current" : "Delete"}
      busyLabel={confirm.kind === "make-current" ? "Saving…" : "Deleting…"}
      danger={confirm.kind !== "make-current"}
      busy={confirmBusy}
      error={confirmError}
      onConfirm={() => void runConfirm()}
      onCancel={() => { setConfirm(null); setConfirmError(null); }}
    >
      {confirm.kind === "delete-year" ? (
        <>
          <p>This removes the academic year and its terms. It cannot be undone.</p>
          <p>A year that has classes cannot be deleted: archive or move those classes first.</p>
        </>
      ) : confirm.kind === "delete-term" ? (
        <p>This removes the term from {confirm.year.name}. It cannot be undone.</p>
      ) : (
        <p>Only one year is current. {years.find((y) => y.isActive)?.name ?? "The present year"} will stop being the current year. Nothing else changes.</p>
      )}
    </ConfirmDialog>
  ) : null;

  return (
    <div className="space-y-8">
      <PageHeader title="School" subtitle="Your school's profile and academic calendar." />
      {flash ? <Notice tone="success">{flash}</Notice> : null}

      <Section id="profile" title="Profile" action={panel?.kind === "profile" ? null : <Button onClick={() => { setFlash(null); setPanel({ kind: "profile" }); }}>Edit</Button>}>
        {panel?.kind === "profile" ? (
          <ProfilePanel school={school} onCancel={() => setPanel(null)} onSaved={() => done("School profile saved.")} />
        ) : (
          <ProfileFacts rows={[
            ["Name", school.name],
            ["School code", school.code ?? "Not set"],
            ["Time zone", school.timezone],
            ["Email", school.contactEmail ?? "Not set"],
            ["Phone", school.contactPhone ?? "Not set"],
            ["Address", school.address ?? "Not set"],
            ["Current academic year", school.activeAcademicYear?.name ?? "None set"],
          ]} />
        )}
      </Section>

      <Section id="years" title="Academic years" action={panel?.kind === "year-new" ? null : <Button variant="primary" onClick={() => { setFlash(null); setPanel({ kind: "year-new" }); }}>Add a year</Button>}>
        {panel?.kind === "year-new" ? <YearPanel mode="create" onCancel={() => setPanel(null)} onSaved={() => done("Academic year added.")} /> : null}
        {panel?.kind === "year-edit" ? <YearPanel mode="edit" year={panel.year} onCancel={() => setPanel(null)} onSaved={() => done("Academic year saved.")} /> : null}
        {panel?.kind === "term-new" ? <TermPanel mode="create" year={panel.year} onCancel={() => setPanel(null)} onSaved={() => done("Term added.")} /> : null}
        {panel?.kind === "term-edit" ? <TermPanel mode="edit" year={panel.year} term={panel.term} onCancel={() => setPanel(null)} onSaved={() => done("Term saved.")} /> : null}

        {years.length === 0 ? (
          <EmptyState title="No academic years yet">Add the current year first. Classes belong to an academic year.</EmptyState>
        ) : (
          <ul className="space-y-4">
            {years.map((y) => (
              <YearCard
                key={y.id} year={y}
                onEdit={() => { setFlash(null); setPanel({ kind: "year-edit", year: y }); }}
                onDelete={() => { setFlash(null); setConfirm({ kind: "delete-year", year: y }); }}
                onMakeCurrent={() => { setFlash(null); setConfirm({ kind: "make-current", year: y }); }}
                onAddTerm={() => { setFlash(null); setPanel({ kind: "term-new", year: y }); }}
                onEditTerm={(term) => { setFlash(null); setPanel({ kind: "term-edit", year: y, term }); }}
                onDeleteTerm={(term) => { setFlash(null); setConfirm({ kind: "delete-term", year: y, term }); }}
              />
            ))}
          </ul>
        )}
      </Section>
      {confirmView}
    </div>
  );
}

function ProfilePanel({ school, onCancel, onSaved }: { school: SchoolProfile; onCancel: () => void; onSaved: () => void }) {
  const f = useFormState<ProfileFormValues>(() => profileToForm(school));
  const save = async () => {
    const req = toUpdateProfile(school, f.values);
    if (Object.keys(req).length === 0) { f.setBanner("Nothing has changed."); return; }
    if (await f.submit(validateUpdateProfile(req), async () => { await adminApi.updateSchool(req); }, PROFILE_FIELDS)) onSaved();
  };
  return <ProfileForm values={f.values} errors={f.errors} banner={f.banner} busy={f.busy} onChange={f.change} onSubmit={() => void save()} onCancel={onCancel} submitLabel="Save profile" />;
}

function YearPanel(props: ({ mode: "create" } | { mode: "edit"; year: AcademicYearDto }) & { onCancel: () => void; onSaved: () => void }) {
  const f = useFormState<YearFormValues>(() => (props.mode === "edit" ? yearToForm(props.year) : emptyYearForm()));
  const save = async () => {
    if (props.mode === "create") {
      if (await f.submit(validateCreateYear(f.values), async () => { await adminApi.createYear(toCreateYear(f.values)); }, YEAR_FIELDS)) props.onSaved();
      return;
    }
    const req = toUpdateYear(props.year, f.values);
    if (Object.keys(req).length === 0) { f.setBanner("Nothing has changed."); return; }
    if (await f.submit(validateUpdateYear(req), async () => { await adminApi.updateYear(props.year.id, req); }, YEAR_FIELDS)) props.onSaved();
  };
  return (
    <div className="rounded-2xl border border-white/15 bg-white/5 p-4">
      <YearForm mode={props.mode} values={f.values} errors={f.errors} banner={f.banner} busy={f.busy} onChange={f.change} onSubmit={() => void save()} onCancel={props.onCancel} submitLabel={props.mode === "create" ? "Add year" : "Save year"} />
    </div>
  );
}

function TermPanel(props: ({ mode: "create" } | { mode: "edit"; term: TermDto }) & { year: AcademicYearDto; onCancel: () => void; onSaved: () => void }) {
  const f = useFormState<TermFormValues>(() => (props.mode === "edit" ? termToForm(props.term) : emptyTermForm()));
  const save = async () => {
    if (props.mode === "create") {
      if (await f.submit(validateCreateTerm(f.values), async () => { await adminApi.createTerm(props.year.id, toCreateTerm(f.values)); }, TERM_FIELDS)) props.onSaved();
      return;
    }
    const req = toUpdateTerm(props.term, f.values);
    if (Object.keys(req).length === 0) { f.setBanner("Nothing has changed."); return; }
    if (await f.submit(validateUpdateTerm(req), async () => { await adminApi.updateTerm(props.term.id, req); }, TERM_FIELDS)) props.onSaved();
  };
  return (
    <div className="rounded-2xl border border-white/15 bg-white/5 p-4">
      <p className="mb-3 text-sm text-dim">{props.mode === "create" ? "New term in" : "Editing a term in"} {props.year.name} ({props.year.startsOn} to {props.year.endsOn})</p>
      <TermForm mode={props.mode} values={f.values} errors={f.errors} banner={f.banner} busy={f.busy} onChange={f.change} onSubmit={() => void save()} onCancel={props.onCancel} submitLabel={props.mode === "create" ? "Add term" : "Save term"} />
    </div>
  );
}
