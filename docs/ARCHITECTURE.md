# SchoolPulse architecture decisions

The order the system is built in, and the order every request flows through it:

Database -> API -> Auth/Permissions -> Offline/Sync -> Real school records -> Calculations -> Intelligence -> Workflows -> Role experiences -> AI

Slice 1 implements everything up to Calculations for one record type (attendance). Slice 2 adds the real school records the register
depends on: school profile and academic years, the student registry, classes and teacher assignments (see "School administration"
below and `docs/SLICE-2-HANDOFF.md`). Phase P1 ("usable and proven foundation") then added staff onboarding, the activity log, security
hardening, cheaper sync, automatic checks and the operator runbook (see "Staff, security and activity (P1)" below and `docs/P1-HANDOFF.md`).
Teaching structure, honest attendance, intelligence and the later layers are not started.

Other documents: `docs/SECURITY.md` (defences and what is still open), `docs/GOVERNANCE.md` (data held, who sees it, backup and restore,
retention, legal position), `docs/RUNBOOK.md` (running, checking, deploying).

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
- **A refresh asks "has anything changed?" first.** The replica carries a `version`: a SHA-256 of its contents (never of the time), mixed with
  the user id, so it needs no counter or trigger that a forgotten code path could fail to update. `GET /v1/sync/bootstrap?since=<version>`
  answers about 100 bytes (`unchanged`, plus the server's time and today's date) when it still matches, and the whole replica otherwise.
  A changed permission (a class assigned or removed) changes the content, so it changes the version. Replica queries have stable
  tie-breakers so two children with the same name cannot reorder and change it.
- **Polling slows down when nothing happens.** The decisions are pure functions in `packages/sync/src/polling.ts`: 30 seconds, doubling every
  second quiet answer up to 5 minutes; slowest at once when the app is in the background; no timer while offline; quick again for registers
  waiting to send. A full download is forced when nothing is held, the stored version is malformed, the last full copy is over 6 hours old, or
  after sending registers. Old and new clients and servers keep working together (no `since` means everything; no `version` means never ask).

## School administration (Slice 2)

- **Where things live.** Rules are pure functions in `packages/domain` (`academic`, `students`, `classes`); `packages/db` has a second
  query layer (`AdminStore`) beside Slice 1's `Store`, over the same connection; `apps/api/src/school-admin` holds framework-free
  handlers (`(deps, auth, request) -> {status, body}`) that Hono merely adapts, so the tests run the exact code the routes run.
- **A student's class is a dated row, never a field.** Moving a student closes the current `enrollments` row the day before and opens
  the next one, so every register still points at the class it was taken for. An exclusion constraint makes "two classes on one day"
  impossible, whatever the application does.
- **Changes start tomorrow at the earliest** (and at most a year ahead). Every register that exists, or could still be waiting on a
  phone, is dated today or earlier, so a change can never strand one. As a second line of defence a change is refused if any
  register exists on or after its date.
- **The attendance push and the admin screens lock the same placement rows** (share lock in the push, `NO KEY UPDATE` in the admin
  path), so a register being saved and a placement change cannot both decide on stale reads.
- **Only the head administers.** Teachers read the roster of classes they teach and nothing else. The school is always the signed-in
  user's school; a request body that names one is rejected.
- **Mistakes in old data are reported, not hidden**: `packages/db/preflight/` lists legacy rows that would stop the migration, and
  rows that predate the new length limits get a clear 409 when edited.

## Staff, security and activity (P1)

- **Joining and recovery without email.** The head issues an invitation or a password-reset link and hands it over by hand (WhatsApp, text,
  in person). A link is 256 random bits, stored only as a SHA-256 (`staff_tokens`, migration 0003), single-use (claimed atomically),
  expiring and revocable. The secret sits after `#` in the address, which a browser never sends to a server. Three public endpoints take
  a link (`invitations/preview`, `invitations/accept`, `password-reset/complete`); they get no signed-in caller, so the school comes from the
  link and cannot come from anywhere else.
- **Who manages whom.** A head manages teachers only. Head accounts are created and recovered by the platform operator's command line
  (`apps/api/scripts/operator.ts`), so one head cannot lock out or take over another. No new roles were added.
- **The activity log is read through a deny-by-default describer.** `GET /v1/audit` (head only, newest first, cursor paging, filters) turns
  each stored action into plain words with a per-action function and never sends the raw stored details; a test fails if the API writes an
  action nobody described.
- **Defence in depth in the browser and at the edge.** The web build writes a strict Content-Security-Policy and other headers from the API
  address (`apps/web/scripts`), the API sets its own, and an optional Cloudflare rate-limit binding slows guessing on public endpoints
  (per endpoint and address, never per account, and it lets people in if the limiter itself breaks). See `docs/SECURITY.md` for what is
  verified and what only a deployment can show.
- **Handlers are framework-free where it matters most.** School administration, staff, activity and sync's bootstrap are plain
  `(deps, auth, request) -> {status, body}` functions that the tests call directly; sign-in, `me`, the sync push and the attendance
  summary are still written inline in `app.ts` (Slice 1). `routes.ts` is the single table of routes and policies either way: the app
  refuses to start if a route has no handler or a handler has no policy.
- **Automatic checks.** `.github/workflows/ci.yml` runs the tests on a throw-away PostgreSQL, the real migration runner twice on an empty
  database, the render checks, a web build that must write the headers and refuse a bad API address, the tests again through the production
  driver, and a phone-sized Chromium run (`e2e/`). Written but not yet run on GitHub.

## Known gaps (to close before real schools use it)

1. **Rate limiting is written but not switched on.** The code and an optional binding exist; the `[[ratelimits]]` block in `wrangler.toml` is
   commented out and the binding has never run on Cloudflare (`docs/SECURITY.md`, section 2).
2. **PBKDF2 uses 100,000 iterations**, the Workers WebCrypto cap, below OWASP's 600,000 guidance. Compensated by password length rules
   (10 or more characters, common passwords refused). The count is stored per hash so it can be raised later.
3. **Accounts in more than one school** must pass `schoolId` at login; there is no school picker in the app yet.
4. **No row-level security** in PostgreSQL yet. Designed, with the evidence needed before it is switched on, in `docs/GOVERNANCE.md` section 4.
5. **Local data is not encrypted at rest** in IndexedDB. Sign-out and "a different person signs in" wipe it; a lost phone keeps its copy until
   the head switches the teacher off (the next sync is then refused). Phones used for registers should have a screen lock.
6. **Refresh tokens live in IndexedDB**, so an XSS bug would expose them. The generated Content-Security-Policy is the defence; it has
   not been seen working in a real browser or on Cloudflare Pages (`docs/SECURITY.md`).
7. **Staff screens exist; learner-facing and guardian accounts do not.** Head and teacher are the only roles.
8. **Import (CSV/Excel), notifications and global search** are planned, not built.
9. **Left out on purpose**: a school-admin role below the head, bulk moves and year-end promotion, guardians and contact details, remote wipe,
   refresh-token reuse detection, multi-factor sign-in, a read log (created with the first screen that shows a development record).
10. **Nothing has been deployed.** The schema, API and web app have only been run against throw-away local databases; the browser, Vite build,
    Hono adapter, production database driver and Cloudflare behaviour have not been exercised in this environment.
