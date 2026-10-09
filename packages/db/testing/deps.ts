/** Re-exports for the test runner, plus an optional loader for the production adapter. */
export { createDb, migrate } from "../src/index.ts";
export type { Db, SqlClient, SqlParam, SqlRunner } from "../src/index.ts";
import type { SqlRunner } from "../src/index.ts";

export async function postgresJsRunnerFactory(url: string): Promise<{ runner: SqlRunner; close(): Promise<void> }> {
  const { default: postgres } = await import("postgres");
  const { postgresJsRunner } = await import("../src/postgres-js.ts");
  const sql = postgres(url, { max: 4, fetch_types: false });
  return { runner: postgresJsRunner(sql), close: () => sql.end() };
}
