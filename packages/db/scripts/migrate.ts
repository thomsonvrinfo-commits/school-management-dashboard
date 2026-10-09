/** Apply SQL migrations to DATABASE_URL. Usage: DATABASE_URL=postgres://... npm run db:migrate */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { migrate } from "../src/migrate.ts";
import { postgresJsRunner } from "../src/postgres-js.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const dir = fileURLToPath(new URL("../migrations/", import.meta.url));
const migrations = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .map((name) => ({ name, sql: readFileSync(dir + name, "utf8") }));

const sql = postgres(url, { max: 1 });
try {
  const applied = await migrate(postgresJsRunner(sql), migrations);
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date.");
} finally {
  await sql.end();
}
