/**
 * The activity query's parameters, checked WITHOUT a database. The production driver sends `$n` placeholders and lets
 * PostgreSQL work out their types, and PostgreSQL refuses a statement whose parameter nothing refers to ("could not
 * determine data type of parameter $2"). The test runner pastes values into the text instead, so that failure used to
 * be invisible: the Activity screen's first page (no date filter) would have failed against the real driver.
 * (The database tests also run in the driver's style: PSQL_TEST_EXTENDED=1.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PostgresAdminStore } from "../src/postgres-admin-store.ts";
import type { SqlClient, SqlParam } from "../src/sql.ts";

const ACTOR = "00000000-0000-4000-8000-000000000001";
const SCHOOL = "00000000-0000-4000-8000-0000000000aa";

async function sentFor(filter: Parameters<PostgresAdminStore["listAudit"]>[1]) {
  const calls: { text: string; params: readonly SqlParam[] }[] = [];
  const client: SqlClient = {
    async query<T>(text: string, params: readonly SqlParam[] = []): Promise<T[]> {
      calls.push({ text, params });
      return [];
    },
    async exec() {},
  };
  await new PostgresAdminStore(client).listAudit(SCHOOL, filter, 31);
  assert.equal(calls.length, 1);
  return calls[0]!;
}

const filters: [string, Parameters<PostgresAdminStore["listAudit"]>[1]][] = [
  ["no filter at all (the screen's first page)", { timeZone: "Africa/Harare" }],
  ["only a marker (Show older)", { timeZone: "Africa/Harare", before: "120" }],
  ["only a kind", { timeZone: "Africa/Harare", actionPrefixes: ["student", "class"] }],
  ["only a person", { timeZone: "Africa/Harare", actorUserId: ACTOR }],
  ["only a start day", { timeZone: "Africa/Harare", fromDate: "2026-10-01" }],
  ["only an end day", { timeZone: "Africa/Harare", toDate: "2026-10-31" }],
  ["a whole day range", { timeZone: "Africa/Harare", fromDate: "2026-10-01", toDate: "2026-10-31" }],
  ["everything at once", { timeZone: "Africa/Harare", actionPrefixes: ["staff"], actorUserId: ACTOR, fromDate: "2026-10-01", toDate: "2026-10-31", before: "999" }],
];

for (const [name, filter] of filters) {
  test(`every parameter sent is used by the query, and none is missing: ${name}`, async () => {
    const { text, params } = await sentFor(filter);
    const used = new Set([...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    for (let n = 1; n <= params.length; n++) assert.ok(used.has(n), `$${n} is sent but the statement never refers to it`);
    for (const n of used) assert.ok(n >= 1 && n <= params.length, `$${n} is referred to but no value is sent`);
  });
}

test("the school's time zone is sent only when a date filter needs it, and only once", async () => {
  assert.ok(!(await sentFor({ timeZone: "Africa/Harare" })).params.includes("Africa/Harare"));
  const both = await sentFor({ timeZone: "Africa/Harare", fromDate: "2026-10-01", toDate: "2026-10-31" });
  assert.equal(both.params.filter((p) => p === "Africa/Harare").length, 1);
});
