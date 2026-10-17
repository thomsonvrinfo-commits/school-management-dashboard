/** The student registry: register, search, view, edit, change status, place in / move between classes. */
import type {
  ChangeStudentStatusRequest, CreateStudentRequest, PlaceStudentRequest, StudentDetail, StudentListParams, StudentPage, UpdateStudentRequest,
} from "@schoolpulse/contracts";
import type { AdminStore, AdminStudentRow, StudentPatch } from "@schoolpulse/db";
import {
  enrolmentOn, latestEnrolment, normaliseAdmissionNo, normalisePersonName, planPlacement, planPlacementRemoval, planStatusChange, validateAdmissionNo,
  validateDateOfBirth, validateEnrolmentDate, validatePersonName, type AttendanceGuard, type PlacementPlan,
} from "@schoolpulse/domain";
import type { Deps } from "../deps.ts";
import { HttpError } from "../errors.ts";
import type { AuthContext } from "../services/auth.ts";
import { audit, changedFields, ensure, httpFromProblem, requireAction, schoolIdOf, todayOf, withConstraints, type ConstraintRule } from "./common.ts";

const studentRules: Record<string, ConstraintRule> = {
  students_school_admission_ci_key: { status: 409, code: "admission_no_taken", message: "Another student already has that admission number.", field: "admissionNo" },
  students_school_id_admission_no_key: { status: 409, code: "admission_no_taken", message: "Another student already has that admission number.", field: "admissionNo" },
  enrollments_no_overlap: { status: 409, code: "placement_overlaps", message: "That would put the student in two classes on the same day. Change the date, or move them instead." },
};

async function detailOf(store: AdminStore, schoolId: string, s: AdminStudentRow, today: string): Promise<StudentDetail> {
  // Sequential on purpose: `store` may be bound to one transaction, which runs one statement at a time.
  const enrolments = await store.listEnrolments(schoolId, s.id);
  const attendance = await store.studentAttendanceByClass(schoolId, s.id);
  const current = enrolmentOn(enrolments, today);
  const upcoming = enrolments.filter((e) => e.startsOn > today).sort((a, b) => a.startsOn.localeCompare(b.startsOn))[0];
  return {
    id: s.id, admissionNo: s.admissionNo, firstName: s.firstName, lastName: s.lastName, status: s.status,
    otherNames: s.otherNames, dateOfBirth: s.dateOfBirth, gender: s.gender, enrolmentDate: s.enrolmentDate,
    currentClass: current ? { id: current.classId, name: current.className } : null,
    upcomingClass: upcoming ? { id: upcoming.classId, name: upcoming.className, startsOn: upcoming.startsOn } : null,
    placements: enrolments.map((e) => ({ id: e.id, classId: e.classId, className: e.className, academicYear: e.academicYear, startsOn: e.startsOn, endsOn: e.endsOn })),
    attendance,
  };
}

/** The attendance guard from a plan: moving or ending a placement is refused if registers already exist from that day. */
async function checkGuard(tx: AdminStore, schoolId: string, studentId: string, guard: AttendanceGuard | undefined, field: string): Promise<void> {
  if (!guard) return;
  if (await tx.studentHasAttendanceBetween(schoolId, studentId, guard.onOrAfter, null)) {
    throw new HttpError(
      409, "attendance_after_effective_date",
      `Attendance has already been recorded for this student on or after ${guard.onOrAfter}. Choose a later date so past registers stay correct.`,
      field,
    );
  }
}

async function applyPlacement(tx: AdminStore, auth: AuthContext, studentId: string, plan: Extract<PlacementPlan, { ok: true }>, id: string): Promise<void> {
  const schoolId = schoolIdOf(auth);
  if (plan.close) await tx.closeEnrolment(schoolId, plan.close.enrolmentId, plan.close.endsOn);
  await tx.insertEnrolment({ id, schoolId, studentId, classId: plan.open.classId, startsOn: plan.open.startsOn, createdBy: auth.ctx.user.id });
}

// ---------- list / view ----------

export async function listStudents(deps: Deps, auth: AuthContext, q: StudentListParams): Promise<StudentPage> {
  requireAction(auth, "student:read");
  const page = await deps.admin.store.listStudents(
    schoolIdOf(auth),
    { q: q.q, classId: q.classId, status: q.status, unplaced: q.unplaced },
    todayOf(deps, auth), q.limit, q.offset,
  );
  return { items: page.items, total: page.total, limit: q.limit, offset: q.offset };
}

export async function getStudent(deps: Deps, auth: AuthContext, id: string): Promise<StudentDetail> {
  requireAction(auth, "student:read");
  const schoolId = schoolIdOf(auth);
  const s = await deps.admin.store.getStudent(schoolId, id);
  if (!s) throw new HttpError(404, "not_found", "Student not found.");
  return detailOf(deps.admin.store, schoolId, s, todayOf(deps, auth));
}

// ---------- register ----------

export async function registerStudent(deps: Deps, auth: AuthContext, req: CreateStudentRequest): Promise<StudentDetail> {
  requireAction(auth, "student:manage");
  const schoolId = schoolIdOf(auth);
  const today = todayOf(deps, auth);

  ensure(validateAdmissionNo(req.admissionNo));
  ensure(validatePersonName(req.firstName, "firstName", "a first name"));
  ensure(validatePersonName(req.lastName, "lastName", "a last name"));
  const dateOfBirth = req.dateOfBirth ?? null;
  if (dateOfBirth) ensure(validateDateOfBirth(dateOfBirth, today));
  const enrolmentDate = req.enrolmentDate ?? today;
  ensure(validateEnrolmentDate(enrolmentDate, dateOfBirth, today));
  if (req.classStartsOn && !req.classId) throw new HttpError(400, "invalid_request", "classStartsOn: choose a class as well.", "classStartsOn");

  const id = deps.newId();
  return withConstraints(studentRules, () =>
    deps.admin.transaction(async (tx) => {
      let plan: Extract<PlacementPlan, { ok: true }> | null = null;
      if (req.classId) {
        if (!(await tx.lockClass(schoolId, req.classId))) throw new HttpError(400, "class_not_found", "That class does not exist.", "classId");
        const cls = (await tx.getClass(schoolId, req.classId, today))!;
        const planned = planPlacement({
          today, student: { status: "enrolled", enrolmentDate }, enrolments: [],
          target: { id: cls.id, status: cls.status, year: cls.academicYear }, effectiveFrom: req.classStartsOn,
        });
        if (!planned.ok) throw httpFromProblem(planned.problem);
        plan = planned;
      }
      await tx.insertStudent({
        id, schoolId, admissionNo: normaliseAdmissionNo(req.admissionNo),
        firstName: normalisePersonName(req.firstName), lastName: normalisePersonName(req.lastName),
        otherNames: req.otherNames ? normalisePersonName(req.otherNames) : null,
        dateOfBirth, gender: req.gender ?? null, enrolmentDate,
      });
      if (plan) await applyPlacement(tx, auth, id, plan, deps.newId());
      await audit(tx, auth, "student.registered", "student", id, { admissionNo: normaliseAdmissionNo(req.admissionNo), classId: req.classId ?? null });
      return detailOf(tx, schoolId, (await tx.getStudent(schoolId, id))!, today);
    }),
  );
}

// ---------- edit ----------

export async function updateStudent(deps: Deps, auth: AuthContext, id: string, patch: UpdateStudentRequest): Promise<StudentDetail> {
  requireAction(auth, "student:manage");
  const schoolId = schoolIdOf(auth);
  const today = todayOf(deps, auth);

  if (patch.admissionNo !== undefined) ensure(validateAdmissionNo(patch.admissionNo));
  if (patch.firstName !== undefined) ensure(validatePersonName(patch.firstName, "firstName", "a first name"));
  if (patch.lastName !== undefined) ensure(validatePersonName(patch.lastName, "lastName", "a last name"));
  if (patch.dateOfBirth) ensure(validateDateOfBirth(patch.dateOfBirth, today));

  return withConstraints(studentRules, () =>
    deps.admin.transaction(async (tx) => {
      const s = await tx.lockStudent(schoolId, id);
      if (!s) throw new HttpError(404, "not_found", "Student not found.");
      const dob = patch.dateOfBirth !== undefined ? patch.dateOfBirth : s.dateOfBirth;
      const enrolmentDate = patch.enrolmentDate ?? s.enrolmentDate;
      if (patch.enrolmentDate !== undefined || patch.dateOfBirth !== undefined) ensure(validateEnrolmentDate(enrolmentDate, dob, today));
      if (patch.enrolmentDate !== undefined) {
        const first = (await tx.listEnrolments(schoolId, id))[0];
        if (first && first.startsOn < patch.enrolmentDate) {
          throw new HttpError(409, "enrolment_date_after_placement", `The student was already placed in a class on ${first.startsOn}, so they cannot have enrolled after that.`, "enrolmentDate");
        }
      }
      const clean: StudentPatch = {
        ...(patch.admissionNo !== undefined ? { admissionNo: normaliseAdmissionNo(patch.admissionNo) } : {}),
        ...(patch.firstName !== undefined ? { firstName: normalisePersonName(patch.firstName) } : {}),
        ...(patch.lastName !== undefined ? { lastName: normalisePersonName(patch.lastName) } : {}),
        ...(patch.otherNames !== undefined ? { otherNames: patch.otherNames ? normalisePersonName(patch.otherNames) : null } : {}),
        ...(patch.dateOfBirth !== undefined ? { dateOfBirth: patch.dateOfBirth } : {}),
        ...(patch.gender !== undefined ? { gender: patch.gender } : {}),
        ...(patch.enrolmentDate !== undefined ? { enrolmentDate: patch.enrolmentDate } : {}),
      };
      await tx.updateStudent(schoolId, id, clean);
      await audit(tx, auth, "student.updated", "student", id, { fields: changedFields(patch) });
      return detailOf(tx, schoolId, (await tx.getStudent(schoolId, id))!, today);
    }),
  );
}

// ---------- status ----------

export async function changeStudentStatus(deps: Deps, auth: AuthContext, id: string, req: ChangeStudentStatusRequest): Promise<StudentDetail> {
  requireAction(auth, "student:manage");
  const schoolId = schoolIdOf(auth);
  const today = todayOf(deps, auth);
  return withConstraints(studentRules, () =>
    deps.admin.transaction(async (tx) => {
      const s = await tx.lockStudent(schoolId, id);
      if (!s) throw new HttpError(404, "not_found", "Student not found.");
      // Hold the placements before the register check: a register being saved right now either lands first (and is seen) or waits.
      const enrolments = await tx.listEnrolments(schoolId, id, { lock: true });
      const plan = planStatusChange({ today, student: { status: s.status }, enrolments, next: req.status, effectiveFrom: req.effectiveFrom });
      if (!plan.ok) throw httpFromProblem(plan.problem);
      await checkGuard(tx, schoolId, id, plan.guard, "effectiveFrom");
      if (plan.close) await tx.closeEnrolment(schoolId, plan.close.enrolmentId, plan.close.endsOn);
      await tx.setStudentStatus(schoolId, id, plan.status);
      await audit(tx, auth, "student.status_changed", "student", id, { from: s.status, to: plan.status, effectiveFrom: plan.effectiveFrom });
      return detailOf(tx, schoolId, (await tx.getStudent(schoolId, id))!, today);
    }),
  );
}

// ---------- placement ----------

export async function placeStudent(deps: Deps, auth: AuthContext, id: string, req: PlaceStudentRequest): Promise<StudentDetail> {
  requireAction(auth, "student:manage");
  const schoolId = schoolIdOf(auth);
  const today = todayOf(deps, auth);
  return withConstraints(studentRules, () =>
    deps.admin.transaction(async (tx) => {
      // Lock order is always class, then student, so two admins doing opposite things cannot deadlock.
      if (!(await tx.lockClass(schoolId, req.classId))) throw new HttpError(400, "class_not_found", "That class does not exist.", "classId");
      const s = await tx.lockStudent(schoolId, id);
      if (!s) throw new HttpError(404, "not_found", "Student not found.");
      const cls = (await tx.getClass(schoolId, req.classId, today))!;
      // Hold the placements before the register check: a register being saved right now either lands first (and is seen) or waits.
      const enrolments = await tx.listEnrolments(schoolId, id, { lock: true });
      const plan = planPlacement({
        today, student: { status: s.status, enrolmentDate: s.enrolmentDate }, enrolments,
        target: { id: cls.id, status: cls.status, year: cls.academicYear }, effectiveFrom: req.effectiveFrom,
      });
      if (!plan.ok) throw httpFromProblem(plan.problem);
      await checkGuard(tx, schoolId, id, plan.guard, "effectiveFrom");
      const previous = plan.close ? enrolments.find((e) => e.id === plan.close!.enrolmentId)!.classId : null;
      await applyPlacement(tx, auth, id, plan, deps.newId());
      await audit(tx, auth, "student.placed", "student", id, { classId: cls.id, effectiveFrom: plan.effectiveFrom, fromClassId: previous });
      return detailOf(tx, schoolId, s, today);
    }),
  );
}

export async function removePlacement(deps: Deps, auth: AuthContext, id: string, placementId: string): Promise<StudentDetail> {
  requireAction(auth, "student:manage");
  const schoolId = schoolIdOf(auth);
  const today = todayOf(deps, auth);
  return withConstraints(studentRules, () =>
    deps.admin.transaction(async (tx) => {
      const s = await tx.lockStudent(schoolId, id);
      if (!s) throw new HttpError(404, "not_found", "Student not found.");
      // Hold the placements before looking for registers, so a register being saved right now either lands first (and is seen) or waits.
      const enrolments = await tx.listEnrolments(schoolId, id, { lock: true });
      const target = enrolments.find((e) => e.id === placementId);
      const hasAttendance = target ? await tx.studentHasAttendanceBetween(schoolId, id, target.startsOn, target.endsOn) : false;
      const previous = target ? latestEnrolment(enrolments.filter((e) => e.id !== target.id)) : null;
      const previousClass = previous ? await tx.getClass(schoolId, previous.classId, today) : null;
      const plan = planPlacementRemoval({
        enrolments, enrolmentId: placementId, hasAttendanceInSpan: hasAttendance,
        studentStatus: s.status, previousClassStatus: previousClass?.status ?? null,
      });
      if (!plan.ok) throw httpFromProblem(plan.problem);
      await tx.deleteEnrolment(schoolId, placementId);
      if (plan.restore) await tx.reopenEnrolment(schoolId, plan.restore.enrolmentId);
      await audit(tx, auth, "student.placement_removed", "student", id, {
        classId: target!.classId, startsOn: target!.startsOn, ...(plan.restore ? { restoredPlacementId: plan.restore.enrolmentId } : {}),
      });
      return detailOf(tx, schoolId, s, today);
    }),
  );
}
