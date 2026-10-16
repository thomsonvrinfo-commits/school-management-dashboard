import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase, pgTestsEnabled, type TestDatabase } from "../testing/pg-test-runner.ts";
import { classifyDbError, createAdminDb, seedDev, DEV_IDS, escapeLike, type AdminDb } from "../src/index.ts";

const skip = pgTestsEnabled() ? false : "no PostgreSQL configured (set PSQL_TEST_CONN)";
const TODAY = "2026-10-08"; // Thursday
const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ID = {
  y26: u(3001), y25: u(3002), y27: u(3003), t1: u(3011), t2: u(3012),
  otherSchool: u(2), otherTeacher: u(13), otherMembership: u(23), otherClass: u(200), otherStudent: u(2900), otherYear: u(3100),
  chipoOther: u(3201), // Ms. Chipo also exists as a teacher... only at Mavambo
  inactiveTeacher: u(3301), inactiveTeacherMembership: u(3302), headAsTeacher: DEV_IDS.head,
  c26_7A: u(4001), c26_7B: u(4002), c27_7A: u(4003),
  stuA: u(5001), stuB: u(5002),
};
const S = DEV_IDS.school;

let t: TestDatabase;
let admin: AdminDb;
const q = <T = Record<string, unknown>>(sql: string, p: (string | number | null)[] = []) => t.runner.query<T>(sql, p);

before(async () => {
  if (skip) return;
  t = await createTestDatabase();
  await seedDev(t.runner, { today: TODAY, passwordHash: "x" });
  admin = createAdminDb(t.runner);
  await q(`insert into schools (id, name, code) values ($1, 'Other School', 'OTHER-1')`, [ID.otherSchool]);
  await q(`insert into users (id, email, name, password_hash) values ($1, 'teacher@other.example', 'Other Teacher', 'x')`, [ID.otherTeacher]);
  await q(`insert into memberships (id, user_id, school_id, role) values ($1, $2, $3, 'teacher')`, [ID.otherMembership, ID.otherTeacher, ID.otherSchool]);
  await q(`insert into classes (id, school_id, name, grade_level) values ($1, $2, 'Form 1A', '8')`, [ID.otherClass, ID.otherSchool]);
  await q(`insert into students (id, school_id, admission_no, first_name, last_name) values ($1, $2, 'MA1001', 'Other', 'Student')`, [ID.otherStudent, ID.otherSchool]);
  await q(`insert into users (id, email, name, password_hash, active) values ($1, 'gone@mavambo.example', 'Gone Teacher', 'x', true)`, [ID.inactiveTeacher]);
  await q(`insert into memberships (id, user_id, school_id, role, active) values ($1, $2, $3, 'teacher', false)`, [ID.inactiveTeacherMembership, ID.inactiveTeacher, S]);
});
after(async () => {
  if (!skip) await t.drop();
});

/** The database refuses `fn`, for this kind of reason and (optionally) this constraint. */
async function refuses(fn: () => Promise<unknown>, kind: string, constraint?: string) {
  try {
    await fn();
  } catch (e) {
    const info = classifyDbError(e);
    assert.equal(info.kind, kind, `expected a ${kind} violation, got ${info.kind}: ${(e as Error).message.split("\n")[0]}`);
    if (constraint) assert.equal(info.constraint, constraint);
    return;
  }
  assert.fail(`expected the database to refuse this (${kind})`);
}

// ---------------------------------------------------------------------------------------------------------------

test("classifyDbError reads both postgres.js errors (SQLSTATE) and plain message text", () => {
  assert.deepEqual(classifyDbError({ code: "23505", constraint_name: "x_key", message: "duplicate" }), { kind: "unique", constraint: "x_key" });
  assert.deepEqual(classifyDbError({ code: "23P01", message: 'conflicting key value violates exclusion constraint "enrollments_no_overlap"' }), { kind: "exclusion", constraint: "enrollments_no_overlap" });
  assert.deepEqual(classifyDbError(new Error('ERROR:  duplicate key value violates unique constraint "students_school_admission_ci_key"\nDETAIL: Key')), { kind: "unique", constraint: "students_school_admission_ci_key" });
  assert.deepEqual(classifyDbError(new Error('ERROR:  insert or update on table "x" violates foreign key constraint "x_fk"')), { kind: "foreign_key", constraint: "x_fk" });
  assert.deepEqual(classifyDbError(new Error('new row for relation "x" violates check constraint "x_check"')), { kind: "check", constraint: "x_check" });
  assert.deepEqual(classifyDbError(new Error("class_teachers_teacher_membership: user a is not an active teacher at school b")), { kind: "check", constraint: "class_teachers_teacher_membership" });
  assert.deepEqual(classifyDbError(new Error('null value in column "name" of relation "x" violates not-null constraint')), { kind: "not_null", constraint: null });
  assert.deepEqual(classifyDbError(new Error("connection reset")), { kind: "other", constraint: null });
  assert.deepEqual(classifyDbError(null), { kind: "other", constraint: null });
  assert.deepEqual(classifyDbError({ code: "23505" }), { kind: "unique", constraint: null });
});

test("escapeLike makes % and _ ordinary characters", () => {
  assert.equal(escapeLike("50%_a\\b"), "50\\%\\_a\\\\b");
});

// ---------- school ----------

test("school profile: read, partial update, clearing a field, and unique school codes", { skip }, async () => {
  const before = await admin.store.getSchool(S);
  assert.deepEqual([before!.name, before!.code, before!.timezone], ["Mavambo Academy", null, "Africa/Harare"]);
  const after = await admin.store.updateSchool(S, { code: "MAV-001", contactEmail: "office@mavambo.example", address: "12 School Road, Harare" });
  assert.deepEqual([after.name, after.code, after.contactEmail, after.address, after.contactPhone], ["Mavambo Academy", "MAV-001", "office@mavambo.example", "12 School Road, Harare", null]);
  assert.equal((await admin.store.updateSchool(S, { address: null })).address, null);
  // another school cannot take the same code, in any capitalisation
  await refuses(() => admin.store.updateSchool(ID.otherSchool, { code: "mav-001" }), "unique", "schools_code_key");
  // and a school can never be patched through a column the code does not know about
  await assert.rejects(admin.store.updateSchool(S, { password_hash: "x" } as never), /unknown field/);
  await assert.rejects(admin.store.updateSchool(S, {}), /Empty patch/);
  await refuses(() => admin.store.updateSchool(S, { code: "x" }), "check", "schools_code_format");
});

test("updating a school that does not exist is an error, not a silent no-op", { skip }, async () => {
  await assert.rejects(admin.store.updateSchool(u(99999), { name: "Ghost" }), /not found/i);
  assert.equal(await admin.store.getSchool(u(99999)), null);
});

// ---------- academic years and terms ----------

test("academic years: at most one active per school, no overlap, unique names, sane dates", { skip }, async () => {
  const s = admin.store;
  await s.insertAcademicYear({ id: ID.y26, schoolId: S, name: "2026", startsOn: "2026-01-13", endsOn: "2026-12-04", isActive: true });
  await s.insertAcademicYear({ id: ID.y25, schoolId: S, name: "2025", startsOn: "2025-01-14", endsOn: "2025-12-05", isActive: false });
  // a second active year is refused by the database itself
  await refuses(() => s.insertAcademicYear({ id: ID.y27, schoolId: S, name: "2027", startsOn: "2027-01-12", endsOn: "2027-12-03", isActive: true }), "unique", "academic_years_one_active");
  // overlapping dates are refused, even by one day
  await refuses(() => s.insertAcademicYear({ id: ID.y27, schoolId: S, name: "2027", startsOn: "2026-12-04", endsOn: "2027-12-03", isActive: false }), "exclusion", "academic_years_no_overlap");
  // names are unique per school, ignoring case
  await refuses(() => s.insertAcademicYear({ id: ID.y27, schoolId: S, name: " 2026".trim(), startsOn: "2027-01-12", endsOn: "2027-12-03", isActive: false }), "unique", "academic_years_name_key");
  await refuses(() => s.insertAcademicYear({ id: ID.y27, schoolId: S, name: "x", startsOn: "2027-12-03", endsOn: "2027-01-12", isActive: false }), "check");
  await s.insertAcademicYear({ id: ID.y27, schoolId: S, name: "2027", startsOn: "2027-01-12", endsOn: "2027-12-03", isActive: false });

  // switching the active year: deactivate the others, then activate
  await admin.transaction(async (tx) => {
    await tx.deactivateOtherYears(S, ID.y27);
    await tx.updateAcademicYear(S, ID.y27, { isActive: true });
  });
  const years = await s.listAcademicYears(S);
  assert.deepEqual(years.map((y) => [y.name, y.isActive]), [["2027", true], ["2026", false], ["2025", false]], "newest first, exactly one active");
  await admin.transaction(async (tx) => {
    await tx.deactivateOtherYears(S, ID.y26);
    await tx.updateAcademicYear(S, ID.y26, { isActive: true });
  });
  assert.deepEqual((await s.listAcademicYears(S)).filter((y) => y.isActive).map((y) => y.name), ["2026"]);

  // other schools are unaffected by this school's years: the same dates and names are fine there
  await s.insertAcademicYear({ id: ID.otherYear, schoolId: ID.otherSchool, name: "2026", startsOn: "2026-01-13", endsOn: "2026-12-04", isActive: true });
  assert.equal((await s.listAcademicYears(ID.otherSchool)).length, 1);
  assert.equal(await s.getAcademicYear(ID.otherSchool, ID.y26), null, "another school's year is invisible");
});

test("terms: unique per year, never overlapping, tied to their own school's year", { skip }, async () => {
  const s = admin.store;
  await s.insertTerm({ id: ID.t1, schoolId: S, academicYearId: ID.y26, name: "Term 1", startsOn: "2026-01-13", endsOn: "2026-04-10" });
  await s.insertTerm({ id: ID.t2, schoolId: S, academicYearId: ID.y26, name: "Term 2", startsOn: "2026-05-05", endsOn: "2026-08-07" });
  await refuses(() => s.insertTerm({ id: u(3013), schoolId: S, academicYearId: ID.y26, name: "term 1", startsOn: "2026-09-08", endsOn: "2026-12-04" }), "unique", "terms_year_name_key");
  await refuses(() => s.insertTerm({ id: u(3013), schoolId: S, academicYearId: ID.y26, name: "Term 3", startsOn: "2026-08-07", endsOn: "2026-12-04" }), "exclusion", "terms_no_overlap");
  // a term cannot hang off another school's year
  await refuses(() => s.insertTerm({ id: u(3014), schoolId: S, academicYearId: ID.otherYear, name: "Sneaky", startsOn: "2026-09-08", endsOn: "2026-12-04" }), "foreign_key");
  assert.deepEqual((await s.listTerms(S, ID.y26)).map((x) => x.name), ["Term 1", "Term 2"]);
  assert.deepEqual(await s.listTerms(S, ID.otherYear), [], "another school's year shows none of our terms");
  await s.updateTerm(S, ID.t2, { endsOn: "2026-08-14" });
  assert.equal((await s.getTerm(S, ID.t2))!.endsOn, "2026-08-14");
  assert.equal(await s.getTerm(ID.otherSchool, ID.t2), null);
  assert.equal(await s.deleteTerm(ID.otherSchool, ID.t2), false, "another school cannot delete our term");
  assert.deepEqual(await s.countYearDependents(S, ID.y26), { classes: 0, terms: 2 });
});

test("a year with classes or terms cannot be deleted by the database either; an empty one can", { skip }, async () => {
  const s = admin.store;
  await refuses(() => s.deleteAcademicYear(S, ID.y26), "foreign_key"); // has terms
  await s.insertClass({ id: ID.c26_7A, schoolId: S, name: "Grade 7A (2026)", gradeLevel: "7", stream: "A", academicYearId: ID.y27 });
  assert.deepEqual(await s.countYearDependents(S, ID.y27), { classes: 1, terms: 0 });
  await refuses(() => s.deleteAcademicYear(S, ID.y27), "foreign_key"); // has a class
  assert.equal(await s.deleteAcademicYear(S, ID.y25), true);
  assert.equal(await s.deleteAcademicYear(S, ID.y25), false);
  assert.equal(await s.deleteAcademicYear(ID.otherSchool, ID.y26), false, "another school cannot delete our year");
  assert.equal((await s.getAcademicYear(S, ID.y27))!.classCount, 1);
});

// ---------- classes ----------

test("classes: unique names per year (not per school), grade+stream unique per year, legacy classes keep their rule", { skip }, async () => {
  const s = admin.store;
  // c26_7A was created above in the 2027 year to test the year delete; make the real 2026 classes now
  await s.insertClass({ id: ID.c26_7B, schoolId: S, name: "Grade 7B", gradeLevel: "7", stream: "B", academicYearId: ID.y26 });
  await s.insertClass({ id: ID.c27_7A, schoolId: S, name: "Grade 7B", gradeLevel: "7", stream: "B", academicYearId: ID.y27 });
  // ...the same name and stream in a different year is exactly the point of the relaxation
  await refuses(() => s.insertClass({ id: u(4010), schoolId: S, name: "  grade 7b".trim(), gradeLevel: "7", stream: "C", academicYearId: ID.y26 }), "unique", "classes_school_year_name_key");
  await refuses(() => s.insertClass({ id: u(4010), schoolId: S, name: "Grade 7 Blue", gradeLevel: "7", stream: "b", academicYearId: ID.y26 }), "unique", "classes_school_year_grade_stream_key");
  // two classes with no stream in the same grade are fine
  await s.insertClass({ id: u(4011), schoolId: S, name: "Grade 6 Maths", gradeLevel: "6", stream: null, academicYearId: ID.y26 });
  await s.insertClass({ id: u(4012), schoolId: S, name: "Grade 6 English", gradeLevel: "6", stream: null, academicYearId: ID.y26 });
  // legacy classes (no year) are still unique per school by name, as in Slice 1
  await refuses(() => q(`insert into classes (school_id, name, grade_level) values ($1, 'grade 7a', '7')`, [S]), "unique", "classes_school_nullyear_name_key");
  // a legacy class and a year-bound class may share a name
  await q(`insert into classes (school_id, name, grade_level, academic_year_id) values ($1, 'Grade 7A', '7', $2)`, [S, ID.y26]);
  // a class cannot point at another school's year
  await refuses(() => s.insertClass({ id: u(4013), schoolId: S, name: "Bad", gradeLevel: "7", stream: null, academicYearId: ID.otherYear }), "foreign_key");
  await refuses(() => q(`update classes set status = 'deleted' where id = $1`, [ID.c26_7B]), "check", "classes_status_check");
});

test("listClasses: filters, headcount for today, newest year first, a real total", { skip }, async () => {
  const s = admin.store;
  const all = await s.listClasses(S, {}, TODAY, 100, 0);
  assert.equal(all.total, all.items.length);
  const y26 = await s.listClasses(S, { academicYearId: ID.y26 }, TODAY, 100, 0);
  assert.ok(y26.items.every((c) => c.academicYear?.id === ID.y26));
  const seven = await s.listClasses(S, { q: "grade 7" }, TODAY, 100, 0);
  assert.ok(seven.items.length >= 3 && seven.items.every((c) => /grade 7/i.test(c.name)));
  const legacy7A = all.items.find((c) => c.id === DEV_IDS.class7A)!;
  assert.deepEqual([legacy7A.studentCount, legacy7A.teacherCount, legacy7A.academicYear], [12, 1, null], "today's headcount comes from the enrolments");
  const none = await s.listClasses(S, { q: "50%" }, TODAY, 100, 0);
  assert.equal(none.total, 0, "a percent sign is a character, not a wildcard");
  const p1 = await s.listClasses(S, {}, TODAY, 2, 0);
  const p2 = await s.listClasses(S, {}, TODAY, 2, 2);
  assert.equal(p1.total, all.total);
  assert.equal(p1.items.length, 2);
  assert.ok(!p2.items.some((c) => p1.items.some((d) => d.id === c.id)), "pages do not repeat rows");
  assert.equal((await s.listClasses(S, {}, TODAY, 2, 1000)).items.length, 0);
  assert.equal((await s.listClasses(S, {}, TODAY, 2, 1000)).total, all.total, "total is right even past the last page");
  assert.equal((await s.listClasses(ID.otherSchool, {}, TODAY, 100, 0)).total, 1, "another school sees only its own class");
  assert.equal(await s.getClass(ID.otherSchool, DEV_IDS.class7A, TODAY), null);
  assert.equal((await s.getClass(S, DEV_IDS.class7A, TODAY))!.name, "Grade 7A");
});

// ---------- students ----------

test("students: admission numbers are unique per school ignoring case, but not across schools", { skip }, async () => {
  const s = admin.store;
  const base = { schoolId: S, firstName: "Tadiwa", lastName: "Zhou", otherNames: null, dateOfBirth: "2014-03-02", gender: "female" as const, enrolmentDate: "2026-01-12" };
  await s.insertStudent({ ...base, id: ID.stuA, admissionNo: "MA7001" });
  await refuses(() => s.insertStudent({ ...base, id: u(5099), admissionNo: "MA7001" }), "unique");
  await refuses(() => s.insertStudent({ ...base, id: u(5099), admissionNo: "ma7001" }), "unique", "students_school_admission_ci_key");
  // MA1001 exists at Other School too (see before()): the same number in a different school is fine
  await s.insertStudent({ ...base, id: ID.stuB, admissionNo: "MA7002", firstName: "Rudo", lastName: "Banda" });
  assert.equal((await s.getStudent(ID.otherSchool, ID.stuA)), null, "another school cannot read the student");
  const mine = await s.getStudent(S, ID.stuA);
  assert.deepEqual([mine!.admissionNo, mine!.status, mine!.gender, mine!.dateOfBirth, mine!.enrolmentDate], ["MA7001", "enrolled", "female", "2014-03-02", "2026-01-12"]);
  await refuses(() => s.insertStudent({ ...base, id: u(5098), admissionNo: "MA7003", gender: "x" as never }), "check", "students_gender_check");
  await refuses(() => s.insertStudent({ ...base, id: u(5098), admissionNo: "MA7003", firstName: "" }), "check", "students_names_len");
  await refuses(() => q(`update students set status = 'expelled' where id = $1`, [ID.stuA]), "check", "students_status_check");
});

test("students: update only what is given, and never another school's student", { skip }, async () => {
  const s = admin.store;
  await s.updateStudent(S, ID.stuA, { otherNames: "Chipo", gender: null });
  const a = await s.getStudent(S, ID.stuA);
  assert.deepEqual([a!.firstName, a!.otherNames, a!.gender, a!.dateOfBirth], ["Tadiwa", "Chipo", null, "2014-03-02"]);
  await s.updateStudent(ID.otherSchool, ID.stuA, { firstName: "Hijacked" });
  assert.equal((await s.getStudent(S, ID.stuA))!.firstName, "Tadiwa", "a write scoped to the wrong school changes nothing");
  await refuses(() => s.updateStudent(S, ID.stuA, { admissionNo: "ma7002" }), "unique", "students_school_admission_ci_key");
  await s.setStudentStatus(S, ID.stuB, "withdrawn");
  assert.equal((await s.getStudent(S, ID.stuB))!.status, "withdrawn");
  await s.setStudentStatus(S, ID.stuB, "enrolled");
  const raw = await q(`select active from students where id = $1`, [ID.stuB]);
  assert.deepEqual(raw, [{ active: true }], "the legacy active flag is never touched by Slice 2 writes");
});

test("enrolments: a student is in at most one class on any day; history is kept", { skip }, async () => {
  const s = admin.store;
  const e = (id: string, classId: string, startsOn: string) => ({ id, schoolId: S, studentId: ID.stuA, classId, startsOn, createdBy: DEV_IDS.head });
  await s.insertEnrolment(e(u(6001), ID.c26_7B, "2026-01-13"));
  // overlapping an open-ended enrolment is refused
  await refuses(() => s.insertEnrolment(e(u(6002), u(4011), "2026-06-01")), "exclusion", "enrollments_no_overlap");
  // the move: close the old one the day before, open the new one: allowed, and they touch without overlapping
  await admin.transaction(async (tx) => {
    await tx.closeEnrolment(S, u(6001), "2026-10-08");
    await tx.insertEnrolment(e(u(6002), u(4011), "2026-10-09"));
  });
  const history = await s.listEnrolments(S, ID.stuA);
  assert.deepEqual(history.map((h) => [h.className, h.startsOn, h.endsOn, h.academicYear?.name]), [
    ["Grade 7B", "2026-01-13", "2026-10-08", "2026"],
    ["Grade 6 Maths", "2026-10-09", null, "2026"],
  ]);
  // back-dating a placement into a gap is fine; into an existing one is not
  await refuses(() => s.insertEnrolment(e(u(6003), ID.c27_7A, "2026-10-08")), "exclusion");
  // another school's class cannot be used (a student with no other enrolment, so only the school check can object)
  await refuses(() => s.insertEnrolment({ ...e(u(6004), ID.otherClass, "2027-02-01"), studentId: ID.stuB }), "foreign_key");
  assert.equal(await s.deleteEnrolment(ID.otherSchool, u(6002)), false, "another school cannot delete our enrolment");
  assert.deepEqual(await s.listEnrolments(ID.otherSchool, ID.stuA), []);
});

test("students list: search, filters, today's class, upcoming class, unplaced, paging, bounded", { skip }, async () => {
  const s = admin.store;
  // stuA: in Grade 6 Maths since 2026-10-09 (tomorrow), was in 7B until today
  const day = await s.listStudents(S, { q: "tadiwa zhou" }, TODAY, 25, 0);
  assert.equal(day.total >= 1, true);
  const a = day.items.find((x) => x.id === ID.stuA)!;
  assert.deepEqual([a.currentClass?.name, a.upcomingClass?.name, a.upcomingClass?.startsOn], ["Grade 7B", "Grade 6 Maths", "2026-10-09"]);
  const tomorrow = (await s.listStudents(S, { q: "MA7001" }, "2026-10-09", 25, 0)).items[0]!;
  assert.deepEqual([tomorrow.currentClass?.name, tomorrow.upcomingClass], ["Grade 6 Maths", null]);

  // every search word must match somewhere; case does not matter; admission numbers match too
  assert.deepEqual((await s.listStudents(S, { q: "ZHOU tadiwa" }, TODAY, 25, 0)).items.filter((x) => x.id === ID.stuA).length, 1);
  assert.equal((await s.listStudents(S, { q: "tadiwa nobody" }, TODAY, 25, 0)).total, 0);
  assert.equal((await s.listStudents(S, { q: "ma700" }, TODAY, 25, 0)).total, 2);
  assert.equal((await s.listStudents(S, { q: "%" }, TODAY, 25, 0)).total, 0, "a percent sign is a character, not a wildcard");
  assert.equal((await s.listStudents(S, { q: "_" }, TODAY, 25, 0)).total, 0);
  assert.equal((await s.listStudents(S, { q: "'; drop table students; --" }, TODAY, 25, 0)).total, 0);
  assert.equal((await q<{ n: number }>(`select count(*)::int n from students`))[0]!.n > 30, true, "and the table is still there");

  // class filter = in that class TODAY
  const in7A = await s.listStudents(S, { classId: DEV_IDS.class7A }, TODAY, 100, 0);
  assert.equal(in7A.total, 12);
  assert.ok(in7A.items.every((x) => x.currentClass?.id === DEV_IDS.class7A));
  assert.equal((await s.listStudents(S, { classId: ID.c26_7B }, TODAY, 100, 0)).items.some((x) => x.id === ID.stuA), true);
  assert.equal((await s.listStudents(S, { classId: ID.c26_7B }, "2026-10-09", 100, 0)).items.some((x) => x.id === ID.stuA), false, "tomorrow they are elsewhere");

  // unplaced = enrolled and in no class today; withdrawn students are not 'unplaced'
  await s.insertStudent({ id: u(5003), schoolId: S, admissionNo: "MA7003", firstName: "Nobody", lastName: "Yet", otherNames: null, dateOfBirth: null, gender: null, enrolmentDate: TODAY });
  await s.insertStudent({ id: u(5004), schoolId: S, admissionNo: "MA7004", firstName: "Left", lastName: "School", otherNames: null, dateOfBirth: null, gender: null, enrolmentDate: TODAY });
  await s.setStudentStatus(S, u(5004), "withdrawn");
  const unplaced = (await s.listStudents(S, { unplaced: true }, TODAY, 100, 0)).items.map((x) => x.admissionNo);
  assert.ok(unplaced.includes("MA7003") && !unplaced.includes("MA7004") && !unplaced.includes("MA7001"));
  assert.deepEqual((await s.listStudents(S, { status: "withdrawn" }, TODAY, 100, 0)).items.map((x) => x.admissionNo), ["MA7004"]);

  // stable order and paging that neither repeats nor skips
  const all = await s.listStudents(S, {}, TODAY, 100, 0);
  const names = all.items.map((x) => `${x.lastName.toLowerCase()}|${x.firstName.toLowerCase()}`);
  assert.deepEqual(names, [...names].sort());
  const seen: string[] = [];
  for (let off = 0; off < all.total; off += 7) seen.push(...(await s.listStudents(S, {}, TODAY, 7, off)).items.map((x) => x.id));
  assert.deepEqual(seen, all.items.map((x) => x.id));
  assert.equal((await s.listStudents(S, {}, TODAY, 7, 0)).total, all.total);

  // the other school sees only its own student
  assert.deepEqual((await s.listStudents(ID.otherSchool, {}, TODAY, 100, 0)).items.map((x) => x.id), [ID.otherStudent]);
  assert.equal((await s.listStudents(ID.otherSchool, { classId: DEV_IDS.class7A }, TODAY, 100, 0)).total, 0, "a class id from another school matches nothing");
});

test("attendance history is separate from placement: later class changes never touch it", { skip }, async () => {
  const s = admin.store;
  const [a7a] = await t.db.store.enrolledStudents(S, [DEV_IDS.class7A], TODAY);
  const before = await s.studentAttendanceByClass(S, a7a!.id);
  assert.equal(before.length, 1);
  assert.equal(before[0]!.className, "Grade 7A");
  assert.equal(before[0]!.days, 14);
  assert.equal(await s.studentHasAttendanceBetween(S, a7a!.id, "2026-10-07", null), true);
  assert.equal(await s.studentHasAttendanceBetween(S, a7a!.id, TODAY, null), false, "nothing yet today");
  assert.equal(await s.studentHasAttendanceBetween(S, a7a!.id, "2026-09-18", "2026-09-25"), true, "the seeded history starts on 18 September");
  assert.equal(await s.studentHasAttendanceBetween(S, a7a!.id, "2026-09-01", "2026-09-10"), false);
  assert.equal(await s.studentHasAttendanceBetween(S, a7a!.id, "2020-01-01", "2020-01-31"), false);
  assert.equal(await s.studentHasAttendanceBetween(ID.otherSchool, a7a!.id, "2000-01-01", null), false, "scoped to the school");
  // move the student into another class from tomorrow
  const [open] = (await s.listEnrolments(S, a7a!.id)).filter((e) => e.endsOn === null);
  await admin.transaction(async (tx) => {
    await tx.closeEnrolment(S, open!.id, TODAY);
    await tx.insertEnrolment({ id: u(6100), schoolId: S, studentId: a7a!.id, classId: DEV_IDS.class7B, startsOn: "2026-10-09", createdBy: DEV_IDS.head });
  });
  const afterMove = await s.studentAttendanceByClass(S, a7a!.id);
  assert.deepEqual(afterMove, before, "the registers taken in 7A still say 7A, with the same count");
  assert.equal(await s.classHasAttendance(S, DEV_IDS.class7A), true);
  assert.equal(await s.classHasEnrolments(S, DEV_IDS.class7A), true);
  assert.equal(await s.classHasEnrolments(ID.otherSchool, DEV_IDS.class7A), false);
  assert.deepEqual(await s.classEnrolmentStarts(S, DEV_IDS.class7A), ["2026-01-12"]);
});

// ---------- teachers ----------

test("teachers: only active teacher members of THIS school can be assigned, enforced by the database", { skip }, async () => {
  const s = admin.store;
  // Ms. Chipo (teacher at Mavambo) and the head (a head, not a teacher), the other school's teacher, a deactivated teacher
  await refuses(() => s.assignTeacher(S, DEV_IDS.class7A, ID.otherTeacher, DEV_IDS.head), "check", "class_teachers_teacher_membership");
  await refuses(() => s.assignTeacher(S, DEV_IDS.class7A, DEV_IDS.head, DEV_IDS.head), "check", "class_teachers_teacher_membership");
  await refuses(() => s.assignTeacher(S, DEV_IDS.class7A, ID.inactiveTeacher, DEV_IDS.head), "check", "class_teachers_teacher_membership");
  // ...and the other school's class cannot be used from this school
  await refuses(() => s.assignTeacher(S, ID.otherClass, DEV_IDS.teacher, DEV_IDS.head), "foreign_key");
  assert.equal((await q<{ n: number }>(`select count(*)::int n from class_teachers where class_id = $1`, [ID.otherClass]))[0]!.n, 0);

  // the legitimate path
  assert.equal(await s.assignTeacher(ID.otherSchool, ID.otherClass, ID.otherTeacher, ID.otherTeacher), true);
  assert.equal(await s.assignTeacher(S, ID.c26_7B, DEV_IDS.teacher, DEV_IDS.head), true);
  assert.equal(await s.assignTeacher(S, ID.c26_7B, DEV_IDS.teacher, DEV_IDS.head), false, "assigning twice is a no-op, not an error");
  assert.deepEqual((await s.listClassTeachers(S, ID.c26_7B)).map((x) => x.name), ["Ms. Chipo"]);
  assert.deepEqual(await s.listClassTeachers(ID.otherSchool, ID.c26_7B), [], "scoped to the school");

  assert.equal(await s.removeTeacher(ID.otherSchool, ID.c26_7B, DEV_IDS.teacher), false, "another school cannot remove our assignment");
  assert.equal(await s.removeTeacher(S, ID.c26_7B, DEV_IDS.teacher), true);
  assert.equal(await s.removeTeacher(S, ID.c26_7B, DEV_IDS.teacher), false);
});

test("teacher lists show active teacher members only, with their active-class counts", { skip }, async () => {
  const s = admin.store;
  const list = await s.listTeachers(S);
  assert.deepEqual(list.map((x) => x.name), ["Ms. Chipo"], "no head, no deactivated teacher, nobody from another school");
  assert.equal(list[0]!.classCount, 3);
  assert.deepEqual((await s.listTeachers(ID.otherSchool)).map((x) => [x.name, x.classCount]), [["Other Teacher", 1]]);
  assert.equal(await s.getTeacher(S, ID.otherTeacher), null);
  assert.equal(await s.getTeacher(S, DEV_IDS.head), null);
  assert.equal(await s.getTeacher(S, ID.inactiveTeacher), null);
  assert.equal((await s.getTeacher(S, DEV_IDS.teacher))!.name, "Ms. Chipo");

  // archiving a class drops it from the count and from 'my classes', and puts it back when reactivated
  await s.updateClass(S, DEV_IDS.class6A, { status: "archived" });
  assert.equal((await s.listTeachers(S))[0]!.classCount, 2);
  assert.deepEqual((await s.myClasses(S, DEV_IDS.teacher, TODAY)).map((c) => c.name), ["Grade 7A", "Grade 7B"]);
  assert.deepEqual((await t.db.store.teacherClasses(S, DEV_IDS.teacher)).map((c) => c.name), ["Grade 7A", "Grade 7B"], "Slice 1's bootstrap list agrees");
  assert.deepEqual((await t.db.store.timetableForTeacher(S, DEV_IDS.teacher, 4)).map((x) => x.className), ["Grade 7A", "Grade 7B"], "and so does Today");
  await s.updateClass(S, DEV_IDS.class6A, { status: "active" });
  assert.deepEqual((await s.myClasses(S, DEV_IDS.teacher, TODAY)).map((c) => c.name), ["Grade 6A", "Grade 7A", "Grade 7B"]);
  assert.deepEqual((await s.myClasses(ID.otherSchool, DEV_IDS.teacher, TODAY)), [], "a teacher id means nothing in another school");
  // a student was moved out of 7A effective tomorrow (earlier test): today's headcount is unchanged, tomorrow's drops by one
  const headcount = async (day: string) => (await s.myClasses(S, DEV_IDS.teacher, day)).find((c) => c.name === "Grade 7A")!;
  assert.deepEqual([(await headcount(TODAY)).studentCount, (await headcount("2026-10-09")).studentCount], [12, 11]);
  assert.equal((await headcount(TODAY)).academicYear, null, "legacy classes have no year yet");
});
