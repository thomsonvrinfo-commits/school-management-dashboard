import type { SqlRunner } from "./sql.ts";

export interface Migration {
  name: string;
  sql: string;
}

/** Applies unapplied migrations in name order, all inside one transaction guarded by an advisory lock. */
export async function migrate(runner: SqlRunner, migrations: readonly Migration[]): Promise<string[]> {
  const sorted = [...migrations].sort((a, b) => a.name.localeCompare(b.name));
  return runner.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock($1::bigint)", [727_274]);
    await tx.exec(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const done = new Set((await tx.query<{ name: string }>("select name from schema_migrations")).map((r) => r.name));
    const applied: string[] = [];
    for (const m of sorted) {
      if (done.has(m.name)) continue;
      await tx.exec(m.sql);
      await tx.query("insert into schema_migrations (name) values ($1)", [m.name]);
      applied.push(m.name);
    }
    return applied;
  });
}
