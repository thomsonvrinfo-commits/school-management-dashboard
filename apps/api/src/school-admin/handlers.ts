/**
 * School-administration endpoints as plain functions: role gate, then parse input with the shared contracts, then call
 * the service. Keyed "METHOD path" exactly like routes.ts, which is the single list of what exists and who may call it.
 */
import {
  assignTeacherRequest, changeStudentStatusRequest, classListQuery, createAcademicYearRequest, createClassRequest, createStudentRequest,
  createTermRequest, placeStudentRequest, rosterQuery, studentListQuery, updateAcademicYearRequest, updateClassRequest, updateSchoolRequest,
  updateStudentRequest, updateTermRequest, uuid,
} from "@schoolpulse/contracts";
import { SCHOOL_ADMIN_ROUTES, routeKey } from "../routes.ts";
import type { AdminHandler } from "./http.ts";
import { guardedBy, idParam, readBody, readQuery } from "./http.ts";
import { assignTeacher, classRoster, createClass, getClass, listClasses, listTeachers, myClasses, removeTeacher, updateClass } from "./classes.ts";
import {
  createAcademicYear, createTerm, deleteAcademicYear, deleteTerm, getSchoolProfile, listAcademicYears, updateAcademicYear, updateSchoolProfile, updateTerm,
} from "./school.ts";
import { changeStudentStatus, getStudent, listStudents, placeStudent, registerStudent, removePlacement, updateStudent } from "./students.ts";

const guarded = guardedBy(SCHOOL_ADMIN_ROUTES);

const id = (req: Parameters<AdminHandler>[2]) => idParam(req, "id", uuid);

export const SCHOOL_ADMIN_HANDLERS: Readonly<Record<string, AdminHandler>> = {
  "GET /v1/school": guarded("GET /v1/school", async (d, a) => ({ status: 200, body: await getSchoolProfile(d, a) })),
  "PATCH /v1/school": guarded("PATCH /v1/school", async (d, a, r) => ({ status: 200, body: await updateSchoolProfile(d, a, await readBody(r, updateSchoolRequest)) })),

  "GET /v1/academic-years": guarded("GET /v1/academic-years", async (d, a) => ({ status: 200, body: await listAcademicYears(d, a) })),
  "POST /v1/academic-years": guarded("POST /v1/academic-years", async (d, a, r) => ({ status: 201, body: await createAcademicYear(d, a, await readBody(r, createAcademicYearRequest)) })),
  "PATCH /v1/academic-years/:id": guarded("PATCH /v1/academic-years/:id", async (d, a, r) => {
    const yearId = id(r);
    return { status: 200, body: await updateAcademicYear(d, a, yearId, await readBody(r, updateAcademicYearRequest)) };
  }),
  "DELETE /v1/academic-years/:id": guarded("DELETE /v1/academic-years/:id", async (d, a, r) => {
    await deleteAcademicYear(d, a, id(r));
    return { status: 204 };
  }),
  "POST /v1/academic-years/:id/terms": guarded("POST /v1/academic-years/:id/terms", async (d, a, r) => {
    const yearId = id(r);
    return { status: 201, body: await createTerm(d, a, yearId, await readBody(r, createTermRequest)) };
  }),
  "PATCH /v1/terms/:id": guarded("PATCH /v1/terms/:id", async (d, a, r) => {
    const termId = id(r);
    return { status: 200, body: await updateTerm(d, a, termId, await readBody(r, updateTermRequest)) };
  }),
  "DELETE /v1/terms/:id": guarded("DELETE /v1/terms/:id", async (d, a, r) => {
    await deleteTerm(d, a, id(r));
    return { status: 204 };
  }),

  "GET /v1/students": guarded("GET /v1/students", async (d, a, r) => ({ status: 200, body: await listStudents(d, a, readQuery(r, studentListQuery)) })),
  "POST /v1/students": guarded("POST /v1/students", async (d, a, r) => ({ status: 201, body: await registerStudent(d, a, await readBody(r, createStudentRequest)) })),
  "GET /v1/students/:id": guarded("GET /v1/students/:id", async (d, a, r) => ({ status: 200, body: await getStudent(d, a, id(r)) })),
  "PATCH /v1/students/:id": guarded("PATCH /v1/students/:id", async (d, a, r) => {
    const studentId = id(r);
    return { status: 200, body: await updateStudent(d, a, studentId, await readBody(r, updateStudentRequest)) };
  }),
  "POST /v1/students/:id/status": guarded("POST /v1/students/:id/status", async (d, a, r) => {
    const studentId = id(r);
    return { status: 200, body: await changeStudentStatus(d, a, studentId, await readBody(r, changeStudentStatusRequest)) };
  }),
  "POST /v1/students/:id/placements": guarded("POST /v1/students/:id/placements", async (d, a, r) => {
    const studentId = id(r);
    return { status: 201, body: await placeStudent(d, a, studentId, await readBody(r, placeStudentRequest)) };
  }),
  "DELETE /v1/students/:id/placements/:placementId": guarded("DELETE /v1/students/:id/placements/:placementId", async (d, a, r) => {
    const studentId = id(r);
    return { status: 200, body: await removePlacement(d, a, studentId, idParam(r, "placementId", uuid)) };
  }),

  "GET /v1/classes": guarded("GET /v1/classes", async (d, a, r) => ({ status: 200, body: await listClasses(d, a, readQuery(r, classListQuery)) })),
  "POST /v1/classes": guarded("POST /v1/classes", async (d, a, r) => ({ status: 201, body: await createClass(d, a, await readBody(r, createClassRequest)) })),
  "GET /v1/classes/:id": guarded("GET /v1/classes/:id", async (d, a, r) => ({ status: 200, body: await getClass(d, a, id(r)) })),
  "PATCH /v1/classes/:id": guarded("PATCH /v1/classes/:id", async (d, a, r) => {
    const classId = id(r);
    return { status: 200, body: await updateClass(d, a, classId, await readBody(r, updateClassRequest)) };
  }),
  "GET /v1/classes/:id/roster": guarded("GET /v1/classes/:id/roster", async (d, a, r) => {
    const classId = id(r);
    return { status: 200, body: await classRoster(d, a, classId, readQuery(r, rosterQuery).date) };
  }),
  "POST /v1/classes/:id/teachers": guarded("POST /v1/classes/:id/teachers", async (d, a, r) => {
    const classId = id(r);
    return { status: 200, body: await assignTeacher(d, a, classId, await readBody(r, assignTeacherRequest)) };
  }),
  "DELETE /v1/classes/:id/teachers/:userId": guarded("DELETE /v1/classes/:id/teachers/:userId", async (d, a, r) => {
    const classId = id(r);
    return { status: 200, body: await removeTeacher(d, a, classId, idParam(r, "userId", uuid)) };
  }),

  "GET /v1/teachers": guarded("GET /v1/teachers", async (d, a) => ({ status: 200, body: await listTeachers(d, a) })),
  "GET /v1/me/classes": guarded("GET /v1/me/classes", async (d, a) => ({ status: 200, body: await myClasses(d, a) })),
};

export const schoolAdminKeys = (): string[] => SCHOOL_ADMIN_ROUTES.map(routeKey);
