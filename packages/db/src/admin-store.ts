/**
 * What the school-administration API needs from persistence (Slice 2). Implemented once, against PostgreSQL, next to
 * the Slice 1 `Store` and on the same `SqlRunner`. Every method takes the school id and filters by it: nothing here
 * can read or write another school's rows. Dates are plain `YYYY-MM-DD` strings.
 *
 * This layer stores and fetches. The RULES (what may change, when, and why not) live in packages/domain and in the
 * API services; the constraints in migration 0002 are the backstop if a rule is ever bypassed.
 */
import type { ClassStatus, Gender, StudentStatus } from "@schoolpulse/domain";
import type { AuditEntry } from "./store.ts";

export interface SchoolRow {
  id: string; name: string; code: string | null; timezone: string;
  contactEmail: string | null; contactPhone: string | null; address: string | null;
}
export type SchoolPatch = Partial<Omit<SchoolRow, "id">>;

export interface AcademicYearRow {
  id: string; name: string; startsOn: string; endsOn: string; isActive: boolean;
  /** Classes (of any status) that belong to this year. */
  classCount: number;
}
export interface NewAcademicYear { id: string; schoolId: string; name: string; startsOn: string; endsOn: string; isActive: boolean }
export type AcademicYearPatch = Partial<{ name: string; startsOn: string; endsOn: string; isActive: boolean }>;

export interface TermRow { id: string; academicYearId: string; name: string; startsOn: string; endsOn: string }
export interface NewTerm { id: string; schoolId: string; academicYearId: string; name: string; startsOn: string; endsOn: string }
export type TermPatch = Partial<{ name: string; startsOn: string; endsOn: string }>;

export interface AdminStudentRow {
  id: string; admissionNo: string; firstName: string; lastName: string; otherNames: string | null;
  dateOfBirth: string | null; gender: Gender | null; enrolmentDate: string; status: StudentStatus;
}
export interface NewStudent {
  id: string; schoolId: string; admissionNo: string; firstName: string; lastName: string; otherNames: string | null;
  dateOfBirth: string | null; gender: Gender | null; enrolmentDate: string;
}
export type StudentPatch = Partial<{
  admissionNo: string; firstName: string; lastName: string; otherNames: string | null;
  dateOfBirth: string | null; gender: Gender | null; enrolmentDate: string;
}>;

export interface StudentListRow {
  id: string; admissionNo: string; firstName: string; lastName: string; status: StudentStatus;
  currentClass: { id: string; name: string } | null;
  upcomingClass: { id: string; name: string; startsOn: string } | null;
}
export interface StudentFilter {
  /** Free text: every word must match the admission number, first name, last name or other names. */
  q?: string;
  /** Currently (today) in this class. */
  classId?: string;
  status?: StudentStatus;
  /** Enrolled but in no class today. */
  unplaced?: boolean;
}

/** One stretch of a student's time in one class. */
export interface EnrolmentRow {
  id: string; studentId: string; classId: string; className: string;
  academicYear: { id: string; name: string } | null;
  startsOn: string; endsOn: string | null;
}
export interface NewEnrolment { id: string; schoolId: string; studentId: string; classId: string; startsOn: string; createdBy: string }

export interface StudentAttendanceSummary { classId: string; className: string; days: number; lastDate: string | null }

export interface AdminClassRow {
  id: string; name: string; gradeLevel: string; stream: string | null; status: ClassStatus;
  academicYear: { id: string; name: string; startsOn: string; endsOn: string } | null;
  /** Students in the class today. */
  studentCount: number; teacherCount: number;
}
export interface NewClass {
  id: string; schoolId: string; name: string; gradeLevel: string; stream: string | null; academicYearId: string;
}
export type ClassPatch = Partial<{ name: string; gradeLevel: string; stream: string | null; academicYearId: string; status: ClassStatus }>;
export interface ClassFilter { q?: string; academicYearId?: string; status?: ClassStatus }

export interface TeacherRow { id: string; name: string; email: string; classCount: number }
export interface ClassTeacherRow { id: string; name: string }

export interface MyClassRow {
  id: string; name: string; gradeLevel: string; stream: string | null;
  academicYear: { id: string; name: string } | null; studentCount: number;
}

export interface Page<T> { items: T[]; total: number }

export interface AdminStore {
  // ---- school ----
  getSchool(schoolId: string): Promise<SchoolRow | null>;
  /** Serialises configuration changes (years, terms) within one school for the rest of the transaction. */
  lockSchool(schoolId: string): Promise<void>;
  updateSchool(schoolId: string, patch: SchoolPatch): Promise<SchoolRow>;

  // ---- academic years and terms ----
  listAcademicYears(schoolId: string): Promise<AcademicYearRow[]>;
  getAcademicYear(schoolId: string, id: string): Promise<AcademicYearRow | null>;
  insertAcademicYear(y: NewAcademicYear): Promise<void>;
  updateAcademicYear(schoolId: string, id: string, patch: AcademicYearPatch): Promise<void>;
  /** Make every year except `exceptId` inactive. */
  deactivateOtherYears(schoolId: string, exceptId: string): Promise<void>;
  deleteAcademicYear(schoolId: string, id: string): Promise<boolean>;
  countYearDependents(schoolId: string, id: string): Promise<{ classes: number; terms: number }>;
  /** Earliest and latest date on which anything already happened in this year's classes (a placement started or a register was taken). */
  yearActivityBounds(schoolId: string, id: string): Promise<{ firstDate: string | null; lastDate: string | null }>;
  listTerms(schoolId: string, academicYearId?: string): Promise<TermRow[]>;
  getTerm(schoolId: string, id: string): Promise<TermRow | null>;
  insertTerm(t: NewTerm): Promise<void>;
  updateTerm(schoolId: string, id: string, patch: TermPatch): Promise<void>;
  deleteTerm(schoolId: string, id: string): Promise<boolean>;

  // ---- students ----
  listStudents(schoolId: string, filter: StudentFilter, today: string, limit: number, offset: number): Promise<Page<StudentListRow>>;
  getStudent(schoolId: string, id: string): Promise<AdminStudentRow | null>;
  /**
   * Like getStudent, but takes a row lock so concurrent placement/status changes for one student queue up.
   * "No key update" on purpose: it queues admins against each other without blocking the foreign-key checks of a
   * register being saved at the same moment.
   */
  lockStudent(schoolId: string, id: string): Promise<AdminStudentRow | null>;
  insertStudent(s: NewStudent): Promise<void>;
  updateStudent(schoolId: string, id: string, patch: StudentPatch): Promise<void>;
  setStudentStatus(schoolId: string, id: string, status: StudentStatus): Promise<void>;
  /**
   * `lock: true` also locks the rows against a register being saved for them (the push path takes the matching share
   * lock): whoever comes second waits, so a move can never be decided on a register check that is already stale.
   */
  listEnrolments(schoolId: string, studentId: string, opts?: { lock?: boolean }): Promise<EnrolmentRow[]>;
  insertEnrolment(e: NewEnrolment): Promise<void>;
  closeEnrolment(schoolId: string, id: string, endsOn: string): Promise<void>;
  /** Make a closed placement open-ended again (used when the placement that replaced it is removed). */
  reopenEnrolment(schoolId: string, id: string): Promise<void>;
  deleteEnrolment(schoolId: string, id: string): Promise<boolean>;
  /** Is there any register entry for this student dated within [from, to] (`to` null = no upper bound)? */
  studentHasAttendanceBetween(schoolId: string, studentId: string, from: string, to: string | null): Promise<boolean>;
  studentAttendanceByClass(schoolId: string, studentId: string): Promise<StudentAttendanceSummary[]>;

  // ---- classes ----
  listClasses(schoolId: string, filter: ClassFilter, today: string, limit: number, offset: number): Promise<Page<AdminClassRow>>;
  getClass(schoolId: string, id: string, today: string): Promise<AdminClassRow | null>;
  lockClass(schoolId: string, id: string): Promise<boolean>;
  insertClass(c: NewClass): Promise<void>;
  updateClass(schoolId: string, id: string, patch: ClassPatch): Promise<void>;
  classHasEnrolments(schoolId: string, id: string): Promise<boolean>;
  classHasAttendance(schoolId: string, id: string): Promise<boolean>;
  /** Placements that have not finished: still open, or ending today or later (includes ones starting in the future). */
  classLiveEnrolmentCount(schoolId: string, id: string, today: string): Promise<number>;
  /** Earliest and latest date any placement or register of this class touches (placement starts and ends, register dates). */
  classActivityBounds(schoolId: string, id: string): Promise<{ firstDate: string | null; lastDate: string | null }>;

  // ---- teachers ----
  listTeachers(schoolId: string): Promise<TeacherRow[]>;
  /** The user, if they hold an ACTIVE TEACHER membership at this school; otherwise null. */
  getTeacher(schoolId: string, userId: string): Promise<TeacherRow | null>;
  listClassTeachers(schoolId: string, classId: string): Promise<ClassTeacherRow[]>;
  /** Returns false if the teacher was already assigned (nothing changes). */
  assignTeacher(schoolId: string, classId: string, userId: string, assignedBy: string): Promise<boolean>;
  /** Returns false if the teacher was not assigned. */
  removeTeacher(schoolId: string, classId: string, userId: string): Promise<boolean>;
  myClasses(schoolId: string, userId: string, today: string): Promise<MyClassRow[]>;

  // ---- audit (same transaction as the change it describes) ----
  appendAudit(e: AuditEntry): Promise<void>;
}

/** Runs `fn` in one database transaction with an AdminStore bound to it. */
export interface AdminDb {
  store: AdminStore;
  transaction<T>(fn: (store: AdminStore) => Promise<T>): Promise<T>;
}
