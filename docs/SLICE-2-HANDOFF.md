# Slice 2 handoff: school administration, student registry and class management

Branch `slice-2/school-administration` (baseline `fd0ba13`, the Slice 1 commit). Nothing here has been pushed, deployed, or
run against any production database. Slice 1's production deployment is being finished separately, so this slice was built
and tested against a throwaway PostgreSQL 16 and **assumes nothing about the state of the production API or database**.

## 1. Status in one paragraph

The server side (migration, domain rules, store, API handlers, shared contracts) is built and tested against a real PostgreSQL:
**294 tests pass, 0 fail, 0 skipped** (with `PSQL_TEST_CONN` set; see section 8 for what is skipped without it). The head's
screens are built and checked as far as this sandbox allows (pure form logic is unit-tested and the screens render and
announce correctly under `react-dom/server`), but **the Hono adapter, the Vite build and the router/network glue of the screens
have never been executed**, because `hono`, `postgres`, `vite` and `react-router` could not be installed here. The first run on a
machine with the full toolchain is part of integration (section 11).

## 2. What the product did before and what it does now

| | Before (Slice 1) | After (Slice 2) |
|---|---|---|
| School | A row with a name and a timezone. No screens. | Head edits profile (name, code, contact, address, timezone). Academic years and terms: create, edit, one active year, no overlaps, cannot be deleted while in use. |
| Students | Created by SQL/seed. Name and admission number only. | Head registers, searches, filters, views, edits students. Admission number unique per school ignoring case. Optional date of birth and gender. Enrolment date and status (enrolled, withdrawn, transferred, graduated). |
| Classes | Created by SQL/seed, unique name per school. | Head creates, edits, archives and reactivates classes with grade, stream and academic year. No duplicate name or grade+stream within a year. Roster for any date. |
| Class membership | Dated `enrollments` rows existed but nothing changed them. | Placing and moving students is a dated operation: the old placement ends the day before, the new one starts. Nothing is overwritten, so every register still points at the class it was taken for. |
| Teachers | Seeded `class_teachers` rows. | Head assigns and removes teachers per class. Only active teachers of the same school; classes that are archived or in a finished year are refused. |
| Attendance | Teacher takes the register offline, syncs, head sees the overview. | Unchanged in behaviour and shape. It now reads the classes and rosters the head configured. |

## 3. How each required module was met

- **A. School profile and academic years/terms**: `packages/domain/src/academic.ts`, `apps/api/src/school-admin/school.ts`, `apps/web/src/screens/admin/school.tsx`.
- **B. Student registry**: `packages/domain/src/students.ts`, `apps/api/src/school-admin/students.ts`, `apps/web/src/screens/admin/students.tsx`. Paginated (default 25, maximum 100), search by name or admission number, filter by class, status, or "unplaced". No sensitive fields beyond optional date of birth and gender.
- **C. Classes and streams**: `packages/domain/src/classes.ts`, `apps/api/src/school-admin/classes.ts`, `apps/web/src/screens/admin/classes.tsx`. The enrolment model is the dated `enrollments` table from Slice 1, now protected by an exclusion constraint (a student is in at most one class on any day).
- **D. Teacher assignments**: same files as C, plus a database trigger (`class_teachers_teacher_membership`) so the rule holds even if application code is bypassed. `GET /v1/me/classes` exposes a teacher's own classes.
- **E. Attendance integration**: see section 7.

## 4. Files

From `git diff --stat fd0ba13..HEAD` at the last commit before this line was written: 65 files, +8,403 / -31.

**Added**
- `packages/db/migrations/0002_school_administration.sql`, `packages/db/preflight/0002_school_administration.sql`
- `packages/db/src/{admin-store,postgres-admin-store,db-errors}.ts`
- `packages/domain/src/{academic,students,classes,problem}.ts`
- `packages/contracts/src/{primitives,admin}.ts`
- `apps/api/src/school-admin/{http,common,school,students,classes,handlers}.ts`
- `apps/web/src/screens/admin/{school,students,classes}.tsx`, `components/{ui,admin-forms,admin-views}.tsx`, `lib/{admin-api,admin-forms,use-request,use-form-state}.ts`
- Tests: `packages/domain/test/{academic,students,classes}.test.ts`, `packages/contracts/test/admin.test.ts`, `packages/db/test/{admin-store,migration-0002}.test.ts`, `apps/api/test/school-admin-{school,students,classes,teachers,integration,policy}.test.ts`, `apps/api/test/admin-support.ts`, `apps/web/test/admin-forms.test.ts`, `apps/web/check/admin-render-check.tsx`

**Modified Slice 1 files** (every one of them, and why):

| File | Change |
|---|---|
| `packages/db/src/postgres-store.ts` | `teacherClasses` and `timetableForTeacher` add `c.status = 'active'` (archived classes drop off the phone). `enrolledStudents` takes an optional `{ lock }` flag. |
| `packages/db/src/store.ts` | Signature of `enrolledStudents` gains the optional flag. Backward compatible. |
| `apps/api/src/services/sync.ts` | One call: the push path passes `{ lock: true }` (section 6, "Concurrency"). |
| `packages/domain/src/authz.ts`, `index.ts` | New actions (`school:*`, `student:*`, `class:*`, `teacher:*`, `teaching:own-classes`). Head holds all but `teaching:own-classes`; a teacher reads a roster only for a class they teach. No new roles. |
| `apps/api/src/{routes,app,deps,errors,index}.ts` | 25 new routes in `SCHOOL_ADMIN_ROUTES`, adapter in `app.ts`, `deps.admin`, optional `field` on `HttpError`, `createAdminDb` in the Worker entry. CORS methods are derived from the route table. |
| `apps/web/src/{App.tsx,components/shell.tsx,lib/api.ts}` | Seven head-only routes, three nav entries, `authed` exported, `ApiFailure.field`. |
| `packages/contracts/src/index.ts`, `packages/db/src/index.ts`, `packages/domain/src/index.ts` | Re-exports. |
| `packages/db/testing/pg-test-runner.ts` | `createTestDatabase({ migrate: false })`, and statements on one session now run strictly in order. |
| `package.json` | Root `npm test` also globs `apps/web/test`; new script `check:render`. |
| `packages/db/test/store.test.ts`, `packages/domain/test/authz.test.ts`, `apps/api/test/support.ts` | Expect the second migration; new authz cases; fixture additions. |

## 5. Migration `0002_school_administration.sql`

**Additive.** Nothing from 0001 is dropped or rewritten. New columns are nullable or defaulted, new tables are new, Slice 1 code
keeps working on the migrated schema (tested: Slice 1 reads, inserts that know nothing about the new columns, bootstrap shape).
It runs in one transaction behind an advisory lock, so a failure changes nothing.

It adds: `btree_gist`; `academic_years`, `terms` (no overlapping dates, at most one active year per school); on `schools` a
code, contact fields and `updated_at`; on `classes` `academic_year_id`, `stream`, `status`; on `students` registry columns
(`enrolment_date` is backfilled from the first placement, else the creation day; `status` from the old `active` flag, which is left
untouched); `enrollments_no_overlap`; a teacher-membership trigger on `class_teachers`.

**One constraint is relaxed on purpose.** 0001 made class names unique per school. They are now unique per school **and academic
year** (case-insensitively), and classes with no year keep the old per-school rule. This is what lets "Grade 7A" exist again next
year. To restore the old per-school rule later you would first have to rename one of any two same-named classes that sit in different years.

**Pre-flight (run this first, read-only).**

```bash
psql "$DATABASE_URL" -f packages/db/preflight/0002_school_administration.sql
```

A row with `severity = blocking` names data the migration cannot accept: placements that overlap for one student; admission
numbers or class names that differ only by case (0001 compared them case-sensitively); `btree_gist` unavailable or not creatable by the role.
No blocking row means the migration will apply. `advisory` rows (admission numbers over 30 characters, names over 100, grade levels
over 20) never block, but the API refuses to edit such a row until the value is corrected and says so with a 409
(`record_needs_correction`). Both outcomes are covered by tests that run the script and then the real migration.

**Rollback.** There is no down migration. The schema change is additive and Slice 1 runs on it, so the safe rollback is to redeploy
the previous API and web build and leave the schema. Dropping the new objects would destroy Slice 2 data; do that only from a backup decision, not as a routine step.

## 6. Rules that matter (and are tested)

- **A class is never overwritten.** A move closes the current placement the day before and opens the new one on the effective date.
- **Changes start tomorrow at the earliest and at most one year ahead.** A move or a leaving date (withdrawn, transferred, graduated) cannot be today or in the past. The default is tomorrow. Reason: every register that exists, or could still be waiting on a phone, is dated today or earlier, so a change can never strand one. The one-year cap stops a typo ("2099") closing a placement that nothing can reopen.
- **A first placement may be back-dated** (catching up records), never over an existing placement.
- **Attendance guard.** If any register exists on or after the effective date the change is refused (409 `attendance_after_effective_date`). Through sync this cannot happen with the rule above, so the guard is a second line of defence (for example after a timezone edit).
- **Removing a mistaken placement** works only for the latest placement and only if it has no register. If it was a move, the placement it replaced is reopened (when it ended the day before, the student is still enrolled and that class is still active); otherwise the student is left unplaced. The audit log records what was restored.
- **Leaving school** ends the open placement. **Re-enrolling restores the status only**; the head places the student again. `students.active` is never changed (Slice 1 reads it).
- **Archiving a class** needs no current or upcoming student in it. An archived class drops off teachers' phones and timetables but queued offline registers for it still sync.
- **A legacy class (no year) can be given a year once**, and the year must contain all of the class's placements and registers (409 `year_excludes_history` says which dates). After that the year is fixed while the class has students or registers.
- **Tenancy.** The school always comes from the authenticated session. Bodies are strict, so a `schoolId` in a request is rejected. A malformed id or an id from another school is a plain 404 and the response is the same as for an id that does not exist.
- **Concurrency.** Admins take row locks in a fixed order (class, then student). A register push share-locks the placements it relies on; a move, a status change or a placement removal locks the same placements before it looks for registers. Whoever comes second waits and decides on committed data. Row locks are `NO KEY UPDATE`, which does not block the foreign-key checks of a register being saved. Three tests run two real database sessions against each other.

## 7. Attendance integration contract (module E)

- **Authorised classes**: Slice 1 `GET /v1/sync/bootstrap` (unchanged shape, parsed by the Slice 1 contract in a test) and Slice 2 `GET /v1/me/classes`. Both read `class_teachers`, active classes only.
- **Roster**: `GET /v1/classes/:id/roster?date=` for the head, or a teacher assigned to the class. It calls the same store query the offline replica is built from, so the two cannot disagree.
- **Stable ids**: classes, students and placements are UUIDs that never change when names, streams or admission numbers are edited. A queued operation that names a class and student by id still applies after such edits (tested).
- **History after changes**: a register stays attached to the class it was taken for; the head's overview attributes each day to that class. Moves, withdrawals and teacher changes never rewrite earlier registers or who recorded them.
- **Offline**: no second sync system. The replica is refreshed by the existing bootstrap (sign-in and sync). A change the head makes shows on a phone at its next refresh. Because changes start tomorrow, a phone that has not refreshed still takes today's register correctly.
- **Known residual risk (not fixed, because it is Slice 1 behaviour)**: Slice 1 rejects a whole push operation when any student in it is not enrolled in that class on that date. After a move takes effect, a phone that has not refreshed and still lists the mover will have that day's register for the class rejected as `invalid`. The teacher sees the rejection and refreshes; nothing is lost silently, but the register must be redone. Making Slice 1 accept the other students would change its contract and was left alone.

## 8. Verification

All with `PSQL_TEST_CONN` pointing at a throwaway PostgreSQL 16.

| Check | Result |
|---|---|
| `npm test` (domain, contracts, sync, db, api, web logic) | 294 tests: 135 packages, 145 API, 14 web. 0 failed, **0 skipped** |
| `npm run check:imports` | OK, 107 source files |
| `npm run check:render` (bun, react-dom/server) | Slice 1 checks pass; 23 admin render checks pass |
| `tsc` for `domain`, `contracts`, `sync` | clean |
| `tsc` for `db` and `api` | only "Cannot find module `postgres` / `hono`" and the implicit-any errors that follow from those; nothing else |
| `tsc` for the new web files | clean, **against throwaway type shims** for `react-router`, forms and test types, not against the real packages |
| Mutation checks | 18 deliberate bugs injected one at a time into the final code (tenant filter removed, teacher authorization widened, back-dating allowed, attendance guard off, archived classes shown, roster authorization removed, strict bodies off, archive guard off, wrong end date, coarse role gate off, no placement locks in sync / move / removal, same-day moves allowed, no date cap, year ignoring history, no restore on removal). The suite failed on **17**. The one that survives (removing the application's own teacher lookup) is still refused by the database trigger, by design. |

**Skipped tests.** With `PSQL_TEST_CONN` (and `TEST_DATABASE_URL`) unset, every test that needs a database skips itself and says why:
**162 of the 294 tests skip and 132 run** (12 of the 25 test files use the database: the db and API suites; the pure domain,
contracts, sync and web-logic tests still run). That run was measured, not estimated. In the run above, with the database
available, nothing was skipped. If `PSQL_TEST_CONN` is set but its role cannot create databases, the tests fail rather than skip.

**Not verified here, and why**
1. `apps/api/src/app.ts` (the Hono adapter), the Worker entry, CORS and body limits: `hono` and `postgres` were not installable. The handlers behind it are the same functions the tests call, and a test checks that every route has a handler and a policy and the reverse.
2. The real `postgres.js` / Hyperdrive adapter. Tests use `psql` sessions, which behave the same for transactions and locks, but a transaction-mode pooler's behaviour with `for share` / `for no key update` has not been tried.
3. `vite build`, and the screens' router and network glue. Pure form logic and rendering are tested; clicking through the screens in a browser has not been done.
4. Real devices and the offline path with the new screens. Slice 1's offline behaviour is untouched by the web changes.
5. Production data. Run the pre-flight against a copy first (section 11).

### Independent review

A separate reviewer who had not seen the work read the code and ran probes against the real database. It found nine issues; none
of them was left unaddressed.

| # | Finding | Severity | Outcome |
|---|---|---|---|
| 1 | A register being saved could be orphaned by a same-day move or removal (race) | medium | Fixed: row locks on both sides, and changes can no longer start today. Three two-session tests. |
| 2 | Unbounded effective dates ("2099") could strand a student | medium | Fixed: one-year cap on moves, leaving dates and first placements. |
| 3 | A legacy class could take a year that did not contain its history, then be locked | medium | Fixed: the year must cover all placements and registers. |
| 4 | Migration fails on case-colliding legacy data and the pre-flight document did not exist | medium | Fixed: runnable pre-flight script, tested against the real migration. |
| 5 | Removing a mistaken move left the student on no roster | low | Fixed: the replaced placement is reopened. |
| 6 | Old rows breaking the new length limits made unrelated edits a 500 | low | Fixed: clear 409 `record_needs_correction`. |
| 7 | A head can learn that another school uses a given school code (409 on a duplicate) | low | **Accepted.** Codes are unique across schools by design (a future sign-in key), only existence is revealed, nothing about the other school. Add rate limiting with the login limiter (existing gap 1 in `ARCHITECTURE.md`). |
| 8 | A teacher gets 403 for an existing class they do not teach and 404 for a missing one | low | **Accepted.** Same-school only, ids are random UUIDs, teachers cannot list classes. Other schools' ids already return 404. |
| 9 | A same-day move rejects the whole offline register | low | Resolved for moves made through the API (changes start tomorrow). The stale-phone case after the effective date remains, see section 7. |

## 9. Environment and configuration

No new environment variables, secrets or bindings. The API uses what Slice 1 already needs: Hyperdrive binding `HYPERDRIVE`,
secret `AUTH_SECRET`, variables `ALLOWED_ORIGIN` and `ENVIRONMENT`. The web app uses `VITE_API_URL`. Nothing is committed that is secret.

For tests only: `PSQL_TEST_CONN` (libpq connection string for a role that can create databases) or `TEST_DATABASE_URL`. `npm run check:render` needs `bun`.

## 10. Dependency on the unfinished Slice 1

- The Slice 2 API shares Slice 1's sign-in, sessions, Hyperdrive connection, `Deps` and `Store`. It needs that deployment working before it can run.
- The migration needs the 0001 schema (including `enrollments`, `class_teachers`, `attendance_records`) and nothing else from Slice 1's deployment.
- Slice 2 edits two Slice 1 queries and one call in the push path (section 4). If the Slice 1 team changes `sync.ts`, `postgres-store.ts` or `store.ts` in parallel, expect a small merge, and keep `{ lock: true }` in the push path or section 6 "Concurrency" stops holding.
- Nothing in Slice 2 changes a Slice 1 contract. If Slice 1 ships first, its API keeps working on the migrated database.

## 11. Integration and deployment instructions

Do these in order, and stop at the first surprise. Do not do any of it until Slice 1 is stable in production.

1. **Merge** `slice-2/school-administration` into the integration branch. Resolve any conflicts in the files listed in section 4 as above.
2. **Install and run the whole suite on a machine with the real toolchain**: `npm install`, `npm run typecheck`, `npm test` (with `PSQL_TEST_CONN`), `npm run check:imports`, `npm run check:render`, `npm run build:web`. The typecheck of `db`/`api` and the web build are the things not exercised here; fix anything they show before continuing.
3. **Rehearse on a copy of production** (for Neon, a branch of the production database; never production itself):
   `psql "$COPY_URL" -f packages/db/preflight/0002_school_administration.sql`, fix any `blocking` row, then `DATABASE_URL=$COPY_URL npm run db:migrate`.
4. **Run the API against the copy** (`npm run dev:api` with Hyperdrive's `localConnectionString` pointing at it) and the web app against that API. Click through: sign in as the head, School (create the current academic year), Classes (give each existing class that year; if it says "year_excludes_history", widen the year to cover the dates it names), Students (register one, place, move from tomorrow, withdraw), assign a teacher, then sign in as that teacher on a phone, take a register offline and sync.
5. **Production, in this order**: pre-flight, then `npm run db:migrate` (the existing Slice 1 API keeps working on the migrated schema), then deploy the API Worker, then the web build. Deploy the web build as a Cloudflare Pages *preview* first and promote it after a smoke test. Never run the seed in production.
6. **After release**: the head must create the academic year and attach existing classes before using year-scoped features. Until then Slice 1 keeps working unchanged because classes without a year behave as before.
7. **Roll back** by redeploying the previous API and web builds. The schema stays (section 5).

## 12. Known limitations

- The head is the only administrator (no school-admin role, no deputy). Teachers see only what they teach.
- Changing the school's timezone changes what "today" means for Slice 1's register as well. It is allowed; the form only carries a hint ("Decides what 'today' means for registers. Change it only if it is wrong."), with no confirmation step.
- Administration screens need a connection: they are not part of the offline replica (only the register is).
- No import (CSV/Excel), no bulk move or year-end promotion, no student photos, guardians or contact details, no audit viewer (every change is written to `audit_log`, and there is no screen for it).
- Class names are unique per academic year, so a class from last year and one from this year can share a name; a report that groups by name alone would merge them.
- A teacher assigned to a class that is later archived keeps the assignment but does not see the class; reactivating it brings it back.
- Row-level security, login rate limiting and the other gaps in `docs/ARCHITECTURE.md` still apply and are not changed by this slice.
