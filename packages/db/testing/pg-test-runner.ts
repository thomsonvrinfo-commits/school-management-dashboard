/**
 * TEST SUPPORT ONLY. Gives the tests a real PostgreSQL without needing a JS driver, by driving the `psql` CLI.
 * Each session is one long-lived psql process, so transactions, row locks and concurrent sessions behave exactly
 * as they do against production PostgreSQL.
 *
 * Configure with PSQL_TEST_CONN, a libpq connection string for a role that may create databases, e.g.
 *   PSQL_TEST_CONN="host=localhost user=schoolpulse password=schoolpulse dbname=postgres"
 * (the docker-compose.yml database works). Without it, database tests are skipped.
 *
 * If TEST_DATABASE_URL is set and the `postgres` package is installed, tests use the production adapter instead.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createDb, migrate, postgresJsRunnerFactory, type Db, type SqlClient, type SqlParam, type SqlRunner } from "./deps.ts";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

class PsqlSession {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  private waiter: ((out: string) => void) | null = null;
  private marker = "";
  private counter = 0;

  constructor(conninfo: string) {
    // stderr is merged into stdout by the shell so errors arrive in order with results.
    this.proc = spawn("bash", ["-c", 'exec psql -X -q -A -t -v ON_ERROR_STOP=0 "$0" 2>&1', conninfo]);
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.flush();
    });
  }

  private flush() {
    if (!this.waiter) return;
    const idx = this.buffer.indexOf(this.marker);
    if (idx === -1) return;
    const out = this.buffer.slice(0, idx);
    this.buffer = this.buffer.slice(idx + this.marker.length).replace(/^\r?\n/, "");
    const w = this.waiter;
    this.waiter = null;
    w(out);
  }

  run(statement: string): Promise<string> {
    return new Promise((resolve) => {
      this.counter += 1;
      this.marker = `__END_${this.counter}_${randomBytes(4).toString("hex")}__`;
      this.waiter = resolve;
      this.proc.stdin.write(`${statement};\n\\echo ${this.marker}\n`);
    });
  }

  async checked(statement: string): Promise<string> {
    const out = await this.run(statement);
    const err = out.split("\n").find((l) => /^(ERROR|FATAL|psql: error):/.test(l));
    if (err) throw new Error(`${err}\n  while running: ${statement.slice(0, 200)}`);
    return out;
  }

  close() {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

function literal(p: SqlParam): string {
  if (p === null) return "NULL";
  if (typeof p === "boolean") return p ? "true" : "false";
  if (typeof p === "number") {
    if (!Number.isFinite(p)) throw new TypeError("Non-finite number parameter");
    return String(p);
  }
  return `'${p.replace(/'/g, "''")}'`;
}

function inline(text: string, params: readonly SqlParam[]): string {
  return text.replace(/\$(\d+)/g, (_m, n: string) => {
    const i = Number(n) - 1;
    if (i < 0 || i >= params.length) throw new RangeError(`Missing parameter $${n}`);
    return literal(params[i] as SqlParam);
  });
}

function clientFor(session: PsqlSession): SqlClient {
  return {
    async query<T>(text: string, params: readonly SqlParam[] = []): Promise<T[]> {
      const sql = inline(text, params).trim();
      const returnsRows = /^\s*(select|with)\b/i.test(sql) || /\breturning\b/i.test(sql);
      if (!returnsRows) {
        await session.checked(sql);
        return [];
      }
      const out = await session.checked(
        `with __t as (${sql}) select coalesce(jsonb_agg(to_jsonb(__t)), '[]'::jsonb) from __t`,
      );
      const line = out.trim().split("\n").pop() ?? "[]";
      return JSON.parse(line) as T[];
    },
    async exec(text: string) {
      await session.checked(text.trim().replace(/;\s*$/, ""));
    },
  };
}

export class PsqlRunner implements SqlRunner {
  private idle: PsqlSession[] = [];
  private all: PsqlSession[] = [];
  private readonly conninfo: string;
  constructor(conninfo: string) {
    this.conninfo = conninfo;
  }

  private async acquire(): Promise<PsqlSession> {
    const s = this.idle.pop() ?? new PsqlSession(this.conninfo);
    if (!this.all.includes(s)) this.all.push(s);
    return s;
  }
  private release(s: PsqlSession) {
    this.idle.push(s);
  }

  async query<T>(text: string, params?: readonly SqlParam[]): Promise<T[]> {
    const s = await this.acquire();
    try {
      return await clientFor(s).query<T>(text, params);
    } finally {
      this.release(s);
    }
  }
  async exec(text: string): Promise<void> {
    const s = await this.acquire();
    try {
      await clientFor(s).exec(text);
    } finally {
      this.release(s);
    }
  }
  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    const s = await this.acquire();
    try {
      await s.checked("begin");
      try {
        const result = await fn(clientFor(s));
        await s.checked("commit");
        return result;
      } catch (e) {
        await s.run("rollback");
        throw e;
      }
    } finally {
      this.release(s);
    }
  }
  close() {
    for (const s of this.all) s.close();
  }
}

export interface TestDatabase {
  runner: SqlRunner;
  db: Db;
  name: string;
  drop(): Promise<void>;
}

export function pgTestsEnabled(): boolean {
  return Boolean(process.env.PSQL_TEST_CONN || process.env.TEST_DATABASE_URL);
}

const migrationsDir = fileURLToPath(new URL("../migrations/", import.meta.url));
export function loadMigrations() {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .map((name) => ({ name, sql: readFileSync(migrationsDir + name, "utf8") }));
}

/** Creates a brand-new empty database, applies every migration, and returns handles to it. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `sp_test_${randomBytes(6).toString("hex")}`;

  if (process.env.TEST_DATABASE_URL) {
    const admin = await postgresJsRunnerFactory(process.env.TEST_DATABASE_URL);
    await admin.runner.exec(`create database ${name}`);
    const u = new URL(process.env.TEST_DATABASE_URL);
    u.pathname = `/${name}`;
    const conn = await postgresJsRunnerFactory(u.toString());
    await migrate(conn.runner, loadMigrations());
    return {
      runner: conn.runner,
      db: createDb(conn.runner),
      name,
      async drop() {
        await conn.close();
        await admin.runner.exec(`drop database ${name} with (force)`);
        await admin.close();
      },
    };
  }

  const base = process.env.PSQL_TEST_CONN!;
  const admin = new PsqlRunner(base);
  await admin.exec(`create database ${name}`);
  const runner = new PsqlRunner(`${base} dbname=${name}`);
  await migrate(runner, loadMigrations());
  return {
    runner,
    db: createDb(runner),
    name,
    async drop() {
      runner.close();
      await admin.exec(`drop database ${name} with (force)`);
      admin.close();
    },
  };
}
