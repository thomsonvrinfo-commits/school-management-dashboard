/**
 * Load the fictional Mavambo Academy sample data into an EMPTY development database.
 *   DATABASE_URL=postgres://... npm run db:seed:dev
 * Refuses to run when ENVIRONMENT=production.
 */
import postgres from "postgres";
import { DEV_ACCOUNTS, seedDev } from "@schoolpulse/db";
import { postgresJsRunner } from "@schoolpulse/db/postgres-js";
import { todayInTimezone } from "@schoolpulse/domain";
import { hashPassword } from "../src/auth/password.ts";

if (process.env.ENVIRONMENT === "production") throw new Error("Refusing to seed sample data in production.");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const password = process.env.DEV_PASSWORD ?? "schoolpulse-dev";

const sql = postgres(url, { max: 1 });
try {
  const result = await seedDev(postgresJsRunner(sql), {
    today: todayInTimezone(new Date(), "Africa/Harare"),
    passwordHash: await hashPassword(password),
  });
  console.log(`Seeded ${result.students} students and ${result.attendance} attendance records.`);
  console.log(`Sign in as ${DEV_ACCOUNTS.teacher.email} (teacher) or ${DEV_ACCOUNTS.head.email} (head), password: ${password}`);
} finally {
  await sql.end();
}
