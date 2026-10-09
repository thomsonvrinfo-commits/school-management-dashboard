/**
 * The only thing the rest of the code knows about the database driver.
 * Production implements this with postgres.js over Hyperdrive (see postgres-js.ts);
 * tests can implement it with any PostgreSQL client. Parameters are always scalars (string, number,
 * boolean, null); structured values go in as JSON text and are cast in the SQL (`$1::jsonb`).
 */
export type SqlParam = string | number | boolean | null;

export interface SqlClient {
  /** Run one parameterised statement and return its rows. */
  query<T = Record<string, unknown>>(text: string, params?: readonly SqlParam[]): Promise<T[]>;
  /** Run one or more statements with no parameters (migrations). */
  exec(text: string): Promise<void>;
}

export interface SqlRunner extends SqlClient {
  /** BEGIN ... COMMIT around `fn`; ROLLBACK if it throws. */
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}
