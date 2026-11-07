/** School profile, academic years and terms. */
import type {
  AcademicYearDto, CreateAcademicYearRequest, CreateTermRequest, SchoolProfile, TermDto, UpdateAcademicYearRequest, UpdateSchoolRequest, UpdateTermRequest,
} from "@schoolpulse/contracts";
import type { AcademicYearRow, AdminStore, TermRow } from "@schoolpulse/db";
import { findOverlap, termsOutside, validateTermWithinYear, validateYearDates } from "@schoolpulse/domain";
import type { Deps } from "../deps.ts";
import { HttpError } from "../errors.ts";
import type { AuthContext } from "../services/auth.ts";
import { audit, changedFields, ensure, requireAction, schoolIdOf, withConstraints, type ConstraintRule } from "./common.ts";

const yearRules: Record<string, ConstraintRule> = {
  academic_years_no_overlap: { status: 409, code: "year_overlap", message: "That academic year overlaps another one. Years cannot share any dates.", field: "startsOn" },
  academic_years_name_key: { status: 409, code: "year_name_taken", message: "Another academic year already has that name.", field: "name" },
  academic_years_one_active: { status: 409, code: "active_year_conflict", message: "Another academic year was just made active. Reload and try again." },
};
const termRules: Record<string, ConstraintRule> = {
  terms_no_overlap: { status: 409, code: "term_overlap", message: "That term overlaps another term.", field: "startsOn" },
  terms_year_name_key: { status: 409, code: "term_name_taken", message: "This academic year already has a term with that name.", field: "name" },
};

const toTermDto = (t: TermRow): TermDto => ({ id: t.id, academicYearId: t.academicYearId, name: t.name, startsOn: t.startsOn, endsOn: t.endsOn });
const toYearDto = (y: AcademicYearRow, terms: readonly TermRow[]): AcademicYearDto => ({
  id: y.id, name: y.name, startsOn: y.startsOn, endsOn: y.endsOn, isActive: y.isActive, classCount: y.classCount,
  terms: terms.filter((t) => t.academicYearId === y.id).map(toTermDto),
});

async function profileOf(store: AdminStore, schoolId: string): Promise<SchoolProfile> {
  const school = await store.getSchool(schoolId);
  if (!school) throw new HttpError(404, "not_found", "School not found.");
  const active = (await store.listAcademicYears(schoolId)).find((y) => y.isActive);
  return {
    ...school,
    activeAcademicYear: active ? { id: active.id, name: active.name, startsOn: active.startsOn, endsOn: active.endsOn } : null,
  };
}

// ---------- school profile ----------

export async function getSchoolProfile(deps: Deps, auth: AuthContext): Promise<SchoolProfile> {
  requireAction(auth, "school:read");
  return profileOf(deps.admin.store, schoolIdOf(auth));
}

export async function updateSchoolProfile(deps: Deps, auth: AuthContext, patch: UpdateSchoolRequest): Promise<SchoolProfile> {
  requireAction(auth, "school:manage");
  const schoolId = schoolIdOf(auth);
  // The request is strict, so it can only contain profile fields: there is no way to name another school here.
  return withConstraints(
    { schools_code_key: { status: 409, code: "school_code_taken", message: "Another school already uses that code.", field: "code" } },
    () =>
      deps.admin.transaction(async (tx) => {
        await tx.updateSchool(schoolId, patch);
        await audit(tx, auth, "school.updated", "school", schoolId, { fields: changedFields(patch) });
        return profileOf(tx, schoolId);
      }),
  );
}

// ---------- academic years ----------

export async function listAcademicYears(deps: Deps, auth: AuthContext): Promise<{ items: AcademicYearDto[] }> {
  requireAction(auth, "school:read");
  const schoolId = schoolIdOf(auth);
  const store = deps.admin.store;
  const [years, terms] = await Promise.all([store.listAcademicYears(schoolId), store.listTerms(schoolId)]);
  return { items: years.map((y) => toYearDto(y, terms)) };
}

export async function createAcademicYear(deps: Deps, auth: AuthContext, req: CreateAcademicYearRequest): Promise<AcademicYearDto> {
  requireAction(auth, "school:manage");
  const schoolId = schoolIdOf(auth);
  const range = { startsOn: req.startsOn, endsOn: req.endsOn };
  ensure(validateYearDates(range));
  const id = deps.newId();
  return withConstraints(yearRules, () =>
    deps.admin.transaction(async (tx) => {
      await tx.lockSchool(schoolId);
      const existing = await tx.listAcademicYears(schoolId);
      const clash = findOverlap(range, existing);
      if (clash) throw new HttpError(409, "year_overlap", `That overlaps academic year ${clash.name} (${clash.startsOn} to ${clash.endsOn}).`, "startsOn");
      if (existing.some((y) => y.name.toLowerCase() === req.name.toLowerCase())) {
        throw new HttpError(409, "year_name_taken", "Another academic year already has that name.", "name");
      }
      const active = req.isActive === true;
      if (active) await tx.deactivateOtherYears(schoolId, id);
      await tx.insertAcademicYear({ id, schoolId, name: req.name, startsOn: req.startsOn, endsOn: req.endsOn, isActive: active });
      await audit(tx, auth, "academic_year.created", "academic_year", id, { name: req.name, active });
      return toYearDto((await tx.getAcademicYear(schoolId, id))!, []);
    }),
  );
}

export async function updateAcademicYear(deps: Deps, auth: AuthContext, id: string, patch: UpdateAcademicYearRequest): Promise<AcademicYearDto> {
  requireAction(auth, "school:manage");
  const schoolId = schoolIdOf(auth);
  return withConstraints(yearRules, () =>
    deps.admin.transaction(async (tx) => {
      await tx.lockSchool(schoolId);
      const year = await tx.getAcademicYear(schoolId, id);
      if (!year) throw new HttpError(404, "not_found", "Academic year not found.");

      const range = { startsOn: patch.startsOn ?? year.startsOn, endsOn: patch.endsOn ?? year.endsOn };
      const datesChanged = range.startsOn !== year.startsOn || range.endsOn !== year.endsOn;
      if (datesChanged) {
        ensure(validateYearDates(range));
        const clash = findOverlap(range, await tx.listAcademicYears(schoolId), id);
        if (clash) throw new HttpError(409, "year_overlap", `That overlaps academic year ${clash.name} (${clash.startsOn} to ${clash.endsOn}).`, "startsOn");
        // Changing dates must not strand what already hangs off this year.
        const stranded = termsOutside(range, await tx.listTerms(schoolId, id));
        if (stranded.length > 0) {
          throw new HttpError(409, "year_excludes_terms", `These terms would fall outside the new dates: ${stranded.map((t) => t.name).join(", ")}. Change or delete them first.`, "startsOn");
        }
        const { firstDate, lastDate } = await tx.yearActivityBounds(schoolId, id);
        if ((firstDate && firstDate < range.startsOn) || (lastDate && lastDate > range.endsOn)) {
          throw new HttpError(409, "year_excludes_activity", `Classes in this year already have placements or registers from ${firstDate} to ${lastDate}. The year must still cover those dates.`, "startsOn");
        }
      }
      if (patch.name !== undefined && patch.name.toLowerCase() !== year.name.toLowerCase()) {
        if ((await tx.listAcademicYears(schoolId)).some((y) => y.id !== id && y.name.toLowerCase() === patch.name!.toLowerCase())) {
          throw new HttpError(409, "year_name_taken", "Another academic year already has that name.", "name");
        }
      }

      // Exactly one active year: switching deactivates the old one in the same transaction.
      if (patch.isActive === true) await tx.deactivateOtherYears(schoolId, id);
      await tx.updateAcademicYear(schoolId, id, patch);
      await audit(tx, auth, "academic_year.updated", "academic_year", id, { fields: changedFields(patch) });
      return toYearDto((await tx.getAcademicYear(schoolId, id))!, await tx.listTerms(schoolId, id));
    }),
  );
}

export async function deleteAcademicYear(deps: Deps, auth: AuthContext, id: string): Promise<void> {
  requireAction(auth, "school:manage");
  const schoolId = schoolIdOf(auth);
  // Foreign keys are the backstop if a class or term appears between the check below and the delete.
  const rules: Record<string, ConstraintRule> = {
    classes_academic_year_fk: { status: 409, code: "year_has_classes", message: "Classes belong to this academic year, so it cannot be deleted." },
    terms_school_id_academic_year_id_fkey: { status: 409, code: "year_has_terms", message: "Delete this year's terms first." },
  };
  await withConstraints(rules, () =>
    deps.admin.transaction(async (tx) => {
      await tx.lockSchool(schoolId);
      const year = await tx.getAcademicYear(schoolId, id);
      if (!year) throw new HttpError(404, "not_found", "Academic year not found.");
      const dependents = await tx.countYearDependents(schoolId, id);
      if (dependents.classes > 0) {
        throw new HttpError(409, "year_has_classes", `${dependents.classes} class${dependents.classes === 1 ? " belongs" : "es belong"} to this academic year, so it cannot be deleted.`);
      }
      if (dependents.terms > 0) {
        throw new HttpError(409, "year_has_terms", `Delete this year's ${dependents.terms} term${dependents.terms === 1 ? "" : "s"} first.`);
      }
      await tx.deleteAcademicYear(schoolId, id);
      await audit(tx, auth, "academic_year.deleted", "academic_year", id, { name: year.name });
    }),
  );
}

// ---------- terms ----------

export async function createTerm(deps: Deps, auth: AuthContext, yearId: string, req: CreateTermRequest): Promise<TermDto> {
  requireAction(auth, "school:manage");
  const schoolId = schoolIdOf(auth);
  const id = deps.newId();
  return withConstraints(termRules, () =>
    deps.admin.transaction(async (tx) => {
      await tx.lockSchool(schoolId);
      const year = await tx.getAcademicYear(schoolId, yearId);
      if (!year) throw new HttpError(404, "not_found", "Academic year not found.");
      const range = { startsOn: req.startsOn, endsOn: req.endsOn };
      ensure(validateTermWithinYear(range, year));
      const terms = await tx.listTerms(schoolId);
      const clash = findOverlap(range, terms);
      if (clash) throw new HttpError(409, "term_overlap", `That overlaps ${clash.name} (${clash.startsOn} to ${clash.endsOn}).`, "startsOn");
      if (terms.some((t) => t.academicYearId === yearId && t.name.toLowerCase() === req.name.toLowerCase())) {
        throw new HttpError(409, "term_name_taken", "This academic year already has a term with that name.", "name");
      }
      await tx.insertTerm({ id, schoolId, academicYearId: yearId, name: req.name, startsOn: req.startsOn, endsOn: req.endsOn });
      await audit(tx, auth, "term.created", "term", id, { name: req.name, academicYearId: yearId });
      return toTermDto((await tx.getTerm(schoolId, id))!);
    }),
  );
}

export async function updateTerm(deps: Deps, auth: AuthContext, id: string, patch: UpdateTermRequest): Promise<TermDto> {
  requireAction(auth, "school:manage");
  const schoolId = schoolIdOf(auth);
  return withConstraints(termRules, () =>
    deps.admin.transaction(async (tx) => {
      await tx.lockSchool(schoolId);
      const term = await tx.getTerm(schoolId, id);
      if (!term) throw new HttpError(404, "not_found", "Term not found.");
      const year = (await tx.getAcademicYear(schoolId, term.academicYearId))!;
      const range = { startsOn: patch.startsOn ?? term.startsOn, endsOn: patch.endsOn ?? term.endsOn };
      ensure(validateTermWithinYear(range, year));
      const terms = await tx.listTerms(schoolId);
      const clash = findOverlap(range, terms, id);
      if (clash) throw new HttpError(409, "term_overlap", `That overlaps ${clash.name} (${clash.startsOn} to ${clash.endsOn}).`, "startsOn");
      if (patch.name !== undefined && terms.some((t) => t.id !== id && t.academicYearId === term.academicYearId && t.name.toLowerCase() === patch.name!.toLowerCase())) {
        throw new HttpError(409, "term_name_taken", "This academic year already has a term with that name.", "name");
      }
      await tx.updateTerm(schoolId, id, patch);
      await audit(tx, auth, "term.updated", "term", id, { fields: changedFields(patch) });
      return toTermDto((await tx.getTerm(schoolId, id))!);
    }),
  );
}

export async function deleteTerm(deps: Deps, auth: AuthContext, id: string): Promise<void> {
  requireAction(auth, "school:manage");
  const schoolId = schoolIdOf(auth);
  await deps.admin.transaction(async (tx) => {
    const term = await tx.getTerm(schoolId, id);
    if (!term) throw new HttpError(404, "not_found", "Term not found.");
    await tx.deleteTerm(schoolId, id);
    await audit(tx, auth, "term.deleted", "term", id, { name: term.name });
  });
}
