# SchoolPulse architecture decisions

The order the system is built in, and the order every request flows through it:

Database -> API -> Auth/Permissions -> Offline/Sync -> Real school records -> Calculations -> Intelligence -> Workflows -> Role experiences -> AI

Slice 1 implements everything up to Calculations for one record type (attendance). Intelligence and later layers are not started.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Frontend | Vite + React + TypeScript SPA/PWA | Logged-in, mobile-first, offline-first app: server rendering adds nothing, and static export fought dynamic routes in the template. |
| Production database | PostgreSQL through Cloudflare Hyperdrive | Relational data (school, class, student, results, fees). SQLite and in-memory stores are not used anywhere, including tests. |
| API | Cloudflare Worker + Hono | Hono only routes. Rules live in services and `packages/domain`. |
| Shared rules | `packages/domain` (pure TypeScript) | The phone and the server run the same attendance maths and the same conflict decision, so numbers cannot disagree. |
| Contracts | zod in `packages/contracts` | One definition, validated on the server, inferred as types on the client. |
| Offline store | Dexie over IndexedDB | The app reads and writes the local store only; the sync engine moves data. |
| Offline logic | `packages/sync` (pure) | Queue, retry, conflict handling and status are testable without a browser. |

## Tenancy

Every tenant table has `school_id`. References between tenant tables are composite `(school_id, id)` foreign keys, so a row
cannot point at another school's data even if application code is wrong. The school for a request comes from the caller's
membership in the database, never from the request body. Not yet done: PostgreSQL row-level security as a second lock.

## Authentication and permissions

- Login returns a 15-minute access token (HS256 JWT: user id, session id) and a rotating refresh token. Only a SHA-256 of the
  refresh token is stored. One `sessions` row per device.
- Every request re-reads the session, user and membership from the database. Role comes from the database, not the token, so
  deactivating someone or revoking a device takes effect on the next request.
- `authorize(principal, action, resource)` in `packages/domain` is one pure function that denies by default. Services look up
  the facts it needs (for example whether the teacher teaches the class) and pass them in.
- `apps/api/src/routes.ts` lists every route with its policy. A test fails if a public route appears without a deliberate edit.

## Offline and sync

- A register save writes to IndexedDB and queues one operation (UUID, device, per-student `baseVersion`). The UI never waits for the network.
- The server records the operation id in the same transaction that applies it. Replays return the stored result.
- Per student the server answers `applied`, `noop` or `conflict`. A conflict means someone else changed that record since this
  device last saw it. Nothing is overwritten; the teacher chooses to keep the register's mark or use their own.
- A device's own earlier write is never a conflict, so saving the same register twice while offline works.
- Failures are separated: no answer (offline, timeout, server error) keeps the operation and retries with backoff; an answer of
  "no" (forbidden, invalid) keeps it visible with the reason until the teacher discards it. Nothing is dropped silently.
- A phone downloads a permission-filtered replica (its classes, students, today's timetable, 14 days of attendance) and nothing else.

## Known gaps (to close before real schools use it)

1. **Login rate limiting is not implemented.** Add a Cloudflare rate-limiting rule or Turnstile on `/v1/auth/login`.
2. **PBKDF2 uses 100,000 iterations**, which I believe is the Workers WebCrypto cap, and below OWASP's 600,000 guidance. Verify the
   cap; raise the count or move to a memory-hard hash if the platform allows. The count is stored per hash so it can be raised later.
3. **Accounts in more than one school** must pass `schoolId` at login; there is no school picker in the app yet.
4. **No row-level security** in PostgreSQL yet.
5. **Local data is not encrypted at rest** in IndexedDB. Sign-out and "a different person signs in" wipe it. Consider device-level protections before holding finance data.
6. **Refresh tokens live in IndexedDB**, so an XSS bug would expose them. Keep a strict Content-Security-Policy on the Pages site.
7. **Replica refresh downloads the whole 14-day window** each time. Fine for one teacher's classes; add incremental pull when it matters.
8. **No password reset, user management or school setup screens.** Accounts come from the seed or direct SQL for now.
9. **Import (CSV/Excel), audit viewer, notifications, global search** are planned, not built.
