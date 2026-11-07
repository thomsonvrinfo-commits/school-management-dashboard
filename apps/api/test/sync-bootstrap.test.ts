/**
 * The offline-register download with a fingerprint (P1.6), against a real PostgreSQL. A phone that already holds the
 * current copy gets a tiny "unchanged" answer; anything that would change what it shows gives it the whole copy again;
 * and nobody can use somebody else's fingerprint to learn anything.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootstrapResponse, bootstrapUnchanged } from "@schoolpulse/contracts";
import { pgTestsEnabled } from "@schoolpulse/db/testing";
import { SYNC_HANDLERS } from "../src/sync/handlers.ts";
import { ROUTES, routeKey } from "../src/routes.ts";
import { push } from "../src/services/sync.ts";
import { DEV_IDS, EXTRA, call, createYear2026, expectError, expectOk, makeAdminFixture, type AdminFixture, type Signed } from "./admin-support.ts";
import { attendanceOp } from "./support.ts";

const skip = pgTestsEnabled() ? false : "no PostgreSQL configured (set PSQL_TEST_CONN)";
const KEY = "GET /v1/sync/bootstrap";
let f: AdminFixture;
let year: string;

before(async () => {
  if (skip) return;
  f = await makeAdminFixture();
  year = await createYear2026(f);
});
after(async () => {
  if (!skip) await f.close();
});

/** The raw body exactly as it goes on the wire. */
const get = async (who: Signed, since?: string) => expectOk(await call(f, who, KEY, since === undefined ? {} : { query: { since } })).body as Record<string, unknown>;
const full = async (who: Signed) => bootstrapResponse.parse(await get(who));
const atTime = async <T>(iso: string, fn: () => Promise<T>): Promise<T> => {
  const real = f.clock.now;
  f.clock.now = new Date(iso);
  try {
    return await fn();
  } finally {
    f.clock.now = real;
  }
};

test("the route is in the master table, with a handler, and the handler is the only place that serves it", () => {
  assert.deepEqual(Object.keys(SYNC_HANDLERS), [KEY]);
  assert.ok(ROUTES.some((r) => routeKey(r) === KEY));
});

test("a plain request gets the whole copy, with a version", async (t) => {
  if (skip) return t.skip(skip);
  const b = await full(f.chipo);
  assert.match(b.version, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(b.students.length, 32);
  assert.equal("unchanged" in b, false);
});

test("asking again with the version just received gets only 'unchanged', today and the clock", async (t) => {
  if (skip) return t.skip(skip);
  const b = await full(f.chipo);
  const raw = await get(f.chipo, b.version);
  assert.deepEqual(Object.keys(raw).sort(), ["serverTime", "today", "unchanged", "version"]);
  const u = bootstrapUnchanged.parse(raw);
  assert.equal(u.version, b.version);
  assert.equal(u.today, b.today);
  assert.ok(JSON.stringify(raw).length < 200, "a few dozen bytes, not the replica");
  assert.ok(JSON.stringify(await get(f.chipo)).length > 2000, "…while the whole copy is large");
});

test("the version does not depend on when it was asked, only on what the phone would hold", async (t) => {
  if (skip) return t.skip(skip);
  const a = await full(f.chipo);
  f.clock.now = new Date(f.clock.now.getTime() + 90_000);
  try {
    const b = await full(f.chipo);
    assert.notEqual(a.serverTime, b.serverTime);
    assert.equal(a.version, b.version);
  } finally {
    f.clock.now = new Date(f.clock.now.getTime() - 90_000);
  }
});

test("a version that is well-formed but not current gets the whole copy", async (t) => {
  if (skip) return t.skip(skip);
  const b = bootstrapResponse.parse(await get(f.chipo, "A".repeat(43)));
  assert.equal(b.students.length, 32);
});

test("a malformed since is a 400 naming the field, never a server error and never silently ignored", async (t) => {
  if (skip) return t.skip(skip);
  for (const bad of ["short", "has spaces in it which is not allowed....", "x".repeat(65), "bad/chars+here=padding=="]) {
    expectError(await call(f, f.chipo, KEY, { query: { since: bad } }), 400, "invalid_request", "since");
  }
});

test("the role gate comes first: the head is refused before the request is even read", async (t) => {
  if (skip) return t.skip(skip);
  expectError(await call(f, f.head, KEY, { query: { since: "not a version" } }), 403, "forbidden");
});

test("an empty since means 'not sent'", async (t) => {
  if (skip) return t.skip(skip);
  bootstrapResponse.parse(await get(f.chipo, ""));
});

test("recording attendance changes the version, and the next 'since' gets the new copy", async (t) => {
  if (skip) return t.skip(skip);
  const before = await full(f.chipo);
  const kid = before.students.find((s) => s.classId === DEV_IDS.class7A)!;
  const existing = before.attendance.find((a) => a.studentId === kid.id && a.date === "2026-10-07");
  const op = attendanceOp(DEV_IDS.class7A, "2026-10-07", [{ studentId: kid.id, status: existing?.status === "absent" ? "present" : "absent", baseVersion: existing?.version ?? 0 }]);
  expectOk({ status: 200, body: await push(f.deps, f.chipo.auth, { deviceId: "device-chipo-001", ops: [op] }) });

  const after = await get(f.chipo, before.version);
  assert.equal("unchanged" in after, false, "stale fingerprint → full copy");
  const b = bootstrapResponse.parse(after);
  assert.notEqual(b.version, before.version);
  assert.ok(b.attendance.some((a) => a.studentId === kid.id && a.date === "2026-10-07" && a.status !== existing?.status));
  assert.equal(bootstrapUnchanged.parse(await get(f.chipo, b.version)).unchanged, true, "and that new fingerprint is current");
});

test("what the head changes for a teacher changes her version: a new class, a renamed child, a removed teacher", async (t) => {
  if (skip) return t.skip(skip);
  const v0 = (await full(f.chipo)).version;

  const cls = expectOk(await call(f, f.head, "POST /v1/classes", { body: { name: "Version 1A", gradeLevel: "V1", stream: null, academicYearId: year } }), 201).body.id as string;
  expectOk(await call(f, f.head, "POST /v1/classes/:id/teachers", { params: { id: cls }, body: { userId: DEV_IDS.teacher } }));
  const v1 = (await full(f.chipo)).version;
  assert.notEqual(v1, v0, "a new class");

  const kid = expectOk(await call(f, f.head, "POST /v1/students", {
    body: { admissionNo: "VER-1", firstName: "Ver", lastName: "One", enrolmentDate: "2026-01-12", classId: cls, classStartsOn: "2026-02-02" },
  }), 201).body;
  const v2 = (await full(f.chipo)).version;
  assert.notEqual(v2, v1, "a new child in a class she teaches");

  expectOk(await call(f, f.head, "PATCH /v1/students/:id", { params: { id: kid.id }, body: { firstName: "Vera" } }));
  const v3 = (await full(f.chipo)).version;
  assert.notEqual(v3, v2, "a corrected name");

  expectOk(await call(f, f.head, "DELETE /v1/classes/:id/teachers/:userId", { params: { id: cls, userId: DEV_IDS.teacher } }));
  const v4 = await full(f.chipo);
  assert.notEqual(v4.version, v3, "a class taken away");
  assert.ok(!v4.classes.some((c) => c.id === cls));
});

test("a new school day gives a new version even when no register changed", async (t) => {
  if (skip) return t.skip(skip);
  const today = await full(f.chipo);
  const tomorrow = await atTime("2026-10-09T06:05:00.000Z", () => full(f.chipo));
  assert.equal(tomorrow.today, "2026-10-09");
  assert.notEqual(tomorrow.version, today.version);
  // a phone still holding yesterday's copy is therefore never told 'unchanged' on the new day
  const raw = await atTime("2026-10-09T06:05:00.000Z", () => get(f.chipo, today.version));
  assert.equal("unchanged" in raw, false);
});

test("the school day alone is enough to change the version: a teacher with nothing else that changes", async (t) => {
  if (skip) return t.skip(skip);
  // Form 1A at the other school has no children, no timetable and no attendance, so only the date differs between days
  const day1 = await full(f.otherTeacher);
  const day2 = await atTime("2026-10-09T06:05:00.000Z", () => full(f.otherTeacher));
  assert.deepEqual([day1.students.length, day1.todaySlots.length, day1.attendance.length], [0, 0, 0]);
  assert.deepEqual([day2.students.length, day2.todaySlots.length, day2.attendance.length], [0, 0, 0]);
  assert.notEqual(day2.version, day1.version);
});

test("nobody can use somebody else's version: another teacher in the same school, another school, the head", async (t) => {
  if (skip) return t.skip(skip);
  const chipo = await full(f.chipo);
  // Mr. Tendai teaches 7A too, but his copy is his own
  const tendai = bootstrapResponse.parse(await get(f.tendai, chipo.version));
  assert.notEqual(tendai.version, chipo.version);
  assert.deepEqual(tendai.classes.map((c) => c.id), [DEV_IDS.class7A], "only the class he teaches");
  // the other school's teacher gets their own school's copy, and none of ours
  const other = bootstrapResponse.parse(await get(f.otherTeacher, chipo.version));
  assert.equal(other.school.id, EXTRA.otherSchool);
  assert.ok(other.classes.every((c) => c.id === EXTRA.otherClass));
  // the head may not use the offline register at all, with or without a fingerprint
  expectError(await call(f, f.head, KEY), 403, "forbidden");
  expectError(await call(f, f.head, KEY, { query: { since: chipo.version } }), 403, "forbidden");
});

test("children with the same name come back in the same order every time, so the version is stable", async (t) => {
  if (skip) return t.skip(skip);
  const cls = expectOk(await call(f, f.head, "POST /v1/classes", { body: { name: "Twins 1A", gradeLevel: "T1", stream: null, academicYearId: year } }), 201).body.id as string;
  expectOk(await call(f, f.head, "POST /v1/classes/:id/teachers", { params: { id: cls }, body: { userId: DEV_IDS.teacher } }));
  for (const no of ["TW-1", "TW-2", "TW-3", "TW-4", "TW-5"]) {
    expectOk(await call(f, f.head, "POST /v1/students", {
      body: { admissionNo: no, firstName: "Same", lastName: "Name", enrolmentDate: "2026-01-12", classId: cls, classStartsOn: "2026-02-02" },
    }), 201);
  }
  const first = await full(f.chipo);
  const ids = first.students.filter((s) => s.classId === cls).map((s) => s.id);
  assert.equal(ids.length, 5);
  assert.deepEqual(ids, [...ids].sort(), "ties are broken by id");
  for (let i = 0; i < 5; i++) assert.equal((await full(f.chipo)).version, first.version);
});
