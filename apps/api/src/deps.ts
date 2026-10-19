import type { AdminDb, Db, StaffDb } from "@schoolpulse/db";

/** Everything a service needs, passed in so tests can control time, ids and the database. */
export interface Deps {
  db: Db;
  /** School administration (Slice 2): same database and connection, its own query layer. */
  admin: AdminDb;
  /** Staff onboarding (P1): invitations, reset links, access on and off. Same database and connection again. */
  staff: StaffDb;
  now(): Date;
  newId(): string;
  authSecret: string;
}
