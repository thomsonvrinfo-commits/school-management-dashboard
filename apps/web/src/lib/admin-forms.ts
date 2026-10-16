/**
 * Pure helpers for the school-administration screens: form values <-> API requests, validation with the SAME schemas
 * the server uses (so a mistake is caught on the phone before it costs a round trip), and plain-language errors.
 *
 * Nothing here touches React, the network or the browser, so it runs under `node --test` (see apps/web/test).
 * Keep it that way: it must not import ./api.ts (which reads `import.meta.env`).
 */
import type { z } from "zod";
import {
  changeStudentStatusRequest, createAcademicYearRequest, createClassRequest, createStudentRequest, createTermRequest, placeStudentRequest,
  updateAcademicYearRequest, updateClassRequest, updateSchoolRequest, updateStudentRequest, updateTermRequest,
} from "@schoolpulse/contracts";
import type {
  AcademicYearDto, ChangeStudentStatusRequest, ClassDetail, CreateAcademicYearRequest, CreateClassRequest, CreateStudentRequest, CreateTermRequest,
  PlaceStudentRequest, PlacementDto, SchoolProfile, StudentDetail, TermDto, UpdateAcademicYearRequest, UpdateClassRequest, UpdateSchoolRequest,
  UpdateStudentRequest, UpdateTermRequest,
} from "@schoolpulse/contracts";
import type { ClassStatus, Gender, StudentStatus } from "@schoolpulse/domain";

// ---------- small shared helpers ----------

/** Builds "?a=1&b=2" from the filters that are actually set. */
export function queryString(params: object): string {
  const entries = Object.entries(params as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (entries.length === 0) return "";
  return `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)] as [string, string])).toString()}`;
}

export const fullName = (s: { firstName: string; lastName: string }): string => `${s.firstName} ${s.lastName}`;

export function dateLabel(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export const STUDENT_STATUS_LABEL: Record<StudentStatus, string> = {
  enrolled: "Enrolled",
  withdrawn: "Withdrawn",
  transferred: "Transferred out",
  graduated: "Graduated",
};
export const CLASS_STATUS_LABEL: Record<ClassStatus, string> = { active: "Active", archived: "Archived" };
export const GENDER_LABEL: Record<Gender, string> = { female: "Female", male: "Male" };

/** Zones offered as suggestions; any valid IANA zone is accepted by the server. */
export const COMMON_TIME_ZONES = ["Africa/Harare", "Africa/Johannesburg", "Africa/Lusaka", "Africa/Maputo", "Africa/Gaborone", "Africa/Nairobi", "Africa/Lagos", "UTC"];

// ---------- errors people can act on ----------

export interface Failure {
  message: string;
  /** The request field the server says the problem is about. */
  field?: string;
  code?: string;
  /** No answer from the server: we cannot tell whether a change was saved. */
  unreachable?: boolean;
}

/** Slice 1's `api.ts` throws NetworkFailure (no answer) or ApiFailure (the server said no); they are recognised by name. */
export function toFailure(e: unknown): Failure {
  const err = e as { name?: unknown; message?: unknown; code?: unknown; field?: unknown } | null;
  if (err?.name === "NetworkFailure") {
    return { message: "The server could not be reached, so we cannot tell whether that was saved. Check the list before trying again.", unreachable: true };
  }
  if (err?.name === "ApiFailure") {
    return {
      message: typeof err.message === "string" ? err.message : "The request was refused.",
      ...(typeof err.code === "string" ? { code: err.code } : {}),
      ...(typeof err.field === "string" ? { field: err.field } : {}),
    };
  }
  return { message: "Something went wrong. Nothing was changed." };
}

// ---------- validation with the shared contracts ----------

export type FieldErrors = Record<string, string>;
export type Validation = { ok: true } | { ok: false; errors: FieldErrors };

const LABEL: Record<string, string> = {
  admissionNo: "admission number", firstName: "first name", lastName: "last name", otherNames: "other names", dateOfBirth: "date of birth",
  gender: "gender", enrolmentDate: "enrolment date", classId: "class", classStartsOn: "start date", name: "name", gradeLevel: "grade",
  stream: "stream", academicYearId: "academic year", startsOn: "start date", endsOn: "end date", timezone: "time zone",
  contactEmail: "email address", contactPhone: "phone number", address: "address", code: "school code", status: "status",
  effectiveFrom: "effective date", userId: "teacher",
};
const CHOOSE = new Set(["classId", "academicYearId", "userId", "gender", "status"]);

function message(issue: z.ZodIssue, field: string, value: unknown): string {
  const label = LABEL[field] ?? field;
  const enter = CHOOSE.has(field) ? `Choose the ${label}.` : `Enter the ${label}.`;
  if (value === "") return enter; // left blank: say what to do, not what format was expected
  if (issue.code === "invalid_enum_value" && CHOOSE.has(field)) return enter;
  if (issue.code === "invalid_type" && (issue as { received?: string }).received === "undefined") return enter;
  if (issue.message === "Required") return enter;
  if (issue.code === "invalid_string" && (issue as { validation?: unknown }).validation === "uuid") return enter;
  if (/calendar date/i.test(issue.message)) return `Enter a real date for the ${label}, for example 2026-10-08.`;
  if (issue.code === "too_big") return `The ${label} is too long (at most ${(issue as { maximum?: number }).maximum} characters).`;
  return issue.message;
}

export function validate(schema: z.ZodTypeAny, request: unknown): Validation {
  const parsed = schema.safeParse(request);
  if (parsed.success) return { ok: true };
  const errors: FieldErrors = {};
  for (const issue of parsed.error.issues) {
    const field = typeof issue.path[0] === "string" ? issue.path[0] : "_";
    errors[field] ??= message(issue, field, (request as Record<string, unknown> | null)?.[field]);
  }
  return { ok: false, errors };
}

/** Where a server refusal should show: next to its field when the form has that field, otherwise at the top. */
export function placeFailure(f: Failure, fields: readonly string[]): { errors: FieldErrors; banner: string | null } {
  if (f.field && fields.includes(f.field)) return { errors: { [f.field]: f.message }, banner: "That was not saved. Fix the highlighted field and try again." };
  return { errors: {}, banner: f.message };
}

// ---------- students ----------

export interface StudentFormValues {
  admissionNo: string;
  firstName: string;
  lastName: string;
  otherNames: string;
  dateOfBirth: string;
  gender: "" | Gender;
  enrolmentDate: string;
  /** Only when registering: put the student in a class straight away. */
  classId: string;
  classStartsOn: string;
}
export const STUDENT_FIELDS = ["admissionNo", "firstName", "lastName", "otherNames", "dateOfBirth", "gender", "enrolmentDate", "classId", "classStartsOn"] as const;

export const emptyStudentForm = (): StudentFormValues => ({
  admissionNo: "", firstName: "", lastName: "", otherNames: "", dateOfBirth: "", gender: "", enrolmentDate: "", classId: "", classStartsOn: "",
});

export const studentToForm = (s: StudentDetail): StudentFormValues => ({
  admissionNo: s.admissionNo, firstName: s.firstName, lastName: s.lastName, otherNames: s.otherNames ?? "", dateOfBirth: s.dateOfBirth ?? "",
  gender: s.gender ?? "", enrolmentDate: s.enrolmentDate, classId: "", classStartsOn: "",
});

/** Required fields are always sent (so a blank one is reported); optional ones only when filled in. */
export function toCreateStudent(v: StudentFormValues): CreateStudentRequest {
  const t = (x: string) => x.trim();
  return {
    admissionNo: t(v.admissionNo), firstName: t(v.firstName), lastName: t(v.lastName),
    ...(t(v.otherNames) ? { otherNames: t(v.otherNames) } : {}),
    ...(t(v.dateOfBirth) ? { dateOfBirth: t(v.dateOfBirth) } : {}),
    ...(v.gender ? { gender: v.gender } : {}),
    ...(t(v.enrolmentDate) ? { enrolmentDate: t(v.enrolmentDate) } : {}),
    ...(v.classId ? { classId: v.classId, ...(t(v.classStartsOn) ? { classStartsOn: t(v.classStartsOn) } : {}) } : {}),
  };
}

/** Only what changed. A cleared optional field is sent as null, which the server stores as "not recorded". */
export function toUpdateStudent(original: StudentDetail, v: StudentFormValues): UpdateStudentRequest {
  const t = (x: string) => x.trim();
  const out: UpdateStudentRequest = {};
  if (t(v.admissionNo) !== original.admissionNo) out.admissionNo = t(v.admissionNo);
  if (t(v.firstName) !== original.firstName) out.firstName = t(v.firstName);
  if (t(v.lastName) !== original.lastName) out.lastName = t(v.lastName);
  if (t(v.otherNames) !== (original.otherNames ?? "")) out.otherNames = t(v.otherNames) || null;
  if (t(v.dateOfBirth) !== (original.dateOfBirth ?? "")) out.dateOfBirth = t(v.dateOfBirth) || null;
  if (v.gender !== (original.gender ?? "")) out.gender = v.gender || null;
  if (t(v.enrolmentDate) !== original.enrolmentDate) out.enrolmentDate = t(v.enrolmentDate);
  return out;
}

export const validateCreateStudent = (v: StudentFormValues): Validation => validate(createStudentRequest, toCreateStudent(v));
export const validateUpdateStudent = (req: UpdateStudentRequest): Validation => validate(updateStudentRequest, req);

export interface PlacementFormValues { classId: string; effectiveFrom: string }
export const toPlacement = (v: PlacementFormValues): PlaceStudentRequest => ({ classId: v.classId, ...(v.effectiveFrom.trim() ? { effectiveFrom: v.effectiveFrom.trim() } : {}) });
export const validatePlacement = (v: PlacementFormValues): Validation => validate(placeStudentRequest, toPlacement(v));

export interface StatusFormValues { status: "" | StudentStatus; effectiveFrom: string }
export const toStatusChange = (v: StatusFormValues): ChangeStudentStatusRequest =>
  ({ status: v.status as StudentStatus, ...(v.effectiveFrom.trim() ? { effectiveFrom: v.effectiveFrom.trim() } : {}) });
export const validateStatusChange = (v: StatusFormValues): Validation => validate(changeStudentStatusRequest, toStatusChange(v));

/** The placement that may still be removed as a mistake: the latest one (the API refuses otherwise). */
export function latestPlacement(placements: readonly PlacementDto[]): PlacementDto | null {
  let latest: PlacementDto | null = null;
  for (const p of placements) if (latest === null || p.startsOn > latest.startsOn) latest = p;
  return latest;
}

export function describePlacement(p: PlacementDto): string {
  const year = p.academicYear ? `, ${p.academicYear.name}` : "";
  const span = p.endsOn ? `${dateLabel(p.startsOn)} to ${dateLabel(p.endsOn)}` : `from ${dateLabel(p.startsOn)}, still there`;
  return `${p.className}${year}: ${span}`;
}

// ---------- classes ----------

export interface ClassFormValues { name: string; gradeLevel: string; stream: string; academicYearId: string; status: ClassStatus }
export const CLASS_FIELDS = ["name", "gradeLevel", "stream", "academicYearId", "status"] as const;
export const emptyClassForm = (academicYearId = ""): ClassFormValues => ({ name: "", gradeLevel: "", stream: "", academicYearId, status: "active" });
export const classToForm = (c: ClassDetail): ClassFormValues => ({
  name: c.name, gradeLevel: c.gradeLevel, stream: c.stream ?? "", academicYearId: c.academicYear?.id ?? "", status: c.status,
});

export function toCreateClass(v: ClassFormValues): CreateClassRequest {
  return {
    name: v.name.trim(), gradeLevel: v.gradeLevel.trim(), academicYearId: v.academicYearId,
    ...(v.stream.trim() ? { stream: v.stream.trim() } : {}),
  };
}
export function toUpdateClass(original: ClassDetail, v: ClassFormValues): UpdateClassRequest {
  const out: UpdateClassRequest = {};
  if (v.name.trim() !== original.name) out.name = v.name.trim();
  if (v.gradeLevel.trim() !== original.gradeLevel) out.gradeLevel = v.gradeLevel.trim();
  if (v.stream.trim() !== (original.stream ?? "")) out.stream = v.stream.trim() || null;
  if (v.academicYearId && v.academicYearId !== (original.academicYear?.id ?? "")) out.academicYearId = v.academicYearId;
  if (v.status !== original.status) out.status = v.status;
  return out;
}
export const validateCreateClass = (v: ClassFormValues): Validation => validate(createClassRequest, toCreateClass(v));
export const validateUpdateClass = (req: UpdateClassRequest): Validation => validate(updateClassRequest, req);

export const className = (c: { name: string }): string => c.name;
export const classLabel = (c: { name: string; academicYear: { name: string } | null }): string => (c.academicYear ? `${c.name} (${c.academicYear.name})` : c.name);

// ---------- school profile, years and terms ----------

export interface ProfileFormValues { name: string; code: string; timezone: string; contactEmail: string; contactPhone: string; address: string }
export const PROFILE_FIELDS = ["name", "code", "timezone", "contactEmail", "contactPhone", "address"] as const;
export const profileToForm = (p: SchoolProfile): ProfileFormValues => ({
  name: p.name, code: p.code ?? "", timezone: p.timezone, contactEmail: p.contactEmail ?? "", contactPhone: p.contactPhone ?? "", address: p.address ?? "",
});
/** Cleared optional fields are sent as "" (the server stores that as "not recorded"). */
export function toUpdateProfile(original: SchoolProfile, v: ProfileFormValues): UpdateSchoolRequest {
  const t = (x: string) => x.trim();
  const out: UpdateSchoolRequest = {};
  if (t(v.name) !== original.name) out.name = t(v.name);
  if (t(v.code) !== (original.code ?? "")) out.code = t(v.code);
  if (t(v.timezone) !== original.timezone) out.timezone = t(v.timezone);
  if (t(v.contactEmail) !== (original.contactEmail ?? "")) out.contactEmail = t(v.contactEmail);
  if (t(v.contactPhone) !== (original.contactPhone ?? "")) out.contactPhone = t(v.contactPhone);
  if (t(v.address) !== (original.address ?? "")) out.address = t(v.address);
  return out;
}
export const validateUpdateProfile = (req: UpdateSchoolRequest): Validation => validate(updateSchoolRequest, req);

export interface YearFormValues { name: string; startsOn: string; endsOn: string; isActive: boolean }
export const YEAR_FIELDS = ["name", "startsOn", "endsOn", "isActive"] as const;
export const emptyYearForm = (): YearFormValues => ({ name: "", startsOn: "", endsOn: "", isActive: false });
export const yearToForm = (y: AcademicYearDto): YearFormValues => ({ name: y.name, startsOn: y.startsOn, endsOn: y.endsOn, isActive: y.isActive });
export const toCreateYear = (v: YearFormValues): CreateAcademicYearRequest => ({ name: v.name.trim(), startsOn: v.startsOn.trim(), endsOn: v.endsOn.trim(), isActive: v.isActive });
export function toUpdateYear(original: AcademicYearDto, v: YearFormValues): UpdateAcademicYearRequest {
  const out: UpdateAcademicYearRequest = {};
  if (v.name.trim() !== original.name) out.name = v.name.trim();
  if (v.startsOn.trim() !== original.startsOn) out.startsOn = v.startsOn.trim();
  if (v.endsOn.trim() !== original.endsOn) out.endsOn = v.endsOn.trim();
  if (v.isActive !== original.isActive) out.isActive = v.isActive;
  return out;
}
export const validateCreateYear = (v: YearFormValues): Validation => validate(createAcademicYearRequest, toCreateYear(v));
export const validateUpdateYear = (req: UpdateAcademicYearRequest): Validation => validate(updateAcademicYearRequest, req);

export interface TermFormValues { name: string; startsOn: string; endsOn: string }
export const TERM_FIELDS = ["name", "startsOn", "endsOn"] as const;
export const emptyTermForm = (): TermFormValues => ({ name: "", startsOn: "", endsOn: "" });
export const termToForm = (t: TermDto): TermFormValues => ({ name: t.name, startsOn: t.startsOn, endsOn: t.endsOn });
export const toCreateTerm = (v: TermFormValues): CreateTermRequest => ({ name: v.name.trim(), startsOn: v.startsOn.trim(), endsOn: v.endsOn.trim() });
export function toUpdateTerm(original: TermDto, v: TermFormValues): UpdateTermRequest {
  const out: UpdateTermRequest = {};
  if (v.name.trim() !== original.name) out.name = v.name.trim();
  if (v.startsOn.trim() !== original.startsOn) out.startsOn = v.startsOn.trim();
  if (v.endsOn.trim() !== original.endsOn) out.endsOn = v.endsOn.trim();
  return out;
}
export const validateCreateTerm = (v: TermFormValues): Validation => validate(createTermRequest, toCreateTerm(v));
export const validateUpdateTerm = (req: UpdateTermRequest): Validation => validate(updateTermRequest, req);

// ---------- paging ----------

export function pageWindow(p: { total: number; limit: number; offset: number }): { from: number; to: number; hasPrev: boolean; hasNext: boolean; prevOffset: number; nextOffset: number } {
  const from = p.total === 0 ? 0 : p.offset + 1;
  const to = Math.min(p.offset + p.limit, p.total);
  return {
    from, to, hasPrev: p.offset > 0, hasNext: p.offset + p.limit < p.total,
    prevOffset: Math.max(0, p.offset - p.limit), nextOffset: p.offset + p.limit,
  };
}
