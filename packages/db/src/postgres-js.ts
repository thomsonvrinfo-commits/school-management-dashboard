/**
 * Production adapter: postgres.js (https://github.com/porsager/postgres) over Cloudflare Hyperdrive.
 * Create one `postgres(connectionString, { max: 5, fetch_types: false })` per request and close it with
 * `ctx.waitUntil(sql.end())`, as Cloudflare's Hyperdrive docs recommend.
 */
import type postgres from "postgres";
import type { SqlClient, SqlParam, SqlRunner } from "./sql.ts";

type Sql = postgres.Sql;
type TransactionSql = postgres.TransactionSql;

function clientOf(sql: Sql | TransactionSql): SqlClient {
  return {
    async query<T>(text: string, params: readonly SqlParam[] = []) {
      const rows = await sql.unsafe(text, params as SqlParam[]);
      return rows as unknown as T[];
    },
    async exec(text: string) {
      await sql.unsafe(text);
    },
  };
}

export function postgresJsRunner(sql: Sql): SqlRunner {
  return {
    ...clientOf(sql),
    async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
      return (await sql.begin((tx) => fn(clientOf(tx)))) as T;
    },
  };
}
