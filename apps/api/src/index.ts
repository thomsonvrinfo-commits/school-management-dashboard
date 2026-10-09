import postgres from "postgres";
import { createDb } from "@schoolpulse/db";
import { postgresJsRunner } from "@schoolpulse/db/postgres-js";
import { createApp, type DepsFactory } from "./app.ts";

/** One short-lived connection pool per request, over Hyperdrive; closed after the response is sent. */
const makeDeps: DepsFactory = (env) => {
  const sql = postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false });
  return {
    deps: {
      db: createDb(postgresJsRunner(sql)),
      now: () => new Date(),
      newId: () => crypto.randomUUID(),
      authSecret: env.AUTH_SECRET,
    },
    dispose: () => sql.end(),
  };
};

export default createApp(makeDeps);
