/**
 * The school-administration forms. Each is a controlled, presentational component: the screen owns the values, the
 * errors and the request; the form only shows them. Every field's problem is shown next to the field, and the
 * banner at the top carries anything that is about the whole form.
 */
import { GENDERS, STUDENT_STATUSES } from "@schoolpulse/domain";
import {
  COMMON_TIME_ZONES, GENDER_LABEL, STUDENT_STATUS_LABEL, classLabel,
  type ClassFormValues, type FieldErrors, type PlacementFormValues, type ProfileFormValues, type StatusFormValues, type StudentFormValues,
  type TermFormValues, type YearFormValues,
} from "../lib/admin-forms.ts";
import { CheckField, FormActions, FormFrame, SelectField, TextField } from "./ui.tsx";

interface FormProps<V> {
  values: V;
  errors: FieldErrors;
  banner?: string | null | undefined;
  busy: boolean;
  onChange: (patch: Partial<V>) => void;
  onSubmit: () => void;
  onCancel?: (() => void) | undefined;
  submitLabel: string;
}

export interface ClassOption { id: string; name: string; academicYear: { name: string } | null }
export interface YearOption { id: string; name: string }

const classOptions = (classes: readonly ClassOption[]) => classes.map((c) => ({ value: c.id, label: classLabel(c) }));

// ---------- students ----------

/** `mode="create"` also offers to put the student in a class; changing class later is its own action (history is kept). */
export function StudentForm(props: FormProps<StudentFormValues> & { mode: "create" | "edit"; classes: readonly ClassOption[] }) {
  const { values: v, errors: e, onChange } = props;
  return (
    <FormFrame label={props.mode === "create" ? "Register a student" : "Edit student details"} onSubmit={props.onSubmit} banner={props.banner}>
      <TextField label="Admission number" required value={v.admissionNo} onChange={(admissionNo) => onChange({ admissionNo })} error={e.admissionNo}
        hint="Unique in this school. Letters, numbers and - _ . / only." maxLength={30} autoComplete="off" />
      <TextField label="First name" required value={v.firstName} onChange={(firstName) => onChange({ firstName })} error={e.firstName} maxLength={100} autoComplete="off" />
      <TextField label="Last name" required value={v.lastName} onChange={(lastName) => onChange({ lastName })} error={e.lastName} maxLength={100} autoComplete="off" />
      <TextField label="Other names" value={v.otherNames} onChange={(otherNames) => onChange({ otherNames })} error={e.otherNames} maxLength={100} autoComplete="off" />
      <TextField label="Date of birth" type="date" value={v.dateOfBirth} onChange={(dateOfBirth) => onChange({ dateOfBirth })} error={e.dateOfBirth} hint="Optional." />
      <SelectField label="Gender" value={v.gender} onChange={(gender) => onChange({ gender: gender as StudentFormValues["gender"] })} error={e.gender}
        placeholder="Not recorded" options={GENDERS.map((g) => ({ value: g, label: GENDER_LABEL[g] }))} hint="Optional." />
      <TextField label="Enrolment date" type="date" value={v.enrolmentDate} onChange={(enrolmentDate) => onChange({ enrolmentDate })} error={e.enrolmentDate}
        hint={props.mode === "create" ? "The day they joined the school. Leave blank for today." : "Cannot be moved after the student's first class placement."} />
      {props.mode === "create" ? (
        <fieldset className="space-y-4 rounded-xl border border-white/10 p-4">
          <legend className="px-1 text-sm font-semibold">Class (optional)</legend>
          <SelectField label="Put in class" value={v.classId} onChange={(classId) => onChange({ classId })} error={e.classId} placeholder="Not in a class yet" options={classOptions(props.classes)}
            hint="You can also do this later from the student's page." />
          {v.classId ? (
            <TextField label="First day in the class" type="date" value={v.classStartsOn} onChange={(classStartsOn) => onChange({ classStartsOn })} error={e.classStartsOn} hint="Leave blank to start today." />
          ) : null}
        </fieldset>
      ) : null}
      <FormActions busy={props.busy} submitLabel={props.submitLabel} onCancel={props.onCancel} />
    </FormFrame>
  );
}

export function PlacementForm(props: FormProps<PlacementFormValues> & { classes: readonly ClassOption[]; currentClassId: string | null }) {
  const { values: v, errors: e, onChange } = props;
  return (
    <FormFrame label="Move to another class" onSubmit={props.onSubmit} banner={props.banner}>
      <SelectField label="New class" required value={v.classId} onChange={(classId) => onChange({ classId })} error={e.classId} placeholder="Choose a class"
        options={classOptions(props.classes.filter((c) => c.id !== props.currentClassId))} />
      <TextField label="First day in the new class" type="date" value={v.effectiveFrom} onChange={(effectiveFrom) => onChange({ effectiveFrom })} error={e.effectiveFrom}
        hint="Leave blank for tomorrow. A move cannot start in the past, so registers already taken stay as they are." />
      <FormActions busy={props.busy} submitLabel={props.submitLabel} busyLabel="Moving…" onCancel={props.onCancel} />
    </FormFrame>
  );
}

export function StatusForm(props: FormProps<StatusFormValues> & { currentStatus: string }) {
  const { values: v, errors: e, onChange } = props;
  return (
    <FormFrame label="Change enrolment status" onSubmit={props.onSubmit} banner={props.banner}>
      <SelectField label="New status" required value={v.status} onChange={(status) => onChange({ status: status as StatusFormValues["status"] })} error={e.status} placeholder="Choose a status"
        options={STUDENT_STATUSES.filter((s) => s !== props.currentStatus).map((s) => ({ value: s, label: STUDENT_STATUS_LABEL[s] }))} />
      <TextField label="Effective from" type="date" value={v.effectiveFrom} onChange={(effectiveFrom) => onChange({ effectiveFrom })} error={e.effectiveFrom}
        hint="Only used when a student leaves: leave blank for tomorrow. Registers taken before that date stay in their history." />
      <FormActions busy={props.busy} submitLabel={props.submitLabel} busyLabel="Saving…" onCancel={props.onCancel} />
    </FormFrame>
  );
}

// ---------- classes ----------

export function ClassForm(props: FormProps<ClassFormValues> & { mode: "create" | "edit"; years: readonly YearOption[]; yearLocked?: boolean }) {
  const { values: v, errors: e, onChange } = props;
  return (
    <FormFrame label={props.mode === "create" ? "Create a class" : "Edit class details"} onSubmit={props.onSubmit} banner={props.banner}>
      <TextField label="Class name" required value={v.name} onChange={(name) => onChange({ name })} error={e.name} maxLength={100} hint="For example Grade 7A. Unique within the academic year." />
      <TextField label="Grade" required value={v.gradeLevel} onChange={(gradeLevel) => onChange({ gradeLevel })} error={e.gradeLevel} maxLength={20} hint="For example 7 or Form 1." />
      <TextField label="Stream" value={v.stream} onChange={(stream) => onChange({ stream })} error={e.stream} maxLength={30} hint="Optional: A, B, Blue… Two classes cannot share a grade and stream in one year." />
      <SelectField label="Academic year" required value={v.academicYearId} onChange={(academicYearId) => onChange({ academicYearId })} error={e.academicYearId}
        placeholder="Choose a year" disabled={props.yearLocked}
        hint={props.yearLocked ? "Fixed once a class has students or registers. Create a new class for another year." : undefined}
        options={props.years.map((y) => ({ value: y.id, label: y.name }))} />
      <FormActions busy={props.busy} submitLabel={props.submitLabel} onCancel={props.onCancel} />
    </FormFrame>
  );
}

// ---------- school ----------

export function ProfileForm(props: FormProps<ProfileFormValues>) {
  const { values: v, errors: e, onChange } = props;
  return (
    <FormFrame label="School profile" onSubmit={props.onSubmit} banner={props.banner}>
      <TextField label="School name" required value={v.name} onChange={(name) => onChange({ name })} error={e.name} maxLength={200} />
      <TextField label="School code" value={v.code} onChange={(code) => onChange({ code })} error={e.code} maxLength={32} hint="Optional short code, unique across SchoolPulse. Letters, numbers, - and _." />
      <TextField label="Time zone" required value={v.timezone} onChange={(timezone) => onChange({ timezone })} error={e.timezone} list="school-time-zones"
        hint="Decides what 'today' means for registers. Change it only if it is wrong." />
      <datalist id="school-time-zones">{COMMON_TIME_ZONES.map((z) => <option key={z} value={z} />)}</datalist>
      <TextField label="Contact email" type="email" inputMode="email" value={v.contactEmail} onChange={(contactEmail) => onChange({ contactEmail })} error={e.contactEmail} maxLength={254} autoComplete="email" />
      <TextField label="Contact phone" type="tel" inputMode="tel" value={v.contactPhone} onChange={(contactPhone) => onChange({ contactPhone })} error={e.contactPhone} maxLength={40} autoComplete="tel" />
      <TextField label="Address" value={v.address} onChange={(address) => onChange({ address })} error={e.address} maxLength={300} autoComplete="street-address" />
      <FormActions busy={props.busy} submitLabel={props.submitLabel} onCancel={props.onCancel} />
    </FormFrame>
  );
}

export function YearForm(props: FormProps<YearFormValues> & { mode: "create" | "edit" }) {
  const { values: v, errors: e, onChange } = props;
  return (
    <FormFrame label={props.mode === "create" ? "Add an academic year" : "Edit academic year"} onSubmit={props.onSubmit} banner={props.banner}>
      <TextField label="Name" required value={v.name} onChange={(name) => onChange({ name })} error={e.name} maxLength={50} hint="For example 2027." />
      <TextField label="First day" required type="date" value={v.startsOn} onChange={(startsOn) => onChange({ startsOn })} error={e.startsOn} />
      <TextField label="Last day" required type="date" value={v.endsOn} onChange={(endsOn) => onChange({ endsOn })} error={e.endsOn} hint="Years cannot overlap." />
      <CheckField label="Make this the current academic year" hint="Only one year is current. This replaces the current one." checked={v.isActive} onChange={(isActive) => onChange({ isActive })} />
      <FormActions busy={props.busy} submitLabel={props.submitLabel} onCancel={props.onCancel} />
    </FormFrame>
  );
}

export function TermForm(props: FormProps<TermFormValues> & { mode: "create" | "edit" }) {
  const { values: v, errors: e, onChange } = props;
  return (
    <FormFrame label={props.mode === "create" ? "Add a term" : "Edit term"} onSubmit={props.onSubmit} banner={props.banner}>
      <TextField label="Name" required value={v.name} onChange={(name) => onChange({ name })} error={e.name} maxLength={50} hint="For example Term 1." />
      <TextField label="First day" required type="date" value={v.startsOn} onChange={(startsOn) => onChange({ startsOn })} error={e.startsOn} />
      <TextField label="Last day" required type="date" value={v.endsOn} onChange={(endsOn) => onChange({ endsOn })} error={e.endsOn} hint="Must fall inside the academic year. Terms cannot overlap." />
      <FormActions busy={props.busy} submitLabel={props.submitLabel} onCancel={props.onCancel} />
    </FormFrame>
  );
}
