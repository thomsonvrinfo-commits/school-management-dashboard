import type { SqlClient, SqlParam, SqlRunner } from "./sql.ts";
import { PostgresStore } from "./postgres-store.ts";
import type { AuditEntry } from "./store.ts";
import type {
  AcademicYearPatch, AcademicYearRow, AdminClassRow, AdminDb, AdminStore, AdminStudentRow, ClassFilter, ClassPatch, ClassTeacherRow,
  EnrolmentRow, MyClassRow, NewAcademicYear, NewClass, NewEnrolment, NewStudent, NewTerm, Page, SchoolPatch, SchoolRow,
  StudentAttendanceSummary, StudentFilter, StudentListRow, StudentPatch, TeacherRow, TermPatch, TermRow,
} from "./admin-store.ts";

/** Dates always come back as `YYYY-MM-DD` text, whatever the driver does with native date types. */
const D = (col: string) => `to_char(${col}, 'YYYY-MM-DD')`;

/** Escape LIKE wildcards so a search for "50%" or "a_b" matches those characters literally. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Search words: split on whitespace, drop empties, cap the count so a pasted paragraph cannot build a huge query. */
function words(q: string | undefined): string[] {
  return (q ?? "").split(/\s+/).filter(Boolean).slice(0, 6);
}

/**
 * Builds `col = $n, col2 = $n+1` from a patch. Only column names listed in `columns` can ever appear in the SQL;
 * values are always parameters. `undefined` means "leave alone"; `null` means "set to NULL".
 */
function setClause(columns: Readonly<Record<string, string>>, patch: Record<string, SqlParam | undefined>, params: SqlParam[]): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const column = columns[key];
    if (!column) throw new TypeError(`Cannot patch unknown field: ${key}`);
    params.push(value);
    parts.push(`${column} = $${params.length}`);
  }
  if (parts.length === 0) throw new TypeError("Empty patch");
  return parts.join(", ");
}

const SCHOOL_COLS = { name: "name", code: "code", timezone: "timezone", contactEmail: "contact_email", contactPhone: "contact_phone", address: "address" };
const YEAR_COLS = { name: "name", startsOn: "starts_on", endsOn: "ends_on", isActive: "is_active" };
const TERM_COLS = { name: "name", startsOn: "starts_on", endsOn: "ends_on" };
const STUDENT_COLS = {
  admissionNo: "admission_no", firstName: "first_name", lastName: "last_name", otherNames: "other_names",
  dateOfBirth: "date_of_birth", gender: "gender", enrolmentDate: "enrolment_date",
};
const CLASS_COLS = { name: "name", gradeLevel: "grade_level", stream: "stream", academicYearId: "academic_year_id", status: "status" };

const SCHOOL_SELECT = `id, name, code, timezone, contact_email as "contactEmail", contact_phone as "contactPhone", address`;
const STUDENT_SELECT = `id, admission_no as "admissionNo", first_name as "firstName", last_name as "lastName", other_names as "otherNames",
       ${D("date_of_birth")} as "dateOfBirth", gender, ${D("enrolment_date")} as "enrolmentDate", status`;

/** SQL fragment: "this student is in a class today" (an enrolment row covering `$today`). */
const inClassToday = (studentAlias: string, today: string, classCond = "") =>
  `exists (select 1 from enrollments e where e.school_id = ${studentAlias}.school_id and e.student_id = ${studentAlias}.id
             and e.starts_on <= ${today}::date and (e.ends_on is null or e.ends_on >= ${today}::date)${classCond})`;

interface ClassSqlRow {
  id: string; name: string; gradeLevel: string; stream: string | null; status: AdminClassRow["status"];
  yearId: string | null; yearName: string | null; yearStarts: string | null; yearEnds: string | null;
  studentCount: number; teacherCount: number;
}

export class PostgresAdminStore implements AdminStore {
  private readonly db: SqlClient;
  private readonly base: PostgresStore;
  constructor(db: SqlClient) {
    this.db = db;
    this.base = new PostgresStore(db);
  }

  // ---------- school ----------

  async getSchool(schoolId: string): Promise<SchoolRow | null> {
    const rows = await this.db.query<SchoolRow>(`select ${SCHOOL_SELECT} from schools where id = $1`, [schoolId]);
    return rows[0] ?? null;
  }

  async lockSchool(schoolId: string): Promise<void> {
    await this.db.query(`select 1 from schools where id = $1 for update`, [schoolId]);
  }

  async updateSchool(schoolId: string, patch: SchoolPatch): Promise<SchoolRow> {
    const params: SqlParam[] = [schoolId];
    const set = setClause(SCHOOL_COLS, patch, params);
    const rows = await this.db.query<SchoolRow>(
      `update schools set ${set}, updated_at = now() where id = $1 returning ${SCHOOL_SELECT}`,
      params,
    );
    if (!rows[0]) throw new Error("School not found");
    return rows[0];
  }

  // ---------- academic years and terms ----------

  private yearSelect(where: string) {
    return `select y.id, y.name, ${D("y.starts_on")} as "startsOn", ${D("y.ends_on")} as "endsOn", y.is_active as "isActive",
                   (select count(*) from classes c where c.school_id = y.school_id and c.academic_year_id = y.id)::int as "classCount"
              from academic_years y where y.school_id = $1 ${where}`;
  }

  async listAcademicYears(schoolId: string): Promise<AcademicYearRow[]> {
    return this.db.query<AcademicYearRow>(`${this.yearSelect("")} order by y.starts_on desc`, [schoolId]);
  }

  async getAcademicYear(schoolId: string, id: string): Promise<AcademicYearRow | null> {
    const rows = await this.db.query<AcademicYearRow>(this.yearSelect("and y.id = $2"), [schoolId, id]);
    return rows[0] ?? null;
  }

  async insertAcademicYear(y: NewAcademicYear): Promise<void> {
    await this.db.query(
      `insert into academic_years (id, school_id, name, starts_on, ends_on, is_active) values ($1, $2, $3, $4::date, $5::date, $6)`,
      [y.id, y.schoolId, y.name, y.startsOn, y.endsOn, y.isActive],
    );
  }

  async updateAcademicYear(schoolId: string, id: string, patch: AcademicYearPatch): Promise<void> {
    const params: SqlParam[] = [schoolId, id];
    const set = setClause(YEAR_COLS, patch, params);
    await this.db.query(`update academic_years set ${set}, updated_at = now() where school_id = $1 and id = $2`, params);
  }

  async deactivateOtherYears(schoolId: string, exceptId: string): Promise<void> {
    await this.db.query(
      `update academic_years set is_active = false, updated_at = now() where school_id = $1 and is_active and id <> $2`,
      [schoolId, exceptId],
    );
  }

  async deleteAcademicYear(schoolId: string, id: string): Promise<boolean> {
    const rows = await this.db.query(`delete from academic_years where school_id = $1 and id = $2 returning id`, [schoolId, id]);
    return rows.length > 0;
  }

  async countYearDependents(schoolId: string, id: string): Promise<{ classes: number; terms: number }> {
    const rows = await this.db.query<{ classes: number; terms: number }>(
      `select (select count(*) from classes where school_id = $1 and academic_year_id = $2)::int as classes,
              (select count(*) from terms where school_id = $1 and academic_year_id = $2)::int as terms`,
      [schoolId, id],
    );
    return rows[0]!;
  }

  private termSelect(where: string) {
    return `select id, academic_year_id as "academicYearId", name, ${D("starts_on")} as "startsOn", ${D("ends_on")} as "endsOn"
              from terms where school_id = $1 ${where}`;
  }

  async listTerms(schoolId: string, academicYearId?: string): Promise<TermRow[]> {
    if (academicYearId) return this.db.query<TermRow>(`${this.termSelect("and academic_year_id = $2")} order by starts_on`, [schoolId, academicYearId]);
    return this.db.query<TermRow>(`${this.termSelect("")} order by starts_on`, [schoolId]);
  }

  async getTerm(schoolId: string, id: string): Promise<TermRow | null> {
    const rows = await this.db.query<TermRow>(this.termSelect("and id = $2"), [schoolId, id]);
    return rows[0] ?? null;
  }

  async insertTerm(t: NewTerm): Promise<void> {
    await this.db.query(
      `insert into terms (id, school_id, academic_year_id, name, starts_on, ends_on) values ($1, $2, $3, $4, $5::date, $6::date)`,
      [t.id, t.schoolId, t.academicYearId, t.name, t.startsOn, t.endsOn],
    );
  }

  async updateTerm(schoolId: string, id: string, patch: TermPatch): Promise<void> {
    const params: SqlParam[] = [schoolId, id];
    const set = setClause(TERM_COLS, patch, params);
    await this.db.query(`update terms set ${set}, updated_at = now() where school_id = $1 and id = $2`, params);
  }

  async deleteTerm(schoolId: string, id: string): Promise<boolean> {
    const rows = await this.db.query(`delete from terms where school_id = $1 and id = $2 returning id`, [schoolId, id]);
    return rows.length > 0;
  }

  // ---------- students ----------

  private studentConditions(schoolId: string, f: StudentFilter, today: string, params: SqlParam[]): string {
    const add = (v: SqlParam) => `$${params.push(v)}`;
    const conds = [`s.school_id = ${add(schoolId)}`];
    for (const w of words(f.q)) {
      const p = add(`%${escapeLike(w)}%`);
      conds.push(
        `(s.admission_no ilike ${p} escape '\\' or s.first_name ilike ${p} escape '\\' or s.last_name ilike ${p} escape '\\' or coalesce(s.other_names, '') ilike ${p} escape '\\')`,
      );
    }
    if (f.status) conds.push(`s.status = ${add(f.status)}`);
    if (f.classId) conds.push(inClassToday("s", add(today), ` and e.class_id = ${add(f.classId)}::uuid`));
    if (f.unplaced) conds.push(`s.status = 'enrolled' and not ${inClassToday("s", add(today))}`);
    return conds.join(" and ");
  }

  async listStudents(schoolId: string, filter: StudentFilter, today: string, limit: number, offset: number): Promise<Page<StudentListRow>> {
    const countParams: SqlParam[] = [];
    const where = this.studentConditions(schoolId, filter, today, countParams);
    const total = (await this.db.query<{ n: number }>(`select count(*)::int as n from students s where ${where}`, countParams))[0]!.n;

    const params: SqlParam[] = [];
    const where2 = this.studentConditions(schoolId, filter, today, params);
    const todayP = `$${params.push(today)}`;
    const limitP = `$${params.push(limit)}`;
    const offsetP = `$${params.push(offset)}`;
    const rows = await this.db.query<{
      id: string; admissionNo: string; firstName: string; lastName: string; status: StudentListRow["status"];
      curId: string | null; curName: string | null; upId: string | null; upName: string | null; upStarts: string | null;
    }>(
      `select s.id, s.admission_no as "admissionNo", s.first_name as "firstName", s.last_name as "lastName", s.status,
              cur.class_id as "curId", cur.name as "curName", up.class_id as "upId", up.name as "upName", ${D("up.starts_on")} as "upStarts"
         from students s
         left join lateral (
           select e.class_id, c.name from enrollments e join classes c on c.school_id = e.school_id and c.id = e.class_id
            where e.school_id = s.school_id and e.student_id = s.id and e.starts_on <= ${todayP}::date and (e.ends_on is null or e.ends_on >= ${todayP}::date)
            limit 1) cur on true
         left join lateral (
           select e.class_id, c.name, e.starts_on from enrollments e join classes c on c.school_id = e.school_id and c.id = e.class_id
            where e.school_id = s.school_id and e.student_id = s.id and e.starts_on > ${todayP}::date
            order by e.starts_on limit 1) up on true
        where ${where2}
        order by lower(s.last_name), lower(s.first_name), s.id
        limit ${limitP} offset ${offsetP}`,
      params,
    );
    return {
      total,
      items: rows.map((r) => ({
        id: r.id, admissionNo: r.admissionNo, firstName: r.firstName, lastName: r.lastName, status: r.status,
        currentClass: r.curId ? { id: r.curId, name: r.curName! } : null,
        upcomingClass: r.upId ? { id: r.upId, name: r.upName!, startsOn: r.upStarts! } : null,
      })),
    };
  }

  async getStudent(schoolId: string, id: string): Promise<AdminStudentRow | null> {
    const rows = await this.db.query<AdminStudentRow>(`select ${STUDENT_SELECT} from students where school_id = $1 and id = $2`, [schoolId, id]);
    return rows[0] ?? null;
  }

  async lockStudent(schoolId: string, id: string): Promise<AdminStudentRow | null> {
    const rows = await this.db.query<AdminStudentRow>(
      `select ${STUDENT_SELECT} from students where school_id = $1 and id = $2 for update`,
      [schoolId, id],
    );
    return rows[0] ?? null;
  }

  async insertStudent(s: NewStudent): Promise<void> {
    await this.db.query(
      `insert into students (id, school_id, admission_no, first_name, last_name, other_names, date_of_birth, gender, enrolment_date)
       values ($1, $2, $3, $4, $5, $6, $7::date, $8, $9::date)`,
      [s.id, s.schoolId, s.admissionNo, s.firstName, s.lastName, s.otherNames, s.dateOfBirth, s.gender, s.enrolmentDate],
    );
  }

  async updateStudent(schoolId: string, id: string, patch: StudentPatch): Promise<void> {
    const params: SqlParam[] = [schoolId, id];
    const set = setClause(STUDENT_COLS, patch, params);
    await this.db.query(`update students set ${set}, updated_at = now() where school_id = $1 and id = $2`, params);
  }

  async setStudentStatus(schoolId: string, id: string, status: StudentListRow["status"]): Promise<void> {
    await this.db.query(`update students set status = $3, updated_at = now() where school_id = $1 and id = $2`, [schoolId, id, status]);
  }

  async listEnrolments(schoolId: string, studentId: string): Promise<EnrolmentRow[]> {
    const rows = await this.db.query<{
      id: string; studentId: string; classId: string; className: string; yearId: string | null; yearName: string | null;
      startsOn: string; endsOn: string | null;
    }>(
      `select e.id, e.student_id as "studentId", e.class_id as "classId", c.name as "className", y.id as "yearId", y.name as "yearName",
              ${D("e.starts_on")} as "startsOn", ${D("e.ends_on")} as "endsOn"
         from enrollments e
         join classes c on c.school_id = e.school_id and c.id = e.class_id
         left join academic_years y on y.school_id = c.school_id and y.id = c.academic_year_id
        where e.school_id = $1 and e.student_id = $2
        order by e.starts_on, e.id`,
      [schoolId, studentId],
    );
    return rows.map((r) => ({
      id: r.id, studentId: r.studentId, classId: r.classId, className: r.className,
      academicYear: r.yearId ? { id: r.yearId, name: r.yearName! } : null,
      startsOn: r.startsOn, endsOn: r.endsOn,
    }));
  }

  async insertEnrolment(e: NewEnrolment): Promise<void> {
    await this.db.query(
      `insert into enrollments (id, school_id, student_id, class_id, starts_on, created_by) values ($1, $2, $3, $4, $5::date, $6)`,
      [e.id, e.schoolId, e.studentId, e.classId, e.startsOn, e.createdBy],
    );
  }

  async closeEnrolment(schoolId: string, id: string, endsOn: string): Promise<void> {
    await this.db.query(`update enrollments set ends_on = $3::date where school_id = $1 and id = $2`, [schoolId, id, endsOn]);
  }

  async deleteEnrolment(schoolId: string, id: string): Promise<boolean> {
    const rows = await this.db.query(`delete from enrollments where school_id = $1 and id = $2 returning id`, [schoolId, id]);
    return rows.length > 0;
  }

  async studentHasAttendanceBetween(schoolId: string, studentId: string, from: string, to: string | null): Promise<boolean> {
    const rows = await this.db.query(
      `select 1 from attendance_records where school_id = $1 and student_id = $2 and date >= $3::date and ($4::date is null or date <= $4::date) limit 1`,
      [schoolId, studentId, from, to],
    );
    return rows.length > 0;
  }

  async studentAttendanceByClass(schoolId: string, studentId: string): Promise<StudentAttendanceSummary[]> {
    return this.db.query<StudentAttendanceSummary>(
      `select a.class_id as "classId", c.name as "className", count(*)::int as days, ${D("max(a.date)")} as "lastDate"
         from attendance_records a join classes c on c.school_id = a.school_id and c.id = a.class_id
        where a.school_id = $1 and a.student_id = $2
        group by a.class_id, c.name order by max(a.date)`,
      [schoolId, studentId],
    );
  }

  // ---------- classes ----------

  private classConditions(schoolId: string, f: ClassFilter, params: SqlParam[]): string {
    const add = (v: SqlParam) => `$${params.push(v)}`;
    const conds = [`c.school_id = ${add(schoolId)}`];
    for (const w of words(f.q)) {
      const p = add(`%${escapeLike(w)}%`);
      conds.push(`(c.name ilike ${p} escape '\\' or c.grade_level ilike ${p} escape '\\' or coalesce(c.stream, '') ilike ${p} escape '\\')`);
    }
    if (f.academicYearId) conds.push(`c.academic_year_id = ${add(f.academicYearId)}::uuid`);
    if (f.status) conds.push(`c.status = ${add(f.status)}`);
    return conds.join(" and ");
  }

  private classSelect(todayParam: string) {
    return `select c.id, c.name, c.grade_level as "gradeLevel", c.stream, c.status,
                   y.id as "yearId", y.name as "yearName", ${D("y.starts_on")} as "yearStarts", ${D("y.ends_on")} as "yearEnds",
                   (select count(*) from enrollments e where e.school_id = c.school_id and e.class_id = c.id
                       and e.starts_on <= ${todayParam}::date and (e.ends_on is null or e.ends_on >= ${todayParam}::date))::int as "studentCount",
                   (select count(*) from class_teachers ct where ct.school_id = c.school_id and ct.class_id = c.id)::int as "teacherCount"
              from classes c left join academic_years y on y.school_id = c.school_id and y.id = c.academic_year_id`;
  }

  private toClassRow(r: ClassSqlRow): AdminClassRow {
    return {
      id: r.id, name: r.name, gradeLevel: r.gradeLevel, stream: r.stream, status: r.status,
      academicYear: r.yearId ? { id: r.yearId, name: r.yearName!, startsOn: r.yearStarts!, endsOn: r.yearEnds! } : null,
      studentCount: r.studentCount, teacherCount: r.teacherCount,
    };
  }

  async listClasses(schoolId: string, filter: ClassFilter, today: string, limit: number, offset: number): Promise<Page<AdminClassRow>> {
    const countParams: SqlParam[] = [];
    const where = this.classConditions(schoolId, filter, countParams);
    const total = (await this.db.query<{ n: number }>(`select count(*)::int as n from classes c where ${where}`, countParams))[0]!.n;

    const params: SqlParam[] = [];
    const where2 = this.classConditions(schoolId, filter, params);
    const todayP = `$${params.push(today)}`;
    const limitP = `$${params.push(limit)}`;
    const offsetP = `$${params.push(offset)}`;
    const rows = await this.db.query<ClassSqlRow>(
      `${this.classSelect(todayP)}
        where ${where2}
        order by y.starts_on desc nulls last, length(c.grade_level), c.grade_level, lower(c.name), c.id
        limit ${limitP} offset ${offsetP}`,
      params,
    );
    return { total, items: rows.map((r) => this.toClassRow(r)) };
  }

  async getClass(schoolId: string, id: string, today: string): Promise<AdminClassRow | null> {
    const rows = await this.db.query<ClassSqlRow>(
      `${this.classSelect("$3")} where c.school_id = $1 and c.id = $2`,
      [schoolId, id, today],
    );
    return rows[0] ? this.toClassRow(rows[0]) : null;
  }

  async lockClass(schoolId: string, id: string): Promise<boolean> {
    const rows = await this.db.query(`select 1 from classes where school_id = $1 and id = $2 for update`, [schoolId, id]);
    return rows.length > 0;
  }

  async insertClass(c: NewClass): Promise<void> {
    await this.db.query(
      `insert into classes (id, school_id, name, grade_level, stream, academic_year_id) values ($1, $2, $3, $4, $5, $6)`,
      [c.id, c.schoolId, c.name, c.gradeLevel, c.stream, c.academicYearId],
    );
  }

  async updateClass(schoolId: string, id: string, patch: ClassPatch): Promise<void> {
    const params: SqlParam[] = [schoolId, id];
    const set = setClause(CLASS_COLS, patch, params);
    await this.db.query(`update classes set ${set}, updated_at = now() where school_id = $1 and id = $2`, params);
  }

  async classHasEnrolments(schoolId: string, id: string): Promise<boolean> {
    return (await this.db.query(`select 1 from enrollments where school_id = $1 and class_id = $2 limit 1`, [schoolId, id])).length > 0;
  }

  async classHasAttendance(schoolId: string, id: string): Promise<boolean> {
    return (await this.db.query(`select 1 from attendance_records where school_id = $1 and class_id = $2 limit 1`, [schoolId, id])).length > 0;
  }

  async classEnrolmentStarts(schoolId: string, id: string): Promise<string[]> {
    const rows = await this.db.query<{ d: string }>(
      `select distinct ${D("starts_on")} as d from enrollments where school_id = $1 and class_id = $2 order by d`,
      [schoolId, id],
    );
    return rows.map((r) => r.d);
  }

  // ---------- teachers ----------

  async listTeachers(schoolId: string): Promise<TeacherRow[]> {
    return this.db.query<TeacherRow>(
      `select u.id, u.name, u.email,
              (select count(*) from class_teachers ct join classes c on c.school_id = ct.school_id and c.id = ct.class_id
                where ct.school_id = m.school_id and ct.user_id = u.id and c.status = 'active')::int as "classCount"
         from memberships m join users u on u.id = m.user_id and u.active
        where m.school_id = $1 and m.role = 'teacher' and m.active
        order by lower(u.name), u.id`,
      [schoolId],
    );
  }

  async getTeacher(schoolId: string, userId: string): Promise<TeacherRow | null> {
    const rows = await this.db.query<TeacherRow>(
      `select u.id, u.name, u.email,
              (select count(*) from class_teachers ct join classes c on c.school_id = ct.school_id and c.id = ct.class_id
                where ct.school_id = m.school_id and ct.user_id = u.id and c.status = 'active')::int as "classCount"
         from memberships m join users u on u.id = m.user_id and u.active
        where m.school_id = $1 and m.user_id = $2 and m.role = 'teacher' and m.active`,
      [schoolId, userId],
    );
    return rows[0] ?? null;
  }

  async listClassTeachers(schoolId: string, classId: string): Promise<ClassTeacherRow[]> {
    return this.db.query<ClassTeacherRow>(
      `select u.id, u.name from class_teachers ct join users u on u.id = ct.user_id
        where ct.school_id = $1 and ct.class_id = $2 order by lower(u.name), u.id`,
      [schoolId, classId],
    );
  }

  async assignTeacher(schoolId: string, classId: string, userId: string, assignedBy: string): Promise<boolean> {
    const rows = await this.db.query(
      `insert into class_teachers (school_id, class_id, user_id, created_by) values ($1, $2, $3, $4)
       on conflict (class_id, user_id) do nothing returning user_id`,
      [schoolId, classId, userId, assignedBy],
    );
    return rows.length > 0;
  }

  async removeTeacher(schoolId: string, classId: string, userId: string): Promise<boolean> {
    const rows = await this.db.query(
      `delete from class_teachers where school_id = $1 and class_id = $2 and user_id = $3 returning user_id`,
      [schoolId, classId, userId],
    );
    return rows.length > 0;
  }

  async myClasses(schoolId: string, userId: string, today: string): Promise<MyClassRow[]> {
    const rows = await this.db.query<{
      id: string; name: string; gradeLevel: string; stream: string | null; yearId: string | null; yearName: string | null; studentCount: number;
    }>(
      `select c.id, c.name, c.grade_level as "gradeLevel", c.stream, y.id as "yearId", y.name as "yearName",
              (select count(*) from enrollments e where e.school_id = c.school_id and e.class_id = c.id
                  and e.starts_on <= $3::date and (e.ends_on is null or e.ends_on >= $3::date))::int as "studentCount"
         from classes c
         join class_teachers ct on ct.school_id = c.school_id and ct.class_id = c.id
         left join academic_years y on y.school_id = c.school_id and y.id = c.academic_year_id
        where c.school_id = $1 and ct.user_id = $2 and c.status = 'active'
        order by c.name`,
      [schoolId, userId, today],
    );
    return rows.map((r) => ({
      id: r.id, name: r.name, gradeLevel: r.gradeLevel, stream: r.stream,
      academicYear: r.yearId ? { id: r.yearId, name: r.yearName! } : null, studentCount: r.studentCount,
    }));
  }

  // ---------- audit ----------

  appendAudit(e: AuditEntry): Promise<void> {
    return this.base.appendAudit(e);
  }
}

export function createAdminDb(runner: SqlRunner): AdminDb {
  return {
    store: new PostgresAdminStore(runner),
    transaction: (fn) => runner.transaction((tx) => fn(new PostgresAdminStore(tx))),
  };
}
