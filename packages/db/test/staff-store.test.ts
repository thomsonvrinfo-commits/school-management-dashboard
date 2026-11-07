/**
 * Migration 0003 and the staff store, on a real PostgreSQL: what the database itself refuses, that every query is
 * scoped to one school, and that a link can be claimed exactly once even when two people open it at the same instant.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDatabase, loadMigrations, pgTestsEnabled, type TestDatabase } from "../testing/pg-test-runner.ts";
import { DEV_IDS, createStaffDb, migrate, seedDev, type NewStaffToken } from "../src/index.ts";

const skip = pgTestsEnabled() ? false : "no PostgreSQL configured (set PSQL_TEST_CONN)";
const TODAY = "2026-10-08";
const NOW = "2026-10-19T08:00:00.000Z";
const LATER = "2026-10-26T08:00:00.000Z";
const OTHER_SCHOOL = "00000000-0000-4000-8000-000000000002";
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let t: TestDatabase;
let staff: ReturnType<typeof createStaffDb>;

before(async () => {
  if (skip) return;
  t = await createTestDatabase();
  await seedDev(t.runner, { today: TODAY, passwordHash: "x" });
  await t.runner.query(`insert into schools (id, name) values ($1, 'Other School')`, [OTHER_SCHOOL]);
  staff = createStaffDb(t.runner);
});
after(async () => {
  if (!skip) await t.drop();
});

let counter = 9000;
const invite = (over: Partial<NewStaffToken> = {}): NewStaffToken => {
  counter += 1;
  return {
    id: uid(counter), schoolId: DEV_IDS.school, purpose: "invite", email: `new${counter}@mavambo.example`, name: null, role: "teacher",
    userId: null, tokenHash: `hash-${counter}-xxxxxxxxxxxxxxxxxxxx`, expiresAt: LATER, createdBy: DEV_IDS.head, ...over,
  };
};

// ---------- the migration ----------

test("0003 applies over a database holding Slice 1 and 2 data, adds only staff_tokens and keeps every row", { skip }, async () => {
  const all = loadMigrations();
  const db = await createTestDatabase({ migrate: false });
  try {
    await migrate(db.runner, all.filter((m) => m.name <= "0002_school_administration.sql"));
    await seedDev(db.runner, { today: TODAY, passwordHash: "x" });
    const count = async (table: string) => (await db.runner.query<{ n: number }>(`select count(*)::int n from ${table}`))[0]!.n;
    const tables = async () => (await db.runner.query<{ t: string }>(`select table_name t from information_schema.tables where table_schema = 'public' order by 1`)).map((r) => r.t);
    const before = { tables: await tables(), users: await count("users"), memberships: await count("memberships"), attendance: await count("attendance_records"), students: await count("students") };

    assert.deepEqual(await migrate(db.runner, all), all.map((m) => m.name).filter((n) => n > "0002_school_administration.sql").sort());

    const after = await tables();
    assert.ok(after.includes("staff_tokens"));
    assert.deepEqual(after.filter((n) => !before.tables.includes(n)).filter((n) => n === "staff_tokens"), ["staff_tokens"]);
    for (const old of before.tables) assert.ok(after.includes(old), `${old} survives`);
    assert.equal(await count("users"), before.users);
    assert.equal(await count("memberships"), before.memberships);
    assert.equal(await count("attendance_records"), before.attendance);
    assert.equal(await count("students"), before.students);
    assert.equal(await count("staff_tokens"), 0);
  } finally {
    await db.drop();
  }
});

const preflight = readFileSync(fileURLToPath(new URL("../preflight/0003_staff_onboarding.sql", import.meta.url)), "utf8")
  .split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n").trim().replace(/;\s*$/, "");
const run = (db: TestDatabase) => db.runner.query<{ severity: string; problem: string; school_id: string | null; detail: string }>(preflight);

test("pre-flight 0003: clean on a 0002 database, blocks when 0002 is missing or the table already exists, advises on odd data", { skip }, async () => {
  const all = loadMigrations();
  const db = await createTestDatabase({ migrate: false });
  try {
    await migrate(db.runner, all.filter((m) => m.name === "0001_init.sql"));
    assert.deepEqual((await run(db)).filter((r) => r.severity === "blocking").map((r) => r.problem), ["earlier_migrations_missing"]);

    await migrate(db.runner, all.filter((m) => m.name <= "0002_school_administration.sql"));
    await db.runner.query(`insert into schools (id, name) values ($1, 'No Head Yet')`, [OTHER_SCHOOL]);
    await db.runner.query(`insert into users (id, email, name, password_hash) values ($1, 'Mixed.Case@Example.com', 'Mixed', 'x')`, [uid(1)]);
    const rows = await run(db);
    assert.deepEqual(rows.filter((r) => r.severity === "blocking"), []);
    assert.deepEqual(rows.map((r) => r.problem).sort(), ["email_not_lower_case", "school_without_active_head"]);
    assert.equal(rows.find((r) => r.problem === "school_without_active_head")!.school_id, OTHER_SCHOOL);

    await migrate(db.runner, all); // now 0003 (and later) exist
    assert.ok((await run(db)).some((r) => r.severity === "blocking" && r.problem === "staff_tokens_already_exists"));
  } finally {
    await db.drop();
  }
});

// ---------- what the database itself refuses ----------

const refuses = (p: Promise<unknown>, what: RegExp) => assert.rejects(p, what);

test("the shape check: an invitation needs a role and no user, a reset needs a user and no role", { skip }, async () => {
  await refuses(staff.store.insertToken(invite({ role: null })), /staff_tokens_shape/);
  await refuses(staff.store.insertToken(invite({ userId: DEV_IDS.teacher })), /staff_tokens_shape/);
  await refuses(staff.store.insertToken(invite({ purpose: "reset", role: null, userId: null })), /staff_tokens_shape/);
  await refuses(staff.store.insertToken(invite({ purpose: "reset", role: "teacher", userId: DEV_IDS.teacher })), /staff_tokens_shape/);
  await staff.store.insertToken(invite({ purpose: "reset", role: null, userId: DEV_IDS.teacher }));
  await staff.store.revokeWaitingResets(DEV_IDS.school, DEV_IDS.teacher, NOW);
});

test("emails are stored lower-case, hashes are unique, and a link cannot be both used and revoked", { skip }, async () => {
  await refuses(staff.store.insertToken(invite({ email: "Upper@Mavambo.Example" })), /staff_tokens_email_check|violates check constraint/);
  const a = invite();
  await staff.store.insertToken(a);
  await refuses(staff.store.insertToken(invite({ tokenHash: a.tokenHash })), /token_hash_key|duplicate key/);
  await refuses(t.runner.query(`update staff_tokens set used_at = now(), revoked_at = now() where id = $1`, [a.id]), /staff_tokens_one_ending/);
});

test("only one waiting invitation per person per school; a revoked or used one frees the slot; another school is independent", { skip }, async () => {
  const first = invite({ email: "slot@mavambo.example" });
  await staff.store.insertToken(first);
  await refuses(staff.store.insertToken(invite({ email: "slot@mavambo.example" })), /staff_tokens_one_open_invite|duplicate key/);
  await staff.store.insertToken(invite({ email: "slot@mavambo.example", schoolId: OTHER_SCHOOL }));

  assert.equal(await staff.store.revokeWaitingInvitations(DEV_IDS.school, "SLOT@mavambo.example", NOW), 1, "matching ignores case");
  await staff.store.insertToken(invite({ email: "slot@mavambo.example" }));
});

test("only one waiting reset per person per school", { skip }, async () => {
  const user = uid(9501);
  await t.runner.query(`insert into users (id, email, name, password_hash) values ($1, 'resetme@mavambo.example', 'Reset Me', 'x')`, [user]);
  await staff.store.insertToken(invite({ purpose: "reset", role: null, userId: user, email: "resetme@mavambo.example" }));
  await refuses(staff.store.insertToken(invite({ purpose: "reset", role: null, userId: user, email: "resetme@mavambo.example" })), /staff_tokens_one_open_reset|duplicate key/);
  assert.equal(await staff.store.revokeWaitingResets(DEV_IDS.school, user, NOW), 1);
  await staff.store.insertToken(invite({ purpose: "reset", role: null, userId: user, email: "resetme@mavambo.example" }));
});

// ---------- the store ----------

test("listStaff shows heads first, then by name, and only this school's people", { skip }, async () => {
  const rows = await staff.store.listStaff(DEV_IDS.school);
  assert.deepEqual(rows.map((r) => [r.name, r.role]), [["Mr. Mbewe", "head"], ["Ms. Chipo", "teacher"]]);
  assert.match(rows[0]!.joinedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.deepEqual(await staff.store.listStaff(OTHER_SCHOOL), []);
});

test("members are found by email ignoring case, and only within their own school", { skip }, async () => {
  const m = await staff.store.findStaffByEmail(DEV_IDS.school, "CHIPO@Mavambo.Example");
  assert.equal(m?.userId, DEV_IDS.teacher);
  assert.equal(await staff.store.findStaffByEmail(OTHER_SCHOOL, "chipo@mavambo.example"), null);
  assert.equal(await staff.store.getStaffMember(OTHER_SCHOOL, DEV_IDS.teacherMembership), null, "another school's id returns nothing");
  assert.equal((await staff.store.getStaffMember(DEV_IDS.school, DEV_IDS.teacherMembership))?.name, "Ms. Chipo");
  assert.equal((await staff.store.lockStaffMember(DEV_IDS.school, DEV_IDS.teacherMembership))?.active, true);
});

test("switching access off ends that person's sessions at this school and no one else's", { skip }, async () => {
  const mk = async (id: number, user: string, membership: string, school: string, hash: string) =>
    t.runner.query(
      `insert into sessions (id, user_id, school_id, membership_id, device_id, refresh_hash, expires_at) values ($1, $2, $3, $4, 'device-x-0001', $5, now() + interval '1 day')`,
      [uid(id), user, school, membership, hash],
    );
  await mk(9601, DEV_IDS.teacher, DEV_IDS.teacherMembership, DEV_IDS.school, "rh-9601-aaaaaaaaaaaa");
  await mk(9602, DEV_IDS.teacher, DEV_IDS.teacherMembership, DEV_IDS.school, "rh-9602-aaaaaaaaaaaa");
  await mk(9603, DEV_IDS.head, DEV_IDS.headMembership, DEV_IDS.school, "rh-9603-aaaaaaaaaaaa");

  assert.equal(await staff.store.revokeSessionsOfMembership(OTHER_SCHOOL, DEV_IDS.teacherMembership), 0, "wrong school: nothing happens");
  assert.equal(await staff.store.revokeSessionsOfMembership(DEV_IDS.school, DEV_IDS.teacherMembership), 2);
  assert.equal(await staff.store.revokeSessionsOfMembership(DEV_IDS.school, DEV_IDS.teacherMembership), 0, "already ended");
  const live = await t.runner.query<{ id: string }>(`select id from sessions where revoked_at is null and id in ($1, $2, $3)`, [uid(9601), uid(9602), uid(9603)]);
  assert.deepEqual(live.map((r) => r.id), [uid(9603)]);
});

test("a link is found by its hash with its school, and only a waiting link can be claimed, once", { skip }, async () => {
  const tok = invite({ email: "claim@mavambo.example" });
  await staff.store.insertToken(tok);
  const found = await staff.store.findTokenByHash(tok.tokenHash);
  assert.equal(found?.schoolId, DEV_IDS.school);
  assert.equal(found?.schoolName, "Mavambo Academy");
  assert.equal(found?.usedAt, null);
  assert.equal(await staff.store.findTokenByHash("no-such-hash-xxxxxxxxxxxxx"), null);

  assert.equal(await staff.store.claimToken(tok.id, NOW), true);
  assert.equal(await staff.store.claimToken(tok.id, NOW), false, "second claim loses");
  assert.equal((await staff.store.findTokenByHash(tok.tokenHash))?.usedAt, NOW);
});

test("a link cannot be claimed after it expires, or after it is revoked", { skip }, async () => {
  const expired = invite({ email: "late@mavambo.example", expiresAt: "2026-10-19T07:59:59.000Z" });
  await staff.store.insertToken(expired);
  assert.equal(await staff.store.claimToken(expired.id, NOW), false);

  const revoked = invite({ email: "gone@mavambo.example" });
  await staff.store.insertToken(revoked);
  assert.equal(await staff.store.revokeInvitation(DEV_IDS.school, revoked.id, NOW), true);
  assert.equal(await staff.store.claimToken(revoked.id, NOW), false);
  assert.equal(await staff.store.revokeInvitation(DEV_IDS.school, revoked.id, NOW), false, "already revoked");
});

test("two people opening one link at the same instant: exactly one wins", { skip }, async () => {
  const tok = invite({ email: "race@mavambo.example" });
  await staff.store.insertToken(tok);
  const results = await Promise.all(Array.from({ length: 6 }, () => staff.transaction((tx) => tx.claimToken(tok.id, NOW))));
  assert.equal(results.filter(Boolean).length, 1);
});

test("revoking an invitation is scoped to the school that issued it", { skip }, async () => {
  const tok = invite({ email: "scoped@mavambo.example" });
  await staff.store.insertToken(tok);
  assert.equal(await staff.store.revokeInvitation(OTHER_SCHOOL, tok.id, NOW), false);
  assert.equal(await staff.store.getToken(OTHER_SCHOOL, tok.id), null);
  assert.equal((await staff.store.getToken(DEV_IDS.school, tok.id))?.revokedAt, null);
  assert.equal(await staff.store.revokeInvitation(DEV_IDS.school, tok.id, NOW), true);
});

test("the waiting list leaves out used, revoked and expired links, newest first", { skip }, async () => {
  const db = await createTestDatabase();
  try {
    await seedDev(db.runner, { today: TODAY, passwordHash: "x" });
    const s = createStaffDb(db.runner).store;
    const mk = (n: number, over: Partial<NewStaffToken>) => ({ ...invite(), id: uid(9700 + n), email: `list${n}@mavambo.example`, tokenHash: `list-hash-${n}-xxxxxxxxxxxxxxx`, ...over });
    for (const x of [mk(1, {}), mk(2, {}), mk(3, {}), mk(4, { expiresAt: "2026-10-01T00:00:00.000Z" }), mk(5, { schoolId: OTHER_SCHOOL })]) {
      if (x.schoolId === OTHER_SCHOOL) await db.runner.query(`insert into schools (id, name) values ($1, 'Other') on conflict do nothing`, [OTHER_SCHOOL]);
      await s.insertToken(x);
    }
    await s.claimToken(uid(9701), NOW);
    await s.revokeInvitation(DEV_IDS.school, uid(9702), NOW);
    await db.runner.query(`update staff_tokens set created_at = now() - interval '1 hour' where id = $1`, [uid(9703)]);
    const rows = await s.listOpenInvitations(DEV_IDS.school, NOW);
    assert.deepEqual(rows.map((r) => r.email), ["list3@mavambo.example"]);
    assert.equal((await s.listOpenInvitations(OTHER_SCHOOL, NOW)).length, 1);
  } finally {
    await db.drop();
  }
});

test("accounts: lookup ignores case, a new user and membership are created together or not at all", { skip }, async () => {
  assert.equal((await staff.store.findUserByEmail("CHIPO@mavambo.example"))?.id, DEV_IDS.teacher);
  assert.equal(await staff.store.findUserByEmail("nobody@mavambo.example"), null);

  await assert.rejects(
    staff.transaction(async (tx) => {
      await tx.insertUser({ id: uid(9801), email: "atomic@mavambo.example", name: "Atomic", passwordHash: "h" });
      await tx.insertMembership({ id: uid(9802), userId: uid(9801), schoolId: DEV_IDS.school, role: "teacher" });
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(await staff.store.findUserByEmail("atomic@mavambo.example"), null, "rolled back");

  await staff.transaction(async (tx) => {
    await tx.insertUser({ id: uid(9801), email: "atomic@mavambo.example", name: "Atomic", passwordHash: "h" });
    await tx.insertMembership({ id: uid(9802), userId: uid(9801), schoolId: DEV_IDS.school, role: "teacher" });
  });
  assert.equal(await staff.store.membershipCountForUser(uid(9801)), 1);
  // the same person cannot get a second account with the same address in another case
  await refuses(staff.store.insertUser({ id: uid(9803), email: "ATOMIC@mavambo.example", name: "Dup", passwordHash: "h" }), /users_email_lower_key|duplicate key/);
  // and cannot hold two memberships in one school
  await refuses(staff.store.insertMembership({ id: uid(9804), userId: uid(9801), schoolId: DEV_IDS.school, role: "teacher" }), /memberships_user_id_school_id_key|duplicate key/);
});

test("a new password replaces the old one and signing out everywhere ends every session of that account", { skip }, async () => {
  const user = uid(9801);
  await t.runner.query(
    `insert into sessions (id, user_id, school_id, membership_id, device_id, refresh_hash, expires_at) values ($1, $2, $3, $4, 'device-y-0001', 'rh-9901-bbbbbbbbbbbb', now() + interval '1 day')`,
    [uid(9901), user, DEV_IDS.school, uid(9802)],
  );
  await staff.store.setUserPassword(user, "new-hash");
  assert.equal((await staff.store.getUser(user))?.passwordHash, "new-hash");
  assert.equal(await staff.store.revokeAllSessionsOfUser(user), 1);
  assert.equal(await staff.store.revokeAllSessionsOfUser(user), 0);
});

test("operator lookups: schools by code (ignoring case) and the schools of an account", { skip }, async () => {
  await staff.store.insertSchool({ id: uid(9950), name: "Coded School", code: "CODED-1", timezone: "Africa/Harare" });
  assert.equal((await staff.store.findSchoolByCode("coded-1"))?.id, uid(9950));
  assert.equal(await staff.store.findSchoolByCode("nope"), null);
  await refuses(staff.store.insertSchool({ id: uid(9951), name: "Clash", code: "coded-1", timezone: "Africa/Harare" }), /schools_code_key|duplicate key/);
  assert.deepEqual((await staff.store.schoolsOfUser(DEV_IDS.teacher)).map((s) => s.name), ["Mavambo Academy"]);
  assert.equal((await staff.store.getSchool(DEV_IDS.school))?.timezone, "Africa/Harare");
});

test("audit entries written by the staff store land in the same log the other stores use", { skip }, async () => {
  await staff.store.appendAudit({ schoolId: DEV_IDS.school, actorUserId: DEV_IDS.head, action: "staff.invited", entityType: "invitation", entityId: uid(1), opId: null, details: { role: "teacher" } });
  const rows = await t.runner.query<{ action: string; details: { role: string } }>(`select action, details from audit_log where action = 'staff.invited'`);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.details, { role: "teacher" });
});
