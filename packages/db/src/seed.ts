/**
 * DEVELOPMENT SAMPLE DATA ONLY. A fictional school ("Mavambo Academy") so the first slice can be seen working.
 * It must never be run against a production database; the scripts that call it refuse when ENVIRONMENT=production.
 */
import { addDays, weekdayOf } from "@schoolpulse/domain";
import type { SqlRunner } from "./sql.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const DEV_IDS = {
  school: id(1),
  head: id(10),
  teacher: id(11),
  headMembership: id(20),
  teacherMembership: id(21),
  class7A: id(100),
  class7B: id(101),
  class6A: id(102),
} as const;

export const DEV_ACCOUNTS = {
  head: { email: "head@mavambo.example", name: "Mr. Mbewe" },
  teacher: { email: "chipo@mavambo.example", name: "Ms. Chipo" },
} as const;

const FIRST = ["Tadiwa", "Nyasha", "Brian", "Tariro", "Blessing", "Rudo", "Tendai", "Farai", "Chenai", "Kudzai", "Tapiwa", "Anesu"];
const LAST = ["Mbewe", "Moyo", "Ncube", "Dube", "Chikwanha", "Sibanda", "Makoni", "Chirwa", "Banda", "Zhou"];

/** Small deterministic generator so the sample history is the same every time. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export interface SeedOptions {
  /** The school's current date (YYYY-MM-DD). History is created for the weekdays before it; today is left empty. */
  today: string;
  /** PBKDF2 hash to give both sample accounts. */
  passwordHash: string;
}

interface Cls { id: string; name: string; grade: string; size: number }

export async function seedDev(runner: SqlRunner, opts: SeedOptions): Promise<{ students: number; attendance: number }> {
  const classes: Cls[] = [
    { id: DEV_IDS.class7A, name: "Grade 7A", grade: "7", size: 12 },
    { id: DEV_IDS.class7B, name: "Grade 7B", grade: "7", size: 10 },
    { id: DEV_IDS.class6A, name: "Grade 6A", grade: "6", size: 10 },
  ];
  const students: { id: string; class_id: string; admission_no: string; first_name: string; last_name: string }[] = [];
  let n = 1000;
  for (const [ci, c] of classes.entries()) {
    for (let i = 0; i < c.size; i++) {
      n += 1;
      students.push({
        id: id(n),
        class_id: c.id,
        admission_no: `MA${String(n).padStart(4, "0")}`,
        first_name: FIRST[i % FIRST.length]!,
        last_name: LAST[(i * 3 + ci) % LAST.length]!,
      });
    }
  }

  // The previous 14 weekdays (excluding today).
  const days: string[] = [];
  for (let d = addDays(opts.today, -1); days.length < 14; d = addDays(d, -1)) {
    if (weekdayOf(d) <= 5) days.push(d);
  }
  days.reverse();
  const recentWeek = new Set(days.slice(-5));

  const rand = lcg(7);
  const attendance: { id: string; student_id: string; class_id: string; date: string; status: string }[] = [];
  let a = 50_000;
  for (const c of classes) {
    for (const s of students.filter((x) => x.class_id === c.id)) {
      for (const date of days) {
        // Grade 7B has a worse recent week, so the head's "what changed" has something real to show.
        const absentRate = c.id === DEV_IDS.class7B && recentWeek.has(date) ? 0.22 : 0.07;
        const r = rand();
        const status = r < absentRate ? "absent" : r < absentRate + 0.04 ? "late" : "present";
        a += 1;
        attendance.push({ id: id(a), student_id: s.id, class_id: c.id, date, status });
      }
    }
  }

  await runner.transaction(async (tx) => {
    await tx.query(`insert into schools (id, name, timezone) values ($1, 'Mavambo Academy', 'Africa/Harare')`, [DEV_IDS.school]);
    await tx.query(
      `insert into users (id, email, name, password_hash) values ($1, $2, $3, $7), ($4, $5, $6, $7)`,
      [DEV_IDS.head, DEV_ACCOUNTS.head.email, DEV_ACCOUNTS.head.name, DEV_IDS.teacher, DEV_ACCOUNTS.teacher.email, DEV_ACCOUNTS.teacher.name, opts.passwordHash],
    );
    await tx.query(
      `insert into memberships (id, user_id, school_id, role) values ($1, $2, $3, 'head'), ($4, $5, $3, 'teacher')`,
      [DEV_IDS.headMembership, DEV_IDS.head, DEV_IDS.school, DEV_IDS.teacherMembership, DEV_IDS.teacher],
    );
    await tx.query(
      `insert into classes (id, school_id, name, grade_level)
       select (c->>'id')::uuid, $1::uuid, c->>'name', c->>'grade' from jsonb_array_elements($2::jsonb) c`,
      [DEV_IDS.school, JSON.stringify(classes)],
    );
    await tx.query(
      `insert into students (id, school_id, admission_no, first_name, last_name)
       select (s->>'id')::uuid, $1::uuid, s->>'admission_no', s->>'first_name', s->>'last_name' from jsonb_array_elements($2::jsonb) s`,
      [DEV_IDS.school, JSON.stringify(students)],
    );
    await tx.query(
      `insert into enrollments (school_id, student_id, class_id, starts_on)
       select $1::uuid, (s->>'id')::uuid, (s->>'class_id')::uuid, date '2026-01-12' from jsonb_array_elements($2::jsonb) s`,
      [DEV_IDS.school, JSON.stringify(students)],
    );
    await tx.query(
      `insert into class_teachers (school_id, class_id, user_id) values ($1, $2, $4), ($1, $3, $4)`,
      [DEV_IDS.school, DEV_IDS.class7A, DEV_IDS.class7B, DEV_IDS.teacher],
    );
    // Ms. Chipo teaches 7A and 7B (and 6A below), Monday to Friday.
    await tx.query(`insert into class_teachers (school_id, class_id, user_id) values ($1, $2, $3)`, [DEV_IDS.school, DEV_IDS.class6A, DEV_IDS.teacher]);
    await tx.query(
      `insert into timetable_slots (school_id, class_id, teacher_user_id, weekday, starts_at, ends_at, subject)
       select $1::uuid, v.class_id::uuid, $2::uuid, w, v.starts::time, v.ends::time, 'Mathematics'
         from generate_series(1, 5) w,
              (values ($3, '08:00', '08:40'), ($4, '10:00', '10:40'), ($5, '13:00', '13:40')) as v(class_id, starts, ends)`,
      [DEV_IDS.school, DEV_IDS.teacher, DEV_IDS.class7A, DEV_IDS.class7B, DEV_IDS.class6A],
    );
    await tx.query(
      `insert into attendance_records (id, school_id, student_id, class_id, date, status, recorded_by, device_id, op_id)
       select (r->>'id')::uuid, $1::uuid, (r->>'student_id')::uuid, (r->>'class_id')::uuid, (r->>'date')::date,
              r->>'status', $2::uuid, 'seed-device', (r->>'id')::uuid
         from jsonb_array_elements($3::jsonb) r`,
      [DEV_IDS.school, DEV_IDS.teacher, JSON.stringify(attendance)],
    );
  });

  return { students: students.length, attendance: attendance.length };
}
