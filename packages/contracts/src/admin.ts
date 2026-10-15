/**
 * Slice 2 wire contracts: school profile, academic years, student registry, classes, rosters, teacher assignments.
 * Used by the API to validate every request and by the web app for types. Written requests are STRICT: an unknown key
 * (for example a `schoolId` smuggled into a body) is a 400, not silently ignored. The school always comes from the
 * signed-in session.
 */
import { z } from "zod";
import {
  ADMISSION_NO_PATTERN, CLASS_STATUSES, GENDERS, STUDENT_STATUSES, isValidTimeZone,
} from "@schoolpulse/domain";
import { isoDate, uuid } from "./primitives.ts";

// ---------- building blocks ----------

/** Free text that may be cleared: "" or null both mean "no value". */
const nullableText = (max: number) =>
  z.union([z.string().trim().max(max), z.null()]).transform((v) => (v === null || v === "" ? null : v));

const requiredText = (max: number) => z.string().trim().min(1, "Required").max(max);

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export type PaginationQuery = z.infer<typeof paginationQuery>;

const page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), total: z.number().int().min(0), limit: z.number().int(), offset: z.number().int() });

export const idParam = z.object({ id: uuid });
const nonEmpty = (o: object) => Object.keys(o).length > 0;
const NOTHING = "Nothing to change";

export const yearRef = z.object({ id: uuid, name: z.string() });
export type YearRef = z.infer<typeof yearRef>;
export const classRef = z.object({ id: uuid, name: z.string() });

// ---------- school profile ----------

export const schoolCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/, "Use 2 to 32 letters, numbers, - or _");

export const academicYearSummary = z.object({ id: uuid, name: z.string(), startsOn: isoDate, endsOn: isoDate });

export const schoolProfile = z.object({
  id: uuid,
  name: z.string(),
  code: z.string().nullable(),
  timezone: z.string(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  address: z.string().nullable(),
  activeAcademicYear: academicYearSummary.nullable(),
});
export type SchoolProfile = z.infer<typeof schoolProfile>;

export const updateSchoolRequest = z
  .object({
    name: requiredText(200),
    code: z.union([schoolCode, z.literal(""), z.null()]).transform((v) => (v === null || v === "" ? null : v)),
    timezone: z.string().trim().refine(isValidTimeZone, "Not a known time zone (for example Africa/Harare)"),
    contactEmail: z
      .union([z.string().trim().email("Not a valid email address").max(254), z.literal(""), z.null()])
      .transform((v) => (v === null || v === "" ? null : v)),
    contactPhone: nullableText(40).refine((v) => v === null || v.length >= 3, "Too short"),
    address: nullableText(300),
  })
  .partial()
  .strict()
  .refine(nonEmpty, NOTHING);
export type UpdateSchoolRequest = z.input<typeof updateSchoolRequest>;

// ---------- academic years and terms ----------

export const termDto = z.object({ id: uuid, academicYearId: uuid, name: z.string(), startsOn: isoDate, endsOn: isoDate });
export type TermDto = z.infer<typeof termDto>;

export const academicYearDto = z.object({
  id: uuid,
  name: z.string(),
  startsOn: isoDate,
  endsOn: isoDate,
  isActive: z.boolean(),
  classCount: z.number().int(),
  terms: z.array(termDto),
});
export type AcademicYearDto = z.infer<typeof academicYearDto>;
export const academicYearsResponse = z.object({ items: z.array(academicYearDto) });

export const createAcademicYearRequest = z
  .object({ name: requiredText(50), startsOn: isoDate, endsOn: isoDate, isActive: z.boolean().optional() })
  .strict();
export type CreateAcademicYearRequest = z.input<typeof createAcademicYearRequest>;

export const updateAcademicYearRequest = z
  .object({ name: requiredText(50), startsOn: isoDate, endsOn: isoDate, isActive: z.boolean() })
  .partial()
  .strict()
  .refine(nonEmpty, NOTHING);
export type UpdateAcademicYearRequest = z.input<typeof updateAcademicYearRequest>;

export const createTermRequest = z.object({ name: requiredText(50), startsOn: isoDate, endsOn: isoDate }).strict();
export type CreateTermRequest = z.input<typeof createTermRequest>;
export const updateTermRequest = z
  .object({ name: requiredText(50), startsOn: isoDate, endsOn: isoDate })
  .partial()
  .strict()
  .refine(nonEmpty, NOTHING);
export type UpdateTermRequest = z.input<typeof updateTermRequest>;

// ---------- students ----------

export const studentStatus = z.enum(STUDENT_STATUSES);
export const gender = z.enum(GENDERS);

export const admissionNo = z
  .string()
  .trim()
  .min(1, "Required")
  .max(30, "At most 30 characters")
  .regex(ADMISSION_NO_PATTERN, "Use letters, numbers, and - _ . / only (no spaces)");

const personName = (label: string) =>
  requiredText(100).refine((v) => /\p{L}/u.test(v), `${label} must contain letters`);

export const upcomingClass = z.object({ id: uuid, name: z.string(), startsOn: isoDate });

/** The list carries only what is needed to find and open a student: no date of birth, no gender. */
export const studentListItem = z.object({
  id: uuid,
  admissionNo: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  status: studentStatus,
  currentClass: classRef.nullable(),
  upcomingClass: upcomingClass.nullable(),
});
export type StudentListItem = z.infer<typeof studentListItem>;
export const studentPage = page(studentListItem);
export type StudentPage = z.infer<typeof studentPage>;

export const studentListQuery = paginationQuery.extend({
  q: z.string().trim().max(100).optional(),
  classId: uuid.optional(),
  status: studentStatus.optional(),
  /** `true`: only enrolled students who are in no class today. */
  unplaced: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
});
export type StudentListQuery = z.input<typeof studentListQuery>;

export const placementDto = z.object({
  id: uuid,
  classId: uuid,
  className: z.string(),
  academicYear: yearRef.nullable(),
  startsOn: isoDate,
  /** Last day in the class; null = still there. */
  endsOn: isoDate.nullable(),
});
export type PlacementDto = z.infer<typeof placementDto>;

export const studentDetail = studentListItem.extend({
  otherNames: z.string().nullable(),
  dateOfBirth: isoDate.nullable(),
  gender: gender.nullable(),
  enrolmentDate: isoDate,
  /** Every class the student has been in, oldest first. Class changes add rows; nothing is overwritten. */
  placements: z.array(placementDto),
  /** Registers taken for the student, grouped by the class they were taken for. Unaffected by later class changes. */
  attendance: z.array(z.object({ classId: uuid, className: z.string(), days: z.number().int(), lastDate: isoDate.nullable() })),
});
export type StudentDetail = z.infer<typeof studentDetail>;

export const createStudentRequest = z
  .object({
    admissionNo,
    firstName: personName("First name"),
    lastName: personName("Last name"),
    otherNames: nullableText(100).optional(),
    dateOfBirth: isoDate.nullable().optional(),
    gender: gender.nullable().optional(),
    /** Defaults to today. */
    enrolmentDate: isoDate.optional(),
    /** Place the student in this class as part of registering them. */
    classId: uuid.optional(),
    /** First day in that class. Defaults to today (or the first day of the class's academic year). */
    classStartsOn: isoDate.optional(),
  })
  .strict();
export type CreateStudentRequest = z.input<typeof createStudentRequest>;

export const updateStudentRequest = z
  .object({
    admissionNo,
    firstName: personName("First name"),
    lastName: personName("Last name"),
    otherNames: nullableText(100),
    dateOfBirth: isoDate.nullable(),
    gender: gender.nullable(),
    enrolmentDate: isoDate,
  })
  .partial()
  .strict()
  .refine(nonEmpty, NOTHING);
export type UpdateStudentRequest = z.input<typeof updateStudentRequest>;

export const changeStudentStatusRequest = z.object({ status: studentStatus, effectiveFrom: isoDate.optional() }).strict();
export type ChangeStudentStatusRequest = z.input<typeof changeStudentStatusRequest>;

export const placeStudentRequest = z.object({ classId: uuid, effectiveFrom: isoDate.optional() }).strict();
export type PlaceStudentRequest = z.input<typeof placeStudentRequest>;

// ---------- classes ----------

export const classStatus = z.enum(CLASS_STATUSES);

export const classListItem = z.object({
  id: uuid,
  name: z.string(),
  gradeLevel: z.string(),
  stream: z.string().nullable(),
  status: classStatus,
  academicYear: yearRef.nullable(),
  /** Students in the class today. */
  studentCount: z.number().int(),
  teacherCount: z.number().int(),
});
export type ClassListItem = z.infer<typeof classListItem>;
export const classPage = page(classListItem);
export type ClassPage = z.infer<typeof classPage>;

export const classListQuery = paginationQuery.extend({
  q: z.string().trim().max(100).optional(),
  academicYearId: uuid.optional(),
  status: classStatus.optional(),
});
export type ClassListQuery = z.input<typeof classListQuery>;

export const teacherRef = z.object({ id: uuid, name: z.string() });
export type TeacherRef = z.infer<typeof teacherRef>;

export const classDetail = classListItem.extend({ teachers: z.array(teacherRef) });
export type ClassDetail = z.infer<typeof classDetail>;

const gradeLevel = requiredText(20);

export const createClassRequest = z
  .object({
    name: requiredText(100),
    gradeLevel,
    stream: nullableText(30).optional(),
    academicYearId: uuid,
  })
  .strict();
export type CreateClassRequest = z.input<typeof createClassRequest>;

export const updateClassRequest = z
  .object({
    name: requiredText(100),
    gradeLevel,
    stream: nullableText(30),
    academicYearId: uuid,
    status: classStatus,
  })
  .partial()
  .strict()
  .refine(nonEmpty, NOTHING);
export type UpdateClassRequest = z.input<typeof updateClassRequest>;

// ---------- rosters (what the attendance register reads) ----------

export const rosterQuery = z.object({ date: isoDate.optional() });
export type RosterQuery = z.input<typeof rosterQuery>;

/**
 * Exactly the shape of the offline replica's `students` (see `bootstrapResponse`), and read through the very same
 * query, so the register and this endpoint can never disagree about who is in a class.
 */
export const rosterStudent = z.object({
  id: uuid,
  classId: uuid,
  admissionNo: z.string(),
  firstName: z.string(),
  lastName: z.string(),
});
export const rosterResponse = z.object({
  classId: uuid,
  className: z.string(),
  gradeLevel: z.string(),
  stream: z.string().nullable(),
  academicYear: yearRef.nullable(),
  date: isoDate,
  students: z.array(rosterStudent),
});
export type RosterResponse = z.infer<typeof rosterResponse>;

// ---------- teachers ----------

export const teacherListItem = z.object({
  id: uuid,
  name: z.string(),
  email: z.string(),
  /** Active classes this teacher is assigned to. */
  classCount: z.number().int(),
});
export type TeacherListItem = z.infer<typeof teacherListItem>;
export const teachersResponse = z.object({ items: z.array(teacherListItem) });

export const assignTeacherRequest = z.object({ userId: uuid }).strict();
export type AssignTeacherRequest = z.input<typeof assignTeacherRequest>;

/**
 * The classes the signed-in teacher is authorised to take registers for: the same set the offline bootstrap sends
 * (active classes the teacher is assigned to), with the academic-year context and today's headcount added.
 */
export const myClassesResponse = z.object({
  today: isoDate,
  classes: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      gradeLevel: z.string(),
      stream: z.string().nullable(),
      academicYear: yearRef.nullable(),
      studentCount: z.number().int(),
    }),
  ),
});
export type MyClassesResponse = z.infer<typeof myClassesResponse>;
