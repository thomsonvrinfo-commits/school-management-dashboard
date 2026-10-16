/**
 * Slice 2 endpoints (school administration). Everything goes through the same `authed` request as Slice 1, so token
 * refresh, the "sign-in expired" banner and the network/API failure split behave identically. These calls need a
 * connection: unlike the attendance register they are not part of the offline replica.
 */
import type {
  AcademicYearDto, ChangeStudentStatusRequest, ClassDetail, ClassListQuery, ClassPage, CreateAcademicYearRequest, CreateClassRequest,
  CreateStudentRequest, CreateTermRequest, MyClassesResponse, PlaceStudentRequest, RosterResponse, SchoolProfile, StudentDetail, StudentListQuery,
  StudentPage, TeacherListItem, TermDto, UpdateAcademicYearRequest, UpdateClassRequest, UpdateSchoolRequest, UpdateStudentRequest,
  UpdateTermRequest,
} from "@schoolpulse/contracts";
import { authed } from "./api.ts";
import { queryString } from "./admin-forms.ts";

export const adminApi = {
  // school profile, years and terms
  school: () => authed<SchoolProfile>("GET", "/v1/school"),
  updateSchool: (body: UpdateSchoolRequest) => authed<SchoolProfile>("PATCH", "/v1/school", body),
  academicYears: () => authed<{ items: AcademicYearDto[] }>("GET", "/v1/academic-years"),
  createYear: (body: CreateAcademicYearRequest) => authed<AcademicYearDto>("POST", "/v1/academic-years", body),
  updateYear: (id: string, body: UpdateAcademicYearRequest) => authed<AcademicYearDto>("PATCH", `/v1/academic-years/${id}`, body),
  deleteYear: (id: string) => authed<void>("DELETE", `/v1/academic-years/${id}`),
  createTerm: (yearId: string, body: CreateTermRequest) => authed<TermDto>("POST", `/v1/academic-years/${yearId}/terms`, body),
  updateTerm: (id: string, body: UpdateTermRequest) => authed<TermDto>("PATCH", `/v1/terms/${id}`, body),
  deleteTerm: (id: string) => authed<void>("DELETE", `/v1/terms/${id}`),

  // students
  students: (query: StudentListQuery = {}) => authed<StudentPage>("GET", `/v1/students${queryString(query)}`),
  student: (id: string) => authed<StudentDetail>("GET", `/v1/students/${id}`),
  createStudent: (body: CreateStudentRequest) => authed<StudentDetail>("POST", "/v1/students", body),
  updateStudent: (id: string, body: UpdateStudentRequest) => authed<StudentDetail>("PATCH", `/v1/students/${id}`, body),
  changeStudentStatus: (id: string, body: ChangeStudentStatusRequest) => authed<StudentDetail>("POST", `/v1/students/${id}/status`, body),
  placeStudent: (id: string, body: PlaceStudentRequest) => authed<StudentDetail>("POST", `/v1/students/${id}/placements`, body),
  removePlacement: (id: string, placementId: string) => authed<StudentDetail>("DELETE", `/v1/students/${id}/placements/${placementId}`),

  // classes, rosters, teachers
  classes: (query: ClassListQuery = {}) => authed<ClassPage>("GET", `/v1/classes${queryString(query)}`),
  class: (id: string) => authed<ClassDetail>("GET", `/v1/classes/${id}`),
  createClass: (body: CreateClassRequest) => authed<ClassDetail>("POST", "/v1/classes", body),
  updateClass: (id: string, body: UpdateClassRequest) => authed<ClassDetail>("PATCH", `/v1/classes/${id}`, body),
  roster: (id: string, date?: string) => authed<RosterResponse>("GET", `/v1/classes/${id}/roster${queryString({ date })}`),
  teachers: () => authed<{ items: TeacherListItem[] }>("GET", "/v1/teachers"),
  assignTeacher: (classId: string, userId: string) => authed<ClassDetail>("POST", `/v1/classes/${classId}/teachers`, { userId }),
  removeTeacher: (classId: string, userId: string) => authed<ClassDetail>("DELETE", `/v1/classes/${classId}/teachers/${userId}`),
  myClasses: () => authed<MyClassesResponse>("GET", "/v1/me/classes"),
};
