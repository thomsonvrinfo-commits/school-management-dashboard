/** Classes and streams, class rosters, and teacher-to-class assignments. */
import type {
  AssignTeacherRequest, ClassDetail, ClassListItem, ClassListParams, ClassPage, CreateClassRequest, MyClassesResponse, RosterResponse,
  TeacherListItem, UpdateClassRequest,
} from "@schoolpulse/contracts";
import type { AdminClassRow, AdminStore, ClassPatch } from "@schoolpulse/db";
import {
  normaliseClassName, normaliseGradeLevel, normaliseStream, validateArchive, validateClassName, validateClassYearChange, validateTeacherAssignment,
} from "@schoolpulse/domain";
import type { Deps } from "../deps.ts";
import { HttpError } from "../errors.ts";
import type { AuthContext } from "../services/auth.ts";
import { audit, changedFields, ensure, requireAction, schoolIdOf, todayOf, withConstraints, type ConstraintRule } from "./common.ts";

const classRules: Record<string, ConstraintRule> = {
  classes_school_year_name_key: { status: 409, code: "class_name_taken", message: "This academic year already has a class with that name.", field: "name" },
  classes_school_nullyear_name_key: { status: 409, code: "class_name_taken", message: "Another class already has that name.", field: "name" },
  classes_school_year_grade_stream_key: { status: 409, code: "class_stream_taken", message: "This academic year already has a class for that grade and stream.", field: "stream" },
};

const toListItem = (c: AdminClassRow): ClassListItem => ({
  id: c.id, name: c.name, gradeLevel: c.gradeLevel, stream: c.stream, status: c.status,
  academicYear: c.academicYear ? { id: c.academicYear.id, name: c.academicYear.name } : null,
  studentCount: c.studentCount, teacherCount: c.teacherCount,
});

async function detailOf(store: AdminStore, schoolId: string, id: string, today: string): Promise<ClassDetail> {
  // Sequential on purpose: `store` may be bound to one transaction, which runs one statement at a time.
  const row = await store.getClass(schoolId, id, today);
  const teachers = await store.listClassTeachers(schoolId, id);
  if (!row) throw new HttpError(404, "not_found", "Class not found.");
  return { ...toListItem(row), teachers };
}

// ---------- list / view ----------

export async function listClasses(deps: Deps, auth: AuthContext, q: ClassListParams): Promise<ClassPage> {
  requireAction(auth, "class:read");
  const page = await deps.admin.store.listClasses(
    schoolIdOf(auth), { q: q.q, academicYearId: q.academicYearId, status: q.status }, todayOf(deps, auth), q.limit, q.offset,
  );
  return { items: page.items.map(toListItem), total: page.total, limit: q.limit, offset: q.offset };
}

export async function getClass(deps: Deps, auth: AuthContext, id: string): Promise<ClassDetail> {
  requireAction(auth, "class:read");
  return detailOf(deps.admin.store, schoolIdOf(auth), id, todayOf(deps, auth));
}

// ---------- create / edit ----------

export async function createClass(deps: Deps, auth: AuthContext, req: CreateClassRequest): Promise<ClassDetail> {
  requireAction(auth, "class:manage");
  const schoolId = schoolIdOf(auth);
  const today = todayOf(deps, auth);
  ensure(validateClassName(req.name));
  const id = deps.newId();
  return withConstraints(classRules, () =>
    deps.admin.transaction(async (tx) => {
      if (!(await tx.getAcademicYear(schoolId, req.academicYearId))) {
        throw new HttpError(400, "academic_year_not_found", "That academic year does not exist.", "academicYearId");
      }
      await tx.insertClass({
        id, schoolId, name: normaliseClassName(req.name), gradeLevel: normaliseGradeLevel(req.gradeLevel),
        stream: normaliseStream(req.stream), academicYearId: req.academicYearId,
      });
      await audit(tx, auth, "class.created", "class", id, { name: normaliseClassName(req.name), academicYearId: req.academicYearId });
      return detailOf(tx, schoolId, id, today);
    }),
  );
}

export async function updateClass(deps: Deps, auth: AuthContext, id: string, patch: UpdateClassRequest): Promise<ClassDetail> {
  requireAction(auth, "class:manage");
  const schoolId = schoolIdOf(auth);
  const today = todayOf(deps, auth);
  if (patch.name !== undefined) ensure(validateClassName(patch.name));

  return withConstraints(classRules, () =>
    deps.admin.transaction(async (tx) => {
      if (!(await tx.lockClass(schoolId, id))) throw new HttpError(404, "not_found", "Class not found.");
      const cur = (await tx.getClass(schoolId, id, today))!;

      const currentYearId = cur.academicYear?.id ?? null;
      if (patch.academicYearId !== undefined && patch.academicYearId !== currentYearId) {
        const nextYear = await tx.getAcademicYear(schoolId, patch.academicYearId);
        if (!nextYear) throw new HttpError(400, "academic_year_not_found", "That academic year does not exist.", "academicYearId");
        ensure(validateClassYearChange({
          currentYearId, nextYearId: patch.academicYearId,
          hasEnrolments: await tx.classHasEnrolments(schoolId, id), hasAttendance: await tx.classHasAttendance(schoolId, id),
          enrolmentStarts: await tx.classEnrolmentStarts(schoolId, id), nextYear,
        }));
      }
      if (patch.status === "archived" && cur.status !== "archived") {
        ensure(validateArchive(await tx.classLiveEnrolmentCount(schoolId, id, today)));
      }

      const clean: ClassPatch = {
        ...(patch.name !== undefined ? { name: normaliseClassName(patch.name) } : {}),
        ...(patch.gradeLevel !== undefined ? { gradeLevel: normaliseGradeLevel(patch.gradeLevel) } : {}),
        ...(patch.stream !== undefined ? { stream: normaliseStream(patch.stream) } : {}),
        ...(patch.academicYearId !== undefined ? { academicYearId: patch.academicYearId } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
      };
      await tx.updateClass(schoolId, id, clean);
      await audit(tx, auth, "class.updated", "class", id, { fields: changedFields(patch), ...(patch.status ? { status: patch.status } : {}) });
      return detailOf(tx, schoolId, id, today);
    }),
  );
}

// ---------- roster (what the attendance register reads) ----------

/**
 * Who is in a class on a date, for the head or for a teacher assigned to the class. It reads through the Slice 1
 * store's `enrolledStudents`, the exact query the offline register is built from, so the two can never disagree.
 */
export async function classRoster(deps: Deps, auth: AuthContext, classId: string, date: string | undefined): Promise<RosterResponse> {
  const schoolId = schoolIdOf(auth);
  const today = todayOf(deps, auth);
  const store = deps.db.store;
  if (!(await store.classExists(schoolId, classId))) throw new HttpError(404, "not_found", "Class not found.");
  const teachesClass = auth.principal.role === "teacher" ? await store.teachesClass(schoolId, auth.ctx.user.id, classId) : undefined;
  requireAction(auth, "class:read-roster", { classId, ...(teachesClass === undefined ? {} : { teachesClass }) });

  const on = date ?? today;
  const [students, cls] = await Promise.all([store.enrolledStudents(schoolId, [classId], on), deps.admin.store.getClass(schoolId, classId, today)]);
  return {
    classId, className: cls!.name, gradeLevel: cls!.gradeLevel, stream: cls!.stream,
    academicYear: cls!.academicYear ? { id: cls!.academicYear.id, name: cls!.academicYear.name } : null,
    date: on,
    students: students.map((s) => ({ id: s.id, classId: s.classId, admissionNo: s.admissionNo, firstName: s.firstName, lastName: s.lastName })),
  };
}

// ---------- teacher assignments ----------

const NOT_A_TEACHER = "That person is not a teacher at this school.";

export async function assignTeacher(deps: Deps, auth: AuthContext, classId: string, req: AssignTeacherRequest): Promise<ClassDetail> {
  requireAction(auth, "teacher:assign");
  const schoolId = schoolIdOf(auth);
  const today = todayOf(deps, auth);
  return withConstraints(
    { class_teachers_teacher_membership: { status: 400, code: "teacher_not_found", message: NOT_A_TEACHER, field: "userId" } },
    () =>
      deps.admin.transaction(async (tx) => {
        if (!(await tx.lockClass(schoolId, classId))) throw new HttpError(404, "not_found", "Class not found.");
        const cls = (await tx.getClass(schoolId, classId, today))!;
        ensure(validateTeacherAssignment({ today, classStatus: cls.status, classYear: cls.academicYear }));
        // Looked up INSIDE this school: a user id from another school, a head, or a deactivated teacher all look the same.
        if (!(await tx.getTeacher(schoolId, req.userId))) throw new HttpError(400, "teacher_not_found", NOT_A_TEACHER, "userId");
        if (await tx.assignTeacher(schoolId, classId, req.userId, auth.ctx.user.id)) {
          await audit(tx, auth, "class.teacher_assigned", "class", classId, { userId: req.userId });
        }
        return detailOf(tx, schoolId, classId, today);
      }),
  );
}

export async function removeTeacher(deps: Deps, auth: AuthContext, classId: string, userId: string): Promise<ClassDetail> {
  requireAction(auth, "teacher:assign");
  const schoolId = schoolIdOf(auth);
  const today = todayOf(deps, auth);
  return deps.admin.transaction(async (tx) => {
    if (!(await tx.lockClass(schoolId, classId))) throw new HttpError(404, "not_found", "Class not found.");
    if (!(await tx.removeTeacher(schoolId, classId, userId))) throw new HttpError(404, "assignment_not_found", "That teacher is not assigned to this class.");
    await audit(tx, auth, "class.teacher_removed", "class", classId, { userId });
    return detailOf(tx, schoolId, classId, today);
  });
}

export async function listTeachers(deps: Deps, auth: AuthContext): Promise<{ items: TeacherListItem[] }> {
  requireAction(auth, "teacher:read");
  return { items: await deps.admin.store.listTeachers(schoolIdOf(auth)) };
}

/** The classes the signed-in teacher may take registers for (the same set the offline bootstrap sends). */
export async function myClasses(deps: Deps, auth: AuthContext): Promise<MyClassesResponse> {
  requireAction(auth, "teaching:own-classes");
  const today = todayOf(deps, auth);
  return { today, classes: await deps.admin.store.myClasses(schoolIdOf(auth), auth.ctx.user.id, today) };
}
