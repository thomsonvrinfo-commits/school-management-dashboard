import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pgTestsEnabled } from "@schoolpulse/db/testing";
import { DEV_IDS } from "@schoolpulse/db";
import { summarise } from "@schoolpulse/domain";
import { attendanceSummary } from "../src/services/admin.ts";
import { push } from "../src/services/sync.ts";
import { HttpError } from "../src/errors.ts";
import { EMAILS, TODAY, attendanceOp, makeFixture, signIn, studentsOf, type Fixture } from "./support.ts";

const skip = pgTestsEnabled() ? false : "no PostgreSQL configured (set PSQL_TEST_CONN)";
let f: Fixture;
before(async () => { if (!skip) f = await makeFixture(); });
after(async () => { if (!skip) await f.close(); });

const status = (e: unknown) => (e instanceof HttpError ? `${e.status} ${e.code}` : String(e));

test("the head's figures match the raw records, with counts that show how they were worked out", { skip }, async () => {
  const head = await signIn(f.deps, EMAILS.head, "device-head00001");
  const s = await attendanceSummary(f.deps, head.auth, { from: "2026-10-01", to: "2026-10-07" });
  assert.deepEqual(s.period, { from: "2026-10-01", to: "2026-10-07" });
  assert.deepEqual(s.previousPeriod, { from: "2026-09-24", to: "2026-09-30" });
  const [raw] = await f.t.runner.query<{ present: number; late: number; absent: number }>(
    `select (count(*) filter (where status='present'))::int present, (count(*) filter (where status='late'))::int late,
            (count(*) filter (where status='absent'))::int absent from attendance_records where date between '2026-10-01' and '2026-10-07'`);
  assert.deepEqual({ present: s.school.present, late: s.school.late, absent: s.school.absent }, raw);
  assert.equal(s.school.total, 32 * 5);
  assert.equal(s.school.rate, summarise(raw!).rate);
  assert.equal(s.classes.length, 4); // 7A, 7B, 6A, and Grade 5A which has no records
  const fiveA = s.classes.find((c) => c.name === "Grade 5A")!;
  assert.deepEqual([fiveA.current.total, fiveA.current.rate, fiveA.changePoints], [0, null, null]);
  assert.equal(s.classes.reduce((n, c) => n + c.current.total, 0), s.school.total);
});

test("Grade 7B, the class with the worse recent week, shows the largest drop", { skip }, async () => {
  const head = await signIn(f.deps, EMAILS.head, "device-head00001");
  const s = await attendanceSummary(f.deps, head.auth, { from: "2026-10-01", to: "2026-10-07" });
  const by = new Map(s.classes.map((c) => [c.name, c.changePoints]));
  assert.ok((by.get("Grade 7B") ?? 0) < -5, `7B change was ${by.get("Grade 7B")}`);
  const drops = s.classes.filter((c) => c.changePoints !== null).sort((a, b) => a.changePoints! - b.changePoints!);
  assert.equal(drops[0]!.name, "Grade 7B");
});

test("a period with no records has a null rate, never 0% or NaN", { skip }, async () => {
  const head = await signIn(f.deps, EMAILS.head, "device-head00001");
  const s = await attendanceSummary(f.deps, head.auth, { from: "2025-01-01", to: "2025-01-07" });
  assert.equal(s.school.total, 0);
  assert.equal(s.school.rate, null);
  assert.equal(s.changePoints, null);
});

test("teachers cannot see the school-wide summary", { skip }, async () => {
  const chipo = await signIn(f.deps, EMAILS.chipo, "device-chipo0001");
  assert.equal(await attendanceSummary(f.deps, chipo.auth, {}).catch(status), "403 forbidden");
});

test("a nonsensical or enormous period is refused", { skip }, async () => {
  const head = await signIn(f.deps, EMAILS.head, "device-head00001");
  assert.equal(await attendanceSummary(f.deps, head.auth, { from: "2026-10-08", to: "2026-10-01" }).catch(status), "400 invalid_period");
  assert.equal(await attendanceSummary(f.deps, head.auth, { from: "2026-01-01", to: "2026-10-01" }).catch(status), "400 invalid_period");
});

test("THE SLICE: a teacher records today's Grade 7A register and the head sees it in the school figures", { skip }, async () => {
  const head = await signIn(f.deps, EMAILS.head, "device-head00001");
  const before = await attendanceSummary(f.deps, head.auth, { from: TODAY, to: TODAY });
  assert.equal(before.school.total, 0);

  const chipo = await signIn(f.deps, EMAILS.chipo, "device-chipo0001");
  const kids = await studentsOf(f, DEV_IDS.class7A);
  assert.equal(kids.length, 12);
  // 9 present, 2 late, 1 absent
  const marks = kids.map((studentId, i) => ({ studentId, status: (i === 0 ? "absent" : i < 3 ? "late" : "present") as "absent" | "late" | "present" }));
  const r = (await push(f.deps, chipo.auth, { deviceId: "device-chipo0001", ops: [attendanceOp(DEV_IDS.class7A, TODAY, marks)] })).results[0]!;
  assert.equal(r.outcome, "applied");

  const after = await attendanceSummary(f.deps, head.auth, { from: TODAY, to: TODAY });
  assert.deepEqual({ p: after.school.present, l: after.school.late, a: after.school.absent, total: after.school.total }, { p: 9, l: 2, a: 1, total: 12 });
  assert.equal(after.school.rate, 91.7); // 11 of 12 in school
  const seven = after.classes.find((c) => c.name === "Grade 7A")!;
  assert.equal(seven.current.rate, 91.7);
  assert.equal(after.classes.find((c) => c.name === "Grade 7B")!.current.total, 0);
});
