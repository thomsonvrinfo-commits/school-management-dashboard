/** Shared helpers for the school-administration (Slice 2) API tests. */
import assert from "node:assert/strict";
import { DEV_IDS } from "@schoolpulse/db";
import { SCHOOL_ADMIN_HANDLERS } from "../src/school-admin/handlers.ts";
import { HttpError } from "../src/errors.ts";
import { EMAILS, EXTRA, PASSWORD, makeFixture, signIn, type Fixture } from "./support.ts";

export { DEV_IDS, EMAILS, EXTRA, PASSWORD };

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const ADMIN_EXTRA = {
  otherHead: uid(15),
  otherHeadMembership: uid(25),
  year: uid(7001),
};

export type Signed = Awaited<ReturnType<typeof signIn>>;
export interface AdminFixture extends Fixture {
  head: Signed;
  chipo: Signed;
  tendai: Signed;
  otherHead: Signed;
  otherTeacher: Signed;
}

/** The Slice 1 fixture (Mavambo Academy + a second school), plus a head at the second school. */
export async function makeAdminFixture(): Promise<AdminFixture> {
  const f = await makeFixture();
  const q = (sql: string, p: (string | number | null)[] = []) => f.t.runner.query(sql, p);
  const [{ password_hash }] = await f.t.runner.query<{ password_hash: string }>(`select password_hash from users where id = $1`, [DEV_IDS.head]) as [{ password_hash: string }];
  await q(`insert into users (id, email, name, password_hash) values ($1, 'head@other.example', 'Other Head', $2)`, [ADMIN_EXTRA.otherHead, password_hash]);
  await q(`insert into memberships (id, user_id, school_id, role) values ($1, $2, $3, 'head')`, [ADMIN_EXTRA.otherHeadMembership, ADMIN_EXTRA.otherHead, EXTRA.otherSchool]);
  return {
    ...f,
    head: await signIn(f.deps, EMAILS.head, "device-head-0001"),
    chipo: await signIn(f.deps, EMAILS.chipo, "device-chipo-001"),
    tendai: await signIn(f.deps, EMAILS.tendai, "device-tendai-01"),
    otherHead: await signIn(f.deps, "head@other.example", "device-ohead-001"),
    otherTeacher: await signIn(f.deps, EMAILS.other, "device-oteach-001"),
  };
}

export interface Res {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export interface CallOptions {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  /** Send this text as the body even though it is not JSON. */
  rawBody?: string;
}

/**
 * Calls an endpoint exactly as the Hono adapter does (same handler, same request view) and turns an HttpError into the
 * status and body the `onError` hook would have produced.
 */
export async function call(f: Fixture, who: Signed, key: string, opts: CallOptions = {}): Promise<Res> {
  const handler = SCHOOL_ADMIN_HANDLERS[key];
  assert.ok(handler, `no handler for ${key}`);
  const req = {
    params: opts.params ?? {},
    query: opts.query ?? {},
    json: async () => {
      if (opts.rawBody !== undefined) return JSON.parse(opts.rawBody);
      return opts.body;
    },
  };
  try {
    const r = await handler(f.deps, who.auth, req);
    return { status: r.status, body: r.body };
  } catch (e) {
    if (e instanceof HttpError) {
      return { status: e.status, body: { error: { code: e.code, message: e.message, ...(e.field ? { field: e.field } : {}) } } };
    }
    throw e;
  }
}

export function expectOk(res: Res, status = 200): Res {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res;
}

export function expectError(res: Res, status: number, code: string, field?: string): Res {
  assert.equal(res.status, status, `expected ${status} ${code}, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body?.error?.code, code, JSON.stringify(res.body));
  if (field !== undefined) assert.equal(res.body.error.field, field, `field of ${JSON.stringify(res.body)}`);
  return res;
}

export const YEAR_2026 = { name: "2026", startsOn: "2026-01-05", endsOn: "2026-12-11" } as const;

/** Create the 2026 academic year (active) as the head and return its id. */
export async function createYear2026(f: AdminFixture, extra: { isActive?: boolean } = {}): Promise<string> {
  const res = expectOk(await call(f, f.head, "POST /v1/academic-years", { body: { ...YEAR_2026, isActive: extra.isActive ?? true } }), 201);
  return res.body.id as string;
}
