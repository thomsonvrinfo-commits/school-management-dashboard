/**
 * The restore drill (docs/GOVERNANCE.md, "Backup and restore"), run for real on a throw-away PostgreSQL: dump a database
 * that holds data, restore it into an empty one, and prove the copy is the same database, not merely one with the same
 * tables. A backup nobody has restored is a hope, so this is the check that it is not.
 *
 * Needs the `psql` test connection (PSQL_TEST_CONN) and PostgreSQL's own `pg_dump` / `pg_restore` on the PATH; skipped
 * otherwise. It proves the dump-and-restore path of THIS schema (including the btree_gist extension and the identity
 * columns). It does not prove anything about a particular provider's backups: that needs a drill on the real service.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, loadMigrations, pgTestsEnabled, type TestDatabase } from "../testing/pg-test-runner.ts";
import { DEV_IDS, createAdminDb, migrate, seedDev } from "../src/index.ts";

const haveTools = (() => {
  try {
    execFileSync("pg_dump", ["--version"], { stdio: "ignore" });
    execFileSync("pg_restore", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const configured = Boolean(process.env.PSQL_TEST_CONN) && pgTestsEnabled();
const skip = !configured
  ? "no PostgreSQL configured (set PSQL_TEST_CONN)"
  : !haveTools ? "pg_dump / pg_restore are not installed" : false;

// On your own computer a missing tool just skips the drill (and says so). In the automatic checks it must FAIL, so a
// broken setup cannot turn the restore drill into a silent pass that never ran.
test("the PostgreSQL backup tools are installed (required in the automatic checks)", { skip: !configured || process.env.CI !== "true" }, () => {
  assert.ok(haveTools, "pg_dump and pg_restore must be on the PATH in CI (install postgresql-client)");
});

const TODAY = "2026-10-08";
let source: TestDatabase;
let copy: TestDatabase;
let dir: string;
let dumpFile: string;
const conn = (name: string) => `${process.env.PSQL_TEST_CONN} dbname=${name}`;

before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), "sp-backup-"));
  dumpFile = join(dir, "backup.dump");
  source = await createTestDatabase();
  await seedDev(source.runner, { today: TODAY, passwordHash: "x" });
  // some rows from the later migrations too: a staff invitation link and an activity entry
  await source.runner.query(
    `insert into staff_tokens (school_id, purpose, email, user_id, token_hash, expires_at, created_by)
     values ($1, 'reset', 'chipo@mavambo.example', $2, $3, now() + interval '1 hour', $4)`,
    [DEV_IDS.school, DEV_IDS.teacher, "A".repeat(43), DEV_IDS.head],
  );
  await createAdminDb(source.runner).store.appendAudit({
    schoolId: DEV_IDS.school, actorUserId: DEV_IDS.head, action: "student.created", entityType: "student", entityId: null, opId: null, details: { name: "Drill" },
  });

  // the backup: PostgreSQL's custom format, the one `pg_restore` can read selectively and in any order
  execFileSync("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", `--file=${dumpFile}`, conn(source.name)]);
  // the restore: into a database that has nothing in it, stopping at the first error
  copy = await createTestDatabase({ migrate: false });
  execFileSync("pg_restore", ["--no-owner", "--exit-on-error", `--dbname=${conn(copy.name)}`, dumpFile]);
});
after(async () => {
  if (skip) return;
  await source?.drop();
  await copy?.drop();
  rmSync(dir, { recursive: true, force: true });
});

const tables = async (t: TestDatabase) =>
  (await t.runner.query<{ name: string }>(
    `select table_name as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`,
  )).map((r) => r.name);

/** One text value that changes if any row of the table changes, whatever order the rows are stored in. */
const fingerprint = async (t: TestDatabase, table: string) =>
  (await t.runner.query<{ n: number; h: string | null }>(
    `select count(*)::int as n, md5(string_agg(x::text, '|' order by x::text)) as h from "${table}" x`,
  ))[0]!;

test("the backup file exists and holds something", { skip }, () => {
  assert.ok(statSync(dumpFile).size > 10_000);
});

test("the restored copy has every table, and in each one exactly the same rows", { skip }, async () => {
  const names = await tables(source);
  assert.deepEqual(await tables(copy), names, "the same set of tables");
  assert.ok(names.includes("staff_tokens") && names.includes("audit_log") && names.includes("attendance_records"), "the drill covers the newest tables too");
  let rows = 0;
  for (const name of names) {
    const a = await fingerprint(source, name);
    const b = await fingerprint(copy, name);
    assert.deepEqual(b, a, `table ${name} differs after restore`);
    rows += a.n;
  }
  assert.ok(rows > 100, "the drill is not an empty-database comparison");
});

test("every constraint and index came back too (keys, the one-class-per-day rule, the new activity indexes)", { skip }, async () => {
  // PostgreSQL prints a restored CHECK with its AND/OR groups flattened ((a AND b) AND c becomes a AND b AND c): same rule,
  // different brackets. So CHECKs are compared without brackets; keys, foreign keys, uniques and exclusions exactly.
  const constraints = async (t: TestDatabase) =>
    (await t.runner.query<{ t: string; conname: string; contype: string; def: string; validated: boolean }>(
      `select conrelid::regclass::text as t, conname, contype, pg_get_constraintdef(oid) as def, convalidated as validated
         from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2`,
    )).map((c) => ({ ...c, def: c.contype === "c" ? c.def.replace(/[()\s]/g, "") : c.def }));
  const indexes = (t: TestDatabase) => t.runner.query(`select indexname, indexdef from pg_indexes where schemaname = 'public' order by 1`);
  const a = await constraints(source);
  assert.ok(a.length > 30 && a.some((c) => c.def.startsWith("EXCLUDE")), "the exclusion constraint is part of what is compared");
  assert.ok(a.some((c) => !c.validated), "a constraint that was added NOT VALID is still not-validated, not quietly checked or dropped");
  assert.deepEqual(await constraints(copy), a);
  const i = await indexes(source);
  assert.ok(i.some((x) => (x as { indexname: string }).indexname === "audit_school_id_idx"));
  assert.deepEqual(await indexes(copy), i);
});

test("the restored database knows which migrations it has: running them again changes nothing", { skip }, async () => {
  assert.deepEqual(await migrate(copy.runner, loadMigrations()), []);
});

test("and it keeps counting from where the original stopped (activity entry numbers do not collide)", { skip }, async () => {
  const max = async (t: TestDatabase) => (await t.runner.query<{ m: string }>(`select max(id)::text as m from audit_log`))[0]!.m;
  const before = BigInt(await max(copy));
  await createAdminDb(copy.runner).store.appendAudit({
    schoolId: DEV_IDS.school, actorUserId: DEV_IDS.head, action: "student.created", entityType: "student", entityId: null, opId: null, details: { name: "After restore" },
  });
  assert.ok(BigInt(await max(copy)) > before);
});

test("the one-class-per-day rule still stops a double placement in the restored copy", { skip }, async () => {
  const [{ student_id, class_id }] = (await copy.runner.query<{ student_id: string; class_id: string }>(
    `select student_id, class_id from enrollments limit 1`,
  )) as [{ student_id: string; class_id: string }];
  const other = (await copy.runner.query<{ id: string }>(`select id from classes where id <> $1 limit 1`, [class_id]))[0]!.id;
  await assert.rejects(
    copy.runner.query(
      `insert into enrollments (school_id, student_id, class_id, starts_on) values ($1, $2, $3, '2026-01-01') returning id`,
      [DEV_IDS.school, student_id, other],
    ),
    // refused by THIS rule, not by some unrelated error that would also make the insert fail
    /enrollments_no_overlap/,
  );
});
