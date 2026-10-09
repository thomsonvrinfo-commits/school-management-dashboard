import type { Db } from "@schoolpulse/db";

/** Everything a service needs, passed in so tests can control time, ids and the database. */
export interface Deps {
  db: Db;
  now(): Date;
  newId(): string;
  authSecret: string;
}
