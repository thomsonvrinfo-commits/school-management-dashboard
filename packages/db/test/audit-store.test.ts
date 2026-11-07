/**
 * Migration 0004 and the activity-screen query, on a real PostgreSQL: the migration only adds two indexes and keeps every
 * row; the query is scoped to one school, newest first, pages without gaps or repeats, and reads school days in the
 * school's own time zone.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDatabase, loadMigrations, pgTestsEnabled, type TestDatabase } from "../testing/pg-test-runner.ts";
import { DEV_IDS, createAdminDb, migrate, seedDev, type AuditFilter } from "../src/index.ts";

const skip = pgTestsEnabled() ? false : "no PostgreSQL configured (set PSQL_TEST_CONN)";
const TODAY = "2026-10-08";
const OTHER_SCHOOL = "00000000-0000-4000-8000-000000000002";
const OTHER_HEAD = "00000000-0000-4000-8000-000000000015";
const HARARE = "Africa/Harare";
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let t: TestDatabase;
let admin: ReturnType<typeof createAdminDb>;

before(async () => {
  if (skip) return;
  t = await createTestDatabase();
  await seedDev(t.runner, { today: TODAY, passwordHash: "x" });
  await t.runner.query(`insert into schools (id, name) values ($1, 'Other School')`, [OTHER_SCHOOL]);
  await t.runner.query(`insert into users (id, email, name, password_hash) values ($1, 'head@other.example', 'Other Head', 'x')`, [OTHER_HEAD]);
  admin = createAdminDb(t.runner);
});
after(async () => {
  if (!skip) await t.drop();
});

const log = (action: string, over: { schoolId?: string; actor?: string; at?: string; details?: unknown; entityType?: string; entityId?: string | null } = {}) =>
  admin.store.appendAudit({
    schoolId: over.schoolId ?? DEV_IDS.school, actorUserId: over.actor ?? DEV_IDS.head, action, entityType: over.entityType ?? "student",
    entityId: over.entityId === undefined ? null : over.entityId, opId: null, details: over.details ?? {},
  });
/** Moves the entry whose details.name is `marker` to a chosen instant (earlier tests' entries are left alone). */
const setAt = (marker: string, at: string) => t.runner.query(`update audit_log set at = $2::timestamptz where details->>'name' = $1`, [marker, at]);
const filter = (over: Partial<AuditFilter> = {}): AuditFilter => ({ timeZone: HARARE, ...over });

// ---------- the migration ----------

test("0004 applies over a 0003 database, adds exactly two indexes on audit_log and keeps every row", { skip }, async () => {
  const all = loadMigrations();
  const db = await createTestDatabase({ migrate: false });
  try {
    await migrate(db.runner, all.filter((m) => m.name <= "0003_staff_onboarding.sql"));
    await seedDev(db.runner, { today: TODAY, passwordHash: "x" });
    await db.runner.query(
      `insert into audit_log (school_id, actor_user_id, action, entity_type, details) values ($1, $2, 'student.registered', 'student', '{"a":1}'::jsonb)`,
      [DEV_IDS.school, DEV_IDS.head],
    );
    const indexes = async () => (await db.runner.query<{ i: string }>(`select indexname i from pg_indexes where tablename = 'audit_log' order by 1`)).map((r) => r.i);
    const tables = async () => (await db.runner.query<{ t: string }>(`select table_name t from information_schema.tables where table_schema = 'public' order by 1`)).map((r) => r.t);
    const before = { indexes: await indexes(), tables: await tables() };

    assert.deepEqual(await migrate(db.runner, all), all.map((m) => m.name).filter((n) => n > "0003_staff_onboarding.sql").sort());

    const after = await indexes();
    assert.deepEqual(after.filter((i) => !before.indexes.includes(i)), ["audit_school_actor_idx", "audit_school_id_idx"]);
    for (const old of before.indexes) assert.ok(after.includes(old), `${old} survives`);
    assert.deepEqual(await tables(), before.tables, "no table added or removed");
    assert.equal((await db.runner.query<{ n: number }>(`select count(*)::int n from audit_log`))[0]!.n, 1);
    const def = (name: string) => db.runner.query<{ d: string }>(`select indexdef d from pg_indexes where indexname = $1`, [name]).then((r) => r[0]!.d);
    assert.match(await def("audit_school_id_idx"), /\(school_id, id DESC\)/);
    assert.match(await def("audit_school_actor_idx"), /\(school_id, actor_user_id, id DESC\)/);
  } finally {
    await db.drop();
  }
});

const preflight = readFileSync(fileURLToPath(new URL("../preflight/0004_audit_viewer.sql", import.meta.url)), "utf8")
  .split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n").trim().replace(/;\s*$/, "");
const run = (db: TestDatabase) => db.runner.query<{ severity: string; problem: string; school_id: string | null; detail: string }>(preflight);

test("pre-flight 0004: clean on a 0003 database, blocks when 0003 is missing or an index already exists", { skip }, async () => {
  const all = loadMigrations();
  const db = await createTestDatabase({ migrate: false });
  try {
    await migrate(db.runner, all.filter((m) => m.name === "0001_init.sql" || m.name === "0002_school_administration.sql"));
    assert.deepEqual((await run(db)).map((r) => r.problem), ["earlier_migrations_missing"]);

    await migrate(db.runner, all.filter((m) => m.name === "0003_staff_onboarding.sql"));
    assert.deepEqual(await run(db), []);

    await migrate(db.runner, all);
    assert.deepEqual((await run(db)).filter((r) => r.severity === "blocking").map((r) => r.problem), ["audit_index_already_exists", "audit_index_already_exists"]);
  } finally {
    await db.drop();
  }
});

// ---------- the query ----------

test("entries come back newest first, with who did them, and never from another school", { skip }, async () => {
  await log("student.registered", { details: { admissionNo: "MA1" }, entityId: uid(1) });
  await log("class.created", { entityType: "class", details: { name: "Grade 9" }, entityId: uid(2) });
  await log("student.registered", { schoolId: OTHER_SCHOOL, actor: OTHER_HEAD, details: { admissionNo: "ZZ9" } });
  const rows = await admin.store.listAudit(DEV_IDS.school, filter(), 50);
  const mine = rows.filter((r) => r.action === "class.created" || r.action === "student.registered");
  assert.equal(mine.length, 2);
  assert.deepEqual(mine.map((r) => r.action), ["class.created", "student.registered"], "newest first");
  assert.ok(rows.every((r) => r.actorId === DEV_IDS.head && r.actorName.length > 0), "only this school's people");
  assert.ok(!JSON.stringify(rows).includes("ZZ9"), "the other school's entry is invisible");
  const created = rows.find((r) => r.action === "class.created")!;
  assert.deepEqual(created.details, { name: "Grade 9" }, "details come back parsed");
  assert.equal(created.entityId, uid(2));
  assert.match(created.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(created.id, /^[1-9]\d*$/);
  const theirs = await admin.store.listAudit(OTHER_SCHOOL, filter(), 50);
  assert.deepEqual(theirs.map((r) => r.actorName), ["Other Head"]);
});

test("paging by 'before' visits every entry exactly once, in order, and stops", { skip }, async () => {
  for (let i = 0; i < 23; i++) await log("student.updated", { details: { fields: ["firstName"] }, entityId: uid(3000 + i) });
  const everything = await admin.store.listAudit(DEV_IDS.school, filter(), 1000);
  const seen: string[] = [];
  let before: string | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const page = await admin.store.listAudit(DEV_IDS.school, filter(before ? { before } : {}), 5);
    if (page.length === 0) break;
    assert.ok(page.length <= 5);
    seen.push(...page.map((r) => r.id));
    before = page[page.length - 1]!.id;
  }
  assert.deepEqual(seen, everything.map((r) => r.id), "same entries, same order, none twice");
  assert.equal(new Set(seen).size, seen.length);
  assert.ok(seen.length >= 25);
  const ids = seen.map((s) => BigInt(s));
  for (let i = 1; i < ids.length; i++) assert.ok(ids[i]! < ids[i - 1]!, "strictly descending");
  assert.deepEqual(await admin.store.listAudit(DEV_IDS.school, filter({ before: seen[seen.length - 1]! }), 5), []);
});

test("the category filter keeps whole families of actions, and only those", { skip }, async () => {
  await log("academic_year.created", { entityType: "academic_year", details: { name: "2026" } });
  await log("term.created", { entityType: "term", details: { name: "Term 1" } });
  await log("school.updated", { entityType: "school", details: { fields: ["name"] } });
  await log("staff.invited", { entityType: "staff_invitation" });
  const school = await admin.store.listAudit(DEV_IDS.school, filter({ actionPrefixes: ["school", "academic_year", "term"] }), 100);
  assert.deepEqual(school.map((r) => r.action).sort(), ["academic_year.created", "school.updated", "term.created"]);
  const staff = await admin.store.listAudit(DEV_IDS.school, filter({ actionPrefixes: ["staff"] }), 100);
  assert.deepEqual(staff.map((r) => r.action), ["staff.invited"]);
  assert.deepEqual(await admin.store.listAudit(DEV_IDS.school, filter({ actionPrefixes: ["nothing"] }), 100), []);
  // a prefix is a whole first part, not a text match: "stud" must not find "student.*"
  assert.deepEqual(await admin.store.listAudit(DEV_IDS.school, filter({ actionPrefixes: ["stud"] }), 100), []);
  // and a % in a prefix is just a character
  assert.deepEqual(await admin.store.listAudit(DEV_IDS.school, filter({ actionPrefixes: ["%"] }), 100), []);
});

test("one person's actions", { skip }, async () => {
  await log("class.updated", { actor: DEV_IDS.teacher, entityType: "class" });
  const theirs = await admin.store.listAudit(DEV_IDS.school, filter({ actorUserId: DEV_IDS.teacher }), 100);
  assert.deepEqual(theirs.map((r) => r.action), ["class.updated"]);
  assert.deepEqual(await admin.store.listAudit(DEV_IDS.school, filter({ actorUserId: uid(999) }), 100), []);
  assert.deepEqual(await admin.store.listAudit(DEV_IDS.school, filter({ actorUserId: OTHER_HEAD }), 100), [], "another school's person has no entries here");
});

test("a school day is read in the school's own time zone, inclusive at both ends", { skip }, async () => {
  await log("term.deleted", { entityType: "term", details: { name: "edge-a" } });
  await log("term.updated", { entityType: "term", details: { name: "edge-b" } });
  await log("term.created", { entityType: "term", details: { name: "edge-c" } });
  // 23:59:59 on 7 Oct in Harare (UTC+2), exactly midnight on the 8th, and 23:59:59 on the 8th.
  await setAt("edge-a", "2026-10-07T21:59:59Z");
  await setAt("edge-b", "2026-10-07T22:00:00Z");
  await setAt("edge-c", "2026-10-08T21:59:59Z");
  const isEdge = (r: { details: unknown }) => String((r.details as { name?: string }).name).startsWith("edge-");
  const day = async (from: string, to: string, tz = HARARE) =>
    (await admin.store.listAudit(DEV_IDS.school, { timeZone: tz, actionPrefixes: ["term"], fromDate: from, toDate: to }, 100)).filter(isEdge).map((r) => r.action).sort();
  assert.deepEqual(await day("2026-10-08", "2026-10-08"), ["term.created", "term.updated"], "the 8th in Harare");
  assert.deepEqual(await day("2026-10-07", "2026-10-07"), ["term.deleted"]);
  assert.deepEqual(await day("2026-10-07", "2026-10-08"), ["term.created", "term.deleted", "term.updated"]);
  assert.deepEqual(await day("2026-10-09", "2026-10-09"), []);
  // the same instants, read in UTC, fall on different days: the zone matters
  assert.deepEqual(await day("2026-10-08", "2026-10-08", "UTC"), ["term.created"]);
  const from = await admin.store.listAudit(DEV_IDS.school, { timeZone: HARARE, actionPrefixes: ["term"], fromDate: "2026-10-08" }, 100);
  assert.deepEqual(from.filter(isEdge).map((r) => r.action).sort(), ["term.created", "term.updated"], "from only: that day and after");
  const to = await admin.store.listAudit(DEV_IDS.school, { timeZone: HARARE, actionPrefixes: ["term"], toDate: "2026-10-07" }, 100);
  assert.deepEqual(to.filter(isEdge).map((r) => r.action), ["term.deleted"], "to only: that day and before");
});

test("filters combine, and a limit of 1 returns one row", { skip }, async () => {
  const rows = await admin.store.listAudit(DEV_IDS.school, filter({ actionPrefixes: ["student"], actorUserId: DEV_IDS.head, fromDate: "2020-01-01", toDate: "2099-12-31" }), 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.actorId, DEV_IDS.head);
});

test("hostile input is data: prefixes, ids and time zones are parameters, never SQL", { skip }, async () => {
  const before = (await admin.store.listAudit(DEV_IDS.school, filter(), 1000)).length;
  await assert.rejects(admin.store.listAudit(DEV_IDS.school, filter({ before: "1; drop table audit_log" }), 5));
  await assert.rejects(admin.store.listAudit(DEV_IDS.school, { timeZone: "Not/AZone", fromDate: "2026-01-01" }, 5));
  assert.deepEqual(await admin.store.listAudit(DEV_IDS.school, filter({ actionPrefixes: ["student') or ('1'='1"] }), 5), []);
  assert.equal((await admin.store.listAudit(DEV_IDS.school, filter(), 1000)).length, before, "the table is intact");
});
