/**
 * Route-by-route sweep of the Slice 2 API surface: every route has a handler and a policy, the role gate runs before
 * anything is read, and no route can be used across schools. The per-feature tests cover behaviour; this file is the
 * net that catches a route someone adds later without thinking about who may call it.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { roleMayAttempt, type Role } from "@schoolpulse/domain";
import { pgTestsEnabled } from "@schoolpulse/db/testing";
import type { Deps } from "../src/deps.ts";
import { HttpError } from "../src/errors.ts";
import { ROUTES, SCHOOL_ADMIN_ROUTES, routeKey } from "../src/routes.ts";
import type { AuthContext } from "../src/services/auth.ts";
import { SCHOOL_ADMIN_HANDLERS, schoolAdminKeys } from "../src/school-admin/handlers.ts";
import { DEV_IDS, EXTRA, call, expectOk, makeAdminFixture, type AdminFixture, type Signed } from "./admin-support.ts";

const skip = pgTestsEnabled() ? false : "no PostgreSQL configured (set PSQL_TEST_CONN)";

// ---------- no database needed ----------

test("every Slice 2 route has exactly one handler, and every handler has a route", () => {
  assert.deepEqual([...schoolAdminKeys()].sort(), Object.keys(SCHOOL_ADMIN_HANDLERS).sort());
  assert.equal(new Set(schoolAdminKeys()).size, schoolAdminKeys().length);
  assert.ok(schoolAdminKeys().every((k) => ROUTES.some((r) => routeKey(r) === k)), "all of them are in the master route table");
});

test("no Slice 2 route is public, and none is merely 'authenticated': each names an action", () => {
  for (const r of SCHOOL_ADMIN_ROUTES) assert.ok(typeof r.access === "object", `${routeKey(r)} must name a policy action`);
});

test("methods follow the contract: reads are GET, nothing that changes data is a GET", () => {
  for (const r of SCHOOL_ADMIN_ROUTES) {
    const reads = typeof r.access === "object" && /:(read|read-roster|own-classes)$/.test(r.access.action);
    if (r.method === "GET") assert.ok(reads, `${routeKey(r)} is a GET but its action is not a read`);
    else assert.ok(!reads || r.method === "POST", `${routeKey(r)} changes data but its action is a read`);
  }
});

test("a role that may never use a route gets a 403 before the input is even looked at", async () => {
  const stubDeps = new Proxy({}, { get() { throw new Error("the service layer must not be reached"); } }) as unknown as Deps;
  const authAs = (role: Role): AuthContext => ({ principal: { userId: "u", schoolId: "s", role }, ctx: {} } as unknown as AuthContext);
  let refused = 0;
  for (const r of SCHOOL_ADMIN_ROUTES) {
    if (typeof r.access !== "object") continue;
    for (const role of ["head", "teacher"] as const) {
      const auth = authAs(role);
      if (roleMayAttempt(auth.principal, r.access.action)) continue;
      const req = {
        params: { id: "not-a-uuid", placementId: "x", userId: "y" },
        query: { limit: "-1", offset: "zzz", date: "never" },
        json: async () => { throw new Error("the body must not be read"); },
      };
      await assert.rejects(
        SCHOOL_ADMIN_HANDLERS[routeKey(r)]!(stubDeps, auth, req),
        (e: unknown) => e instanceof HttpError && e.status === 403 && e.code === "forbidden",
        `${role} on ${routeKey(r)}`,
      );
      refused++;
    }
  }
  assert.ok(refused >= 20, `expected the sweep to cover many refusals, covered ${refused}`);
});

test("the policy table matches the people: head runs the school; a teacher only reads rosters of own classes and /me/classes", () => {
  const teacherMay = SCHOOL_ADMIN_ROUTES.filter((r) => typeof r.access === "object" && roleMayAttempt({ userId: "u", schoolId: "s", role: "teacher" }, r.access.action)).map(routeKey);
  assert.deepEqual(teacherMay.sort(), ["GET /v1/classes/:id/roster", "GET /v1/me/classes"]);
  const headMayNot = SCHOOL_ADMIN_ROUTES.filter((r) => typeof r.access === "object" && !roleMayAttempt({ userId: "u", schoolId: "s", role: "head" }, r.access.action)).map(routeKey);
  assert.deepEqual(headMayNot, ["GET /v1/me/classes"], "the head has no personal teaching list");
});

// ---------- with the database ----------

interface Resources {
  head: Signed; teacher: Signed;
  year: string; term: string; student: string; placement: string; class: string; teacherId: string;
}
let f: AdminFixture;
let mavambo: Resources;
let other: Resources;

const TABLES = ["classes", "students", "enrollments", "class_teachers", "academic_years", "terms", "audit_log", "attendance_records"] as const;
async function snapshot(schoolId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of TABLES) {
    const [row] = await f.t.runner.query<{ h: string }>(
      `select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from ${t} x where school_id = $1`, [schoolId]);
    out[t] = row!.h;
  }
  return out;
}

async function setUp(head: Signed, teacherId: string, teacher: Signed, ids: { class?: string }): Promise<Resources> {
  const year = expectOk(await call(f, head, "POST /v1/academic-years", { body: { name: "2026", startsOn: "2026-01-05", endsOn: "2026-12-11", isActive: true } }), 201).body.id as string;
  const term = expectOk(await call(f, head, "POST /v1/academic-years/:id/terms", { params: { id: year }, body: { name: "Term 3", startsOn: "2026-09-01", endsOn: "2026-12-04" } }), 201).body.id as string;
  const cls = ids.class ?? (expectOk(await call(f, head, "POST /v1/classes", { body: { name: "Sweep 1A", gradeLevel: "1", stream: "S", academicYearId: year } }), 201).body.id as string);
  const student = expectOk(await call(f, head, "POST /v1/students", { body: { admissionNo: "SW-1", firstName: "Sweep", lastName: "Test", enrolmentDate: "2026-01-12", classId: cls, classStartsOn: "2026-02-02" } }), 201).body;
  return { head, teacher, year, term, student: student.id, placement: student.placements[0].id, class: cls, teacherId };
}

before(async () => {
  if (skip) return;
  f = await makeAdminFixture();
  // Mavambo: the head's own year (so the seeded Slice 1 classes stay yearless), a class taught by Ms. Chipo
  mavambo = await setUp(f.head, DEV_IDS.teacher, f.chipo, {});
  expectOk(await call(f, f.head, "POST /v1/classes/:id/teachers", { params: { id: mavambo.class }, body: { userId: DEV_IDS.teacher } }));
  other = await setUp(f.otherHead, EXTRA.otherTeacher, f.otherTeacher, {});
  expectOk(await call(f, f.otherHead, "POST /v1/classes/:id/teachers", { params: { id: other.class }, body: { userId: EXTRA.otherTeacher } }));
});
after(async () => {
  if (!skip) await f.close();
});

/** A valid request for each route that takes an id, aimed at the resources of `r`, made by someone whose own school's resources are `mine`. */
const REQUESTS: Record<string, (r: Resources, mine: Resources) => { params: Record<string, string>; body?: unknown }> = {
  "PATCH /v1/academic-years/:id": (r) => ({ params: { id: r.year }, body: { name: "Hijacked" } }),
  "DELETE /v1/academic-years/:id": (r) => ({ params: { id: r.year } }),
  "POST /v1/academic-years/:id/terms": (r) => ({ params: { id: r.year }, body: { name: "Hijack term", startsOn: "2026-06-01", endsOn: "2026-06-30" } }),
  "PATCH /v1/terms/:id": (r) => ({ params: { id: r.term }, body: { name: "Hijacked" } }),
  "DELETE /v1/terms/:id": (r) => ({ params: { id: r.term } }),
  "GET /v1/students/:id": (r) => ({ params: { id: r.student } }),
  "PATCH /v1/students/:id": (r) => ({ params: { id: r.student }, body: { firstName: "Hijacked" } }),
  "POST /v1/students/:id/status": (r) => ({ params: { id: r.student }, body: { status: "withdrawn", effectiveFrom: "2026-10-20" } }),
  "POST /v1/students/:id/placements": (r, mine) => ({ params: { id: r.student }, body: { classId: mine.class, effectiveFrom: "2026-10-20" } }),
  "DELETE /v1/students/:id/placements/:placementId": (r) => ({ params: { id: r.student, placementId: r.placement } }),
  "GET /v1/classes/:id": (r) => ({ params: { id: r.class } }),
  "PATCH /v1/classes/:id": (r) => ({ params: { id: r.class }, body: { name: "Hijacked" } }),
  "GET /v1/classes/:id/roster": (r) => ({ params: { id: r.class } }),
  "POST /v1/classes/:id/teachers": (r, mine) => ({ params: { id: r.class }, body: { userId: mine.teacherId } }),
  "DELETE /v1/classes/:id/teachers/:userId": (r) => ({ params: { id: r.class, userId: r.teacherId } }),
};

test("the sweep covers every Slice 2 route that takes an id", { skip }, () => {
  const withId = SCHOOL_ADMIN_ROUTES.filter((r) => r.path.includes(":")).map(routeKey).sort();
  assert.deepEqual(Object.keys(REQUESTS).sort(), withId);
});

test("no route can reach another school's year, term, student, placement, class or teacher assignment", { skip }, async () => {
  const beforeM = await snapshot(DEV_IDS.school);
  const beforeO = await snapshot(EXTRA.otherSchool);
  let calls = 0;
  for (const [key, build] of Object.entries(REQUESTS)) {
    // the other school's head against Mavambo's resources, and the reverse
    for (const [who, target, mine] of [[f.otherHead, mavambo, other], [f.head, other, mavambo]] as const) {
      const { params, body } = build(target, mine);
      const res = await call(f, who, key, { params, body });
      assert.equal(res.status, 404, `${key} as ${who === f.head ? "Mavambo" : "other"} head: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error.code, "not_found", key);
      calls++;
    }
    // teachers: the head-only routes are refused outright; the roster is 404 for a class in another school
    for (const [who, target, mine] of [[f.otherTeacher, mavambo, other], [f.chipo, other, mavambo]] as const) {
      const { params, body } = build(target, mine);
      const res = await call(f, who, key, { params, body });
      const expected = key === "GET /v1/classes/:id/roster" ? 404 : 403;
      assert.equal(res.status, expected, `${key} as a teacher: ${JSON.stringify(res.body)}`);
      calls++;
    }
  }
  assert.equal(calls, Object.keys(REQUESTS).length * 4);
  assert.deepEqual(await snapshot(DEV_IDS.school), beforeM, "nothing in Mavambo changed, including its audit log");
  assert.deepEqual(await snapshot(EXTRA.otherSchool), beforeO, "nothing in the other school changed, including its audit log");
});

test("a teacher is refused every head-only route even for their own school's resources, and nothing changes", { skip }, async () => {
  const beforeM = await snapshot(DEV_IDS.school);
  for (const r of SCHOOL_ADMIN_ROUTES) {
    if (typeof r.access !== "object") continue;
    const key = routeKey(r);
    const build = REQUESTS[key];
    const req = build ? build(mavambo, mavambo) : { params: {}, body: {} };
    const res = await call(f, f.chipo, key, { ...req, query: {} });
    if (key === "GET /v1/classes/:id/roster") assert.equal(res.status, 200, "her own class's roster");
    else if (key === "GET /v1/me/classes") assert.equal(res.status, 200);
    else assert.equal(res.status, 403, `${key}: ${JSON.stringify(res.body)}`);
  }
  assert.deepEqual(await snapshot(DEV_IDS.school), beforeM);
});

test("the head is refused the teacher-only list, and a teacher's other roster is refused", { skip }, async () => {
  assert.equal((await call(f, f.head, "GET /v1/me/classes")).status, 403);
  // Mr. Tendai teaches 7A only; Ms. Chipo's sweep class is not his
  assert.equal((await call(f, f.tendai, "GET /v1/classes/:id/roster", { params: { id: mavambo.class } })).status, 403);
});

test("a body may never name the school: every route with a body rejects an extra schoolId and changes nothing", { skip }, async () => {
  const beforeM = await snapshot(DEV_IDS.school);
  const withBody: [string, Record<string, string>, Record<string, unknown>][] = [
    ["PATCH /v1/school", {}, { name: "Mavambo Academy" }],
    ["POST /v1/academic-years", {}, { name: "2030", startsOn: "2030-01-07", endsOn: "2030-12-13" }],
    ["PATCH /v1/academic-years/:id", { id: mavambo.year }, { name: "2026" }],
    ["POST /v1/academic-years/:id/terms", { id: mavambo.year }, { name: "Term 1", startsOn: "2026-01-12", endsOn: "2026-04-10" }],
    ["PATCH /v1/terms/:id", { id: mavambo.term }, { name: "Term 3" }],
    ["POST /v1/students", {}, { admissionNo: "SC-1", firstName: "A", lastName: "B" }],
    ["PATCH /v1/students/:id", { id: mavambo.student }, { firstName: "Sweep" }],
    ["POST /v1/students/:id/status", { id: mavambo.student }, { status: "withdrawn" }],
    ["POST /v1/students/:id/placements", { id: mavambo.student }, { classId: mavambo.class }],
    ["POST /v1/classes", {}, { name: "Schooled", gradeLevel: "1", academicYearId: mavambo.year }],
    ["PATCH /v1/classes/:id", { id: mavambo.class }, { name: "Sweep 1A" }],
    ["POST /v1/classes/:id/teachers", { id: mavambo.class }, { userId: DEV_IDS.teacher }],
  ];
  for (const [key, params, body] of withBody) {
    const res = await call(f, f.head, key, { params, body: { ...body, schoolId: EXTRA.otherSchool } });
    assert.equal(res.status, 400, `${key}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error.code, "invalid_request", key);
  }
  assert.deepEqual(await snapshot(DEV_IDS.school), beforeM);
  assert.deepEqual(await snapshot(EXTRA.otherSchool).then((s) => Object.keys(s).length), TABLES.length);
});

test("a malformed id in the path is a plain 404 on every route, never a 500", { skip }, async () => {
  for (const [key, build] of Object.entries(REQUESTS)) {
    const good = build(mavambo, mavambo);
    for (const name of Object.keys(good.params)) {
      const params = { ...good.params, [name]: "not-a-uuid" };
      const res = await call(f, f.head, key, { params, body: good.body });
      assert.equal(res.status, 404, `${key} with bad ${name}: ${JSON.stringify(res.body)}`);
    }
  }
});

test("a head whose token names no known user, or a signed-in user of a school with no data, still only ever sees their own school", { skip }, async () => {
  // a brand-new school with nothing in it: every list is empty, not an error, and never holds anyone else's rows
  const fresh = crypto.randomUUID();
  const freshHead = crypto.randomUUID();
  await f.t.runner.query(`insert into schools (id, name) values ($1, 'Fresh School')`, [fresh]);
  const [{ password_hash }] = (await f.t.runner.query<{ password_hash: string }>(`select password_hash from users where id = $1`, [DEV_IDS.head])) as [{ password_hash: string }];
  await f.t.runner.query(`insert into users (id, email, name, password_hash) values ($1, 'head@fresh.example', 'Fresh Head', $2)`, [freshHead, password_hash]);
  await f.t.runner.query(`insert into memberships (id, user_id, school_id, role) values ($1, $2, $3, 'head')`, [crypto.randomUUID(), freshHead, fresh]);
  const { signIn } = await import("./support.ts");
  const head = await signIn(f.deps, "head@fresh.example", "device-fresh-001");
  for (const path of ["GET /v1/students", "GET /v1/classes", "GET /v1/academic-years", "GET /v1/teachers"]) {
    const res = expectOk(await call(f, head, path));
    const items = Array.isArray(res.body) ? res.body : res.body.items;
    assert.deepEqual(items, [], path);
  }
  const profile = expectOk(await call(f, head, "GET /v1/school")).body;
  assert.equal(profile.name, "Fresh School");
});
