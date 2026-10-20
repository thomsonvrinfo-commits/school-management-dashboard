/**
 * The head's activity screen (P1), against a real PostgreSQL: head only, scoped to the caller's own school, newest first,
 * paged without gaps or repeats, filtered by kind, person and school day, and it says what happened in plain words
 * WITHOUT ever sending the raw stored details.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { auditPage, type AuditItem } from "@schoolpulse/contracts";
import { pgTestsEnabled } from "@schoolpulse/db/testing";
import { AUDIT_ACTIONS, roleMayAttempt, type Role } from "@schoolpulse/domain";
import type { Deps } from "../src/deps.ts";
import { HttpError } from "../src/errors.ts";
import { AUDIT_ROUTES, ROUTES, routeKey } from "../src/routes.ts";
import { AUDIT_HANDLERS, auditKeys } from "../src/audit/handlers.ts";
import type { AuthContext } from "../src/services/auth.ts";
import { push } from "../src/services/sync.ts";
import { ADMIN_EXTRA, DEV_IDS, call, expectError, expectOk, makeAdminFixture, type AdminFixture } from "./admin-support.ts";
import { attendanceOp, studentsOf } from "./support.ts";

const skip = pgTestsEnabled() ? false : "no PostgreSQL configured (set PSQL_TEST_CONN)";
const KEY = "GET /v1/audit";
let f: AdminFixture;

before(async () => {
  if (skip) return;
  f = await makeAdminFixture();
});
after(async () => {
  if (!skip) await f.close();
});

/** The response exactly as it would go on the wire (nothing stripped or reshaped by a parser). */
const raw = async (query: Record<string, string> = {}, who = () => f.head) => expectOk(await call(f, who(), KEY, { query })).body as { items: Record<string, unknown>[]; nextBefore: string | null };
const page = async (query: Record<string, string> = {}, who = () => f.head) => {
  const body = await raw(query, who);
  // the published shape, checked strictly: a field nobody declared is a failure, not something quietly dropped
  assert.deepEqual(Object.keys(body).sort(), ["items", "nextBefore"]);
  for (const i of body.items) assert.deepEqual(Object.keys(i).sort(), ["actor", "at", "category", "detail", "entity", "id", "summary"]);
  return auditPage.parse(body);
};
const everything = async (query: Record<string, string> = {}, who = () => f.head): Promise<AuditItem[]> => {
  const out: AuditItem[] = [];
  let before: string | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const p = await page({ ...query, limit: "100", ...(before ? { before } : {}) }, who);
    out.push(...p.items);
    if (!p.nextBefore) return out;
    before = p.nextBefore;
  }
  throw new Error("paging did not end");
};
const q = <T extends object>(sql: string, p: (string | null)[] = []) => f.t.runner.query<T>(sql, p);

// ---------- the route table ----------

test("the activity route is in the master table with a head-only policy and a handler", () => {
  assert.deepEqual(auditKeys(), [KEY]);
  assert.deepEqual(Object.keys(AUDIT_HANDLERS), [KEY]);
  assert.ok(AUDIT_ROUTES.every((r) => ROUTES.includes(r)));
  assert.deepEqual(AUDIT_ROUTES[0]!.access, { action: "audit:read" });
  assert.equal(roleMayAttempt({ userId: "u", schoolId: "s", role: "teacher" }, "audit:read"), false);
  assert.equal(roleMayAttempt({ userId: "u", schoolId: "s", role: "head" }, "audit:read"), true);
  assert.equal(AUDIT_ROUTES[0]!.method, "GET", "the activity log is read-only");
  assert.equal(routeKey(AUDIT_ROUTES[0]!), KEY);
});

test("a teacher gets a 403 before the query is even looked at, and the service layer is not reached", async () => {
  const stubDeps = new Proxy({}, { get() { throw new Error("the service layer must not be reached"); } }) as unknown as Deps;
  const auth = (role: Role): AuthContext => ({ principal: { userId: "u", schoolId: "s", role }, ctx: {} } as unknown as AuthContext);
  await assert.rejects(
    AUDIT_HANDLERS[KEY]!(stubDeps, auth("teacher"), { params: {}, query: { limit: "banana", category: "nope" }, json: async () => { throw new Error("no body"); } }),
    (e: unknown) => e instanceof HttpError && e.status === 403 && e.code === "forbidden",
  );
});

// ---------- the behaviour ----------

test("a teacher is refused with a real session, and learns nothing", { skip }, async () => {
  expectError(await call(f, f.chipo, KEY), 403, "forbidden");
  expectError(await call(f, f.otherTeacher, KEY, { query: { limit: "banana" } }), 403, "forbidden");
});

test("what a head does shows up newest first, in words, with who did it and what it was about", { skip }, async () => {
  const year = expectOk(await call(f, f.head, "POST /v1/academic-years", { body: { name: "2026", startsOn: "2026-01-05", endsOn: "2026-12-11", isActive: true } }), 201).body.id as string;
  const cls = expectOk(await call(f, f.head, "POST /v1/classes", { body: { name: "Grade 9A", gradeLevel: "9", academicYearId: year } }), 201).body.id as string;
  expectOk(await call(f, f.head, "PATCH /v1/classes/:id", { params: { id: cls }, body: { name: "Grade 9B" } }));
  const items = (await page()).items;
  assert.deepEqual(items.slice(0, 3).map((i) => i.summary), ["Edited a class", "Created a class", "Created an academic year"]);
  const [edited, created] = items as [AuditItem, AuditItem];
  assert.equal(edited.detail, "Changed: name");
  assert.equal(created.detail, "Grade 9A");
  assert.deepEqual(edited.actor, { id: DEV_IDS.head, name: f.head.auth.ctx.user.name });
  assert.equal(edited.category, "classes");
  assert.deepEqual(edited.entity, { type: "class", id: cls });
  assert.equal(items[2]!.detail, "2026. Made current");
  assert.equal(items[2]!.category, "school");
  assert.ok(Date.parse(edited.at) >= Date.parse(created.at), "newest first");
  // every item is exactly the published shape and nothing more
  for (const i of items) assert.deepEqual(Object.keys(i).sort(), ["actor", "at", "category", "detail", "entity", "id", "summary"]);
});

test("the stored details are never sent: an admission number, ids and per-child marks stay out of the response", { skip }, async () => {
  await q(
    `insert into audit_log (school_id, actor_user_id, action, entity_type, details) values ($1, $2, 'student.registered', 'student', $3::jsonb)`,
    [DEV_IDS.school, DEV_IDS.head, JSON.stringify({ admissionNo: "MA-SECRET-77", classId: DEV_IDS.class7A, note: "Kuda is struggling", email: "kuda@family.example" })],
  );
  await q(
    `insert into audit_log (school_id, actor_user_id, action, entity_type, details) values ($1, $2, 'brand.new_action', 'thing', $3::jsonb)`,
    [DEV_IDS.school, DEV_IDS.head, JSON.stringify({ secret: "do-not-show-me" })],
  );
  const body = JSON.stringify(await raw({ limit: "20" }));
  for (const leaked of ["MA-SECRET-77", "Kuda", "kuda@family", "struggling", "do-not-show-me", "details"]) assert.ok(!body.includes(leaked), `leaked ${leaked}`);
  const items = (await page({ limit: "20" })).items;
  assert.deepEqual(items.slice(0, 2).map((i) => [i.summary, i.detail, i.category]), [
    ["Made a change", null, "other"],
    ["Registered a student", "Put in a class at the same time", "students"],
  ]);
});

test("a register is shown as a day and a count; the children in it are not", { skip }, async () => {
  const kids = await studentsOf(f, DEV_IDS.class7A);
  assert.ok(kids.length >= 2);
  const op = attendanceOp(DEV_IDS.class7A, "2026-10-08", [{ studentId: kids[0]!, status: "absent" }, { studentId: kids[1]!, status: "late" }]);
  await push(f.deps, f.chipo.auth, { deviceId: "device-chipo-001", ops: [op] });
  const top = (await page()).items[0]!;
  assert.equal(top.summary, "Recorded attendance");
  assert.equal(top.detail, "Register for 2026-10-08. 2 marks changed");
  assert.equal(top.category, "attendance");
  assert.equal(top.actor.id, DEV_IDS.teacher);
  const body = JSON.stringify(top);
  for (const k of kids) assert.ok(!body.includes(k), "no student id");
  assert.ok(!body.includes("device-chipo"), "no device id");
});

test("another school's head sees only their own school, whatever they pass", { skip }, async () => {
  const theirs = await everything({}, () => f.otherHead);
  assert.deepEqual(theirs, [], "a school with no activity has an empty log");
  const otherYear = expectOk(await call(f, f.otherHead, "POST /v1/academic-years", { body: { name: "2026", startsOn: "2026-01-05", endsOn: "2026-12-11", isActive: true } }), 201).body.id as string;
  expectOk(await call(f, f.otherHead, "POST /v1/classes", { body: { name: "Form 2A", gradeLevel: "9", academicYearId: otherYear } }), 201);
  const mine = await everything();
  const theirs2 = await everything({}, () => f.otherHead);
  assert.deepEqual(theirs2.map((i) => i.detail), ["Form 2A", "2026. Made current"]);
  assert.ok(!mine.some((i) => i.detail === "Form 2A"), "the other school's entry is not in mine");
  assert.ok(mine.length > 5);
  // naming a school, a person from the other school, or a marker taken from the other school's page changes nothing
  const sneaky = await everything({ schoolId: DEV_IDS.school }, () => f.otherHead);
  assert.deepEqual(sneaky.map((i) => i.id), theirs2.map((i) => i.id));
  assert.deepEqual((await page({ actor: DEV_IDS.head }, () => f.otherHead)).items, []);
  assert.deepEqual((await page({ actor: ADMIN_EXTRA.otherHead })).items, []);
  const marker = (await page({ limit: "1" }, () => f.otherHead)).items[0]!.id;
  const withForeignMarker = await page({ before: String(BigInt(marker) + 1000000n), limit: "100" });
  assert.ok(!withForeignMarker.items.some((i) => i.detail === "Form 2A"));
});

test("paging visits every entry once: a page of N, a marker, and an end that says so", { skip }, async () => {
  for (let i = 0; i < 10; i++) {
    await q(`insert into audit_log (school_id, actor_user_id, action, entity_type, details) values ($1, $2, 'student.updated', 'student', '{"fields":["firstName"]}'::jsonb)`, [DEV_IDS.school, DEV_IDS.head]);
  }
  const all = await everything();
  assert.ok(all.length >= 8);
  const seen: string[] = [];
  let before: string | undefined;
  let pages = 0;
  for (; pages < 100; pages++) {
    const p = await page({ limit: "3", ...(before ? { before } : {}) });
    assert.ok(p.items.length <= 3);
    seen.push(...p.items.map((i) => i.id));
    if (p.nextBefore === null) break;
    assert.equal(p.items.length, 3, "a page with an older page behind it is full");
    assert.equal(p.nextBefore, p.items[2]!.id);
    before = p.nextBefore;
  }
  assert.deepEqual(seen, all.map((i) => i.id));
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(pages, Math.ceil(all.length / 3) - 1);
  // exactly one page of data: no phantom "next page"
  const exact = await page({ limit: String(all.length) });
  assert.equal(exact.items.length, all.length);
  assert.equal(exact.nextBefore, null);
  const oneShort = await page({ limit: String(all.length - 1) });
  assert.notEqual(oneShort.nextBefore, null);
});

test("filter by kind: students, classes, staff and so on each keep their own", { skip }, async () => {
  expectOk(await call(f, f.head, "POST /v1/staff/invitations", { body: { email: "filter.me@mavambo.example" } }), 201);
  const staff = await everything({ category: "staff" });
  assert.ok(staff.length >= 1 && staff.every((i) => i.category === "staff"));
  const classes = await everything({ category: "classes" });
  assert.ok(classes.length >= 2 && classes.every((i) => i.category === "classes"));
  const attendance = await everything({ category: "attendance" });
  assert.ok(attendance.length >= 1 && attendance.every((i) => i.category === "attendance"));
  const school = await everything({ category: "school" });
  assert.ok(school.length >= 1 && school.every((i) => i.category === "school"));
  const all = await everything();
  assert.ok(all.some((i) => i.category === "other"), "everything includes what no filter covers");
  const sum = staff.length + classes.length + attendance.length + school.length + (await everything({ category: "students" })).length + all.filter((i) => i.category === "other").length;
  assert.equal(sum, all.length, "the kinds add up to everything");
});

test("filter by person", { skip }, async () => {
  const teacher = await everything({ actor: DEV_IDS.teacher });
  assert.ok(teacher.length >= 1 && teacher.every((i) => i.actor.id === DEV_IDS.teacher));
  const head = await everything({ actor: DEV_IDS.head });
  assert.ok(head.every((i) => i.actor.id === DEV_IDS.head));
  assert.equal(teacher.length + head.length, (await everything()).length);
});

test("filter by school day, read in the school's own time zone", { skip }, async () => {
  // Harare is UTC+2: 22:00 UTC on the 7th is midnight on the 8th.
  await q(`insert into audit_log (school_id, actor_user_id, action, entity_type, details, at) values
             ($1, $2, 'term.created', 'term', '{"name":"day-a"}'::jsonb, '2026-03-07T21:59:59Z'),
             ($1, $2, 'term.created', 'term', '{"name":"day-b"}'::jsonb, '2026-03-07T22:00:00Z'),
             ($1, $2, 'term.created', 'term', '{"name":"day-c"}'::jsonb, '2026-03-08T21:59:59Z')`, [DEV_IDS.school, DEV_IDS.head]);
  const names = async (query: Record<string, string>) => (await everything(query)).map((i) => i.detail).filter((d) => d?.startsWith("day-")).sort();
  assert.deepEqual(await names({ from: "2026-03-08", to: "2026-03-08" }), ["day-b", "day-c"]);
  assert.deepEqual(await names({ from: "2026-03-07", to: "2026-03-07" }), ["day-a"]);
  assert.deepEqual(await names({ from: "2026-03-08" }), ["day-b", "day-c"]);
  assert.deepEqual(await names({ to: "2026-03-07" }), ["day-a"]);
  assert.deepEqual(await names({ from: "2026-03-09", to: "2026-03-20" }), []);
});

test("bad queries are refused with a clear 400 naming the field", { skip }, async () => {
  expectError(await call(f, f.head, KEY, { query: { category: "money" } }), 400, "invalid_request", "category");
  expectError(await call(f, f.head, KEY, { query: { limit: "0" } }), 400, "invalid_request", "limit");
  expectError(await call(f, f.head, KEY, { query: { limit: "101" } }), 400, "invalid_request", "limit");
  expectError(await call(f, f.head, KEY, { query: { limit: "1.5" } }), 400, "invalid_request", "limit");
  expectError(await call(f, f.head, KEY, { query: { limit: "banana" } }), 400, "invalid_request", "limit");
  expectError(await call(f, f.head, KEY, { query: { actor: "not-a-uuid" } }), 400, "invalid_request", "actor");
  for (const before of ["abc", "0", "-5", "1; drop table audit_log", "1e5", "9".repeat(30), "01"]) {
    expectError(await call(f, f.head, KEY, { query: { before } }), 400, "invalid_request", "before");
  }
  expectError(await call(f, f.head, KEY, { query: { from: "2026-02-30" } }), 400, "invalid_request", "from");
  expectError(await call(f, f.head, KEY, { query: { to: "yesterday" } }), 400, "invalid_request", "to");
  expectError(await call(f, f.head, KEY, { query: { from: "2026-05-02", to: "2026-05-01" } }), 400, "invalid_request", "from");
  expectOk(await call(f, f.head, KEY, { query: { from: "2026-05-01", to: "2026-05-01" } }));
  expectOk(await call(f, f.head, KEY, { query: { limit: "", category: "" } }), 200); // blanks count as absent
});

test("reading the log changes nothing", { skip }, async () => {
  const count = async () => (await q<{ n: number }>(`select count(*)::int n from audit_log`))[0]!.n;
  const before = await count();
  await page({ limit: "100" });
  await everything({ category: "staff" });
  assert.equal(await count(), before);
});

// ---------- keeping the screen honest as the product grows ----------

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") ? [p] : [];
  });
}

test("every audit action the API writes is one the screen can describe, and every description is for an action still written", () => {
  const root = fileURLToPath(new URL("../src", import.meta.url));
  const written = new Set<string>();
  for (const file of sources(root)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\baudit\(\s*\w+\s*,\s*\w+\s*,\s*"([a-z_]+\.[a-z_]+)"/g)) written.add(m[1]!);
    for (const m of text.matchAll(/\baction:\s*"([a-z_]+\.[a-z_]+)"/g)) written.add(m[1]!);
  }
  assert.ok(written.size >= 20, `the scan found only ${written.size} actions: the pattern no longer matches how audit entries are written`);
  const described = new Set(AUDIT_ACTIONS);
  assert.deepEqual([...written].filter((a) => !described.has(a)).sort(), [], "written but not described: the screen would say 'Made a change'");
  assert.deepEqual([...described].filter((a) => !written.has(a)).sort(), [], "described but never written: a stale description");
});
