import type { AdminDb, Db } from "@schoolpulse/db";

/** Everything a service needs, passed in so tests can control time, ids and the database. */
export interface Deps {
  db: Db;
  /** School administration (Slice 2): same database and connection, its own query layer. */
  admin: AdminDb;
  now(): Date;
  newId(): string;
  authSecret: string;
}
